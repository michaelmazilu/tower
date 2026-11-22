import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentPrompt, AskAgent, Timing } from "@towerai/contracts";
import { recordWorld } from "@towerai/world";
import { cachedLine, voiceLine, type Line } from "../voice/voice";
import { createAskAgent } from "./ask";
import { ElevenLabs } from "./client";
import { dataPath, readData, writeData } from "./data";
import { latencySamples } from "./modelled";

/**
 * Builds packages/world/data/world.json.
 *
 *   npm run record:world                offline and free: replays the recorded agent choices and voice
 *   ... record-world.ts --decide        also asks the agents where no choice is recorded (about 31 credits each)
 *   ... record-world.ts --voice         also voices storyline lines that have no audio (half a credit a character)
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
const saved = readData<{ recordedAt: string; replies: Record<string, Recorded> }>(DECISIONS, { recordedAt: "", replies: {} });
const api = args.length ? ElevenLabs.fromEnv() : null;
if (args.length && !api) throw new Error("--decide and --voice need ELEVENLABS_API_KEY.");
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

let voicedLines = 0;
for (const { summary, messages } of world.flights) {
  for (const m of messages) {
    if (m.from === "operator") continue;
    // A responder is not the controller, so it does not get the controller's voice.
    const responder = m.speaker.endsWith("(simulated)");
    const role = m.from === "pilot" || responder ? "pilot" : "controller";
    const line: Line = { role, speaker: responder ? m.speaker : summary.id, text: m.text };
    let voiced = cachedLine(line);
    const storyline = MOMENTS.some(([id, from, to]) => id === summary.id && m.t >= from && m.t <= to);
    if (!voiced && storyline && args.includes("--voice")) {
      voiced = await voiceLine(line, { api }).catch((error: unknown) => (console.error(String(error)), null));
    }
    if (!voiced) continue;
    voicedLines++;
    m.audioUrl = voiced.audioUrl;
    m.timings = [...m.timings.filter((x) => x.stage !== "voice"), voiced.timing];
  }
}

const messages = world.flights.flatMap((f) => f.messages);
const llm = messages.filter((m) => m.brain === "llm").length;
world.provenance.traffic += ` ${llm} choices were made by a real LLM agent in an earlier recording and are replayed only where the prompt is identical to the one it answered; every other line is rules. ${voicedLines} lines have recorded ElevenLabs voice.`;

const json = JSON.stringify(world);
writeFileSync(`${OUT}.tmp`, json);
renameSync(`${OUT}.tmp`, OUT);
console.log(`world.json: ${(json.length / 1e6).toFixed(2)} MB, ${world.flights.length} flights, ${llm} LLM choices, ${voicedLines} voiced lines`);
console.log(world.stats);
