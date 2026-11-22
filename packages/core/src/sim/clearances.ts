import type { RunwayEndRef } from "../airport/graph";
import { angleDiff, bearing, dist, NM, projectOnSegment } from "../geometry";
import { clearancePhrase, matchReadback, readbackPhrase } from "../radio/phraseology";
import type {
  Aircraft,
  Clearance,
  ClearanceStatus,
  ClearanceType,
  Command,
  CommandResult,
  ReservationKind,
  RequestType,
  Vector,
} from "../types";
import { CLEARANCE_TYPES } from "../types";
import { MISSED_APPROACH_FT, goAround, priorityRoute } from "./air";
import { resolveEmergenciesFor } from "./emergencies";
import { distanceAlongRoute, routeOrigin, setRoute } from "./ground";
import { enqueueTransmission, failTransmission } from "./radio";
import { moveToRunway, replacementRunway } from "./reassign";
import {
  distanceToThreshold,
  emergencyInbound,
  inboundArrivals,
  occupiedByOthers,
  release,
  reserve,
  reservedByOther,
  runwayOccupiedBy,
  touchdownIn,
} from "./runways";
import type { Simulation } from "./simulation";
import { gateInUse } from "./spawn";

/**
 * The rulebook. The controller (human or LLM) proposes a clearance; this
 * module decides whether the modelled constraints allow it. Accepted
 * clearances then move through issued -> transmitted -> acknowledged, and
 * only change the aircraft's behaviour once the pilot has read them back
 * (or, for stop-now instructions, once they have been transmitted).
 */

type IssueCommand = Extract<Command, { type: "clearance.issue" }>;
type ClosedClearanceStatus = Extract<ClearanceStatus, "completed" | "expired" | "cancelled" | "superseded">;

const RUNWAY_AUTH_CLEARANCE = {
  cross: "CROSS_RUNWAY",
  lineup: "LINE_UP_AND_WAIT",
  takeoff: "CLEARED_TAKEOFF",
} as const;

/** Instructions a crew obeys the moment they hear them. */
const ACT_ON_TRANSMIT: ReadonlySet<ClearanceType> = new Set<ClearanceType>(["GO_AROUND", "HOLD_POSITION", "HOLD_SHORT"]);
/** Instructions that may interrupt an unacknowledged clearance. */
const OVERRIDES_PENDING: ReadonlySet<ClearanceType> = new Set<ClearanceType>(["GO_AROUND", "HOLD_POSITION", "HOLD_SHORT", "RUNWAY_CHANGE", "RETURN_TO_LAND"]);
/** Routine traffic lands ahead of an emergency only with this much in hand. */
const EMERGENCY_CLEAR_SEC = 100;
const RETURN_FT = 2000;

/** How soon each instruction gets on the air. */
function priorityOf(ac: Aircraft, clr: Clearance, sim: Simulation): number {
  if (clr.type === "GO_AROUND" || clr.type === "HOLD_POSITION") return 98;
  if (clr.type === "RETURN_TO_LAND") return 96;
  if (clr.issuedBy === "human") return 94;
  if (ac.flags.incursionHold || ac.flags.incursionActive) return 90;
  if (ac.priority === "emergency") return 90;
  if (clr.type === "RUNWAY_CHANGE") return 86;
  if (clr.type === "HOLD_SHORT") return ac.runwayAuth[clr.runwayId ?? ""] ? 86 : 56;
  if (clr.type === "VECTOR") return 80;
  if (clr.type === "CLEARED_TO_LAND") return distanceToThreshold(sim, ac) < sim.config.rules.clearanceNeededNm * NM ? 76 : 62;
  return 50;
}

const RESOLVES: Partial<Record<ClearanceType, RequestType>> = {
  PUSHBACK: "PUSHBACK",
  TAXI: "TAXI",
  CLEARED_TAKEOFF: "TAKEOFF",
  CLEARED_TO_LAND: "LANDING",
  CROSS_RUNWAY: "CROSS",
};
const DEFERS: Partial<Record<ClearanceType, RequestType[]>> = {
  HOLD_SHORT: ["TAKEOFF", "CROSS"],
  LINE_UP_AND_WAIT: ["TAKEOFF"],
  CONTINUE_APPROACH: ["LANDING"],
  HOLD: ["LANDING"],
  HOLD_POSITION: ["TAXI"],
};

interface Plan {
  runway?: string;
  runwayId?: string;
  gate?: string;
  route?: string[];
  via?: string[];
  reserve?: ReservationKind;
  vector?: Vector;
}

export interface Failure {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  needsClarification?: boolean;
}
type Verdict = { ok: true; plan: Plan } | Failure;

const no = (code: string, message: string, details?: Record<string, unknown>): Failure => ({ ok: false, code, message, details });
const ask = (code: string, message: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  code,
  message,
  details,
  needsClarification: true,
});

const isPending = (c: Clearance) => c.status === "issued" || c.status === "transmitted";
export const isOpenClearance = (c: Clearance) => isPending(c) || c.status === "acknowledged" || c.status === "readback_missing";

// ------------------------------------------------------------------ lookups

export function resolveAircraft(sim: Simulation, input: string): { ac: Aircraft; error?: undefined } | { ac?: undefined; error: Failure } {
  const wanted = (input ?? "").toUpperCase().replace(/[\s-]/g, "");
  const direct = sim.aircraft.get(wanted);
  if (direct) return { ac: direct };
  const all = [...sim.aircraft.values()];
  const digits = wanted.replace(/\D/g, "");
  const letters = wanted.replace(/[^A-Z]/g, "");
  const similar = all.filter(
    (a) =>
      (digits.length > 0 && a.callsign.replace(/\D/g, "") === digits) ||
      (letters.length >= 2 && a.callsign.startsWith(letters) && digits.length === 0),
  );
  if (similar.length > 0) {
    return {
      error: ask("AMBIGUOUS_AIRCRAFT", `No aircraft "${input}". Did you mean ${similar.map((a) => a.callsign).join(" or ")}?`, {
        candidates: similar.map((a) => a.callsign),
      }),
    };
  }
  return { error: no("UNKNOWN_AIRCRAFT", `No aircraft "${input}" in the simulation.`) };
}

/** The clearance that currently authorises what the aircraft is doing. */
export function grantingClearance(sim: Simulation, ac: Aircraft, runwayId?: string): Clearance | undefined {
  let found: Clearance | undefined;
  for (const c of sim.clearances.values()) {
    if (c.aircraftId !== ac.id || !c.active || (!isOpenClearance(c) && c.status !== "completed")) continue;
    if (runwayId && c.runwayId !== runwayId) continue;
    if (!found || c.issuedAt >= found.issuedAt) found = c;
  }
  return found;
}

/** The next runway whose hold line lies ahead on the aircraft's route. */
function nextGuardedRunway(sim: Simulation, ac: Aircraft): string | undefined {
  const g = sim.graph;
  for (let j = ac.currentWaypointIndex; j < ac.route.length; j++) {
    const n = g.node(ac.route[j]);
    if (n.kind !== "hold_short" || !n.guards) continue;
    const next = ac.route[j + 1];
    if (next === undefined || g.node(next).kind === "runway") return n.guards;
  }
  return undefined;
}

function displayDesignator(sim: Simulation, runwayId: string): string {
  const rw = sim.graph.runways.get(runwayId)!;
  const active = [...sim.activeRunways.arrivals, ...sim.activeRunways.departures];
  return rw.ends.find((e) => active.includes(e.designator))?.designator ?? rw.ends[1].designator;
}

function atDepartureHold(sim: Simulation, ac: Aircraft, ref: RunwayEndRef): boolean {
  const holds = sim.graph.departureHolds(ref.end.designator);
  if (ac.route.length === 0) return false;
  const here = ac.route[ac.currentWaypointIndex];
  if (ac.phase === "holding_short" && ac.distToNextM <= 0 && holds.includes(here)) return true;
  const limit = ac.route[Math.min(ac.routeLimitIndex, ac.route.length - 1)];
  if (ac.phase === "taxi_out" && holds.includes(limit)) {
    return distanceAlongRoute(sim, ac, Math.min(ac.routeLimitIndex, ac.route.length - 1)) < 300;
  }
  return false;
}

// --------------------------------------------------------------- validation

export function mayLand(ac: Aircraft | undefined, designator: string, active: Simulation["activeRunways"]): boolean {
  return active.arrivals.includes(designator) || (ac?.flags.emergencyReturn === true && active.departures.includes(designator));
}

