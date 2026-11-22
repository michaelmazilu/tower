import type { RadioMode, Transmission, TransmissionKind } from "../types";
import { closeClearance, onClearanceTransmitted } from "./clearances";
import { onReadbackHeard, onRequestHeard, refreshWords } from "./pilots";
import { controlPosition } from "./positions";
import type { Simulation } from "./simulation";

/**
 * One voice at a time on a frequency: one for the airport, or one per
 * control position with `separateFrequencies`. Everything said on the radio
 * queues here; the highest-priority transmission on a frequency goes next.
 *
 * "simulated" transmissions time themselves from their word count.
 * "external" transmissions wait for the voice layer to report that the
 * audio actually finished (radio.tx_complete) or failed (radio.tx_failed).
 * Either way, an instruction only counts as transmitted once this module
 * says the transmission completed — a tool call alone never does.
 */

export interface RadioState {
  queue: Transmission[];
  /** The line to listen to: with several frequencies, the most important one on the air. */
  active: Transmission | null;
  onAir: Transmission[];
  /** Frequency -> sim time before which it stays quiet (gap between speakers). */
  freeAt: Map<string, number>;
}

const GAP_SEC = 0.7;
/** One speaker on every position keeps the exchanges tight. */
const BUSY_GAP_SEC = 0.55; // long enough for the crew being spoken to to answer first
const BUSY_WORDS_PER_SEC = 3.8;
/** A handoff or traffic call that has waited this long is no longer true. */
const STALE_SEC = 35;
const STALE_BELOW = 56;
/** Safety, and a person's instruction, steps on anything short of another urgent line. */
const SAFETY = 94;
/** This urgent steps on a line that can wait. */
const PREEMPTS = 84;
const CAN_WAIT = 78;
/** Too close to the end to be worth cutting off. */
const NEARLY_DONE_SEC = 1;
/** A waiting line gains a point every few seconds, so that routine calls are never starved. */
const AGEING_SEC = 4;
const MOST_AGEING = 18;
const WORDS_PER_SEC = 3.2;

export interface TransmissionInput {
  from: string;
  to: string;
  kind: TransmissionKind;
  text: string;
  spoken: string;
  clearanceId?: string;
  requestId?: string;
  priority: number;
  /** The words were already said live (human on the microphone). */
  alreadySpoken?: boolean;
}

export function estimateDurationSec(spoken: string): number {
  const words = spoken.trim().split(/\s+/).length;
  return Math.max(1.2, 0.6 + words / WORDS_PER_SEC);
}

function modeFor(sim: Simulation, from: string): RadioMode {
  return from === "TOWER" ? sim.config.radio.controller : sim.config.radio.pilots;
}

function channelFor(sim: Simulation, input: TransmissionInput): string {
  const { radio, separateFrequencies } = sim.config;
  if (!separateFrequencies || sim.config.oneSpeaker || radio.controller === "external" || radio.pilots === "external") return "all";
  // A readback answers on the frequency the instruction came on.
  if (input.kind === "readback" && input.clearanceId) {
    const asked = sim.transmissions.get(sim.clearances.get(input.clearanceId)?.transmissionId ?? "");
    if (asked) return asked.channel;
  }
  const ac = sim.get(input.from === "TOWER" ? input.to : input.from);
  return ac ? controlPosition(sim, ac) : "tower";
}

export function enqueueTransmission(sim: Simulation, input: TransmissionInput): Transmission {
  const tx: Transmission = {
    id: sim.nextId("TX"),
    from: input.from,
    to: input.to,
    kind: input.kind,
    text: input.text,
    spoken: input.spoken,
    clearanceId: input.clearanceId,
    requestId: input.requestId,
    priority: input.priority,
    mode: modeFor(sim, input.from),
    channel: channelFor(sim, input),
    status: "queued",
    queuedAt: sim.time,
  };
  sim.transmissions.set(tx.id, tx);
  if (input.alreadySpoken) {
    tx.startedAt = sim.time;
    tx.status = "active";
    sim.emit("radio.tx_started", { aircraftId: aircraftOf(tx), data: txData(tx) });
    finish(sim, tx);
    return tx;
  }
  sim.radio.queue.push(tx);
  sim.emit("radio.tx_queued", { aircraftId: aircraftOf(tx), data: txData(tx) });
  return tx;
}

const aircraftOf = (tx: Transmission) => (tx.from === "TOWER" ? (tx.to === "ALL" ? undefined : tx.to) : tx.from);

function txData(tx: Transmission): Record<string, unknown> {
  return {
    transmissionId: tx.id,
    from: tx.from,
    to: tx.to,
    kind: tx.kind,
    text: tx.text,
    spoken: tx.spoken,
    mode: tx.mode,
    clearanceId: tx.clearanceId,
    requestId: tx.requestId,
  };
}

export function stepRadio(sim: Simulation): void {
  const radio = sim.radio;
  for (const active of [...radio.onAir]) {
    if (active.mode === "simulated" && sim.time >= (active.endsAt ?? 0)) completeTransmission(sim, active);
    else if (active.mode === "external" && sim.time >= (active.endsAt ?? Infinity)) {
      failTransmission(sim, active, "voice output timed out");
    }
  }
  for (const waiting of [...radio.queue]) {
    if (waiting.kind !== "info" || waiting.priority >= STALE_BELOW || sim.time - waiting.queuedAt <= STALE_SEC) continue;
    failTransmission(sim, waiting, "no longer current");
  }
  preempt(sim);
  for (const waiting of [...radio.queue]) {
    const asked = waiting.kind === "request" && waiting.requestId ? sim.requests.get(waiting.requestId) : undefined;
    // Answered before it could be said.
    if (asked && sim.config.oneSpeaker && (asked.status === "answered" || asked.status === "withdrawn") && asked.type !== "OTHER") failTransmission(sim, waiting, "no longer needed");
  }
  for (;;) {
    const tx = takeNext(sim);
    if (!tx) return;
    start(sim, tx);
  }
}

