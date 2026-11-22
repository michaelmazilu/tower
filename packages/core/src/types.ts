/**
 * Shared domain types. Everything here is plain serialisable data so the
 * same shapes travel over the WebSocket to the dashboard unchanged.
 *
 * Units: positions in metres (x east, y north, origin at the airport
 * reference point), speeds in knots, altitudes in feet AGL, headings in
 * degrees clockwise from north, times in simulation seconds.
 */

export interface Vec2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------- aircraft

export type FlightPhase =
  | "at_gate"
  | "pushback"
  | "taxi_out"
  | "holding_short"
  | "line_up"
  | "takeoff"
  | "departure"
  | "approach"
  | "holding"
  | "go_around"
  | "landing"
  | "rollout"
  | "taxi_in";

export const GROUND_PHASES: ReadonlySet<FlightPhase> = new Set<FlightPhase>([
  "at_gate",
  "pushback",
  "taxi_out",
  "holding_short",
  "line_up",
  "rollout",
  "taxi_in",
]);

export const AIRBORNE_PHASES: ReadonlySet<FlightPhase> = new Set<FlightPhase>([
  "departure",
  "approach",
  "holding",
  "go_around",
  "landing",
]);

export type PilotType = "ai" | "scripted" | "human";
export type Priority = "normal" | "urgent" | "emergency";
export type RunwayAuth = "cross" | "lineup" | "takeoff";

export interface AirWaypoint {
  name: string;
  x: number;
  y: number;
  altFt?: number;
  speedKts?: number;
  tag?: "if" | "faf" | "touchdown" | "rejoin" | "departure_exit" | "circuit";
}

export interface Aircraft {
  id: string;
  callsign: string;
  type: string;
  pilotType: PilotType;
  /**
   * False: the built-in deterministic pilot makes this aircraft's requests
   * and readbacks. True: an external pilot (human microphone or AI pilot
   * agent) has claimed the radio and must send them through commands.
   */
  externallyControlled: boolean;
  flight: "departure" | "arrival";

  position: Vec2;
  altitudeFt: number;
  speedKts: number;
  headingDeg: number;

  phase: FlightPhase;
  phaseSince: number;
  /** Runway END designator, e.g. "23". */
  assignedRunway?: string;
  gate?: string;

  // --- ground routing: node ids through the airport graph.
  route: string[];
  /** Index of the node the aircraft is heading to (or standing on). */
  currentWaypointIndex: number;
  /** Metres remaining to route[currentWaypointIndex]; 0 = standing on it. */
  distToNextM: number;
  /** The aircraft may not pass this route index (its clearance limit). */
  routeLimitIndex: number;
  holdPosition: boolean;
  /** Physical runway id -> what the aircraft is currently cleared to do on it. */
  runwayAuth: Record<string, RunwayAuth>;

  // --- airborne routing
  airRoute: AirWaypoint[];
  airIndex: number;
  landingCleared: boolean;

  /** Latest clearance, in the compact shape the plan specifies. */
  clearance?: {
    id: string;
    type: string;
    issuedAt: number;
    status: "pending" | Exclude<ClearanceStatus, "issued" | "transmitted">;
  };

  priority: Priority;
  emergencyId?: string;
  /** Sim time at which a departure at the gate becomes ready to push. */
  readyAt: number;
  flightComplete: boolean;
  spawnedAt: number;
  /** A person has this flight: only clearances issued by "human" are accepted. */
  humanControl?: boolean;

  blockedSince?: number;
  blockedBy?: string;
  blockedReason?: string;

  flags: {
    pushbackComplete?: boolean;
    vacated?: boolean;
    airborne?: boolean;
    clearanceNeededNotified?: boolean;
    taxiClearanceCancelled?: boolean;
    /** Engine failure after departure: may land back on its departure runway. */
    emergencyReturn?: boolean;
    /** Emergency injection: roll through the next hold-short line. */
    ignoreNextHold?: boolean;
    incursionActive?: boolean;
    incursionHold?: boolean;
    /** Its runway shut. It keeps the old plan until a change of runway is read back. */
    runwayUnavailable?: boolean;
    /** Missed approach: the heading, altitude and speed have been read back. */
    vectored?: boolean;
    /** Emergency: number one, flying the short pattern back. */
    priorityReturn?: boolean;
  };
}

// -------------------------------------------------------------- clearances

