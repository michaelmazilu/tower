import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentPrompt, AskAgent, Timing } from "@towerai/contracts";
import { recordWorld } from "@towerai/world";
import { cachedLine, voiceLine, type Line, type VoicedLine } from "../voice/voice";
import { createAskAgent } from "./ask";
import { ElevenLabs, SpendLimitError } from "./client";
import { dataPath, readData, writeData } from "./data";
import { latencySamples } from "./modelled";

/**
 * Builds packages/world/data/world.json.
 *
 *   npm run record:world                offline and free: replays the recorded agent choices and voice
 *   ... record-world.ts --decide        also asks the agents where no choice is recorded (about 31 credits each)
 *   ... record-world.ts --voice         also voices storyline lines that have no audio (half a credit a character)
 *   ... record-world.ts --voice-all     voices every spoken line that has no audio, in every flight
 *   ... --cap=N                         stop once the account has used N credits this billing period (default and
 *                                       most for the live app: HARD_CAP). Set it from your plan; a stopped run keeps
 *                                       what it voiced, and running again carries on from there.
 */

/** The moments a judge is shown: flight, then the seconds of the recording to voice. */
const MOMENTS: [flightId: string, from: number, to: number][] = [
  ["QTR721", 15, 40],
  ["ACA860", 140, 160],
  ["DAL401", 545, 590],
];

const DECISIONS = dataPath("world", "decisions.json");
const OUT = fileURLToPath(new URL("../../../world/data/world.json", import.meta.url));

interface Recorded {
  optionId: string;
  reason: string;
  timings: Timing[];
}

const args = process.argv.slice(2);
const voiceAll = args.includes("--voice-all");
const capArg = args.find((a) => a.startsWith("--cap="));
const cap = capArg === undefined ? undefined : Number(capArg.slice("--cap=".length));
if (cap !== undefined && !(Number.isInteger(cap) && cap > 0)) throw new Error("--cap=N needs a whole number of credits.");
const spends = args.includes("--decide") || args.includes("--voice") || voiceAll;
const saved = readData<{ recordedAt: string; replies: Record<string, Recorded> }>(DECISIONS, { recordedAt: "", replies: {} });
// The owner names the cap on the command line, so it may go above the live app's HARD_CAP.
const api = spends ? ElevenLabs.fromEnv(cap, cap) : null;
if (spends && !api) throw new Error("--decide, --voice and --voice-all need ELEVENLABS_API_KEY.");
const live = createAskAgent({ enabled: args.includes("--decide"), api, maxCalls: 24, voice: false, onError: (e) => console.error(String(e)) });

// A recorded choice is replayed as "llm" only for the exact prompt it answered. Anything else is rules.
const ask: AskAgent = async (prompt) => {
  // With one option there is nothing to decide, so there is nothing to pay for.
  if (prompt.options.length < 2) return null;
  const key = createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 24);
  let reply: Recorded | undefined = saved.replies[key];
  if (!reply && args.includes("--decide")) {
    // Read the meter first, so that it is not counted as the agent's thinking time.
    await api!.prepare();
    const answer = await live(prompt);
    if (!answer) return null;
    reply = { optionId: answer.optionId, reason: answer.reason, timings: answer.timings };
    saved.replies[key] = reply;
    saved.recordedAt ||= new Date().toISOString();
    writeData(DECISIONS, saved);
    console.log(`${prompt.role} ${prompt.flightId}: ${reply.optionId}, ${reply.timings[0]?.ms} ms, ${reply.reason}`);
  }
  return reply ? { optionId: reply.optionId, reason: reply.reason, timings: reply.timings, brain: "llm" } : null;
};

const samples = latencySamples();
const world = await recordWorld({
  seed: 7,
  ask,
  maxAgentCalls: 1000,
  generatedAt: saved.recordedAt || undefined,
  modelTiming: samples
    ? {
        source: `${samples.llm} and ${samples.tts}, recorded ${samples.recorded}`,
        controllerDecideMs: samples.controller.decide,
        pilotDecideMs: samples.pilot.decide,
        voiceMs: [...samples.controller.voice, ...samples.pilot.voice],
      }
    : undefined,
});