function runwayAvailable(
  sim: Simulation,
  ac: Aircraft,
  runwayId: string,
  arrivalBufferSec: number,
  what: string,
): Verdict | null {
  const others = occupiedByOthers(sim, runwayId, ac.id);
  if (others.length > 0) {
    return no("RUNWAY_OCCUPIED", `Runway ${runwayId} is occupied by ${others.join(", ")}.`, { runwayId, occupants: others });
  }
  const res = reservedByOther(sim, runwayId, ac.id);
  if (res) {
    return no("RUNWAY_RESERVED", `Runway ${runwayId} is reserved for ${res.aircraftId} (${res.kind}).`, {
      runwayId,
      reservedFor: res.aircraftId,
      kind: res.kind,
    });
  }
  const coming = emergencyInbound(sim, runwayId, ac.id);
  if (coming?.phase === "go_around") {
    const eta = touchdownIn(sim, coming);
    if (eta < sim.config.rules.emergencyArrivalBufferSec) {
      return no("EMERGENCY_PRIORITY", `Runway ${runwayId} is kept for ${coming.callsign}, an emergency ${Math.round(eta)} s from landing.`, {
        runwayId,
        arrival: coming.id,
      });
    }
  }
  for (const arr of inboundArrivals(sim, runwayId)) {
    if (arr.aircraft.id === ac.id) continue;
    const { emergencyArrivalBufferSec, urgentArrivalBufferSec } = sim.config.rules;
    const urgent = arr.aircraft.priority === "urgent" && what !== "cross";
    const buffer =
      arr.aircraft.priority === "emergency" ? emergencyArrivalBufferSec : urgent ? Math.max(urgentArrivalBufferSec, arrivalBufferSec) : arrivalBufferSec;
    if (arr.etaSec < buffer) {
      return no(
        "ARRIVAL_TOO_CLOSE",
        `${arr.aircraft.callsign} is ${arr.distanceNm.toFixed(1)} NM from runway ${runwayId} (${Math.round(arr.etaSec)} s); too close to ${what}.`,
        { runwayId, arrival: arr.aircraft.id, etaSec: Math.round(arr.etaSec), requiredSec: buffer },
      );
    }
  }
  return null;
}

/**
 * Runways that physically cross are used one at a time: a takeoff or landing
 * needs every runway crossing its own to be free of takeoffs and landings,
 * and keeps them blocked until it is finished. Taxiing across a crossing
 * runway elsewhere along its length does not count.
 */
function crossingRunwayInUse(sim: Simulation, ac: Aircraft, runwayId: string, arrivalBufferSec?: number): Verdict | null {
  for (const other of sim.graph.intersecting(runwayId)) {
    const details = { runwayId, crossingRunway: other };
    for (const o of sim.aircraft.values()) {
      if (o.id === ac.id || (o.phase !== "takeoff" && o.phase !== "landing" && o.phase !== "rollout")) continue;
      if (sim.graph.runwayEnd(o.assignedRunway)?.runway.id !== other) continue;
      return no(
        "CROSSING_RUNWAY_IN_USE",
        `${o.callsign} is ${o.phase === "takeoff" ? "departing from" : "landing on"} runway ${other}, which crosses runway ${runwayId}.`,
        { ...details, aircraft: o.id },
      );
    }
    const res = reservedByOther(sim, other, ac.id);
    if (res && (res.kind === "landing" || res.kind === "takeoff")) {
      return no("CROSSING_RUNWAY_IN_USE", `Runway ${other}, which crosses runway ${runwayId}, is reserved for ${res.aircraftId} (${res.kind}).`, {
        ...details,
        reservedFor: res.aircraftId,
        kind: res.kind,
      });
    }
    if (arrivalBufferSec === undefined) continue;
    for (const arr of inboundArrivals(sim, other)) {
      if (arr.aircraft.id === ac.id) continue;
      const buffer = arr.aircraft.priority === "emergency" ? sim.config.rules.emergencyArrivalBufferSec : arrivalBufferSec;
      if (arr.etaSec < buffer) {
        return no(
          "ARRIVAL_TOO_CLOSE",
          `${arr.aircraft.callsign} is ${arr.distanceNm.toFixed(1)} NM from runway ${other}, which crosses runway ${runwayId} (${Math.round(arr.etaSec)} s).`,
          { ...details, arrival: arr.aircraft.id, etaSec: Math.round(arr.etaSec), requiredSec: buffer },
        );
      }
    }
  }
  return null;
}

/**
 * Standing on a taxiway with nowhere cleared to go: pushed back and waiting,
 * or just off the runway waiting for a route. Nobody knows which way it will
 * leave, so nothing is routed through it. An aircraft holding short of a
 * runway it is about to enter is different: it leaves forwards, and others
 * may queue behind it.
 */
function parkedOnTaxiway(sim: Simulation, ac: Aircraft): boolean {
  if (ac.altitudeFt > 0 || ac.route.length === 0) return false;
  if (ac.phase === "pushback") return true;
  if (ac.phase !== "taxi_in" && ac.phase !== "taxi_out" && ac.phase !== "holding_short") return false;
  const i = ac.currentWaypointIndex;
  if (ac.distToNextM > 0 || i < Math.min(ac.routeLimitIndex, ac.route.length - 1)) return false;
  const here = sim.graph.node(ac.route[i]);
  if (here.kind !== "hold_short") return true;
  // On a hold line: parked only if it arrived there coming off the runway.
  return i > 0 && sim.graph.node(ac.route[i - 1]).kind === "runway";
}

/**
 * Taxiways are single lines here: two aircraft cannot pass on one. A route
 * is only cleared if no other aircraft is cleared along any part of it in
 * the opposite direction and nobody is parked on it. The aircraft waits
 * where it is until the other has gone by, which rules out a nose-to-nose
 * standoff instead of trying to untangle one afterwards.
 */
function taxiRouteConflict(sim: Simulation, ac: Aircraft, path: string[]): Failure | null {
  const g = sim.graph;
  for (let k = 1; k < path.length; k++) {
    const oncoming = sim.traffic.directed.get(`${path[k]}>${path[k - 1]}`)?.find((o) => o.id !== ac.id);
    if (oncoming) {
      const other = sim.aircraft.get(oncoming.id);
      const where = g.edgeBetween(path[k - 1], path[k])?.name;
      return no(
        "TAXI_ROUTE_CONFLICT",
        `${other?.callsign ?? oncoming.id} is cleared the opposite way${where ? ` along ${where}` : ""}; no other route is open. Try again once it has passed.`,
        { blockedBy: oncoming.id, ...(where ? { taxiway: where } : {}) },
      );
    }
    const owner = sim.nodeClaims.get(path[k]);
    const parked = owner && owner !== ac.id ? sim.aircraft.get(owner) : undefined;
    if (parked && parkedOnTaxiway(sim, parked)) {
      return no("TAXI_ROUTE_CONFLICT", `${parked.callsign} is standing on the route waiting for its own clearance. Try again once it has moved.`, {
        blockedBy: parked.id,
      });
    }
  }
  // An aircraft being pushed back swings across the apron behind its gate: keep clear of where it will end up.
  for (const other of sim.aircraft.values()) {
    if (other.id === ac.id || other.phase !== "pushback") continue;
    const spot = g.pos(other.route[other.route.length - 1]);
    if (routePassesNear(sim, path, 0, path.length - 1, spot)) {
      return no("TAXI_ROUTE_CONFLICT", `${other.callsign} is pushing back onto the route. Try again once it has moved.`, { blockedBy: other.id });
    }
  }
  return null;
}

const APRON_CLEARANCE_M = 45;

/** An aircraft cleared to pass a push spot within this distance would get there during the push. */
const PUSHBACK_TRAFFIC_M = 500;

/** Index of the first point at which route[from..to] passes within wingtip distance of `p`, or -1. */
function routeIndexNear(sim: Simulation, route: string[], from: number, to: number, p: { x: number; y: number }): number {
  const g = sim.graph;
  for (let k = Math.max(from, 0); k <= to; k++) {
    const b = g.pos(route[k]);
    if (k === from) {
      if (dist(b, p) < APRON_CLEARANCE_M) return k;
      continue;
    }
    const a = g.pos(route[k - 1]);
    const pr = projectOnSegment(p, a, b);
    if (pr.t >= 0 && pr.t <= pr.length ? pr.lateral < APRON_CLEARANCE_M : dist(b, p) < APRON_CLEARANCE_M) return k;
  }
  return -1;
}

function routePassesNear(sim: Simulation, route: string[], from: number, to: number, p: { x: number; y: number }): boolean {
  return routeIndexNear(sim, route, from, to, p) >= 0;
}

