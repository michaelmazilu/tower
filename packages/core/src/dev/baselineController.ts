import { NM } from "../geometry";
import { distanceToThreshold, emergencyInbound, inboundArrivals, runwayOccupiedBy, touchdownIn } from "../sim/runways";
import { DecisionTurn } from "../tools/decisionTurn";
import type { Simulation } from "../sim/simulation";
import type { ToolGateway } from "../tools/gateway";
import type { ClearanceType, SimEvent } from "../types";

/**
 * NOT the AI controller. A small rule-based stand-in that works the tower
 * through exactly the same tool gateway the ElevenLabs agent will use, so
 * the simulation, the tools and the radio loop can be exercised end to
 * end before any agent exists. It answers requests first come first
 * served and never plans ahead.
 */

interface PendingRequestView {
  requestId: string;
  aircraftId: string;
  type: "PUSHBACK" | "TAXI" | "TAKEOFF" | "LANDING" | "CROSS" | "OTHER";
  runway: string | null;
  deferred: boolean;
}

const GRANT: Record<string, ClearanceType | undefined> = {
  PUSHBACK: "PUSHBACK",
  TAXI: "TAXI",
  TAKEOFF: "CLEARED_TAKEOFF",
  LANDING: "CLEARED_TO_LAND",
  CROSS: "CROSS_RUNWAY",
};

const WAIT_CODES = new Set(["EMERGENCY_PRIORITY", "RUNWAY_OCCUPIED", "RUNWAY_RESERVED", "ARRIVAL_TOO_CLOSE", "DEPARTURE_SEPARATION", "CROSSING_RUNWAY_IN_USE", "NOT_NUMBER_ONE"]);

/** A landing clearance reserves the runway; given further out it would starve departures and crossings. */
const LAND_WITHIN_NM = 5;
const URGENT_LAND_WITHIN_NM = 8;
/** An intruder on the runway: everyone this close to it breaks off. */
const INCURSION_PROTECT_SEC = 100;
/** A routine arrival this near an emergency's runway at the same time makes way. */
const EMERGENCY_GAP_SEC = 70;

const SLOW_RETRY_CODES = new Set(["TAXI_ROUTE_CONFLICT", "APRON_BLOCKED"]);

export class BaselineController {
  private dirty = true;
  private lastEval = -Infinity;
  private readonly lastTry = new Map<string, number>();
  private readonly toldToHold = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly maydayHeard = new Set<string>();
  /** Requests turned down because a runway was busy, and when. */
  private readonly waiting = new Map<string, number>();
  private runwayChangedAt = -Infinity;
  private unsubscribe?: () => void;

  constructor(
    private readonly sim: Simulation,
    private readonly gateway: ToolGateway,
  ) {}

  attach(): this {
    this.unsubscribe = this.sim.on((e: SimEvent) => {
      if (e.attention) this.dirty = true;
      if (e.type === "radio.tx_completed" && e.data.kind === "emergency" && e.aircraftId) {
        this.maydayHeard.add(e.aircraftId);
        this.dirty = true;
      }
      if (e.type === "go_around.initiated" || e.type === "emergency.runway_incursion") this.dirty = true;
      if (e.type === "runway.released" || e.type === "runway.vacated") this.runwayChangedAt = e.simTime;
    });
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
  }

  /** Call after each simulation step. */
  update(): void {
    const t = this.sim.time;
    if (t - this.lastEval < 0.5) return;
    if (!this.dirty && t - this.lastEval < 6) return;
    this.dirty = false;
    this.lastEval = t;
    this.evaluate();
  }

  private issue(turn: DecisionTurn, aircraftId: string, clearanceType: ClearanceType, reason: string, extra: Record<string, unknown> = {}) {
    const res = turn.call(
      "issue_clearance",
      { aircraftId, clearanceType, reason, ...extra },
    );
    type Verdict = { status: string; code?: string; message?: string; details?: { freeGates?: string[] } };
    return res.ok ? (res.result as Verdict) : ({ status: "error", code: res.error.code, message: res.error.message } as Verdict);
  }

