/**
 * docs/latency-protocol.md.
 *   node --import tsx packages/server/src/agents/latency.ts                        rebuild the results from raw samples, offline
 *   node --env-file=.env --import tsx packages/server/src/agents/latency.ts --plan show what a run would send and cost
 *   node --env-file=.env --import tsx packages/server/src/agents/latency.ts --run  collect once, spends credits
 *   ... --resume  send, once, the prompts that the credit meter stopped. Disclosed in the results.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentPrompt, ControlPosition } from "@towerai/contracts";
import {
  BaselineController, SCENARIOS, ToolGateway, clearancePhrase, createSimulation, getRunwayStatus,
  matchReadback, readbackPhrase, type Clearance, type ClearanceType,
} from "@towerai/core";
import { radioSpeech } from "../voice/speech";
import { TTS_MODEL, voiceLine, type Line } from "../voice/voice";
import { ElevenLabs } from "./client";
import { agentIds, dataPath, writeData } from "./data";
import { DECISION_CREDITS, decide } from "./decide";

type Role = "controller" | "pilot";
const ROLES: Role[] = ["controller", "pilot"];
const RAW = dataPath("latency", "samples.jsonl");
const DOC = fileURLToPath(new URL("../../../../docs/latency-results.md", import.meta.url));
const PROTOCOL = fileURLToPath(new URL("../../../../docs/latency-protocol.md", import.meta.url));
const SCENARIO = "guided-demo";
const N = 20;
const TIMEOUT_MS = 10_000;
const THRESHOLD_MS = 2000;
const BOOTSTRAP = { resamples: 10_000, seed: 20261122 };

interface Meta {
  kind: "meta";
  at: string;
  runId: string;
  protocolSha256: string;
  scenario: string;
  seed: number;
  n: number;
  timeoutMs: number;
  llm: string;
  tts: string;
  node: string;
  os: string;
}
interface Resume {
  kind: "resume";
  at: string;
  reason: string;
  warmupMs?: number;
}
interface Sample {
  kind: "warmup" | "sample";
  id: string;
  role: Role;
  at: string;
  prompt: AgentPrompt;
  chosen?: string;
  reason?: string;
  conversationId?: string;
  decideMs?: number;
  voiceText?: string;
  voiceMs?: number;
  rulesDecideMs: number;
  error?: string;
  resumed?: boolean;
}
const MAX_PER_BATCH = 10;
const stoppedByMeter = (s: Sample) => s.error?.includes("/v1/user/subscription") === true;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The first N clearances of the seeded demo, each with what was true when it was issued. */
function scenarioPrompts() {
  const scenario = SCENARIOS[SCENARIO];
  const sim = createSimulation(scenario, { radio: { controller: "simulated", pilots: "simulated" } });
  const baseline = new BaselineController(sim, new ToolGateway(() => sim)).attach();
  const seen = new Set<string>();
  const prompts: { role: Role; prompt: AgentPrompt; rulesDecideMs: number }[] = [];
  const add = (clearance: Clearance, rulesMs: number) => {
    const ac = sim.get(clearance.aircraftId)!;
    const position: ControlPosition = clearance.type === "PUSHBACK" || clearance.type === "TAXI" ? "ground" : "tower";
    const request = clearance.requestId ? sim.requests.get(clearance.requestId)?.text : undefined;
    const facts = [`${ac.callsign} phase ${ac.phase}, runway ${ac.assignedRunway}`];
    if (clearance.runway) facts.push(`runway status ${JSON.stringify(getRunwayStatus(sim, clearance.runway)).slice(0, 500)}`);
    prompts.push({
      role: "controller",
      rulesDecideMs: rulesMs,
      prompt: {
        role: "controller", flightId: ac.id, speaker: "Toronto Tower", position,
        context: facts,
        history: request ? [request] : [],
        options: [
          { id: "issue", action: clearance.type, text: clearance.phraseology },
          { id: "stand_by", action: "wait", text: `${ac.callsign}, stand by.` },
        ],
      },
    });
    const started = performance.now();
    const readback = readbackPhrase({
      callsign: ac.callsign, type: clearance.type, runway: clearance.runway, via: clearance.via, flight: ac.flight,
      gate: ac.flight === "arrival" && clearance.type === "TAXI" ? clearance.gate : undefined,
    });
    matchReadback({ ...clearance, callsign: ac.callsign }, readback.text);
    prompts.push({
      role: "pilot",
      rulesDecideMs: performance.now() - started,
      prompt: {
        role: "pilot", flightId: ac.id, speaker: ac.callsign, position,
        context: [facts[0]],
        history: [`Tower: ${clearance.phraseology}`],
        options: [
          { id: "readback", action: "readback", text: clearance.expectedReadback },
          { id: "human", action: "escalate", text: `Tower, ${ac.callsign}, unable, request a human controller.` },
        ],
      },
    });
  };
  for (const clearance of sim.clearances.values()) {
    seen.add(clearance.id);
    // Issued at scenario set-up, so there is no rules decision to time: timed as the validator's lookup.
    const started = performance.now();
    getRunwayStatus(sim, clearance.runway ?? sim.get(clearance.aircraftId)!.assignedRunway);
    add(clearance, performance.now() - started);
  }
  for (let tick = 0; tick < 12_000 && prompts.length < N * 2; tick++) {
    sim.step();
    const started = performance.now();
    baseline.update();
    const ms = performance.now() - started;
    for (const clearance of sim.clearances.values()) {
      if (seen.has(clearance.id) || prompts.length >= N * 2) continue;
      seen.add(clearance.id);
      add(clearance, ms);
    }
  }
  baseline.detach();
  return { scenario, prompts };
}