function planTaxiRoute(sim: Simulation, ac: Aircraft, targets: string[]) {
  const g = sim.graph;
  const origin = routeOrigin(ac);
  const behind = ac.distToNextM > 0 && ac.currentWaypointIndex > 0 ? ac.route[ac.currentWaypointIndex - 1] : undefined;
  return g.shortestPath(origin, targets, {
    closedEdges: sim.closedEdges,
    penalty: (edge, from, to) => {
      let m = 1;
      // do not plan a U-turn on the segment the aircraft is already rolling along
      if (behind && from === origin && to === behind) m *= 50;
      // Oncoming traffic: avoid it if it is planned, never route into it if it is right there.
      const oncoming = sim.traffic.directed.get(`${to}>${from}`);
      if (oncoming) {
        for (const o of oncoming) {
          if (o.id === ac.id) continue;
          const seg = sim.traffic.routes?.get(o.id)?.find((x) => x.key === `${to}>${from}`);
          m *= o.on || (seg !== undefined && seg.start < 150) ? 1000 : 25;
        }
      }
      const owner = sim.nodeClaims.get(to);
      if (owner && owner !== ac.id) {
        const other = sim.aircraft.get(owner);
        if (other && parkedOnTaxiway(sim, other)) m *= 1000;
        else if (other && other.speedKts === 0 && other.phase !== "at_gate") m *= 4;
      }
      return m;
    },
  });
}

/** Shared by the tool gateway's get_taxi_route. */
export function computeTaxiRoute(
  sim: Simulation,
  ac: Aircraft,
  dest: { runway?: string; gate?: string },
): Verdict {
  const g = sim.graph;
  if (ac.route.length === 0 || ac.altitudeFt > 0) return no("NOT_ON_GROUND", `${ac.callsign} is not on the ground.`);
  if (dest.gate) {
    const gateNode = g.gates.get(dest.gate.toUpperCase());
    if (!gateNode) return no("UNKNOWN_GATE", `No gate ${dest.gate}.`, { gates: [...g.gates.keys()] });
    const res = planTaxiRoute(sim, ac, [gateNode.id]);
    if (!res) return no("NO_ROUTE", `No open taxi route from ${routeOrigin(ac)} to gate ${gateNode.gate}.`);
    const conflict = taxiRouteConflict(sim, ac, res.path);
    if (conflict) return conflict;
    return { ok: true, plan: { gate: gateNode.gate, route: res.path, via: g.viaNames(res.path) } };
  }
  const ref = g.runwayEnd(dest.runway);
  if (!ref) return ask("UNKNOWN_RUNWAY", `Which runway? "${dest.runway ?? ""}" is not a runway at this airport.`);
  const res = planTaxiRoute(sim, ac, g.departureHolds(ref.end.designator));
  if (!res) return no("NO_ROUTE", `No open taxi route from ${routeOrigin(ac)} to runway ${ref.end.designator}.`);
  const conflict = taxiRouteConflict(sim, ac, res.path);
  if (conflict) return conflict;
  return {
    ok: true,
    plan: { runway: ref.end.designator, runwayId: ref.runway.id, route: res.path, via: g.viaNames(res.path) },
  };
}