  private evaluate(): void {
    const t = this.sim.time;

    const turn = new DecisionTurn(this.sim, this.gateway, "baseline-controller");

    // Safety first: send an arrival around if its runway is not its own.
    const conflicts = turn.call("get_conflicts");
    this.protectRunways(turn);
    this.serveEmergencies(turn);
    if (conflicts.ok) {
      for (const c of conflicts.result.conflicts as { type: string; severity: string; aircraft: string[]; description: string }[]) {
        if (c.type !== "arrival_runway_occupied" || c.severity !== "critical") continue;
        const target = this.sim.get(c.aircraft[0]);
        if (!target || target.humanControl || (target.phase !== "approach" && target.phase !== "landing")) continue;
        // An emergency keeps coming while the runway may still clear; its crew goes around at the decision point if not.
        if (target.priority === "emergency") continue;
        if (target.clearance?.type !== "GO_AROUND" || target.clearance.status !== "pending") {
          this.issue(turn, c.aircraft[0], "GO_AROUND", `Runway not clear: ${c.description}`);
        }
      }
    }

    const pending = turn.call("get_pending_requests");
    if (!pending.ok) return;
    for (const r of pending.result.requests as PendingRequestView[]) {
      const grant = GRANT[r.type];
      if (!grant) continue;
      const last = this.lastTry.get(r.requestId);
      if (last !== undefined && t - last < 4) continue;
      // Turned down for a busy runway: wait until a runway frees up (or a while passes).
      const since = this.waiting.get(r.requestId);
      if (since !== undefined && this.runwayChangedAt <= since && t - since < 20) continue;
      this.lastTry.set(r.requestId, t);

      const ac = this.sim.get(r.aircraftId);
      if (r.type === "LANDING" && ac?.phase === "approach" && ac.priority !== "emergency") {
        const out = distanceToThreshold(this.sim, ac) / NM;
        if (out > (ac.priority === "urgent" ? URGENT_LAND_WITHIN_NM : LAND_WITHIN_NM)) {
          if (!r.deferred) {
            const why = `${out.toFixed(0)} NM out: sequenced, leaving the runway to departures and crossings until ${LAND_WITHIN_NM} NM.`;
            const res = this.issue(turn, r.aircraftId, "CONTINUE_APPROACH", why, { requestId: r.requestId });
            if (res.status === "accepted") this.lastTry.set(r.requestId, t + 10);
          }
          continue;
        }
      }

      const res = this.issue(turn, r.aircraftId, grant, reasonFor(r), {
        requestId: r.requestId,
        ...(r.runway && r.type !== "PUSHBACK" ? { runway: r.runway } : {}),
      });
      if (res.status === "accepted") {
        this.waiting.delete(r.requestId);
        // Give the readback time to arrive before looking at this request again.
        this.lastTry.set(r.requestId, t + 30);
        continue;
      }
      if (WAIT_CODES.has(res.code ?? "")) this.waiting.set(r.requestId, t);
      // Waiting for other traffic to taxi past: asking again every few seconds achieves nothing.
      if (SLOW_RETRY_CODES.has(res.code ?? "")) this.lastTry.set(r.requestId, t + 8);

      // The planned gate was taken in the meantime: send the aircraft to a free one.
      const spare = res.details?.freeGates?.[0];
      if (res.code === "GATE_OCCUPIED" && spare) {
        this.issue(turn, r.aircraftId, "TAXI", `Planned gate is occupied; ${spare} is free.`, { requestId: r.requestId, gate: spare });
        continue;
      }

      // Not possible yet: tell the aircraft to hold, once, and say why.
      const canHold = r.type === "TAKEOFF" || r.type === "CROSS";
      if (canHold && WAIT_CODES.has(res.code ?? "") && !r.deferred && !this.toldToHold.has(r.requestId)) {
        this.toldToHold.add(r.requestId);
        this.issue(turn, r.aircraftId, "HOLD_SHORT", res.message ?? "Runway not available.", {
          requestId: r.requestId,
          ...(r.runway ? { runway: r.runway } : {}),
        });
      }
    }
  }