export type ClearanceType =
  | "PUSHBACK"
  | "TAXI"
  | "HOLD_SHORT"
  | "CROSS_RUNWAY"
  | "LINE_UP_AND_WAIT"
  | "CLEARED_TAKEOFF"
  | "CLEARED_TO_LAND"
  | "GO_AROUND"
  | "HOLD"
  | "CONTINUE_APPROACH"
  | "HOLD_POSITION"
  | "CONTINUE_TAXI"
  | "RUNWAY_CHANGE"
  | "VECTOR"
  | "RETURN_TO_LAND";

export const CLEARANCE_TYPES: readonly ClearanceType[] = [
  "PUSHBACK",
  "TAXI",
  "HOLD_SHORT",
  "CROSS_RUNWAY",
  "LINE_UP_AND_WAIT",
  "CLEARED_TAKEOFF",
  "CLEARED_TO_LAND",
  "GO_AROUND",
  "HOLD",
  "CONTINUE_APPROACH",
  "HOLD_POSITION",
  "CONTINUE_TAXI",
  "RUNWAY_CHANGE",
  "VECTOR",
  "RETURN_TO_LAND",
];

/**
 * issued        validated and recorded, not yet spoken on the radio
 * transmitted   the controller's transmission finished
 * acknowledged  the pilot read it back correctly; the aircraft is acting on it
 * readback_missing  a stop instruction remains active after its readback deadline
 * completed     the manoeuvre finished
 * expired       never transmitted / never read back in time
 * cancelled     withdrawn (e.g. landing clearance voided by a go-around)
 * superseded    replaced by a newer clearance
 */
export type ClearanceStatus =
  | "issued"
  | "transmitted"
  | "acknowledged"
  | "readback_missing"
  | "completed"
  | "expired"
  | "cancelled"
  | "superseded";

export interface Vector {
  turn: "left" | "right";
  headingDeg: number;
  altitudeFt: number;
  speedKts: number;
}

export interface Clearance {
  id: string;
  aircraftId: string;
  type: ClearanceType;
  /** Runway end designator the clearance refers to, when relevant. */
  runway?: string;
  /** Physical runway id, e.g. "05/23". */
  runwayId?: string;
  gate?: string;
  route?: string[];
  via?: string[];
  /** Worked out by the rulebook, never supplied by the controller. */
  vector?: Vector;
  /** The controller's stated rationale. Logged verbatim, never invented. */
  reason: string;
  issuedBy: string;
  requestId?: string;
  status: ClearanceStatus;
  /** True once the clearance has changed the aircraft's behaviour. */
  active: boolean;
  issuedAt: number;
  transmittedAt?: number;
  acknowledgedAt?: number;
  closedAt?: number;
  closeReason?: string;
  transmissionId?: string;
  /** Readable text for the dashboard. */
  phraseology: string;
  /** Text shaped for TTS: digits and letters spelled the way ATC says them. */
  spoken: string;
  expectedReadback: string;
}

// ----------------------------------------------------------------- requests

export type RequestType = "PUSHBACK" | "TAXI" | "TAKEOFF" | "LANDING" | "CROSS" | "OTHER";

export interface PilotRequest {
  id: string;
  aircraftId: string;
  type: RequestType;
  runway?: string;
  gate?: string;
  text: string;
  spoken: string;
  /**
   * transmitting  queued/being spoken; the controller has not heard it yet
   * pending       heard, waiting for the controller
   * answered      resolved by an acknowledged clearance
   * withdrawn     no longer relevant (e.g. the aircraft went around)
   */
  status: "transmitting" | "pending" | "answered" | "withdrawn";
  priority: Priority;
  createdAt: number;
  heardAt?: number;
  closedAt?: number;
  answeredBy?: string;
  /** Clearance that acknowledged but did not grant it (e.g. HOLD_SHORT). */
  deferredBy?: string;
  deferredAt?: number;
  reminders: number;
  lastTransmittedAt: number;
}

// -------------------------------------------------------------------- radio

export type TransmissionKind = "clearance" | "request" | "readback" | "report" | "emergency" | "info";
export const ADVISORY_KINDS = ["weather", "closure", "traffic", "handoff", "responders", "responders_ack", "details", "escalation", "info"] as const;
export type AdvisoryKind = (typeof ADVISORY_KINDS)[number];
export type RadioMode = "simulated" | "external";