// A click on a storyline flight opens on its moment, not wherever the clock is.
for (const f of world.flights) {
  const moment = MOMENTS.find(([id]) => id === f.summary.id);
  if (moment) f.opensAt = moment[1];
}

type Message = (typeof world.flights)[number]["messages"][number];
const attach = (m: Message, voiced: VoicedLine) => {
  m.audioUrl = voiced.audioUrl;
  m.timings = [...m.timings.filter((x) => x.stage !== "voice"), voiced.timing];
};

// Lines still to voice, keyed by what is said and by whom, so a repeated line is paid for once.
const wanted = new Map<string, { line: Line; messages: Message[] }>();
for (const { summary, messages } of world.flights) {
  for (const m of messages) {
    if (m.from === "operator") continue;
    // A responder is not the controller, so it does not get the controller's voice.
    const responder = m.speaker.endsWith("(simulated)");
    const role = m.from === "pilot" || responder ? "pilot" : "controller";
    const line: Line = { role, speaker: responder ? m.speaker : summary.id, text: m.text };
    const voiced = cachedLine(line, true);
    if (voiced) {
      attach(m, voiced);
      continue;
    }
    // A line the validator stopped was never said, so it is not paid for.
    if (!m.text || (m.decision?.verdict === "rejected" && m.durationS === 0)) continue;
    const storyline = MOMENTS.some(([id, from, to]) => id === summary.id && m.t >= from && m.t <= to);
    if (!voiceAll && !(storyline && args.includes("--voice"))) continue;
    const key = JSON.stringify(line);
    const job = wanted.get(key);
    if (job) job.messages.push(m);
    else wanted.set(key, { line, messages: [m] });
  }
}

if (wanted.size) {
  const queue = [...wanted.values()];
  const total = queue.length;
  const chars = queue.reduce((n, { line }) => n + line.text.length, 0);
  console.log(`voicing ${total} lines, about ${Math.ceil(chars / 2)} credits before radio wording`);
  let made = 0;
  let failed = 0;
  let failedInARow = 0;
  let stopped: string | undefined;
  // The client allows three requests at once, so three workers keep it busy.
  const worker = async () => {
    for (let job = queue.shift(); job && !stopped; job = queue.shift()) {
      try {
        const voiced = await voiceLine(job.line, { api, commit: true });
        if (!voiced) throw new Error("ElevenLabs returned no line.");
        for (const m of job.messages) attach(m, voiced);
        failedInARow = 0;
        if (++made % 25 === 0) console.log(`voiced ${made}/${total}`);
      } catch (error) {
        if (error instanceof SpendLimitError) stopped = error.message;
        else {
          failed++;
          console.error(String(error));
          // A bad key or a dead network fails every line: stop instead of logging all of them.
          if (++failedInARow >= 10) stopped = "10 lines in a row failed.";
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const left = total - made;
  console.log(`voiced ${made} lines, ${failed} failed, ${left} still without audio.`);
  if (stopped) console.log(`Stopped: ${stopped}`);
  if (left) console.log("Run the same command again to carry on: voiced lines are kept and skipped.");
}

const messages = world.flights.flatMap((f) => f.messages);
const voicedLines = messages.filter((m) => m.audioUrl).length;
const llm = messages.filter((m) => m.brain === "llm").length;
world.provenance.traffic += ` ${llm} choices were made by a real LLM agent in an earlier recording and are replayed only where the prompt is identical to the one it answered; every other line is rules. ${voicedLines} lines have recorded ElevenLabs voice.`;

const json = JSON.stringify(world);
writeFileSync(`${OUT}.tmp`, json);
renameSync(`${OUT}.tmp`, OUT);
console.log(`world.json: ${(json.length / 1e6).toFixed(2)} MB, ${world.flights.length} flights, ${llm} LLM choices, ${voicedLines} voiced lines`);
console.log(world.stats);