/**
 * The credit cap cannot cover 40 full-length lines, so the voice stage uses complete
 * short transmissions for the same scenario's aircraft, all different.
 */
function voiceLines(): Record<Role, Line[]> {
  const types: ClearanceType[] = ["GO_AROUND", "HOLD_POSITION", "CONTINUE_TAXI"];
  const build = (role: Role) =>
    SCENARIOS[SCENARIO].aircraft
      .flatMap(({ callsign, flight }) =>
        types.map((type): Line => {
          const phrase = { callsign, type, flight };
          return { role, speaker: callsign, text: (role === "controller" ? clearancePhrase(phrase) : readbackPhrase(phrase)).text };
        }))
      .sort((a, b) => radioSpeech(a.text).length - radioSpeech(b.text).length)
      .slice(0, N);
  return { controller: build("controller"), pilot: build("pilot") };
}

function plan() {
  const { scenario, prompts } = scenarioPrompts();
  const lines = voiceLines();
  const all = [...lines.controller, ...lines.pilot, lines.controller[0]];
  const voice = all.reduce((sum, line) => sum + Math.ceil(radioSpeech(line.text).length / 2), 0);
  return { scenario, prompts, lines, credits: (prompts.length + 1) * DECISION_CREDITS + voice };
}

async function collect(resume: boolean): Promise<void> {
  if (!resume && existsSync(RAW)) throw new Error(`${RAW} exists. Samples are never replaced or topped up.`);
  const api = ElevenLabs.fromEnv();
  const ids = agentIds();
  if (!api || !ids) throw new Error("Needs ELEVENLABS_API_KEY and data/agents.json.");
  const { scenario, prompts, lines, credits } = plan();
  if (prompts.length !== N * 2) throw new Error(`The scenario gave ${prompts.length} prompts, expected ${N * 2}.`);
  console.log("planned credits", credits, await api.guard.refresh());

  const write = (row: Meta | Resume | Sample) => appendFileSync(RAW, JSON.stringify(row) + "\n");
  const now = new Date().toISOString();
  let stopped: Set<string> | undefined;
  if (resume) {
    const rows = readFileSync(RAW, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Meta | Resume | Sample);
    if (rows.some((row) => row.kind === "resume")) throw new Error("Already resumed once.");
    stopped = new Set(rows.filter((row): row is Sample => row.kind === "sample" && stoppedByMeter(row)).map((row) => row.id));
    const started = performance.now();
    // Free: opens the connection and creates a conversation that never runs.
    await api.json("POST", "/v1/convai/conversations", { agent: { type: "persisted", agent_id: ids.controller } }, AbortSignal.timeout(TIMEOUT_MS));
    write({
      kind: "resume", at: now, warmupMs: Math.round(performance.now() - started),
      reason: "The harness read the rate-limited credit meter before every call. It now reads it before each batch.",
    });
  } else write({
    kind: "meta", at: now, runId: `latency-${now}`,
    protocolSha256: createHash("sha256").update(readFileSync(PROTOCOL)).digest("hex"),
    scenario: scenario.id, seed: scenario.seed, n: N, timeoutMs: TIMEOUT_MS, llm: ids.llm, tts: TTS_MODEL,
    node: process.version, os: `${platform()} ${release()} ${arch()}`,
  });

  let sent = 0;
  const measure = async (kind: Sample["kind"], id: string, item: (typeof prompts)[number], line: Line) => {
    const sample: Sample = {
      kind, id, role: item.role, at: new Date().toISOString(), prompt: item.prompt,
      rulesDecideMs: Number(item.rulesDecideMs.toFixed(3)),
    };
    if (resume) sample.resumed = true;
    try {
      if (sent++ % MAX_PER_BATCH === 0) await api.guard.refresh();
      const chosen = await decide(api, ids, item.prompt, TIMEOUT_MS);
      Object.assign(sample, { chosen: chosen.optionId, reason: chosen.reason, conversationId: chosen.conversationId, decideMs: chosen.timing.ms });
      sample.voiceText = line.text;
      const voiced = await voiceLine(line, { api, fresh: true, timeoutMs: TIMEOUT_MS });
      sample.voiceMs = voiced!.timing.ms;
    } catch (error) {
      sample.error = messageOf(error);
    }
    write(sample);
    console.log(id, sample.role, sample.chosen, sample.decideMs, sample.voiceMs, sample.error ?? "");
  };

  if (!resume) await measure("warmup", "warmup", prompts[0], lines.controller[0]);
  const used = { controller: 0, pilot: 0 };
  for (const item of prompts) {
    const i = used[item.role]++;
    const id = `${item.role}-${i + 1}`;
    if (!stopped || stopped.has(id)) await measure("sample", id, item, lines[item.role][i]);
  }
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const at = (values: number[], q: number) => sorted(values)[Math.max(0, Math.ceil(q * values.length) - 1)];
function median(values: number[]): number {
  const v = sorted(values);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
function interval(values: number[]): [number, number] {
  let state = BOOTSTRAP.seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const medians = Array.from({ length: BOOTSTRAP.resamples }, () => median(values.map(() => values[Math.floor(random() * values.length)])));
  return [at(medians, 0.025), at(medians, 0.975)];
}
/** Exact two-sided sign test. */
function signTest(differences: number[]): number {
  const d = differences.filter((x) => x !== 0);
  const k = Math.min(d.filter((x) => x > 0).length, d.filter((x) => x < 0).length);
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= k; i++) {
    term *= (d.length - i + 1) / i;
    sum += term;
  }
  return Math.min(1, (2 * sum) / 2 ** d.length);
}

const ms = (value: number) => (value < 1 ? value.toFixed(3) : String(Math.round(value)));
function cell(values: number[]): string {
  if (!values.length) return "none";
  const [low, high] = interval(values);
  return `${ms(median(values))} [${ms(low)}, ${ms(high)}]`;
}

function report(): void {
  const rows = readFileSync(RAW, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Meta | Resume | Sample);
  const meta = rows.find((row): row is Meta => row.kind === "meta")!;
  const warmup = rows.find((row): row is Sample => row.kind === "warmup");
  const samples = rows.filter((row): row is Sample => row.kind === "sample");

  const resumed = rows.find((row): row is Resume => row.kind === "resume");
  const verdicts: string[] = [];
  const firstRun: string[] = [];
  const table: string[] = [];
  const timings: Record<string, { decide: number[]; voice: number[] }> = {};
  for (const role of ROLES) {
    const mine = samples.filter((s) => s.role === role);
    const ok = mine.filter((s) => !s.error && s.decideMs !== undefined && s.voiceMs !== undefined);
    const decideMs = ok.map((s) => s.decideMs!);
    const voiceMs = ok.map((s) => s.voiceMs!);
    const total = ok.map((s) => s.decideMs! + s.voiceMs!);
    const rules = ok.map((s) => s.rulesDecideMs);
    const row = (metric: string, values: number[], baseline: string) =>
      table.push(`| ${role} | ${metric} | ${values.length} | ${mine.length - ok.length} of ${mine.length} | ${cell(values)} | ${values.length ? ms(at(values, 0.95)) : "none"} | ${baseline} |`);
    row("decide", decideMs, cell(rules));
    row("voice", voiceMs, "same voice service");
    row("**decide + voice**", total, cell(ok.map((s) => s.rulesDecideMs + s.voiceMs!)));
    timings[role] = { decide: decideMs, voice: voiceMs };

    const before = ok.filter((s) => !s.resumed).map((s) => s.decideMs! + s.voiceMs!);
    const after = ok.filter((s) => s.resumed).map((s) => s.decideMs! + s.voiceMs!);
    if (resumed) {
      firstRun.push(`| ${role} | before the stop | ${before.length} | ${mine.filter((s) => !s.resumed && s.error).length} | ${cell(before)} | underpowered, no claim |`);
      firstRun.push(`| ${role} | after the resume | ${after.length} | ${mine.filter((s) => s.resumed && s.error).length} | ${cell(after)} | underpowered, no claim |`);
    }
    if (!total.length) {
      verdicts.push(`- **${role}: no successful samples. No claim.**`);
      continue;
    }
    const middle = median(total);
    const [low, high] = interval(total);
    const verdict = total.length < 20
      ? `UNDERPOWERED (n=${total.length}, needs 20). No pass or fail claim`
      : middle <= THRESHOLD_MS
        ? `${resumed ? "under" : "MET"} the ${THRESHOLD_MS} ms threshold${high > THRESHOLD_MS ? ", but the interval crosses it" : ""}${resumed ? ", but NOT a clean pass: the run was interrupted and resumed (see below)" : ""}`
        : `MISSED the ${THRESHOLD_MS} ms threshold by ${ms(middle - THRESHOLD_MS)} ms`;
    const differences = ok.map((s) => s.decideMs! - s.rulesDecideMs);
    verdicts.push(
      `- **${role}: ${verdict}.** Median response ${ms(middle)} ms (bootstrap 95% interval ${ms(low)} to ${ms(high)}, n=${total.length}, ` +
      `${mine.length - ok.length} failed, p95 ${ms(at(total, 0.95))} ms). The rules baseline with the same voice is ` +
      `${ms(median(ok.map((s) => s.rulesDecideMs + s.voiceMs!)))} ms. The agent is slower than the rules: median paired difference ` +
      `${cell(differences)} ms, exact sign test p=${signTest(differences).toExponential(1)}.`,
    );
  }
  writeData(dataPath("latency", "timings.json"), {
    runId: meta.runId, recorded: meta.at.slice(0, 10), llm: meta.llm, tts: meta.tts, ...timings,
  });

  const offScript = samples.filter((s) => s.chosen && s.chosen !== "issue" && s.chosen !== "readback");
  const failures = samples.filter((s) => s.error);
  const byMeter = failures.filter(stoppedByMeter);
  const otherFailures = failures.filter((s) => !stoppedByMeter(s));
  const stopNote = resumed
    ? `
**Read this with the verdict: the run was interrupted and resumed.** The harness read the credit meter before every call, that endpoint rate limited it (HTTP 429), and ${byMeter.length} attempts stopped${byMeter.some((s) => s.decideMs !== undefined) ? " (one of them after its decide stage, before voice)" : " before reaching the agent"}. They are counted as failures above and kept in the raw file. After seeing five samples per role, the harness was fixed to read the meter per batch and only those same prompts were sent, once, at ${resumed.at}. Nothing about the model, prompts, lines, threshold or timeout changed. A run with no interruption would be stronger evidence. Taken alone, neither part reaches n=20:

| role | part | n | failures | median response [95%] | claim |
|---|---|---|---|---|---|
${firstRun.join("\n")}
`
    : "";
  writeFileSync(DOC, `# Agent latency results

Generated from raw samples by \`packages/server/src/agents/latency.ts\`. Protocol: [latency-protocol.md](latency-protocol.md), sha256 \`${meta.protocolSha256}\`.

## Result

${verdicts.join("\n")}

All times are milliseconds, measured on real calls. Medians carry a bootstrap 95% interval (${BOOTSTRAP.resamples} resamples, seed ${BOOTSTRAP.seed}).

| role | metric | n | failures | median [95%] | p95 | rules baseline |
|---|---|---|---|---|---|---|
${table.join("\n")}

${stopNote}
The floor is 0 ms. Random and human performance were not measured, so there is no comparison with human controllers.

## Run

- Run \`${meta.runId}\`, scenario \`${meta.scenario}\` seed ${meta.seed}, Node ${meta.node}, ${meta.os}.
- Agent model \`${meta.llm}\`, reasoning off, temperature 0, no backup model. Voice model \`${meta.tts}\`, 22 kHz 32 kbps MP3.
- Controller and pilot interleaved, one request at a time, timeout ${meta.timeoutMs} ms, no automatic retries.
- Excluded warm-up: decide ${warmup?.decideMs ?? "failed"} ms, voice ${warmup?.voiceMs ?? "failed"} ms${warmup?.error ? ` (${warmup.error})` : ""}.
${resumed ? `- Warm-up before the resume, excluded: conversation create without a model turn, ${resumed.warmupMs} ms.\n` : ""}- Failures: ${byMeter.length} stopped by the credit meter's rate limit. Other: ${otherFailures.length ? otherFailures.map((s) => `${s.id}: ${s.error}`).join("; ") : "none"}.
- Choices other than the expected clearance or readback: ${offScript.length ? offScript.map((s) => `${s.id} chose ${s.chosen} ("${s.reason}")`).join("; ") : "none"}. Reported for transparency. This is not a quality score.

## Method and deviations

1. \`decide\` includes creating the conversation, the model turn and validating the chosen option. Reading the credit meter happens before the clock starts. Waiting for the turn to come up in the product is not included.
2. **Deviation, voice text.** The credit cap did not cover 40 full-length lines. Each voice sample is a complete, different, short transmission (go around, hold position, continue taxi) for an aircraft in the same scenario, so it is not the line chosen in the paired decide call. Taxi clearances are up to three times as long. Their first byte was not measured and could be slower.
3. **Baseline detail.** The rules time is the baseline controller's whole evaluation that issued the clearance, and for pilots phrase plus readback check. Clearances issued at scenario set-up have no controller evaluation, so a runway-status lookup is timed for those. A harness bug passed the callsign in place of the readback text to the pilot's rules check during this run. It is fixed now, and it affects only the tens-of-microseconds baseline, not the agent timings.
4. Before the run, one decide call and one voice call tested the endpoints. During the interruption one tower review tested the tool loop. One earlier decide attempt failed locally on an invalid timeout before the model was called, and one conversation was created without a turn. None are in the samples. No other model was tried, so the model was not picked on these results.
5. **Prompt flaw found by the raw data.** Controller context was captured just after the rules had reserved the runway, so it read "not clear, reserved" for the very flight being answered, and the agent often chose stand by, giving that as its reason. It does not change what was timed, and it is one more reason these samples say nothing about decision quality. After the run one clause was added to the controller prompt to explain reservations, so the timings are for the prompt without that clause.
6. The account's credit meter lagged and once read lower than before (551, then 30). Spending was capped on the higher of that meter and a local estimate, reconciled with per-conversation billing records and voiced characters.
7. A failed stage fails the whole response sample. ${resumed ? "Prompts stopped by the credit meter were sent once more, as disclosed above. No other sample was retried and none was replaced." : "No sample was retried or replaced."}

## What these numbers do not support

Performance on another network, under concurrent load, on another day, at paid-tier priority, over a long conversation or for a tower review that uses several tools. Any statement about safety, correctness or human performance. Twenty samples per role give a rough median and a weak p95 (it is the second-slowest sample). Anything not timed on a real call must be shown as \`modelled\`.

## Replicate

\`\`\`sh
node --import tsx packages/server/src/agents/latency.ts
\`\`\`

rebuilds this file and \`packages/server/data/latency/timings.json\` offline from \`packages/server/data/latency/samples.jsonl\`. A new measurement needs that file moved aside, a key and about 1900 credits:

\`\`\`sh
node --env-file=.env --import tsx packages/server/src/agents/latency.ts --run
\`\`\`

## BetterBench Appendix I checklist

### Design

| item | answer | note |
|---|---|---|
| Capability defined | Yes | Radio response time, in the protocol. |
| Capability mapped to tasks | Yes | Pick a validated clearance, read one back, reach first audio. |
| Real-world use described | Yes | How long an operator waits. |
| Interpretation and misuse described | Yes | Section above. |
| Domain experts involved | **No** | No controller or pilot reviewed it. |
| Use cases or personas | Yes | Demo operator. |
| Domain literature integrated | **No** | None reviewed. |
| Metric choice justified | Yes | Wall clock is what the operator feels. |
| Floors and ceilings | **No** | Floor 0 ms. The timeout bounds a call, no meaningful ceiling was set. |
| Human performance | **No** | Not measured. |
| Random performance | **No** | Not measured. |
| Automatic evaluation, validated | **No** | Automatic, but the timer was not checked against an external one. |
| Differences to related benchmarks | **No** | Not surveyed. |
| Input sensitivity | **No** | Long voice lines and larger prompts were not tested. |

### Implementation

| item | answer | note |
|---|---|---|
| Evaluation code available | Yes | The script. |
| Data or generator available | Yes | Seeded scenario and raw samples. |
| API models supported | Yes | ElevenLabs. |
| Local models supported | **No** | Not implemented. |
| Unique identifier or encryption | Yes | Run and sample ids. |
| Training contamination check | N/A | Latency, not correctness. |
| Replication script | Yes | Offline rebuild from raw samples. |
| Uncertainty reported | Yes | Bootstrap interval and paired sign test. |
| Content warning assessed | N/A | Synthetic aviation phrases. |
| Build status | **No** | None for this benchmark. |
| Release requirements | **No** | None specified. |

### Documentation

| item | answer | note |
|---|---|---|
| Requirements file | Yes | package.json and lockfile. |
| Quick start | Yes | Replicate. |
| In-line comments | Yes | In the script. |
| Code documentation | Yes | Script header. |
| Peer-reviewed paper | **No** | Hackathon measurement. |
| Construction documented | Yes | Protocol and method. |
| Tasks and rationale | Yes | Method. |
| Normative assumptions | **No** | The 2000 ms threshold is a product target without cited evidence. |
| Limitations | Yes | Above. |
| Collection and prompt design | Yes | Script and raw prompts. |
| Metric documented | Yes | Protocol. |
| Licence | **No** | None specified for these samples. |

### Maintenance

| item | answer | note |
|---|---|---|
| Usability checked within a year | Yes | Run on ${meta.at.slice(0, 10)}. |
| Feedback channel | **No** | None. |
| Contact person | **No** | None listed. |
`);
  console.log(verdicts.join("\n"));
}

if (process.argv.includes("--plan")) {
  const { prompts, lines, credits } = plan();
  console.log({ prompts: prompts.length, credits, controllerLines: lines.controller.map((l) => l.text), pilotLines: lines.pilot.map((l) => l.text) });
  console.log(JSON.stringify(prompts[10].prompt), JSON.stringify(prompts[10].prompt).length);
  console.log("rules ms", prompts.map((p) => p.rulesDecideMs.toFixed(3)).join(" "));
} else {
  if (process.argv.includes("--run")) await collect(false);
  if (process.argv.includes("--resume")) await collect(true);
  report();
}