export interface Transmission {
  id: string;
  /** "TOWER" or an aircraft id. */
  from: string;
  to: string;
  kind: TransmissionKind;
  text: string;
  spoken: string;
  clearanceId?: string;
  requestId?: string;
  priority: number;
  mode: RadioMode;
  /** The frequency it is said on; "all" when everyone shares one. */
  channel: string;
  status: "queued" | "active" | "completed" | "failed";
  queuedAt: number;
  startedAt?: number;
  /** Simulated mode: when it will finish. External mode: failure deadline. */
  endsAt?: number;
  completedAt?: number;
  error?: string;
}

// ------------------------------------------------------------------ runways

export type ReservationKind = "landing" | "takeoff" | "lineup" | "crossing";

export interface RunwayReservation {
  aircraftId: string;
  kind: ReservationKind;
  clearanceId: string;
  since: number;
}

export interface RunwayState {
  id: string;
  occupants: string[];
  reservation?: RunwayReservation;
  lastDepartureRollAt?: number;
  lastDepartureId?: string;
}

// ------------------------------------------------------- emergencies/conflicts

export type EmergencyMode = "off" | "manual" | "random";
export type EmergencyType = "engine_failure" | "runway_incursion" | "go_around" | "taxiway_blocked";

export const EMERGENCY_TYPES: readonly EmergencyType[] = [
  "engine_failure",
  "runway_incursion",
  "go_around",
  "taxiway_blocked",
];

export interface Emergency {
  id: string;
  type: EmergencyType;
  aircraftId?: string;
  edgeId?: string;
  runwayId?: string;
  description: string;
  startedAt: number;
  resolvedAt?: number;
  source: "operator" | "random";
}

export interface Conflict {
  key: string;
  type:
    | "runway_incursion"
    | "arrival_runway_occupied"
    | "taxi_blocked"
    | "airborne_separation"
    | "closed_edge_on_route";
  severity: "advisory" | "warning" | "critical";
  aircraftIds: string[];
  runwayId?: string;
  description: string;
  detectedAt: number;
}

// ------------------------------------------------------------------- events

export type Cause =
  | { kind: "clearance"; clearanceId: string }
  | { kind: "request"; requestId: string }
  | { kind: "auto"; rule: string }
  | { kind: "pilot"; reason: string }
  | { kind: "operator"; action: string }
  | { kind: "emergency"; emergencyId: string }
  | { kind: "scenario" };

export interface SimEvent {
  /** Strictly increasing; with `tick` it lets a run be replayed in order. */
  seq: number;
  tick: number;
  simTime: number;
  type: string;
  aircraftId?: string;
  /** True when the controller should re-evaluate the situation. */
  attention?: boolean;
  /** What made this happen. Present on every aircraft state change. */
  cause?: Cause;
  data: Record<string, unknown>;
}

/** A proposed action and its gateway verdict. Observation sequence numbers address the same run's event log. */
export interface DecisionEvent extends SimEvent {
  type: "controller.decision";
  data: {
    turnId: string;
    caller: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    observationSeqs: number[];
    result: import("./tools/gateway").ToolResult;
  };
}

// ----------------------------------------------------------------- commands

export interface SpawnSpec {
  callsign: string;
  type?: string;
  pilotType?: PilotType;
  priority?: Priority;
  flight: "departure" | "arrival";
  /** Runway end designator. */
  runway?: string;
  gate?: string;
  start:
    | { kind: "gate" }
    /** `cleared`: the takeoff or landing clearance was given before the scenario began. */
    | { kind: "holding_short"; cleared?: boolean }
    | { kind: "taxiing"; from: string }
    | { kind: "approach"; distanceNm: number; cleared?: boolean };
  /** Departures at a gate: seconds until the crew calls for pushback. */
  readyInSec?: number;
}

/**
 * Every outside influence on the simulation is one of these. They are
 * logged with the tick they arrived on, which is what makes a run
 * replayable without the LLM.
 */
