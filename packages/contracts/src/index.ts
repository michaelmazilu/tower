/**
 * The seams between the world engine, the live Pearson ops layer, the agents
 * and the web app. Units: seconds of sim time unless the name says `Ms`,
 * knots, feet, degrees true, nautical miles, WGS84 latitude and longitude.
 */

// ---------------------------------------------------------------- provenance

/** Who produced the words or decision. Shown in the UI; never upgraded. */
export type Brain = "llm" | "rules" | "human";
/** measured = timed on a real call. modelled = drawn from measured samples or a stated assumption. */
export type TimingKind = "measured" | "modelled";

export interface Timing {
  /** decide: think of what to say. voice: time to first audio byte. */
  stage: "decide" | "voice";
  ms: number;
  kind: TimingKind;
  /** e.g. "ElevenLabs agent, recorded 2026-11-22" or "modelled from 24 measured samples". */
  source: string;
}

// ------------------------------------------------------------------- flights

export type ControlPosition = "ground" | "tower" | "departure" | "approach" | "enroute";
export type RiskLevel = "normal" | "watch" | "high" | "critical";
export type Attention =
  | "none"
  /** The agent is handling it; worth an operator's eye. */
  | "monitor"
  /** The rules say a person should step in. */
  | "intervene"
  /** The pilot or the agent explicitly asked for a person. */
  | "human_requested"
  /** A person has control; the agent does not act on this flight. */
  | "human_control";

export interface Risk {
  /** 0..100, deterministic. */
  score: number;
  level: RiskLevel;
  /** Plain-language factors, biggest first. */
  reasons: string[];
}

export interface FlightSummary {
  id: string;
  callsign: string;
  airline: string;
  type: string;
  origin: string;
  destination: string;
  /** Plain words: "holding short 23", "climbing FL240". */
  status: string;
  position: ControlPosition;
  /** Who is talking to it: "Toronto Tower", "Shanwick Control". */
  facility: string;
  lat: number;
  lon: number;
  altFt: number;
  gsKt: number;
  hdg: number;
  vsFpm: number;
  risk: Risk;
  attention: Attention;
  /** What the pilot needs right now, if anything. */
  need: string | null;
  lastMessage: string | null;
  /** Live only: present while a person is needed or has control. Not replayed. */
  brief?: HandoffBrief;
}

/**
 * The agent's briefing to the person taking a flight, shaped like the briefing
 * one controller gives another when relieving a position. Derived by rules
 * from simulation state; no model writes it.
 */
export interface HandoffBrief {
  /** What is wrong, in a few words: "Passenger medical emergency". */
  problem: string;
  /** Where the flight is, in plain words: "Landing on runway 23, 14 miles out, about 5 min from touchdown." */
  context: string;
  /** Time left to decide before the flight acts on its own. Null when nothing forces the pace. */
  deadline: { inS: number; then: string } | null;
  /** What to do now, in order, in plain words. Accepting sends exactly these, in the person's name. */
  recommend: { clearanceType: string; label: string; why: string }[];
  /** What is true right now, in sentences: who is in control, what has been given, what is waiting. */
  now: string[];
  /** Held flights only: what the agent will and will not do if handed back. */
  onHandback: string | null;
  /** A sentence: what the agent is saying or has just had confirmed for this flight, and whether taking over would cancel it. */
  agentDoing: { text: string; cancelledByTakeover: boolean } | null;
  /** Arrivals only: where it is on the way in, the abort point, and others landing on the same runway. Miles to the threshold. */
  approach: { runway: string; miles: number; decisionNm: number; others: { callsign: string; miles: number }[] } | null;
  /** One or two sentences: who is ahead and behind, and whether the runway is clear. */
  around: string | null;
  /** The last few moments that explain how the flight got here, oldest first, in plain words. */
  story: { t: number; text: string }[];
}

/** [t, lat, lon, altFt, gsKt, hdg, vsFpm], ascending t. */
export type TrackPoint = [number, number, number, number, number, number, number];

export interface Message {
  id: string;
  t: number;
  durationS: number;
  from: "controller" | "pilot" | "operator";
  speaker: string;
  position: ControlPosition;
  kind: "request" | "clearance" | "readback" | "advisory" | "emergency" | "handoff" | "escalation" | "info";
  text: string;
  brain: Brain;
  /** Response timings, for both controller and pilot messages. */
  timings: Timing[];
  /** The id of the message this answers; response time is measured between them. */
  replyTo?: string;
  /** Controller messages: why, what it looked at, and what the validator said. */
  decision?: {
    action: string;
    reason: string;
    context: string[];
    verdict: "accepted" | "rejected";
    blockedBy?: string;
  };
  /** Cached audio, if this line was voiced. */
  audioUrl?: string;
}

