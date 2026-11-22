import type { AirportGraph } from "../airport/graph";
import { Rng } from "../rng";
import type {
  Aircraft,
  Cause,
  Clearance,
  Command,
  CommandRecord,
  CommandResult,
  Conflict,
  Emergency,
  EmergencyMode,
  FlightPhase,
  PilotRequest,
  RunwayState,
  SimConfig,
  SimEvent,
  Transmission,
} from "../types";
import { DEFAULT_CONFIG, DEFAULT_RULES } from "../types";
import { stepAir } from "./air";
import { cancelClearance, isOpenClearance, issueClearance, reconcileRunwayClearances, stepClearanceTimeouts } from "./clearances";
import { checkCommand } from "./commandSchema";
import { issueAdvisory, setHumanControl } from "./control";
import { offerRunwayChanges, reassignRunways } from "./reassign";
import { detectConflicts } from "./conflicts";
import { resolveEmergency, stepEmergencies, triggerEmergency } from "./emergencies";
import { buildTraffic, stepGround, type Traffic } from "./ground";
import { claimPilot, externalReadback, externalRequest, releasePilot, stepPilots } from "./pilots";
import { completeTransmission, enqueueTransmission, failTransmission, stepRadio, type RadioState } from "./radio";
import { releaseAllReservations, updateOccupancy } from "./runways";
import { removeAircraft, spawnAircraft } from "./spawn";

/** Legal phase changes. Anything else is a bug and throws. */
export const PHASE_TRANSITIONS: Record<FlightPhase, readonly FlightPhase[]> = {
  at_gate: ["pushback"],
  pushback: ["taxi_out"],
  taxi_out: ["holding_short", "line_up"],
  holding_short: ["taxi_out", "taxi_in", "line_up"],
  line_up: ["takeoff"],
  takeoff: ["departure"],
  departure: ["go_around"],
  approach: ["landing", "go_around", "holding"],
  holding: ["approach", "go_around"],
  go_around: ["approach"],
  landing: ["rollout", "go_around"],
  rollout: ["taxi_in"],
  taxi_in: ["holding_short", "at_gate"],
};

export interface Timer {
  at: number;
  action:
    | { kind: "readback"; clearanceId: string }
    | { kind: "resolve_emergency"; emergencyId: string };
}

export interface SimSnapshot {
  tick: number;
  time: number;
  activeRunways: { arrivals: string[]; departures: string[] };
  closedRunways: string[];
  emergencyMode: EmergencyMode;
  aircraft: Aircraft[];
  runways: RunwayState[];
  requests: PilotRequest[];
  clearances: Clearance[];
  radio: { active: Transmission | null; onAir: Transmission[]; queue: Transmission[] };
  emergencies: Emergency[];
  conflicts: Conflict[];
  closedEdges: string[];
  stats: Simulation["stats"];
}

type EmitFields = {
  aircraftId?: string;
  attention?: boolean;
  cause?: Cause;
  data?: Record<string, unknown>;
};

/**
 * The authoritative world. It advances in fixed steps, accepts outside
 * influence only through `dispatch(command)`, and reports everything that
 * happens as a numbered event. Nothing in here knows about HTTP, voice or
 * an LLM.
 */
export class Simulation {
  readonly config: SimConfig;
  readonly rng: Rng;

  tick = 0;
  time = 0;

  readonly aircraft = new Map<string, Aircraft>();
  readonly clearances = new Map<string, Clearance>();
  readonly requests = new Map<string, PilotRequest>();
  readonly transmissions = new Map<string, Transmission>();
  readonly runwayState = new Map<string, RunwayState>();
  readonly emergencies = new Map<string, Emergency>();
  readonly conflicts = new Map<string, Conflict>();
  readonly closedEdges = new Set<string>();
  /** Graph node -> aircraft that currently owns it (junction right-of-way). */
  readonly nodeClaims = new Map<string, string>();

  activeRunways: { arrivals: string[]; departures: string[] } = { arrivals: [], departures: [] };
  /** Physical runway ids shut to takeoffs and landings. */
  closedRunways: string[] = [];
  emergencyMode: EmergencyMode;
  radio: RadioState = { queue: [], active: null, onAir: [], freeAt: new Map() };
  timers: Timer[] = [];
  traffic: Traffic = { directed: new Map() };