function validate(sim: Simulation, ac: Aircraft, cmd: IssueCommand): Verdict {
  const g = sim.graph;
  const rules = sim.config.rules;
  const phase = ac.phase;
  const wrongPhase = (need: string) =>
    no("INVALID_PHASE", `${ac.callsign} is in phase "${phase}"; ${cmd.clearanceType} needs it to be ${need}.`, {
      phase,
    });

  switch (cmd.clearanceType) {
    case "PUSHBACK": {
      if (phase !== "at_gate" || ac.flight !== "departure" || ac.flightComplete) return wrongPhase("a departure at its gate");
      const gateNode = ac.gate ? g.gates.get(ac.gate) : undefined;
      if (!gateNode?.pushbackNode) return no("UNKNOWN_GATE", `${ac.callsign} has no gate.`);
      const lane = gateNode.pushbackNode;
      let wayOut: Set<string> | null | undefined;
      const wayOutRunsAgainst = (other: Aircraft): boolean => {
        if (wayOut === undefined) {
          const path = g.shortestPath(lane, g.departureHolds(ac.assignedRunway ?? ""), { closedEdges: sim.closedEdges })?.path;
          wayOut = path ? new Set(path.slice(1).map((id, k) => `${path[k]}>${id}`)) : null;
        }
        const theirs = sim.traffic.routes?.get(other.id);
        if (!wayOut || !theirs) return true;
        return theirs.some((seg) => wayOut!.has(seg.rev));
      };
      const owner = sim.nodeClaims.get(lane);
      if (owner && owner !== ac.id) {
        return no("APRON_BLOCKED", `${owner} is on the apron behind gate ${ac.gate}.`, { blockedBy: owner });
      }
      for (const other of sim.aircraft.values()) {
        if (other.id === ac.id || other.altitudeFt > 0) continue;
        // Another aircraft pushing, or about to push, onto the same piece of apron.
        const pushing =
          other.phase === "pushback" ||
          [...sim.clearances.values()].some((c) => c.aircraftId === other.id && c.type === "PUSHBACK" && isOpenClearance(c));
        const theirLane = pushing && other.gate ? g.gates.get(other.gate)?.pushbackNode : undefined;
        if (theirLane && dist(g.pos(theirLane), g.pos(lane)) < 100) {
          return no("APRON_BLOCKED", `${other.callsign} is pushing back next to gate ${ac.gate}.`, { blockedBy: other.id });
        }
        if (other.phase === "at_gate") continue;
        const d = dist(other.position, g.pos(lane));
        // Close by, or cleared to taxi through the spot the aircraft would push onto. However far
        // away it still is, pushing into its path would leave the two facing each other.
        if (d < 90) return no("APRON_BLOCKED", `${other.callsign} is passing behind gate ${ac.gate}.`, { blockedBy: other.id });
        if (other.phase === "pushback") continue;
        // Cleared to taxi through the spot this aircraft would push onto. That is fine if it is still
        // some way off and this aircraft will then leave ahead of it in the same direction; it is a
        // standoff in the making if this aircraft's way out runs against it.
        const limit = Math.min(other.routeLimitIndex, other.route.length - 1);
        const at = routeIndexNear(sim, other.route, other.currentWaypointIndex, limit, g.pos(lane));
        if (at < 0) continue;
        // An arrival about to turn onto a stand right beside this one needs the room this aircraft would be sitting in.
        const theirStand = other.phase === "taxi_in" && other.gate ? g.gates.get(other.gate)?.pushbackNode : undefined;
        const parkingAlongside = theirStand !== undefined && dist(g.pos(theirStand), g.pos(lane)) < 100;
        if (parkingAlongside || distanceAlongRoute(sim, other, at) < PUSHBACK_TRAFFIC_M || wayOutRunsAgainst(other)) {
          return no("APRON_BLOCKED", `${other.callsign} is cleared to taxi behind gate ${ac.gate}.`, { blockedBy: other.id });
        }
      }
      return { ok: true, plan: { gate: ac.gate, route: [gateNode.id, lane] } };
    }

    case "TAXI": {
      if (ac.flight === "departure") {
        const ready = (phase === "pushback" && ac.flags.pushbackComplete) || phase === "taxi_out" || phase === "holding_short";
        if (!ready) return wrongPhase("pushed back and ready to taxi");
        if (runwayOccupiedBy(sim, ac)) return no("ON_RUNWAY", `${ac.callsign} is on a runway; clear it first.`);
        const designator = cmd.runway ?? ac.assignedRunway;
        if (!designator) return ask("RUNWAY_REQUIRED", `Which runway should ${ac.callsign} taxi to?`);
        const ref = g.runwayEnd(designator);
        if (!ref) return ask("UNKNOWN_RUNWAY", `"${designator}" is not a runway at this airport.`);
        if (!sim.activeRunways.departures.includes(ref.end.designator)) {
          return no("RUNWAY_NOT_ACTIVE", `Runway ${ref.end.designator} is not in use for departures.`, {
            activeDepartures: sim.activeRunways.departures,
          });
        }
        return taxiPlan(sim, ac, cmd, { runway: ref.end.designator });
      }
      const ready = (phase === "taxi_in" && ac.speedKts === 0) || phase === "taxi_in" || phase === "holding_short";
      if (!ready) return wrongPhase("clear of the runway");
      if (runwayOccupiedBy(sim, ac)) return no("ON_RUNWAY", `${ac.callsign} is still on the runway.`);
      const gateName = (cmd.gate ?? ac.gate)?.toUpperCase();
      if (!gateName) return ask("GATE_REQUIRED", `Which gate should ${ac.callsign} taxi to?`);
      const gateNode = g.gates.get(gateName);
      if (!gateNode) return no("UNKNOWN_GATE", `No gate ${gateName}.`, { gates: [...g.gates.keys()] });
      for (const other of sim.aircraft.values()) {
        if (other.id !== ac.id && other.gate === gateName && (other.phase === "at_gate" || other.phase === "pushback" || other.flight === "arrival")) {
          const freeGates = [...g.gates.keys()].filter((name) => !gateInUse(sim, name));
          return no("GATE_OCCUPIED", `Gate ${gateName} is in use by ${other.callsign}. Free gates: ${freeGates.join(", ") || "none"}.`, {
            occupiedBy: other.id,
            freeGates,
          });
        }
      }
      return taxiPlan(sim, ac, cmd, { gate: gateName });
    }

    case "HOLD_SHORT": {
      if (!["pushback", "taxi_out", "taxi_in", "holding_short"].includes(phase)) return wrongPhase("taxiing");
      const requested = g.physicalRunway(cmd.runway);
      if (cmd.runway && !requested) return ask("UNKNOWN_RUNWAY", `"${cmd.runway}" is not a runway at this airport.`);
      const runwayId = requested?.id ?? nextGuardedRunway(sim, ac);
      if (!runwayId) return ask("RUNWAY_REQUIRED", `Hold short of which runway? ${ac.callsign} has no runway ahead on its route.`);
      if (runwayOccupiedBy(sim, ac) === runwayId) {
        return no("ALREADY_ON_RUNWAY", `${ac.callsign} is already on runway ${runwayId}.`);
      }
      const designator = g.runwayEnd(cmd.runway)?.end.designator ?? displayDesignator(sim, runwayId);
      return { ok: true, plan: { runway: designator, runwayId } };
    }

    case "CROSS_RUNWAY": {
      if (!["taxi_out", "taxi_in", "holding_short"].includes(phase)) return wrongPhase("taxiing or holding short");
      const onRunway = runwayOccupiedBy(sim, ac);
      const requested = g.physicalRunway(cmd.runway);
      if (cmd.runway && !requested) return ask("UNKNOWN_RUNWAY", `"${cmd.runway}" is not a runway at this airport.`);
      const runwayId = requested?.id ?? onRunway ?? nextGuardedRunway(sim, ac);
      if (!runwayId) return ask("RUNWAY_REQUIRED", `Cross which runway? ${ac.callsign} has no runway ahead on its route.`);
      if (onRunway !== runwayId) {
        if (nextGuardedRunway(sim, ac) !== runwayId) {
          return no("WRONG_RUNWAY", `${ac.callsign}'s route does not cross runway ${runwayId} next.`, {
            nextRunway: nextGuardedRunway(sim, ac) ?? null,
          });
        }
        if (!g.crossings(ac.route.slice(Math.max(0, ac.currentWaypointIndex - 1))).includes(runwayId)) {
          return no("NOT_A_CROSSING", `${ac.callsign}'s route ends at runway ${runwayId}; it is not crossing it.`);
        }
      }
      const blocked = runwayAvailable(sim, ac, runwayId, rules.crossArrivalBufferSec, "cross");
      if (blocked) return blocked;
      const designator = g.runwayEnd(cmd.runway)?.end.designator ?? displayDesignator(sim, runwayId);
      return { ok: true, plan: { runway: designator, runwayId, reserve: "crossing" } };
    }

    case "LINE_UP_AND_WAIT":
    case "CLEARED_TAKEOFF": {
      const takeoff = cmd.clearanceType === "CLEARED_TAKEOFF";
      if (ac.flight !== "departure") return wrongPhase("a departure");
      const designator = cmd.runway ?? ac.assignedRunway;
      if (!designator) return ask("RUNWAY_REQUIRED", `Which runway for ${ac.callsign}?`);
      const ref = g.runwayEnd(designator);
      if (!ref) return ask("UNKNOWN_RUNWAY", `"${designator}" is not a runway at this airport.`);
      if (!sim.activeRunways.departures.includes(ref.end.designator)) {
        return no("RUNWAY_NOT_ACTIVE", `Runway ${ref.end.designator} is not in use for departures.`, {
          activeDepartures: sim.activeRunways.departures,
        });
      }
      const onThisRunway = runwayOccupiedBy(sim, ac) === ref.runway.id;
      if (onThisRunway && ac.assignedRunway !== ref.end.designator) {
        return no("WRONG_RUNWAY", `${ac.callsign} is positioned for runway ${ac.assignedRunway}.`);
      }
      const linedUp = phase === "line_up" && onThisRunway;
      const strayed = onThisRunway && phase === "taxi_out"; // stopped past the hold line
      if (!linedUp && !strayed && !atDepartureHold(sim, ac, ref)) {
        if (phase === "line_up") return no("WRONG_RUNWAY", `${ac.callsign} is lined up on a different runway.`);
        return no("NOT_AT_HOLD_POINT", `${ac.callsign} is not at the runway ${ref.end.designator} holding point.`, { phase });
      }
      if (!takeoff && linedUp) return no("ALREADY_LINED_UP", `${ac.callsign} is already lined up on runway ${ref.end.designator}.`);
      const buffer = takeoff ? rules.takeoffArrivalBufferSec : rules.lineUpArrivalBufferSec;
      const blocked = runwayAvailable(sim, ac, ref.runway.id, buffer, takeoff ? "depart ahead of it" : "line up ahead of it");
      if (blocked) return blocked;
      if (takeoff) {
        const crossing = crossingRunwayInUse(sim, ac, ref.runway.id, buffer);
        if (crossing) return crossing;
        const state = sim.runwayState.get(ref.runway.id)!;
        if (state.lastDepartureRollAt !== undefined && state.lastDepartureId !== ac.id) {
          const since = sim.time - state.lastDepartureRollAt;
          if (since < rules.departureSeparationSec) {
            const wait = Math.ceil(rules.departureSeparationSec - since);
            return no("DEPARTURE_SEPARATION", `${state.lastDepartureId} started its takeoff roll ${Math.round(since)} s ago; wait ${wait} s.`, {
              retryAfterSec: wait,
            });
          }
        }
      }
      return {
        ok: true,
        plan: { runway: ref.end.designator, runwayId: ref.runway.id, reserve: takeoff ? "takeoff" : "lineup" },
      };
    }

    case "CLEARED_TO_LAND": {
      if (phase !== "approach") return wrongPhase("on approach");
      const ref = g.runwayEnd(cmd.runway ?? ac.assignedRunway);
      if (!ref) return ask("UNKNOWN_RUNWAY", `"${cmd.runway ?? ""}" is not a runway at this airport.`);
      if (ref.end.designator !== ac.assignedRunway) {
        return no("WRONG_RUNWAY", `${ac.callsign} is on approach to runway ${ac.assignedRunway}, not ${ref.end.designator}.`, {
          assignedRunway: ac.assignedRunway,
        });
      }
      if (!mayLand(ac, ref.end.designator, sim.activeRunways)) {
        return no("RUNWAY_NOT_ACTIVE", `Runway ${ref.end.designator} is not in use for arrivals.`, {
          activeArrivals: sim.activeRunways.arrivals,
        });
      }
      if (ac.landingCleared) return no("ALREADY_CLEARED", `${ac.callsign} is already cleared to land.`);
      const others = occupiedByOthers(sim, ref.runway.id, ac.id);
      if (others.length > 0) {
        return no("RUNWAY_OCCUPIED", `Runway ${ref.runway.id} is occupied by ${others.join(", ")}.`, { occupants: others });
      }
      const res = reservedByOther(sim, ref.runway.id, ac.id);
      if (res) {
        return no("RUNWAY_RESERVED", `Runway ${ref.runway.id} is reserved for ${res.aircraftId} (${res.kind}).`, {
          reservedFor: res.aircraftId,
          kind: res.kind,
        });
      }
      const crossing = crossingRunwayInUse(sim, ac, ref.runway.id);
      if (crossing) return crossing;
      const distress = ac.priority === "emergency";
      const first = distress ? undefined : emergencyInbound(sim, ref.runway.id, ac.id);
      if (first && touchdownIn(sim, ac) > touchdownIn(sim, first) - EMERGENCY_CLEAR_SEC) {
        return no("EMERGENCY_PRIORITY", `${first.callsign} is number one for runway ${ref.end.designator} with an emergency.`, { ahead: first.id });
      }
      const ahead = inboundArrivals(sim, ref.runway.id).find(
        (a) =>
          a.aircraft.id !== ac.id &&
          (!distress || a.aircraft.priority === "emergency") &&
          a.distanceNm < distanceToThreshold(sim, ac) / NM,
      );
      if (ahead) {
        return no("NOT_NUMBER_ONE", `${ahead.aircraft.callsign} is ahead of ${ac.callsign} for runway ${ref.end.designator}.`, {
          ahead: ahead.aircraft.id,
        });
      }
      return { ok: true, plan: { runway: ref.end.designator, runwayId: ref.runway.id, reserve: "landing" } };
    }

    case "GO_AROUND": {
      if (phase !== "approach" && phase !== "landing") return wrongPhase("on approach or short final");
      const ref = g.runwayEnd(ac.assignedRunway);
      return { ok: true, plan: { runway: ac.assignedRunway, runwayId: ref?.runway.id } };
    }

    case "HOLD": {
      if (phase !== "approach") return wrongPhase("on approach");
      const d = distanceToThreshold(sim, ac) / NM;
      if (d < rules.holdMinDistanceNm) {
        return no("TOO_CLOSE_TO_HOLD", `${ac.callsign} is ${d.toFixed(1)} NM out; inside ${rules.holdMinDistanceNm} NM use GO_AROUND instead.`);
      }
      if (ac.landingCleared) return no("ALREADY_CLEARED", `${ac.callsign} is cleared to land; cancel that first.`);
      return { ok: true, plan: { runway: ac.assignedRunway } };
    }

    case "CONTINUE_APPROACH": {
      if (phase !== "approach" && phase !== "holding") return wrongPhase("on approach or holding");
      return { ok: true, plan: { runway: ac.assignedRunway } };
    }

    case "HOLD_POSITION": {
      if (!["pushback", "taxi_out", "taxi_in", "holding_short", "line_up"].includes(phase)) return wrongPhase("moving on the ground");
      return { ok: true, plan: {} };
    }

    case "CONTINUE_TAXI": {
      if (ac.flags.taxiClearanceCancelled) {
        return no("TAXI_CLEARANCE_REQUIRED", `${ac.callsign} needs a new taxi route.`);
      }
      if (!ac.holdPosition) return no("NOT_HOLDING", `${ac.callsign} has not been told to hold position.`);
      return { ok: true, plan: {} };
    }

    case "RUNWAY_CHANGE": {
      if (!ac.flags.runwayUnavailable) return no("NOT_NEEDED", `Runway ${ac.assignedRunway} is available to ${ac.callsign}.`);
      const designator = cmd.runway ?? replacementRunway(sim, ac);
      const ref = g.runwayEnd(designator);
      if (!ref) return ask("UNKNOWN_RUNWAY", `"${designator ?? ""}" is not a runway at this airport.`);
      const inUse = ac.flight === "departure" ? sim.activeRunways.departures : sim.activeRunways.arrivals;
      if (!inUse.includes(ref.end.designator)) return no("RUNWAY_NOT_ACTIVE", `Runway ${ref.end.designator} is not in use.`, { active: inUse });
      return { ok: true, plan: { runway: ref.end.designator, runwayId: ref.runway.id } };
    }

    case "VECTOR": {
      if (phase !== "go_around" || ac.emergencyId || ac.flags.priorityReturn || ac.flags.emergencyReturn) return wrongPhase("flying a missed approach");
      if (ac.flags.vectored) return no("ALREADY_VECTORED", `${ac.callsign} already has its heading and altitude.`);
      const next = ac.airRoute[ac.airIndex];
      if (next?.tag !== "circuit" && next?.tag !== "rejoin") return no("TOO_LATE", `${ac.callsign} is already turning on to final.`);
      return { ok: true, plan: { vector: vectorTo(ac, next, missedApproachFt(sim, ac), 180) } };
    }

    case "RETURN_TO_LAND": {
      if (phase !== "go_around" || !ac.flags.emergencyReturn) return wrongPhase("turning back with an emergency");
      if (ac.flags.priorityReturn) return no("ALREADY_CLEARED", `${ac.callsign} already has priority back to the runway.`);
      const ref = g.runwayEnd(ac.assignedRunway);
      if (!ref || !mayLand(ac, ref.end.designator, sim.activeRunways)) return no("RUNWAY_NOT_ACTIVE", `Runway ${ac.assignedRunway} cannot take the return.`);
      const first = priorityRoute(g, ref.end.designator, ac.type, ac.position)[0]!;
      return { ok: true, plan: { runway: ref.end.designator, runwayId: ref.runway.id, vector: vectorTo(ac, first, RETURN_FT, 160) } };
    }
  }
}