  private pendingFor(id: string, type: ClearanceType): boolean {
    return [...this.sim.clearances.values()].some((c) => c.aircraftId === id && c.type === type && (c.status === "issued" || c.status === "transmitted"));
  }

  /** An intruder on a runway: whoever is landing on it breaks off, and the intruder stops. */
  private protectRunways(turn: DecisionTurn): void {
    const { sim } = this;
    for (const ac of [...sim.aircraft.values()]) {
      if (!ac.flags.incursionActive && !ac.flags.incursionHold) continue;
      const runway = runwayOccupiedBy(sim, ac);
      if (!runway) continue;
      for (const arrival of inboundArrivals(sim, runway)) {
        const target = arrival.aircraft;
        if (target.id === ac.id || target.humanControl || arrival.etaSec > INCURSION_PROTECT_SEC || this.pendingFor(target.id, "GO_AROUND")) continue;
        this.issue(turn, target.id, "GO_AROUND", `${ac.callsign} is on runway ${runway} without a clearance, ${arrival.distanceNm.toFixed(1)} NM ahead: break off now.`);
      }
      const key = `${ac.id}:${ac.emergencyId}`;
      if (ac.humanControl || this.stopped.has(key)) continue;
      const stop = this.issue(turn, ac.id, "HOLD_POSITION", `On runway ${runway} without a clearance: stop, then it can be cleared or moved off.`);
      if (stop.status === "accepted") this.stopped.add(key);
    }
  }

  private serveEmergencies(turn: DecisionTurn): void {
    const { sim } = this;
    for (const ac of [...sim.aircraft.values()]) {
      if (ac.humanControl) continue;
      if (ac.flags.emergencyReturn && !ac.flags.priorityReturn && ac.phase === "go_around") {
        if (this.maydayHeard.has(ac.id) && !this.pendingFor(ac.id, "RETURN_TO_LAND")) {
          this.issue(turn, ac.id, "RETURN_TO_LAND", `Mayday: priority over all traffic, shortest pattern back to runway ${ac.assignedRunway}.`);
        }
      } else if (ac.phase === "go_around" && !ac.flags.vectored && !ac.emergencyId && !ac.flags.runwayUnavailable && ac.airIndex === 0) {
        const busy = [...sim.clearances.values()].some((c) => c.aircraftId === ac.id && (c.status === "issued" || c.status === "transmitted"));
        if (!busy) this.issue(turn, ac.id, "VECTOR", "Missed approach: a heading away from the parallel final and an altitude above both intercepts.");
      } else if (ac.phase === "approach" && ac.priority !== "emergency") {
        const runway = sim.graph.runwayEnd(ac.assignedRunway)?.runway.id;
        const first = runway ? emergencyInbound(sim, runway, ac.id) : undefined;
        if (!first || this.pendingFor(ac.id, "GO_AROUND") || distanceToThreshold(sim, ac) > LAND_WITHIN_NM * NM) continue;
        if (Math.abs(touchdownIn(sim, ac) - touchdownIn(sim, first)) < EMERGENCY_GAP_SEC) {
          this.issue(turn, ac.id, "GO_AROUND", `${first.callsign} has an emergency and is number one for runway ${ac.assignedRunway}.`);
        }
      }
    }
  }
}

function reasonFor(r: PendingRequestView): string {
  switch (r.type) {
    case "PUSHBACK":
      return "Apron behind the gate is clear.";
    case "TAXI":
      return "Route available; answering requests in the order received.";
    case "TAKEOFF":
      return `Runway ${r.runway} is clear and no arrival is close enough to conflict.`;
    case "LANDING":
      return `Runway ${r.runway} is clear and this aircraft is next to land.`;
    case "CROSS":
      return `Runway ${r.runway} is clear with no arrival or departure about to use it.`;
    default:
      return "Request answered.";
  }
}