export interface Marker {
  t: number;
  kind: "handoff" | "conflict" | "resolved" | "emergency" | "weather" | "closure" | "escalation" | "takeover" | "handback";
  label: string;
  otherFlightId?: string;
}

export interface SeparationSample {
  t: number;
  otherFlightId: string;
  lateralNm: number;
  verticalFt: number;
  requiredNm: number;
  requiredFt: number;
}

/** Everything the replay screen needs. Every field can be read at any t. */
export interface FlightRecord {
  summary: FlightSummary;
  startT: number;
  endT: number;
  track: TrackPoint[];
  messages: Message[];
  markers: Marker[];
  /** Step functions: the value holds until the next sample. */
  riskSeries: { t: number; risk: Risk; attention: Attention; need: string | null; status: string; position: ControlPosition; facility: string }[];
  separation: SeparationSample[];
}

// --------------------------------------------------------------------- world

export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
}

/** A light, synthetic flight drawn along a great circle. Not controlled. */
export interface BackgroundFlight {
  id: string;
  from: [lat: number, lon: number];
  to: [lat: number, lon: number];
  departT: number;
  durationS: number;
  altFt: number;
}

export interface WorldRecording {
  version: 1;
  generatedAt: string;
  seed: number;
  /** The recording covers 0..durationS. */
  durationS: number;
  /** Wall-clock label for t = 0, ISO UTC. */
  epoch: string;
  provenance: {
    traffic: string;
    separation: string;
    performance: string;
    latency: string;
    attribution: string[];
  };
  airports: Airport[];
  flights: FlightRecord[];
  background: BackgroundFlight[];
  stats: {
    conflictsPredicted: number;
    conflictsResolved: number;
    lossesOfSeparation: number;
    escalations: number;
    handoffs: number;
    messages: number;
  };
}

// ---------------------------------------------------------- world agent seam

export interface AgentPrompt {
  role: "controller" | "pilot";
  flightId: string;
  speaker: string;
  position: ControlPosition;
  /** Compact facts the agent may use. */
  context: string[];
  /** Earlier lines on this frequency, oldest first. */
  history: string[];
  /** Already validated. A controller picks one; a pilot has exactly one or may escalate. */
  options: { id: string; action: string; text: string }[];
}

export interface AgentReply {
  optionId: string;
  reason: string;
  /** Optional natural wording for lines that are not safety-critical. Clearances and readbacks use option text. */
  text?: string;
  brain: Brain;
  timings: Timing[];
  audioUrl?: string;
}

/** The world recorder calls this at storyline moments. Null means use the rules. */
export type AskAgent = (prompt: AgentPrompt) => Promise<AgentReply | null>;

// ----------------------------------------------------------------- live ops

export interface OpsState {
  runId: string;
  t: number;
  paused: boolean;
  speed: number;
  controller: { brain: Brain; label: string; state: "listening" | "reviewing" | "error" };
  voice: { available: boolean; label: string };
  /** Highest attention and risk first. */
  flights: FlightSummary[];
  onAir: { flightId: string | null; speaker: string; text: string; audioUrl?: string } | null;
  alerts: { id: string; flightId: string | null; t: number; level: RiskLevel; title: string; detail: string; suggestedAction: string | null; acknowledged: boolean }[];
  runways: { id: string; state: "clear" | "reserved" | "occupied" | "inactive" | "closed"; flightId: string | null }[];
}

export interface OperatorInstruction {
  clearanceType: string;
  reason: string;
  runway?: string;
  gate?: string;
}

/*
 * HTTP (all JSON, same origin):
 *   GET  /api/world                           WorldRecording
 *   GET  /api/airport                         AirportData from @towerai/core
 *   GET  /api/ops                             OpsState
 *   GET  /api/ops/flights/:id                 FlightRecord, history from the start of this run
 *   GET  /api/ops/flights/:id/actions         { actions: { clearanceType, label }[] } valid operator choices now
 *   POST /api/ops/flights/:id/takeover        { ok, message? }
 *   POST /api/ops/flights/:id/instruct        OperatorInstruction -> { ok, message? }
 *   POST /api/ops/flights/:id/ask             { question } -> { ok, message }: a plain answer from the
 *                                             flight's briefing, by rules (no model), for "Ask the agent"
 *   POST /api/ops/flights/:id/accept          { steps: clearanceType[] } -> { ok, message? }; takes control if
 *                                             needed, then sends the agent's recommendation as shown, or refuses
 *                                             if it has changed since
 *   POST /api/ops/flights/:id/handback        { ok, message? }
 *   POST /api/ops/alerts/:id/ack              { ok }
 *   POST /api/demo/restart                    { ok }, restarts the judge scenario from t = 0
 *   POST /api/sim/control                     existing pause, resume, speed
 *   GET  /api/audio/:file                     cached audio
 *   WS   /ws                                  existing messages, plus { type: "ops", ops: OpsState } at 2 Hz
 */

export * from "./cockpit";