/** Two missed approaches on one side of the airport fly it 1000 ft apart. */
function missedApproachFt(sim: Simulation, ac: Aircraft): number {
  const occupied = [...sim.aircraft.values()].some(
    (o) =>
      o.id !== ac.id &&
      o.phase === "go_around" &&
      o.airRoute[o.airIndex]?.altFt === MISSED_APPROACH_FT &&
      sim.graph.runwayEnd(o.assignedRunway)?.runway.id === sim.graph.runwayEnd(ac.assignedRunway)?.runway.id,
  );
  return occupied ? MISSED_APPROACH_FT - 1000 : MISSED_APPROACH_FT;
}

function vectorTo(ac: Aircraft, to: { x: number; y: number }, altitudeFt: number, speedKts: number): Vector {
  const heading = bearing(ac.position, to);
  return {
    turn: angleDiff(ac.headingDeg, heading) < 0 ? "left" : "right",
    headingDeg: (Math.round(heading / 5) * 5) % 360 || 360,
    altitudeFt,
    speedKts,
  };
}

function taxiPlan(sim: Simulation, ac: Aircraft, cmd: IssueCommand, dest: { runway?: string; gate?: string }): Verdict {
  const g = sim.graph;
  if (!cmd.route || cmd.route.length === 0) return computeTaxiRoute(sim, ac, dest);
  const origin = routeOrigin(ac);
  if (cmd.route[0] !== origin) {
    return no("INVALID_ROUTE", `The route must start at ${origin}, where ${ac.callsign} is.`, { origin });
  }
  const problem = g.validatePath(cmd.route, sim.closedEdges);
  if (problem) return no("INVALID_ROUTE", `Route rejected: ${problem}.`);
  const conflict = taxiRouteConflict(sim, ac, cmd.route);
  if (conflict) return conflict;
  const last = cmd.route[cmd.route.length - 1];
  if (dest.gate) {
    if (g.gates.get(dest.gate)?.id !== last) return no("INVALID_ROUTE", `The route does not end at gate ${dest.gate}.`);
    return { ok: true, plan: { gate: dest.gate, route: cmd.route, via: g.viaNames(cmd.route) } };
  }
  const ref = g.runwayEnd(dest.runway)!;
  if (!g.departureHolds(ref.end.designator).includes(last)) {
    return no("INVALID_ROUTE", `The route does not end at a runway ${ref.end.designator} holding point.`);
  }
  return {
    ok: true,
    plan: { runway: ref.end.designator, runwayId: ref.runway.id, route: cmd.route, via: g.viaNames(cmd.route) },
  };
}

// -------------------------------------------------------------------- issue

function reject(sim: Simulation, cmd: IssueCommand, v: Failure, aircraftId?: string): CommandResult {
  sim.stats.clearancesRejected++;
  sim.emit("clearance.rejected", {
    aircraftId,
    data: {
      clearanceType: cmd.clearanceType,
      runway: cmd.runway,
      code: v.code,
      message: v.message,
      needsClarification: v.needsClarification ?? false,
      details: v.details ?? {},
      reason: cmd.reason,
      issuedBy: cmd.issuedBy ?? "controller",
      requestId: cmd.requestId,
    },
  });
  return { ok: false, code: v.code, message: v.message, needsClarification: v.needsClarification, details: v.details };
}