export type Command =
  | {
      type: "clearance.issue";
      aircraftId: string;
      clearanceType: ClearanceType;
      runway?: string;
      gate?: string;
      route?: string[];
      reason: string;
      requestId?: string;
      issuedBy?: string;
    }
  | { type: "clearance.cancel"; clearanceId: string; reason: string }
  | { type: "priority.set"; aircraftId: string; priority: Priority; reason: string }
  | {
      type: "pilot.request";
      aircraftId: string;
      requestType: RequestType;
      runway?: string;
      text?: string;
      /** The words were already said on the air (live microphone). */
      spoken?: boolean;
    }
  | { type: "pilot.readback"; aircraftId: string; clearanceId?: string; text?: string; spoken?: boolean }
  | { type: "pilot.claim"; aircraftId: string; by: "human" | "ai" }
  | { type: "pilot.release"; aircraftId: string }
  | { type: "radio.tx_complete"; transmissionId: string }
  | { type: "radio.tx_failed"; transmissionId: string; error?: string }
  | { type: "radio.transmit"; from: string; to?: string; text: string; spoken?: boolean }
  | { type: "emergency.set_mode"; mode: EmergencyMode }
  | { type: "emergency.trigger"; emergencyType: EmergencyType; aircraftId?: string; edgeId?: string }
  | { type: "emergency.resolve"; emergencyId: string }
  | { type: "aircraft.spawn"; spec: SpawnSpec }
  | { type: "aircraft.remove"; aircraftId: string }
  | {
      type: "runways.set_active";
      arrivals: string[];
      departures: string[];
      /** Runways shut to takeoffs and landings. Left out: stays as it is, minus any made active. */
      closed?: string[];
      reason?: string;
    }
  | { type: "control.takeover"; aircraftId: string }
  | { type: "control.handback"; aircraftId: string }
  | {
      /** Something said on frequency that carries no clearance. */
      type: "advisory.issue";
      kind: AdvisoryKind;
      text: string;
      spoken?: string;
      /** The flight it concerns. Left out: everyone on frequency. */
      aircraftId?: string;
      by?: "tower" | "pilot" | "operator";
      /** The transmission this answers. */
      replyTo?: string;
      reason?: string;
    };

export type CommandResult =
  | ({ ok: true } & Record<string, unknown>)
  | {
      ok: false;
      code: string;
      message: string;
      /** The caller should ask a question instead of treating this as final. */
      needsClarification?: boolean;
      details?: Record<string, unknown>;
    };

export interface CommandRecord {
  tick: number;
  simTime: number;
  command: Command;
  ok: boolean;
}

// ------------------------------------------------------------------- config

export interface Rules {
  /** No takeoff clearance if an arrival reaches the threshold sooner than this. */
  takeoffArrivalBufferSec: number;
  lineUpArrivalBufferSec: number;
  crossArrivalBufferSec: number;
  /** Wider protection in front of an arrival that has declared an emergency. */
  emergencyArrivalBufferSec: number;
  /** The same for an urgent arrival, for example a medical one. */
  urgentArrivalBufferSec: number;
  departureSeparationSec: number;
  /** Arrivals without a landing clearance (or with a blocked runway) go around here. */
  decisionDistanceNm: number;
  clearanceNeededNm: number;
  holdMinDistanceNm: number;
  readbackTimeoutSec: number;
  untransmittedTimeoutSec: number;
  requestReminderSec: number;
  maxReminders: number;
  handoffDistanceNm: number;
  randomEmergencyMeanIntervalSec: number;
  taxiwayBlockDurationSec: number;
}

export interface SimConfig {
  seed: number;
  /** Fixed simulation step in seconds. */
  dt: number;
  rules: Rules;
  radio: { controller: RadioMode; pilots: RadioMode };
  /**
   * One voice at a time per control position instead of one for the whole
   * airport. Ignored with external radio, where one speaker plays everything.
   */
  separateFrequencies: boolean;
  /** Crews still call each position by name, but one speaker monitors them all, one voice at a time. */
  oneSpeaker: boolean;
  /** How long a recorded line really runs. Must be pure, so that a replay times it the same. */
  clipSec?: (from: string, text: string, spoken: string) => number | undefined;
  emergencyMode: EmergencyMode;
  /** Rethrow internal errors instead of turning them into failed commands. */
  strict: boolean;
}

export const DEFAULT_RULES: Rules = {
  takeoffArrivalBufferSec: 120,
  lineUpArrivalBufferSec: 90,
  crossArrivalBufferSec: 60,
  emergencyArrivalBufferSec: 240,
  urgentArrivalBufferSec: 180,
  departureSeparationSec: 60,
  decisionDistanceNm: 1.0,
  clearanceNeededNm: 4,
  holdMinDistanceNm: 6,
  readbackTimeoutSec: 25,
  untransmittedTimeoutSec: 60,
  requestReminderSec: 75,
  maxReminders: 3,
  handoffDistanceNm: 9,
  randomEmergencyMeanIntervalSec: 300,
  taxiwayBlockDurationSec: 300,
};

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  dt: 0.1,
  rules: DEFAULT_RULES,
  radio: { controller: "simulated", pilots: "simulated" },
  separateFrequencies: false,
  oneSpeaker: false,
  emergencyMode: "off",
  strict: false,
};
