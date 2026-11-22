import type { Brain, Timing } from "./index";

/*
 * The pilot's seat: a visitor holds a key, talks, and Toronto Tower answers from the live state
 * of that aircraft. It has a simulation of its own, so the operator demo is never disturbed.
 *
 * The model (or the rules, without one) only chooses among options built from that state. The
 * validator decides, and every safety-critical word comes from a template, never from the model.
 */

export type Fault = "engine_failure" | "smoke" | "low_fuel";

/** Synthetic instruments, derived from the simulation and the faults set on it. */
export interface Vitals {
  onGround: boolean;
  altFt: number;
  gsKt: number;
  hdg: number;
  vsFpm: number;
  /** Percent N1, left and right. */
  engines: [left: number, right: number];
  fuelMin: number;
  smoke: boolean;
  gearDown: boolean;
}

/** What the pilot claimed, against what the tower can see. */
export interface CrossCheck {
  claim: string;
  verdict: "confirmed" | "contradicted" | "unverified";
  evidence: { label: string; value: string; agrees: boolean }[];
}

/** One press of the key: what was heard, and the answer. */
export interface Exchange {
  id: string;
  t: number;
  heard: string;
  input: "speech" | "typed";
  said: string;
  brain: Brain;
  intent: string;
  reason: string;
  /** The facts the answer was built from. */
  looked: string[];
  check: CrossCheck | null;
  /** The clearance this exchange asked the validator for, if any. */
  action: { type: string; verdict: "accepted" | "rejected"; blockedBy?: string } | null;
  callsHuman: boolean;
  /** Wall-clock, measured. A stage that did not run has no entry. */
  timings: { transcribeMs?: number; decide: Timing; voice?: Timing; totalMs: number };
  audioUrl?: string;
}

export interface CockpitState {
  runId: string;
  t: number;
  callsign: string;
  spokenCallsign: string;
  type: string;
  runway: string;
  phase: string;
  /** Plain words: "holding short of runway 24L". */
  status: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  vitals: Vitals;
  faults: Fault[];
  traffic: { callsign: string; x: number; y: number; altFt: number; hdg: number; status: string }[];
  /** What a person who has never flown could say next, in their own words. Two or three. */
  coach: { now: string; trySaying: string[] };
  /** The clearance waiting for a readback, if any. */
  readBack: string | null;
  humanCalled: boolean;
  exchanges: Exchange[];
  speech: { available: boolean; label: string; creditsLeft: number | null };
}

/*
 * HTTP, same origin:
 *   GET  /api/cockpit                  CockpitState (poll at 4 Hz)
 *   POST /api/cockpit/talk             body: the recorded audio, content-type audio/*  -> { ok, exchange?, message? }
 *   POST /api/cockpit/say              { text }                                        -> { ok, exchange?, message? }
 *   POST /api/cockpit/fault            { fault, on }                                   -> { ok }
 *   POST /api/cockpit/reset            {}                                              -> { ok }
 *   POST /api/world/voice              { flightId, messageId }                         -> { ok, audioUrl?, timing?, message? }
 */