export function issueClearance(sim: Simulation, cmd: IssueCommand): CommandResult {
  const found = resolveAircraft(sim, cmd.aircraftId);
  if (found.error) return reject(sim, cmd, found.error);
  const ac = found.ac;

  if (!CLEARANCE_TYPES.includes(cmd.clearanceType)) {
    return reject(sim, cmd, no("UNKNOWN_CLEARANCE_TYPE", `"${cmd.clearanceType}" is not a clearance. Valid: ${CLEARANCE_TYPES.join(", ")}.`), ac.id);
  }
  if (!cmd.reason || !cmd.reason.trim()) {
    return reject(sim, cmd, no("MISSING_REASON", "Every clearance needs a stated reason for the decision log."), ac.id);
  }

  if (ac.humanControl && cmd.issuedBy !== "human") {
    return reject(sim, cmd, no("HUMAN_CONTROL", `${ac.callsign} is under human control; the agent may not instruct it.`), ac.id);
  }
  if (cmd.requestId !== undefined) {
    const request = sim.requests.get(cmd.requestId);
    if (request?.status !== "pending" || request.aircraftId !== ac.id) {
      return reject(sim, cmd, ask("INVALID_REQUEST", "Refresh pending requests and use the open request for this aircraft."), ac.id);
    }
  }

  const pending = [...sim.clearances.values()].filter((c) => c.aircraftId === ac.id && isPending(c));
  const same = pending.find((c) => c.type === cmd.clearanceType);
  if (same) {
    const differentRunway = cmd.runway && sim.graph.runwayEnd(cmd.runway)?.end.designator !== same.runway && (
      !["HOLD_SHORT", "CROSS_RUNWAY"].includes(cmd.clearanceType) ||
      sim.graph.physicalRunway(cmd.runway)?.id !== same.runwayId
    );
    const differentRoute = cmd.route?.length && (cmd.route.length !== same.route?.length ||
      cmd.route.some((node, i) => node !== same.route?.[i]));
    if (differentRunway || differentRoute || (cmd.gate && cmd.gate.toUpperCase() !== same.gate)) {
      return reject(sim, cmd, no("CLEARANCE_PENDING", "An instruction with different parameters is awaiting readback.", {
        pendingClearanceId: same.id,
      }), ac.id);
    }
    // The same instruction again (e.g. a retried webhook): not a new clearance.
    return {
      ok: true,
      duplicate: true,
      clearanceId: same.id,
      transmissionId: same.transmissionId,
      status: same.status,
      phraseology: same.phraseology,
      spoken: same.spoken,
    };
  }
  if (pending.length > 0 && !OVERRIDES_PENDING.has(cmd.clearanceType)) {
    return reject(
      sim,
      cmd,
      no("CLEARANCE_PENDING", `${ac.callsign} has not read back ${pending[0].type} yet. Wait for the readback.`, {
        pendingClearanceId: pending[0].id,
      }),
      ac.id,
    );
  }

  const verdict = validate(sim, ac, cmd);
  if (!verdict.ok) return reject(sim, cmd, verdict, ac.id);
  const plan = verdict.plan;

  for (const p of pending) closeClearance(sim, p, "superseded", `superseded by ${cmd.clearanceType}`);

  const phraseInput = phraseInputFor(ac, { ...plan, type: cmd.clearanceType });
  const phrase = clearancePhrase(phraseInput);
  const clr: Clearance = {
    id: sim.nextId("CLR"),
    aircraftId: ac.id,
    type: cmd.clearanceType,
    runway: plan.runway,
    runwayId: plan.runwayId,
    gate: plan.gate,
    route: plan.route,
    via: plan.via,
    vector: plan.vector,
    reason: cmd.reason.trim(),
    issuedBy: cmd.issuedBy ?? "controller",
    requestId: cmd.requestId,
    status: "issued",
    active: false,
    issuedAt: sim.time,
    phraseology: phrase.text,
    spoken: phrase.spoken,
    expectedReadback: readbackPhrase(phraseInput).text,
  };
  sim.clearances.set(clr.id, clr);
  sim.stats.clearancesIssued++;
  ac.clearance = { id: clr.id, type: clr.type, issuedAt: clr.issuedAt, status: "pending" };

  if (plan.reserve && plan.runwayId) {
    // Keep an existing clearance's reservation until its replacement takes effect.
    const state = sim.runwayState.get(plan.runwayId)!;
    if (!state.reservation) reserve(sim, plan.runwayId, ac.id, plan.reserve, clr.id);
  }

  sim.emit("clearance.issued", {
    aircraftId: ac.id,
    cause: cmd.requestId ? { kind: "request", requestId: cmd.requestId } : undefined,
    data: {
      clearanceId: clr.id,
      clearanceType: clr.type,
      runway: clr.runway,
      gate: clr.gate,
      via: clr.via,
      vector: clr.vector,
      reason: clr.reason,
      phraseology: clr.phraseology,
      issuedBy: clr.issuedBy,
      validator: "accepted",
    },
  });

  const tx = enqueueTransmission(sim, {
    from: "TOWER",
    to: ac.id,
    kind: "clearance",
    text: clr.phraseology,
    spoken: clr.spoken,
    clearanceId: clr.id,
    priority: priorityOf(ac, clr, sim),
  });
  clr.transmissionId = tx.id;

  return {
    ok: true,
    clearanceId: clr.id,
    status: clr.status,
    phraseology: clr.phraseology,
    spoken: clr.spoken,
    expectedReadback: clr.expectedReadback,
    runway: clr.runway,
    gate: clr.gate,
    via: clr.via,
    transmissionId: tx.id,
  };
}

/** What the radio text for this instruction is built from. */
export function phraseInputFor(ac: Aircraft, c: Pick<Clearance, "type" | "runway" | "gate" | "via" | "vector">) {
  return {
    callsign: ac.callsign,
    type: c.type,
    runway: c.runway,
    gate: ac.flight === "arrival" && c.type === "TAXI" ? c.gate : undefined,
    via: c.via,
    vector: c.vector,
    from: c.type === "RUNWAY_CHANGE" ? ac.assignedRunway : undefined,
    flight: ac.flight,
  };
}

// ---------------------------------------------------------------- lifecycle

/** Recheck the actual instruction after the time spent on the radio. */
function revalidate(sim: Simulation, ac: Aircraft, clr: Clearance): Verdict {
  let route = clr.route;
  if (clr.type === "TAXI" && route) {
    const origin = routeOrigin(ac);
    const start = route.indexOf(origin);
    if (start < 0) {
      const verdict = no("TAXI_ROUTE_CHANGED", `${ac.callsign} has moved off the cleared taxi route.`);
      closeClearance(sim, clr, "expired", verdict.message);
      return verdict;
    }
    route = route.slice(start);
  }
  const verdict = validate(sim, ac, {
    type: "clearance.issue",
    aircraftId: clr.aircraftId,
    clearanceType: clr.type,
    runway: clr.runway,
    gate: clr.gate,
    route,
    reason: clr.reason,
  });
  if (!verdict.ok) closeClearance(sim, clr, "expired", verdict.message);
  return verdict;
}

export function onClearanceTransmitted(sim: Simulation, clr: Clearance): void {
  if (clr.status !== "issued") return;
  clr.status = "transmitted";
  clr.transmittedAt = sim.time;
  sim.emit("clearance.transmitted", {
    aircraftId: clr.aircraftId,
    cause: { kind: "clearance", clearanceId: clr.id },
    data: { clearanceId: clr.id, clearanceType: clr.type },
  });
  const ac = sim.get(clr.aircraftId);
  if (!ac) return;
  if (ACT_ON_TRANSMIT.has(clr.type)) {
    if (!revalidate(sim, ac, clr).ok) return;
    activate(sim, ac, clr);
  }
  if (!ac.externallyControlled && sim.aircraft.has(ac.id)) {
    // Quick enough that the readback is on the air before anyone else keys up.
    sim.timers.push({ at: sim.time + 0.2 + sim.rng.range(0, 0.3), action: { kind: "readback", clearanceId: clr.id } });
  }
}

/**
 * The pilot's readback arrived. `text` is checked against the structured
 * clearance when it came from a human or STT; the built-in pilot's
 * readbacks are generated from the clearance and need no check.
 */
export function confirmReadback(sim: Simulation, clr: Clearance, text?: string): CommandResult {
  if (clr.status !== "transmitted") {
    return { ok: false, code: "NOT_AWAITING_READBACK", message: `Clearance ${clr.id} is ${clr.status}, not awaiting a readback.` };
  }
  const ac = sim.get(clr.aircraftId);
  if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: "Aircraft has left the simulation." };
  if (text !== undefined) {
    const check = matchReadback({ ...clr, callsign: ac.callsign }, text);
    if (!check.ok) {
      sim.emit("readback.incorrect", {
        aircraftId: ac.id,
        attention: true,
        cause: { kind: "clearance", clearanceId: clr.id },
        data: { clearanceId: clr.id, heard: text, expected: clr.expectedReadback, missing: check.missing },
      });
      return {
        ok: false,
        code: "READBACK_INCORRECT",
        message: `Readback did not match: missing ${check.missing.join(", ")}.`,
        details: { expected: clr.expectedReadback, missing: check.missing },
      };
    }
  }
  const verdict = clr.active ? undefined : revalidate(sim, ac, clr);
  if (verdict?.ok === false) return verdict;
  if (verdict?.plan.reserve && clr.runwayId && sim.runwayState.get(clr.runwayId)?.reservation?.clearanceId !== clr.id) {
    reserve(sim, clr.runwayId, ac.id, verdict.plan.reserve, clr.id);
  }
  clr.status = "acknowledged";
  clr.acknowledgedAt = sim.time;
  if (ac.clearance?.id === clr.id) ac.clearance.status = "acknowledged";
  sim.emit("clearance.acknowledged", {
    aircraftId: ac.id,
    cause: { kind: "clearance", clearanceId: clr.id },
    data: { clearanceId: clr.id, clearanceType: clr.type, readback: text ?? clr.expectedReadback },
  });
  if (!clr.active) activate(sim, ac, clr, verdict?.plan.route);
  settleRequests(sim, ac, clr);
  return { ok: true, clearanceId: clr.id, status: clr.status };
}