/** Safety, emergency and operator lines do not wait for a routine call to finish. */
function preempt(sim: Simulation): void {
  const { queue, onAir, freeAt } = sim.radio;
  for (const waiting of queue) {
    if (waiting.priority < PREEMPTS) continue;
    const cut = onAir.find((o) => o.channel === waiting.channel);
    if (!cut || cut.mode !== "simulated" || cut.priority >= (waiting.priority >= SAFETY ? PREEMPTS : CAN_WAIT) || (cut.endsAt ?? 0) - sim.time <= NEARLY_DONE_SEC) continue;
    cut.status = "failed";
    cut.error = "interrupted by priority traffic";
    cut.completedAt = sim.time;
    offAir(sim, cut);
    freeAt.set(cut.channel, sim.time);
    sim.emit("radio.tx_interrupted", { aircraftId: aircraftOf(cut), data: { ...txData(cut), by: waiting.id } });
    const again = enqueueTransmission(sim, cut);
    again.queuedAt = cut.queuedAt;
    if (cut.kind === "clearance" && cut.clearanceId) sim.clearances.get(cut.clearanceId)!.transmissionId = again.id;
    sim.emit("radio.tx_requeued", { aircraftId: aircraftOf(again), data: { transmissionId: again.id, replaces: cut.id } });
    return;
  }
}

/** Highest priority first, then first come first served, on a frequency that is quiet. */
function takeNext(sim: Simulation): Transmission | undefined {
  const { queue, onAir, freeAt } = sim.radio;
  const rank = (tx: Transmission) =>
    tx.priority >= CAN_WAIT ? tx.priority : Math.min(CAN_WAIT - 1, tx.priority + Math.min(MOST_AGEING, Math.floor((sim.time - tx.queuedAt) / AGEING_SEC)));
  let best = -1;
  for (let i = 0; i < queue.length; i++) {
    const tx = queue[i];
    if (best >= 0 && rank(tx) <= rank(queue[best])) continue;
    if (sim.time < (freeAt.get(tx.channel) ?? 0) || onAir.some((o) => o.channel === tx.channel)) continue;
    best = i;
  }
  return best < 0 ? undefined : queue.splice(best, 1)[0];
}

function start(sim: Simulation, tx: Transmission): void {
  const { radio } = sim;
  refreshWords(sim, tx);
  const clip = sim.config.clipSec?.(tx.from, tx.text, tx.spoken);
  const duration = clip ?? (sim.config.oneSpeaker ? Math.max(1.2, 0.4 + tx.spoken.trim().split(/\s+/).length / BUSY_WORDS_PER_SEC) : estimateDurationSec(tx.spoken));
  tx.status = "active";
  tx.startedAt = sim.time;
  tx.endsAt = sim.time + (tx.mode === "simulated" ? duration : Math.max(20, duration * 4));
  radio.onAir.push(tx);
  if (!radio.active || tx.priority > radio.active.priority) radio.active = tx;
  sim.emit("radio.tx_started", {
    aircraftId: aircraftOf(tx),
    data: { ...txData(tx), estimatedDurationSec: duration },
  });
}

function offAir(sim: Simulation, tx: Transmission): void {
  const { radio } = sim;
  if (!radio.onAir.includes(tx)) return;
  radio.onAir = radio.onAir.filter((o) => o !== tx);
  radio.freeAt.set(tx.channel, sim.time + (sim.config.oneSpeaker ? BUSY_GAP_SEC : GAP_SEC));
  if (radio.active !== tx) return;
  radio.active = null;
  for (const o of radio.onAir) if (!radio.active || o.priority >= radio.active.priority) radio.active = o;
}

function finish(sim: Simulation, tx: Transmission): void {
  tx.status = "completed";
  tx.completedAt = sim.time;
  offAir(sim, tx);
  sim.emit("radio.tx_completed", { aircraftId: aircraftOf(tx), data: txData(tx) });

  if (tx.kind === "clearance" && tx.clearanceId) {
    const clr = sim.clearances.get(tx.clearanceId);
    if (clr) onClearanceTransmitted(sim, clr);
  } else if (tx.kind === "readback" && tx.clearanceId) {
    onReadbackHeard(sim, tx);
  } else if (tx.kind === "request" && tx.requestId) {
    onRequestHeard(sim, tx);
  }
}

export function completeTransmission(sim: Simulation, tx: Transmission): void {
  if (tx.status !== "active") return;
  finish(sim, tx);
}

export function failTransmission(sim: Simulation, tx: Transmission, error: string): void {
  if (tx.status !== "active" && tx.status !== "queued") return;
  const wasActive = tx.status === "active";
  tx.status = "failed";
  tx.error = error;
  tx.completedAt = sim.time;
  if (wasActive && sim.radio.onAir.includes(tx)) {
    offAir(sim, tx);
  } else {
    sim.radio.queue = sim.radio.queue.filter((q) => q.id !== tx.id);
  }
  sim.emit("radio.tx_failed", {
    aircraftId: aircraftOf(tx),
    attention: tx.kind === "clearance",
    data: { ...txData(tx), error },
  });
  if (tx.kind === "clearance" && tx.clearanceId) {
    const clearance = sim.clearances.get(tx.clearanceId);
    if (clearance?.status === "issued") closeClearance(sim, clearance, "expired", error);
  }
}