  readonly events: SimEvent[] = [];
  readonly commands: CommandRecord[] = [];
  readonly stats = { departed: 0, arrived: 0, goArounds: 0, clearancesIssued: 0, clearancesRejected: 0 };

  private readonly listeners = new Set<(e: SimEvent) => void>();
  private outbox: SimEvent[] = [];
  private depth = 0;
  private flushing = false;
  private seq = 0;
  private readonly counters: Record<string, number> = {};

  constructor(
    readonly graph: AirportGraph,
    config: Partial<SimConfig> = {},
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      rules: { ...DEFAULT_RULES, ...config.rules },
      radio: { ...DEFAULT_CONFIG.radio, ...config.radio },
    };
    this.rng = new Rng(this.config.seed);
    this.emergencyMode = this.config.emergencyMode;
    for (const r of graph.runways.values()) this.runwayState.set(r.id, { id: r.id, occupants: [] });
  }

  // ------------------------------------------------------------------ events

  on(listener: (e: SimEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: string, fields: EmitFields = {}): SimEvent {
    const event: SimEvent = {
      seq: ++this.seq,
      tick: this.tick,
      simTime: this.time,
      type,
      ...(fields.aircraftId ? { aircraftId: fields.aircraftId } : {}),
      ...(fields.attention ? { attention: true } : {}),
      ...(fields.cause ? { cause: fields.cause } : {}),
      data: fields.data ?? {},
    };
    this.events.push(event);
    this.outbox.push(event);
    return event;
  }

  /**
   * Listeners only ever run between steps, never in the middle of one. A
   * listener that dispatches a command therefore always acts on a
   * consistent world, and the command lands on a well-defined tick.
   */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0) {
        const batch = this.outbox;
        this.outbox = [];
        for (const e of batch) for (const l of this.listeners) l(e);
      }
    } finally {
      this.flushing = false;
    }
  }

  nextId(prefix: string): string {
    this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
    return `${prefix}-${String(this.counters[prefix]).padStart(4, "0")}`;
  }

  // ---------------------------------------------------------------- aircraft

  get(id: string): Aircraft | undefined {
    return this.aircraft.get(id);
  }

  setPhase(ac: Aircraft, phase: FlightPhase, cause: Cause, data: Record<string, unknown> = {}): void {
    if (ac.phase === phase) return;
    if (!PHASE_TRANSITIONS[ac.phase].includes(phase)) {
      throw new Error(`illegal phase change ${ac.phase} -> ${phase} for ${ac.id}`);
    }
    const from = ac.phase;
    ac.phase = phase;
    ac.phaseSince = this.time;
    this.emit("aircraft.phase_changed", { aircraftId: ac.id, cause, data: { from, to: phase, ...data } });
  }

  // ---------------------------------------------------------------- commands

  dispatch(command: Command): CommandResult {
    this.depth++;
    let result: CommandResult;
    try {
      result = this.apply(command);
    } catch (err) {
      if (this.config.strict) {
        this.depth--;
        throw err;
      }
      result = { ok: false, code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) };
    }
    this.commands.push({ tick: this.tick, simTime: this.time, command, ok: result.ok });
    this.depth--;
    if (this.depth === 0) this.flush();
    return result;
  }

  private apply(cmd: Command): CommandResult {
    const invalid = checkCommand(cmd);
    if (invalid) return invalid;
    switch (cmd.type) {
      case "clearance.issue":
        return issueClearance(this, cmd);
      case "clearance.cancel":
        return cancelClearance(this, cmd.clearanceId, cmd.reason);
      case "priority.set": {
        const ac = this.get(cmd.aircraftId);
        if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${cmd.aircraftId}` };
        const from = ac.priority;
        ac.priority = cmd.priority;
        for (const r of this.requests.values()) if (r.aircraftId === ac.id) r.priority = cmd.priority;
        this.emit("aircraft.priority_changed", {
          aircraftId: ac.id,
          attention: cmd.priority !== "normal",
          cause: { kind: "operator", action: "priority.set" },
          data: { from, to: cmd.priority, reason: cmd.reason },
        });
        return { ok: true, aircraftId: ac.id, priority: ac.priority };
      }
      case "pilot.request":
        return externalRequest(this, cmd);
      case "pilot.readback":
        return externalReadback(this, cmd);
      case "pilot.claim":
        return claimPilot(this, cmd.aircraftId, cmd.by);
      case "pilot.release":
        return releasePilot(this, cmd.aircraftId);
      case "radio.tx_complete": {
        const tx = this.transmissions.get(cmd.transmissionId);
        if (!tx || tx.status !== "active") {
          return { ok: false, code: "NOT_ACTIVE", message: `Transmission ${cmd.transmissionId} is not on the air` };
        }
        completeTransmission(this, tx);
        return { ok: true };
      }
      case "radio.tx_failed": {
        const tx = this.transmissions.get(cmd.transmissionId);
        if (!tx || (tx.status !== "active" && tx.status !== "queued")) {
          return { ok: false, code: "NOT_ACTIVE", message: `Transmission ${cmd.transmissionId} is not pending` };
        }
        failTransmission(this, tx, cmd.error ?? "voice output failed");
        return { ok: true };
      }
      case "radio.transmit": {
        const tx = enqueueTransmission(this, {
          from: cmd.from,
          to: cmd.to ?? "ALL",
          kind: "info",
          text: cmd.text,
          spoken: cmd.text,
          priority: cmd.from === "TOWER" ? 50 : 10,
          alreadySpoken: cmd.spoken,
        });
        return { ok: true, transmissionId: tx.id };
      }
      case "emergency.set_mode":
        this.emergencyMode = cmd.mode;
        this.emit("emergency.mode_changed", {
          cause: { kind: "operator", action: "emergency.set_mode" },
          data: { mode: cmd.mode },
        });
        return { ok: true, mode: cmd.mode };
      case "emergency.trigger":
        if (this.emergencyMode === "off") {
          return { ok: false, code: "EMERGENCIES_OFF", message: "Emergency mode is off; switch to manual or random first" };
        }
        return triggerEmergency(this, cmd.emergencyType, { aircraftId: cmd.aircraftId, edgeId: cmd.edgeId }, "operator");
      case "emergency.resolve":
        return resolveEmergency(this, cmd.emergencyId, "operator");
      case "aircraft.spawn":
        return spawnAircraft(this, cmd.spec, { kind: "operator", action: "aircraft.spawn" });
      case "aircraft.remove": {
        const ac = this.get(cmd.aircraftId);
        if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${cmd.aircraftId}` };
        removeAircraft(this, ac, "aircraft.removed", { kind: "operator", action: "aircraft.remove" });
        return { ok: true };
      }
      case "control.takeover":
        return setHumanControl(this, cmd.aircraftId, true);
      case "control.handback":
        return setHumanControl(this, cmd.aircraftId, false);
      case "advisory.issue":
        return issueAdvisory(this, cmd);
      case "runways.set_active": {
        const all = [...cmd.arrivals, ...cmd.departures];
        const bad = all.find((d) => !this.graph.runwayEnd(d));
        if (bad) return { ok: false, code: "UNKNOWN_RUNWAY", message: `Unknown runway ${bad}` };
        const norm = (d: string) => this.graph.runwayEnd(d)!.end.designator;
        // One direction per physical runway at a time.
        const dirs = new Map<string, string>();
        for (const d of all.map(norm)) {
          const rw = this.graph.runwayEnd(d)!.runway.id;
          if (dirs.has(rw) && dirs.get(rw) !== d) {
            return { ok: false, code: "OPPOSITE_DIRECTION", message: `Runway ${rw} cannot be used in both directions` };
          }
          dirs.set(rw, d);
        }
        const next = { arrivals: cmd.arrivals.map(norm), departures: cmd.departures.map(norm) };
        const active = new Set([...dirs.keys()]);
        const closed: string[] = [];
        for (const id of cmd.closed ?? this.closedRunways) {
          const runway = this.graph.physicalRunway(id)?.id;
          if (!runway) return { ok: false, code: "UNKNOWN_RUNWAY", message: `Unknown runway ${id}` };
          if (!active.has(runway)) closed.push(runway);
          else if (cmd.closed) return { ok: false, code: "RUNWAY_CLOSED", message: `Runway ${runway} cannot be both closed and in use` };
        }
        const closing = closed.filter((id) => !this.closedRunways.includes(id));
        const result = reconcileRunwayClearances(this, next, closing);
        if (!result.ok) return result;
        this.activeRunways = next;
        this.closedRunways = closed;
        this.emit("runways.configuration_changed", {
          attention: true,
          cause: { kind: "operator", action: "runways.set_active" },
          data: { ...this.activeRunways, closed, closing, reason: cmd.reason },
        });
        reassignRunways(this);
        return { ok: true, ...this.activeRunways, closed };
      }
    }
  }

  /** Record something that happened outside the world (e.g. a read-only tool call). */
  annotate(type: string, data: Record<string, unknown>, aircraftId?: string): SimEvent {
    const e = this.emit(type, { aircraftId, data });
    if (this.depth === 0) this.flush();
    return e;
  }

  // -------------------------------------------------------------------- step

  step(): void {
    this.depth++;
    try {
      this.tick++;
      this.time = Math.round(this.tick * this.config.dt * 1000) / 1000;

      stepRadio(this);
      this.runTimers();
      stepPilots(this);

      this.traffic = buildTraffic(this);
      for (const ac of [...this.aircraft.values()]) {
        if (!this.aircraft.has(ac.id)) continue;
        if (ac.altitudeFt > 0 || ac.phase === "takeoff" || ac.airRoute.length > 0) stepAir(this, ac);
        else stepGround(this, ac);
      }

      updateOccupancy(this);
      stepClearanceTimeouts(this);

      const ticksPerSecond = Math.round(1 / this.config.dt);
      if (this.tick % ticksPerSecond === 0) {
        detectConflicts(this);
        stepEmergencies(this);
        offerRunwayChanges(this);
      }
    } finally {
      this.depth--;
    }
    if (this.depth === 0) this.flush();
  }

  /** Advance by a number of simulated seconds. */
  run(seconds: number): void {
    const steps = Math.round(seconds / this.config.dt);
    for (let i = 0; i < steps; i++) this.step();
  }

  private runTimers(): void {
    if (this.timers.length === 0) return;
    const due = this.timers.filter((t) => t.at <= this.time);
    if (due.length === 0) return;
    this.timers = this.timers.filter((t) => t.at > this.time);
    for (const t of due) {
      if (t.action.kind === "readback") {
        // handled by the pilot system, which owns readbacks
        this.pendingReadbacks.push(t.action.clearanceId);
      } else {
        resolveEmergency(this, t.action.emergencyId, "auto");
      }
    }
  }

  /** Clearances whose scripted readback is due this tick. */
  pendingReadbacks: string[] = [];

  /** Drop everything an aircraft holds when it leaves the world. */
  forget(ac: Aircraft): void {
    releaseAllReservations(this, ac.id);
    for (const [node, owner] of this.nodeClaims) if (owner === ac.id) this.nodeClaims.delete(node);
    this.aircraft.delete(ac.id);
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(): SimSnapshot {
    return structuredClone({
      tick: this.tick,
      time: this.time,
      activeRunways: this.activeRunways,
      emergencyMode: this.emergencyMode,
      aircraft: [...this.aircraft.values()],
      runways: [...this.runwayState.values()],
      requests: [...this.requests.values()].filter((r) => r.status === "transmitting" || r.status === "pending"),
      clearances: [...this.clearances.values()].filter(isOpenClearance),
      radio: { active: this.radio.active, onAir: this.radio.onAir, queue: this.radio.queue },
      emergencies: [...this.emergencies.values()].filter((e) => e.resolvedAt === undefined),
      conflicts: [...this.conflicts.values()],
      closedRunways: this.closedRunways,
      closedEdges: [...this.closedEdges],
      stats: this.stats,
    });
  }

  /** Compact fingerprint of the world, used to prove a replay matches. */
  stateHash(): string {
    const r = (n: number) => Math.round(n * 100) / 100;
    return JSON.stringify({
      tick: this.tick,
      aircraft: [...this.aircraft.values()].map((a) => [
        a.id,
        a.phase,
        r(a.position.x),
        r(a.position.y),
        r(a.altitudeFt),
        r(a.speedKts),
        r(a.headingDeg),
      ]),
      clearances: [...this.clearances.values()].map((c) => [c.id, c.type, c.aircraftId, c.status]),
      runways: [...this.runwayState.values()].map((s) => [s.id, s.occupants, s.reservation?.aircraftId ?? null]),
      stats: this.stats,
    });
  }
}