function settleRequests(sim: Simulation, ac: Aircraft, clr: Clearance): void {
  const resolves = RESOLVES[clr.type];
  const defers = DEFERS[clr.type] ?? [];
  for (const r of sim.requests.values()) {
    if (r.aircraftId !== ac.id || (r.status !== "pending" && r.status !== "transmitting")) continue;
    if (r.type === resolves) {
      r.status = "answered";
      r.answeredBy = clr.id;
      r.closedAt = sim.time;
      sim.emit("request.answered", {
        aircraftId: ac.id,
        cause: { kind: "clearance", clearanceId: clr.id },
        data: { requestId: r.id, requestType: r.type, clearanceId: clr.id },
      });
    } else if (defers.includes(r.type)) {
      r.deferredBy = clr.id;
      r.deferredAt = sim.time;
    }
  }
}

/** Turn an accepted clearance into aircraft behaviour. */
function activate(sim: Simulation, ac: Aircraft, clr: Clearance, route = clr.route): void {
  clr.active = true;
  const cause = { kind: "clearance" as const, clearanceId: clr.id };
  const g = sim.graph;
  sim.emit("clearance.activated", { aircraftId: ac.id, cause, data: { clearanceId: clr.id, clearanceType: clr.type } });

  const clearIncursionHold = () => {
    if (ac.flags.incursionActive || ac.flags.incursionHold) {
      ac.flags.ignoreNextHold = false;
      resolveEmergenciesFor(sim, ac.id, ["runway_incursion"]);
    }
    ac.flags.incursionActive = false;
    if (ac.flags.incursionHold) {
      ac.flags.incursionHold = false;
      ac.holdPosition = false;
    }
  };
  const lineUpRoute = (runwayId: string) => {
    const ref = g.runwayEnd(clr.runway)!;
    const threshold = ref.end.thresholdNode;
    if (ac.route[ac.route.length - 1] !== threshold) {
      const holds = g.departureHolds(ref.end.designator);
      const at = ac.route.findIndex((n, idx) => idx >= ac.currentWaypointIndex && holds.includes(n));
      if (at >= 0) ac.route = [...ac.route.slice(0, at + 1), threshold];
      else ac.route = [...ac.route, threshold];
    }
    ac.routeLimitIndex = ac.route.length - 1;
    if (runwayOccupiedBy(sim, ac) === runwayId && ac.phase === "taxi_out") sim.setPhase(ac, "line_up", cause, { runwayId });
  };

  switch (clr.type) {
    case "PUSHBACK":
      ac.route = route ?? ac.route;
      ac.currentWaypointIndex = 0;
      ac.distToNextM = 0;
      ac.routeLimitIndex = ac.route.length - 1;
      ac.flags.pushbackComplete = false;
      sim.setPhase(ac, "pushback", cause);
      break;

    case "TAXI": {
      // A new route voids any runway permission the old one relied on.
      for (const rw of Object.keys(ac.runwayAuth)) {
        delete ac.runwayAuth[rw];
        release(sim, rw, ac.id, "re-routed");
      }
      closeOpenClearances(sim, ac.id, ["TAXI", "CROSS_RUNWAY", "LINE_UP_AND_WAIT", "HOLD_SHORT", "HOLD_POSITION"], "superseded", "new taxi clearance", clr.id);
      setRoute(ac, route ?? []);
      ac.holdPosition = false;
      ac.flags.taxiClearanceCancelled = false;
      if (ac.flight === "departure") {
        ac.assignedRunway = clr.runway ?? ac.assignedRunway;
        if (ac.phase === "pushback") sim.setPhase(ac, "taxi_out", cause);
      } else {
        ac.gate = clr.gate ?? ac.gate;
      }
      break;
    }

    case "HOLD_SHORT": {
      const rw = clr.runwayId!;
      if (ac.runwayAuth[rw] && runwayOccupiedBy(sim, ac) !== rw) {
        delete ac.runwayAuth[rw];
        closeOpenClearances(sim, ac.id, ["CROSS_RUNWAY", "LINE_UP_AND_WAIT", "CLEARED_TAKEOFF"], "superseded", "told to hold short", clr.id, rw);
        release(sim, rw, ac.id, "told to hold short");
      }
      break;
    }

    case "CROSS_RUNWAY":
      ac.runwayAuth[clr.runwayId!] = "cross";
      closeOpenClearances(sim, ac.id, ["HOLD_SHORT"], "superseded", "cleared to cross", clr.id, clr.runwayId);
      clearIncursionHold();
      break;

    case "LINE_UP_AND_WAIT":
      ac.runwayAuth[clr.runwayId!] = "lineup";
      ac.assignedRunway = clr.runway;
      lineUpRoute(clr.runwayId!);
      closeOpenClearances(sim, ac.id, ["HOLD_SHORT"], "superseded", "cleared to line up", clr.id, clr.runwayId);
      clearIncursionHold();
      break;

    case "CLEARED_TAKEOFF":
      ac.runwayAuth[clr.runwayId!] = "takeoff";
      ac.assignedRunway = clr.runway;
      lineUpRoute(clr.runwayId!);
      closeOpenClearances(sim, ac.id, ["LINE_UP_AND_WAIT", "HOLD_SHORT", "HOLD_POSITION"], "superseded", "cleared for takeoff", clr.id);
      ac.holdPosition = false;
      clearIncursionHold();
      break;

    case "CLEARED_TO_LAND":
      ac.landingCleared = true;
      closeOpenClearances(sim, ac.id, ["CONTINUE_APPROACH"], "superseded", "cleared to land", clr.id);
      break;

    case "GO_AROUND":
      goAround(sim, ac, cause, "instructed by tower");
      break;

    case "HOLD":
      sim.setPhase(ac, "holding", cause);
      break;

    case "CONTINUE_APPROACH":
      if (ac.phase === "holding") {
        sim.setPhase(ac, "approach", cause);
        closeOpenClearances(sim, ac.id, ["HOLD"], "completed", "released from the hold", clr.id);
      }
      break;

    case "HOLD_POSITION":
      ac.holdPosition = true;
      if (ac.flags.incursionActive) {
        ac.flags.incursionActive = false;
        ac.flags.incursionHold = true;
      }
      // Conditions change while it waits, so rolling again takes a newly validated takeoff clearance.
      closeOpenClearances(sim, ac.id, ["CLEARED_TAKEOFF"], "cancelled", "told to hold position", clr.id);
      break;

    case "CONTINUE_TAXI":
      ac.holdPosition = false;
      ac.flags.incursionHold = false;
      closeOpenClearances(sim, ac.id, ["HOLD_POSITION"], "completed", "told to continue", clr.id);
      closeClearance(sim, clr, "completed", "taxi resumed");
      break;

    case "RUNWAY_CHANGE":
      moveToRunway(sim, ac, clr.runway!);
      closeClearance(sim, clr, "completed", "changed runway");
      break;

    case "VECTOR": {
      ac.flags.vectored = true;
      for (const wp of ac.airRoute.slice(ac.airIndex)) {
        if (wp.tag !== "circuit" && wp.tag !== "rejoin") break;
        wp.altFt = clr.vector!.altitudeFt;
        wp.speedKts = clr.vector!.speedKts;
      }
      break;
    }

    case "RETURN_TO_LAND":
      ac.flags.priorityReturn = true;
      ac.airRoute = priorityRoute(g, clr.runway!, ac.type, ac.position);
      ac.airIndex = 0;
      break;
  }
}

