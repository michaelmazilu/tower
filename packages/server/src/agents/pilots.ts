import type { AgentPrompt, Brain, Timing } from "@towerai/contracts";
import { controlPosition, describeLocation, requestPhrase, wantedRequest, type Aircraft, type Clearance, type Command, type RequestType, type Simulation } from "@towerai/core";
import { ElevenLabs, SpendLimitError } from "./client";
import { agentIds, type AgentIds } from "./data";
import { decide } from "./decide";

const POLL_MS = 200;
/** Sim seconds between looks, so a host can call update on every step. */
const LOOK_EVERY_S = 0.5;
const CONCURRENT = 2;
/** Sim seconds a turn may wait for a free slot before the rules take it. */
const MAX_WAIT_S = 8;
const MAX_FAILURES = 3;
/** Safety instructions are read back at once. Nobody waits on a model for these. */
const INSTANT = new Set<Clearance["type"]>(["GO_AROUND", "HOLD_POSITION"]);

export interface PilotTurn {
  aircraftId: string;
  action: "request" | "readback" | "human_requested";
  text: string;
  brain: Brain;
  reason: string;
  timings: Timing[];
  clearanceId?: string;
  requestId?: string;
  transmissionId?: string;
}

export interface PilotOptions {
  /** Off unless explicitly true: rehearsals must not drain credits. */
  enabled?: boolean;
  /** LLM calls for this run. When they are gone every flight goes back to the rules. */
  maxCalls?: number;
  timeoutMs?: number;
  /** Defaults to the flights the scenario marks as AI pilots. */
  flights?: "all" | string[];
  onTurn?: (turn: PilotTurn) => void;
  /** Also ask the AI when the pilot has only one valid reply. Off: it costs credits and time for no choice. */
  askOnRoutine?: boolean;
  api?: ElevenLabs | null;
  ids?: AgentIds | null;
}

export interface PilotDriver {
  enabled: boolean;
  calls(): number;
  /** Called on a timer. Exposed so a stepped simulation can drive it. */
  update(): Promise<void>;
  detach(): void;
}

type Task =
  | { key: string; ac: Aircraft; clearance: Clearance }
  | { key: string; ac: Aircraft; need: NonNullable<ReturnType<typeof wantedRequest>>; reminder: boolean };

const OFF: PilotDriver = { enabled: false, calls: () => 0, update: async () => {}, detach: () => {} };

/**
 * AI pilots on the existing claim, request and readback commands. The model
 * chooses between saying the validated line and calling for a person. Every
 * failure, timeout or exhausted budget is answered by the rules at once.
 *
 * Emits `pilot.turn` with brain and timings, and `pilot.human_requested`.
 * A call for a person is a `pilot.request` of type OTHER.
 */