export function closeClearance(sim: Simulation, clr: Clearance, status: ClosedClearanceStatus, why: string): void {
  if (!isOpenClearance(clr)) return;
  const wasActive = clr.active;
  clr.status = status;
  clr.closedAt = sim.time;
  clr.closeReason = why;
  const ac = sim.get(clr.aircraftId);
  if (ac?.clearance?.id === clr.id) ac.clearance.status = status;

  const pendingRadio = [...sim.radio.queue, ...sim.radio.onAir];
  for (const tx of pendingRadio) {
    if (tx.clearanceId === clr.id) failTransmission(sim, tx, `Clearance ${status}: ${why}`);
  }

  // Give the runway back, unless the aircraft is physically on it.
  if (clr.runwayId) {
    const state = sim.runwayState.get(clr.runwayId);
    const onRunway = ac && runwayOccupiedBy(sim, ac) === clr.runwayId;
    if (state?.reservation?.clearanceId === clr.id) {
      if (!onRunway || status === "completed") release(sim, clr.runwayId, clr.aircraftId, why);
    }
    const auth = ac?.runwayAuth[clr.runwayId];
    if (ac && wasActive && status !== "completed" && auth && RUNWAY_AUTH_CLEARANCE[auth] === clr.type) {
      const stillAuthorized = [...sim.clearances.values()].some(
        (c) => c.aircraftId === ac.id && c.runwayId === clr.runwayId && c.type === clr.type && c.active && isOpenClearance(c),
      );
      if (!stillAuthorized) {
        if (!onRunway) delete ac.runwayAuth[clr.runwayId];
        // An aircraft on the runway may finish aligning or crossing, but cannot start a cancelled takeoff.
        else if (auth === "takeoff" && ac.phase === "line_up") ac.runwayAuth[clr.runwayId] = "lineup";
      }
    }
  }
  if (ac && clr.type === "CLEARED_TO_LAND" && status !== "completed") ac.landingCleared = false;

  sim.emit("clearance.closed", {
    aircraftId: clr.aircraftId,
    attention: status === "expired",
    cause: { kind: "clearance", clearanceId: clr.id },
    data: { clearanceId: clr.id, clearanceType: clr.type, status, why, wasActive },
  });
}

/** Close this aircraft's open clearances of the given types. */
export function closeOpenClearances(
  sim: Simulation,
  aircraftId: string,
  types: ClearanceType[],
  status: ClosedClearanceStatus,
  why: string,
  exceptId?: string,
  runwayId?: string,
): void {
  for (const c of sim.clearances.values()) {
    if (c.aircraftId !== aircraftId || c.id === exceptId || !isOpenClearance(c) || !types.includes(c.type)) continue;
    if (runwayId && c.runwayId !== runwayId) continue;
    closeClearance(sim, c, status, why);
  }
}

export function completeClearances(
  sim: Simulation,
  aircraftId: string,
  types: ClearanceType[],
  why: string,
  runwayId?: string,
): void {
  closeOpenClearances(sim, aircraftId, types, "completed", why, undefined, runwayId);
}

export function cancelClearance(sim: Simulation, clearanceId: string, reason: string): CommandResult {
  const clr = sim.clearances.get(clearanceId);
  if (!clr) return { ok: false, code: "UNKNOWN_CLEARANCE", message: `No clearance ${clearanceId}.` };
  if (!isOpenClearance(clr)) return { ok: false, code: "ALREADY_CLOSED", message: `Clearance ${clearanceId} is already ${clr.status}.` };
  const ac = sim.get(clr.aircraftId);
  const committedLanding = ac?.phase === "landing" && clr.type === "CLEARED_TO_LAND";
  const onRunway = ac && clr.runwayId && runwayOccupiedBy(sim, ac) === clr.runwayId;
  if (committedLanding || (onRunway && (ac.phase === "takeoff" || ac.phase === "rollout"))) {
    return { ok: false, code: "TOO_LATE", message: `${ac.callsign} is already using the runway.` };
  }
  closeClearance(sim, clr, "cancelled", reason);
  if (ac && clr.active && clr.type === "TAXI" && ["taxi_out", "taxi_in", "holding_short"].includes(ac.phase)) {
    stopAfterTaxiCancellation(sim, ac);
  }
  return { ok: true, clearanceId, status: "cancelled" };
}

export function stopAfterTaxiCancellation(sim: Simulation, ac: Aircraft): void {
  const occupiedRunway = runwayOccupiedBy(sim, ac);
  ac.flags.taxiClearanceCancelled = true;
  if (occupiedRunway) {
    // Let a crossing already in progress reach the first hold line clear of the runway.
    const exit = ac.route.findIndex((id, i) =>
      i >= Math.max(1, ac.currentWaypointIndex)
      && sim.graph.node(id).guards === occupiedRunway
      && sim.graph.node(ac.route[i - 1]).kind === "runway",
    );
    if (exit >= 0) ac.routeLimitIndex = Math.min(ac.routeLimitIndex, exit);
  } else {
    ac.holdPosition = true;
  }
  for (const clr of sim.clearances.values()) {
    if (clr.aircraftId !== ac.id || !clr.runwayId) continue;
    if (clr.type === "CROSS_RUNWAY" && clr.runwayId === occupiedRunway) continue;
    if (clr.type === "CROSS_RUNWAY" || clr.type === "LINE_UP_AND_WAIT" || clr.type === "CLEARED_TAKEOFF") {
      closeClearance(sim, clr, "cancelled", "taxi route cancelled");
    }
  }
}

/** What the validator would accept for this aircraft right now. Nothing is issued or logged. */
export function availableClearances(sim: Simulation, aircraftId: string): { type: ClearanceType; runway?: string; gate?: string }[] {
  const ac = sim.get(aircraftId);
  if (!ac) return [];
  const pending = [...sim.clearances.values()].filter((c) => c.aircraftId === ac.id && isPending(c));
  const out: { type: ClearanceType; runway?: string; gate?: string }[] = [];
  for (const type of CLEARANCE_TYPES) {
    if (pending.length && (!OVERRIDES_PENDING.has(type) || pending.some((c) => c.type === type))) continue;
    if (type === "HOLD_POSITION" && ac.holdPosition) continue;
    const verdict = validate(sim, ac, { type: "clearance.issue", aircraftId: ac.id, clearanceType: type, reason: "check" });
    if (verdict.ok) out.push({ type, runway: verdict.plan.runway, gate: verdict.plan.gate });
  }
  return out;
}

/** `closing`: runways being shut now, which withdraws clearances not yet being flown. */
export function reconcileRunwayClearances(
  sim: Simulation,
  next: Simulation["activeRunways"],
  closing: readonly string[] = [],
): CommandResult {
  const disabled = [...sim.clearances.values()].filter((clr) => {
    if (!isOpenClearance(clr) || !clr.runway) return false;
    switch (clr.type) {
      case "CLEARED_TO_LAND":
        return !mayLand(sim.get(clr.aircraftId), clr.runway, next);
      case "LINE_UP_AND_WAIT":
      case "CLEARED_TAKEOFF":
        return !next.departures.includes(clr.runway);
      case "TAXI":
        return isPending(clr) && !next.departures.includes(clr.runway);
      default:
        return false;
    }
  });
  const committed = disabled.find((clr) => {
    if (!clr.active) return false;
    const ac = sim.get(clr.aircraftId);
    if (!ac || !clr.runwayId || !closing.includes(clr.runwayId)) return true;
    return ["landing", "rollout", "takeoff"].includes(ac.phase) || runwayOccupiedBy(sim, ac) === clr.runwayId;
  });
  if (committed) {
    return no("RUNWAY_IN_USE", `${committed.aircraftId} has an active clearance for runway ${committed.runway}.`, {
      clearanceId: committed.id,
      runway: committed.runway,
    });
  }
  for (const ac of sim.aircraft.values()) {
    if (ac.phase !== "line_up" && ac.phase !== "takeoff" && ac.phase !== "rollout") continue;
    const ref = sim.graph.runwayEnd(ac.assignedRunway);
    if (!ref || runwayOccupiedBy(sim, ac) !== ref.runway.id) continue;
    const designator = ref.end.designator;
    const allowed = ac.phase === "rollout" ? mayLand(ac, designator, next) : next.departures.includes(designator);
    if (!allowed) {
      return no("RUNWAY_IN_USE", `${ac.callsign} is using runway ${ac.assignedRunway}.`, { runway: ac.assignedRunway });
    }
  }
  for (const clr of disabled) closeClearance(sim, clr, "expired", `Runway ${clr.runway} is no longer active.`);
  return { ok: true };
}

export function stepClearanceTimeouts(sim: Simulation): void {
  const rules = sim.config.rules;
  for (const clr of sim.clearances.values()) {
    // One speaker for every position: a routine instruction may wait longer for its turn.
    if (clr.status === "issued" && sim.time - clr.issuedAt > rules.untransmittedTimeoutSec * (sim.config.oneSpeaker ? 2 : 1)) {
      closeClearance(sim, clr, "expired", "never transmitted");
    } else if (clr.status === "transmitted" && sim.time - (clr.transmittedAt ?? 0) > rules.readbackTimeoutSec) {
      if (clr.active) {
        clr.status = "readback_missing";
        const ac = sim.get(clr.aircraftId);
        if (ac?.clearance?.id === clr.id) ac.clearance.status = "readback_missing";
        sim.emit("readback.missing", {
          aircraftId: clr.aircraftId,
          attention: true,
          cause: { kind: "clearance", clearanceId: clr.id },
          data: { clearanceId: clr.id, clearanceType: clr.type },
        });
      } else {
        closeClearance(sim, clr, "expired", "no readback");
      }
    }
  }
}