export function attachPilots(sim: Simulation, options: PilotOptions = {}): PilotDriver {
  if (options.enabled !== true) return OFF;
  const maybeApi = options.api === undefined ? ElevenLabs.fromEnv() : options.api;
  const maybeIds = options.ids === undefined ? agentIds() : options.ids;
  if (!maybeApi || !maybeIds) return OFF;
  const api = maybeApi;
  const ids = maybeIds;
  const { maxCalls = 12, timeoutMs = 4000, flights, onTurn, askOnRoutine = false } = options;
  // Always this sim, never "the host's current one": a late reply must not land in a restarted run.
  const dispatch = (command: Command) => sim.dispatch(command);

  const mine = new Set<string>();
  const released = new Set<string>();
  const busy = new Set<string>();
  const done = new Map<string, number>();
  const waitingSince = new Map<string, number>();
  let calls = 0;
  let failures = 0;
  let stopped = false;
  let lastTime = -Infinity;

  const wanted = (ac: Aircraft) =>
    flights === "all" || (flights ? flights.includes(ac.id) : ac.pilotType === "ai");
  const driving = (ac: Aircraft) => mine.has(ac.id) && ac.externallyControlled && ac.pilotType === "ai" && sim.get(ac.id) === ac;

  function record(turn: PilotTurn): void {
    sim.annotate(turn.action === "human_requested" ? "pilot.human_requested" : "pilot.turn", { ...turn }, turn.aircraftId);
    onTurn?.(turn);
  }

  function say(task: Task, brain: Brain, reason: string, timings: Timing[]): void {
    const { ac } = task;
    const base = { aircraftId: ac.id, brain, reason, timings };
    if ("clearance" in task) {
      const { id, expectedReadback } = task.clearance;
      const sent = dispatch({ type: "pilot.readback", aircraftId: ac.id, clearanceId: id, text: expectedReadback });
      const transmissionId = sent.ok ? String(sent.transmissionId) : undefined;
      record({ ...base, action: "readback", text: expectedReadback, clearanceId: id, transmissionId });
      return;
    }
    // No text: the simulator's phraseology says it, so words and data cannot drift apart.
    record({ ...base, action: "request", ...ask(ac.id, task.need.type, task.need.runway) });
  }

  function ask(id: string, requestType: RequestType, runway?: string, text?: string) {
    const sent = dispatch({ type: "pilot.request", aircraftId: id, requestType, runway, text });
    const request = sent.ok ? sim.requests.get(String(sent.requestId)) : undefined;
    const tx = request && [...sim.transmissions.values()].filter((t) => t.requestId === request.id).pop();
    return { text: request?.text ?? text ?? "", requestId: request?.id, transmissionId: tx?.id };
  }

  function release(id: string): void {
    mine.delete(id);
    released.add(id);
    const ac = sim.get(id);
    if (ac?.externallyControlled && ac.pilotType === "ai") dispatch({ type: "pilot.release", aircraftId: id });
  }

  function toRules(): void {
    for (const id of [...mine]) {
      const ac = sim.get(id);
      // The built-in pilot never sees a readback that fell due while the flight was claimed.
      if (ac && driving(ac)) {
        for (const clearance of sim.clearances.values()) {
          const key = `rb:${clearance.id}`;
          if (clearance.aircraftId === id && clearance.status === "transmitted" && !done.has(key)) {
            say({ key, ac, clearance }, "rules", "AI pilot stopped, rules took over.", []);
          }
        }
      }
      release(id);
    }
  }

  function nextTask(ac: Aircraft): Task | null {
    let awaiting = false;
    for (const clearance of sim.clearances.values()) {
      if (clearance.aircraftId !== ac.id) continue;
      if (clearance.status === "transmitted") {
        const key = `rb:${clearance.id}`;
        if (!done.has(key)) return { key, ac, clearance };
      }
      if (clearance.status === "issued" || clearance.status === "transmitted") awaiting = true;
    }
    if (awaiting) return null;
    const need = wantedRequest(sim, ac);
    if (!need) return null;
    const open = [...sim.requests.values()].find(
      (r) => r.aircraftId === ac.id && r.type === need.type && (r.status === "pending" || r.status === "transmitting"),
    );
    if (!open) {
      const key = `rq:${ac.id}:${need.type}`;
      // Asked a moment ago: give the radio a chance before asking again.
      return sim.time - (done.get(key) ?? -Infinity) < 5 ? null : { key, ac, need, reminder: false };
    }
    const { requestReminderSec, maxReminders } = sim.config.rules;
    const patience = open.deferredBy ? requestReminderSec * 2 : requestReminderSec;
    const quiet = sim.time - Math.max(open.lastTransmittedAt, open.deferredAt ?? 0);
    if (quiet <= patience || open.reminders >= maxReminders) return null;
    return { key: `rm:${open.id}:${open.reminders}`, ac, need, reminder: true };
  }

  function promptFor(task: Task): AgentPrompt {
    const { ac } = task;
    const context = [`${ac.phase.replaceAll("_", " ")}, ${describeLocation(sim, ac)}`, `priority ${ac.priority}`];
    const conflicts = [...sim.conflicts.values()].filter((c) => c.aircraftIds.includes(ac.id));
    for (const conflict of conflicts) context.push(conflict.description);
    const emergency = [...sim.emergencies.values()].find((e) => e.resolvedAt === undefined && e.aircraftId === ac.id);
    if (emergency) context.push(`emergency: ${emergency.type.replaceAll("_", " ")}`);
    if (!("clearance" in task) && task.reminder) context.push("the controller has not answered your earlier request");

    const normal = "clearance" in task
      ? { id: "say", action: "readback", text: task.clearance.expectedReadback }
      : {
          id: "say",
          action: "request",
          text: requestPhrase({ callsign: ac.callsign, type: task.need.type, runway: task.need.runway, gate: ac.gate, flight: ac.flight }).text,
        };
    const troubled = conflicts.length > 0 || !!emergency || ac.priority !== "normal" || (!("clearance" in task) && task.reminder);
    const position = controlPosition(sim, ac);
    const called = position[0].toUpperCase() + position.slice(1);
    const choices = troubled
      ? [normal, { id: "human", action: "escalate", text: `${called}, ${ac.callsign}, unable, request a human controller.` }]
      : [normal];
    return {
      role: "pilot",
      flightId: ac.id,
      speaker: ac.callsign,
      position,
      context,
      history: [...sim.transmissions.values()].filter((t) => t.status === "completed" && (t.from === ac.id || t.to === ac.id)).slice(-4).map((t) => t.text),
      options: choices,
    };
  }

  function stillDue(task: Task): boolean {
    if (stopped || !driving(task.ac)) return false;
    return "clearance" in task ? task.clearance.status === "transmitted" : wantedRequest(sim, task.ac)?.type === task.need.type;
  }

  async function take(task: Task): Promise<void> {
    busy.add(task.ac.id);
    calls++;
    const started = performance.now();
    try {
      await api.prepare();
      const prompt = promptFor(task);
      const chosen = await decide(api, ids, prompt, timeoutMs);
      failures = 0;
      if (!stillDue(task)) return;
      const timings = [{ ...chosen.timing, ms: Math.round(performance.now() - started) }];
      done.set(task.key, sim.time);
      if (chosen.optionId !== "human") return say(task, "llm", chosen.reason, timings);
      const text = prompt.options.find((o) => o.id === "human")!.text;
      // An OTHER request is how a flight calls for a person: it stays open until someone takes it.
      record({ aircraftId: task.ac.id, action: "human_requested", brain: "llm", reason: chosen.reason, timings, ...ask(task.ac.id, "OTHER", undefined, text) });
      release(task.ac.id);
    } catch (error) {
      if (!stillDue(task)) return;
      done.set(task.key, sim.time);
      say(task, "rules", "AI pilot unavailable or too slow, rules answered.", []);
      if (error instanceof SpendLimitError || ++failures >= MAX_FAILURES) calls = maxCalls;
    } finally {
      busy.delete(task.ac.id);
    }
  }

  async function update(): Promise<void> {
    if (stopped || sim.time - lastTime < LOOK_EVERY_S) return;
    lastTime = sim.time;
    if (calls >= maxCalls && !busy.size) return toRules();
    for (const ac of sim.aircraft.values()) {
      if (mine.has(ac.id) || released.has(ac.id) || ac.externallyControlled || calls >= maxCalls || !wanted(ac)) continue;
      dispatch({ type: "pilot.claim", aircraftId: ac.id, by: "ai" });
      mine.add(ac.id);
    }
    const tasks: Task[] = [];
    for (const ac of sim.aircraft.values()) {
      if (!driving(ac) || busy.has(ac.id)) continue;
      const task = nextTask(ac);
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => Number("clearance" in b) - Number("clearance" in a));

    const running: Promise<void>[] = [];
    for (const task of tasks) {
      const instant = "clearance" in task && INSTANT.has(task.clearance.type);
      // With nothing wrong the pilot has one valid reply. An AI call would cost credits
      // and about 1.3 s to pick it, so the rules say it at once and the budget waits
      // for turns with a real choice (read back, or ask for a person).
      const routine = !instant && !askOnRoutine && promptFor(task).options.length === 1;
      const slot = busy.size < CONCURRENT && calls < maxCalls;
      const since = waitingSince.get(task.key) ?? sim.time;
      if (routine) {
        waitingSince.delete(task.key);
        done.set(task.key, sim.time);
        say(task, "rules", "Routine reply with only one valid option, so no AI call.", []);
      } else if (!instant && slot) {
        waitingSince.delete(task.key);
        running.push(take(task));
      } else if (instant || calls >= maxCalls || sim.time - since > MAX_WAIT_S) {
        waitingSince.delete(task.key);
        done.set(task.key, sim.time);
        say(task, "rules", instant ? "Safety instruction, read back at once by rules." : "AI pilot busy or out of budget, rules answered.", []);
      } else {
        waitingSince.set(task.key, since);
      }
    }
    await Promise.all(running);
  }

  const timer = setInterval(() => void update(), POLL_MS);
  timer.unref();

  return {
    enabled: true,
    calls: () => calls,
    update,
    detach() {
      if (stopped) return;
      clearInterval(timer);
      toRules();
      stopped = true;
    },
  };
}
