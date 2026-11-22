import type { AirportGraph, RunwayEndRef } from "../airport/graph";
import { add, angleDiff, bearing, dist, dot, FT, headingVec, KT, NM, scale, sub, turnToward } from "../geometry";
import { spokenCallsign } from "../radio/phraseology";
import type { Aircraft, AirWaypoint, Cause, Vec2 } from "../types";
import { closeOpenClearances, completeClearances } from "./clearances";
import { resolveEmergenciesFor } from "./emergencies";
import { performance } from "./performance";
import { enqueueTransmission } from "./radio";
import { distanceToThreshold, flyingSec, occupiedByOthers, release, touchdownIn } from "./runways";
import type { Simulation } from "./simulation";
import { removeAircraft } from "./spawn";

/**
 * Airborne movement: simplified 2D kinematics with altitude. Aircraft steer
 * toward the next waypoint at a standard-rate turn; on approach they follow
 * a 3-degree path to a touchdown point 300 m past the threshold.
 */

const TURN_RATE = 3; // deg/s
const GLIDE_TAN = Math.tan((3 * Math.PI) / 180);
const TOUCHDOWN_OFFSET_M = 300;
const TAKEOFF_ACCEL_KTS = 3.2; // kt/s
const CLIMB_FPS = 40;
const ONE_ENGINE_CLIMB_FPS = 12;
const DESCENT_FPS = 25;
const EXIT_SPEED = 8;
const ROLLOUT_DECEL = 1.7;
const MAX_EXIT_TURN_DEG = 135;
const EXIT_LOOKAHEAD_M = 700;
export const MISSED_APPROACH_FT = 5000;
const CIRCUIT_OUT_NM = 3.5;
const ESTABLISHED_NM = 0.35;
/** Same or closely spaced final: do not turn in this near another touchdown. */
const REJOIN_GAP_SEC = 110;
const MOST_EXTENDED_NM = 26;
const REJOIN_DESCENT_NM = 3;

export function touchdownPoint(ref: RunwayEndRef): Vec2 {
  return add(ref.end.threshold, scale(headingVec(ref.end.headingDeg), TOUCHDOWN_OFFSET_M));
}

export function glidepathAltFt(distanceToTouchdownM: number): number {
  return (distanceToTouchdownM * GLIDE_TAN) / FT;
}

/** +1 where the outside of the airport is right of this runway's course, -1 where it is left. */
function outward(graph: AirportGraph, ref: RunwayEndRef): number {
  const mid = scale(add(ref.end.threshold, ref.opposite.threshold), 0.5);
  return dot(sub(mid, graph.data.center), headingVec(ref.end.headingDeg + 90)) >= 0 ? 1 : -1;
}

/** The two sides of the airport join their finals 1000 ft apart. */
export function interceptAltFt(graph: AirportGraph, ref: RunwayEndRef): number {
  return outward(graph, ref) > 0 ? 3000 : 4000;
}

/** Metres right of the extended centreline. */
export function crossTrack(ref: RunwayEndRef, p: Vec2): number {
  return dot(sub(p, ref.end.threshold), headingVec(ref.end.headingDeg + 90));
}

/** On its own final, not still turning on to it. */
export function established(sim: Simulation, ac: Aircraft): boolean {
  if (ac.phase === "landing") return true;
  if (ac.phase !== "approach") return false;
  const ref = sim.graph.runwayEnd(ac.assignedRunway);
  return !!ref && Math.abs(crossTrack(ref, ac.position)) < ESTABLISHED_NM * NM && Math.abs(angleDiff(ac.headingDeg, ref.end.headingDeg)) < 25;
}

export function approachRoute(graph: AirportGraph, designator: string, type: string, interceptNm = 10): AirWaypoint[] {
  const ref = graph.runwayEnd(designator);
  if (!ref) return [];
  const dir = headingVec(ref.end.headingDeg);
  const td = touchdownPoint(ref);
  const back = (nm: number) => sub(td, scale(dir, nm * NM));
  return [
    { name: `IF${designator}`, ...back(interceptNm), altFt: interceptAltFt(graph, ref), speedKts: 180, tag: "if" },
    { name: `FAF${designator}`, ...back(5), speedKts: 160, tag: "faf" },
    { name: `RW${designator}`, ...td, altFt: 0, speedKts: performance(type).vapp, tag: "touchdown" },
  ];
}

/**
 * Missed approach: turn away from the other runways at once while climbing above
 * both intercept altitudes, fly downwind, and rejoin where there is a gap.
 */
export function circuitRoute(graph: AirportGraph, designator: string, type: string, from: Vec2, behindNm = -Infinity): AirWaypoint[] {
  const ref = graph.runwayEnd(designator);
  if (!ref) return [];
  const dir = headingVec(ref.end.headingDeg);
  const out = scale(headingVec(ref.end.headingDeg + 90), outward(graph, ref) * CIRCUIT_OUT_NM * NM);
  const td = touchdownPoint(ref);
  const turnedOut = Math.max(dot(sub(from, td), dir) / NM + 2, behindNm);
  const rejoinNm = Math.max(10, 2 - turnedOut);
  const point = (alongNm: number) => add(add(td, scale(dir, alongNm * NM)), out);
  return [
    { name: "TURNOUT", ...point(turnedOut), altFt: 4000, speedKts: 190, tag: "circuit" },
    { name: "DOWNWIND", ...point(-rejoinNm), altFt: 4000, speedKts: 190, tag: "rejoin" },
    ...approachRoute(graph, designator, type, rejoinNm),
  ];
}

/** An emergency return: a tight pattern on the outside of the airport and a short final. */
export function priorityRoute(graph: AirportGraph, designator: string, type: string, from: Vec2): AirWaypoint[] {
  const ref = graph.runwayEnd(designator);
  if (!ref) return [];
  const dir = headingVec(ref.end.headingDeg);
  const right = headingVec(ref.end.headingDeg + 90);
  const side = outward(graph, ref);
  const td = touchdownPoint(ref);
  const point = (alongNm: number, outNm: number) => add(add(td, scale(dir, alongNm * NM)), scale(right, side * outNm * NM));
  const here = dot(sub(from, td), dir) / NM;
  return [
    { name: "RETURN", ...point(here, 1.6), altFt: 2000, speedKts: 190, tag: "circuit" },
    { name: "ABEAM", ...point(0, 1.6), altFt: 1300, speedKts: 180, tag: "circuit" },
    { name: "BASE", ...point(-1.8, 1.6), altFt: 900, speedKts: 150, tag: "rejoin" },
    { name: `RW${designator}`, ...td, altFt: 0, speedKts: performance(type).vapp, tag: "touchdown" },
  ];
}

export function departureRoute(graph: AirportGraph, designator: string, handoffNm: number): AirWaypoint[] {
  const ref = graph.runwayEnd(designator);
  if (!ref) return [];
  const side = outward(graph, ref);
  // Departures diverge from each other and climb to different levels.
  const exit = add(ref.opposite.threshold, scale(headingVec(ref.end.headingDeg + side * 15), handoffNm * NM));
  return [{ name: "DEP", ...exit, altFt: side > 0 ? 6000 : 5000, speedKts: 220, tag: "departure_exit" }];
}

function approach(v: number, target: number, up: number, down: number): number {
  if (target > v) return Math.min(target, v + up);
  return Math.max(target, v - down);
}

export function stepAir(sim: Simulation, ac: Aircraft): void {
  if (ac.phase === "takeoff") return stepTakeoff(sim, ac);
  const dt = sim.config.dt;

  if (ac.phase === "holding") {
    ac.headingDeg = (ac.headingDeg + TURN_RATE * dt) % 360;
    ac.speedKts = approach(ac.speedKts, 180, 1.5 * dt, 1.2 * dt);
    ac.position = add(ac.position, scale(headingVec(ac.headingDeg), ac.speedKts * KT * dt));
    return;
  }

  if (ac.phase === "landing") {
    const ref = sim.graph.runwayEnd(ac.assignedRunway)!;
    if (occupiedByOthers(sim, ref.runway.id, ac.id).length > 0) {
      goAround(sim, ac, { kind: "auto", rule: "runway_occupied" }, "runway occupied");
      return;
    }
  }

  const wp = ac.airRoute[ac.airIndex];
  if (wp) {
    const brg = bearing(ac.position, wp);
    ac.headingDeg = turnToward(ac.headingDeg, brg, TURN_RATE * dt);
    if (wp.speedKts !== undefined) ac.speedKts = approach(ac.speedKts, wp.speedKts, 1.5 * dt, 1.2 * dt);
  }

  // Altitude: glidepath on approach, otherwise toward the waypoint's altitude.
  if (ac.phase === "approach" || ac.phase === "landing") {
    const ref = sim.graph.runwayEnd(ac.assignedRunway);
    if (ref) {
      const gp = glidepathAltFt(dist(ac.position, touchdownPoint(ref)));
      // Vertical separation from the other final holds until it is established on its own.
      const floor = ac.flags.priorityReturn || established(sim, ac) ? gp : Math.max(gp, interceptAltFt(sim.graph, ref));
      if (ac.altitudeFt > floor) ac.altitudeFt = Math.max(floor, ac.altitudeFt - DESCENT_FPS * dt);
    }
  } else if (wp?.altFt !== undefined) {
    if (ac.phase === "go_around" && wp.tag === "rejoin" && !ac.flags.priorityReturn && !ac.emergencyId && dist(ac.position, wp) < REJOIN_DESCENT_NM * NM) {
      // Through the other intercept altitude while still well clear of that final.
      const intercept = interceptAltFt(sim.graph, sim.graph.runwayEnd(ac.assignedRunway)!);
      if (wp.altFt > intercept && levelBelowFree(sim, ac, intercept)) wp.altFt = intercept;
    }
    const climb = ac.flags.emergencyReturn ? ONE_ENGINE_CLIMB_FPS : CLIMB_FPS;
    ac.altitudeFt = approach(ac.altitudeFt, wp.altFt, climb * dt, DESCENT_FPS * dt);
  }

  const v = ac.speedKts * KT;
  ac.position = add(ac.position, scale(headingVec(ac.headingDeg), v * dt));

  if (wp) {
    const d = dist(ac.position, wp);
    if (wp.tag === "touchdown") {
      const ref = sim.graph.runwayEnd(ac.assignedRunway)!;
      const along = dot(sub(ac.position, wp), headingVec(ref.end.headingDeg));
      if (ac.phase === "landing" && (along >= 0 || d < 40)) return touchdown(sim, ac);
    } else {
      const behind = Math.abs(angleDiff(ac.headingDeg, bearing(ac.position, wp))) > 90;
      if (d < Math.max(600, v * 8, turnLeadM(ac, wp, v)) || (behind && d < 2500)) {
        if (wp.tag !== "rejoin" || !extendDownwind(sim, ac, wp)) reachWaypoint(sim, ac, wp);
      }
    }
  }
  if (!sim.aircraft.has(ac.id)) return;

  // --- approach gates
  if (ac.phase === "approach") {
    const rules = sim.config.rules;
    const toThreshold = distanceToThreshold(sim, ac);
    if (!ac.landingCleared && !ac.flags.clearanceNeededNotified && toThreshold < rules.clearanceNeededNm * NM) {
      ac.flags.clearanceNeededNotified = true;
      sim.emit("approach.clearance_needed", {
        aircraftId: ac.id,
        attention: true,
        cause: { kind: "auto", rule: "approach_gate" },
        data: { runway: ac.assignedRunway, distanceNm: toThreshold / NM },
      });
    }
    if (toThreshold <= rules.decisionDistanceNm * NM && ac.airRoute[ac.airIndex]?.tag === "touchdown") {
      const ref = sim.graph.runwayEnd(ac.assignedRunway)!;
      const others = occupiedByOthers(sim, ref.runway.id, ac.id);
      if (ac.landingCleared && others.length === 0) {
        const clr = [...sim.clearances.values()].find(
          (c) => c.aircraftId === ac.id && c.type === "CLEARED_TO_LAND" && c.active && c.status === "acknowledged",
        );
        sim.setPhase(ac, "landing", clr ? { kind: "clearance", clearanceId: clr.id } : { kind: "auto", rule: "landing" });
      } else {
        goAround(
          sim,
          ac,
          { kind: "auto", rule: ac.landingCleared ? "runway_occupied" : "no_landing_clearance" },
          ac.landingCleared ? "runway occupied" : "no landing clearance",
        );
      }
    }
  }
}

/** How early to turn on to final so as not to swing through it toward the other one. */
function turnLeadM(ac: Aircraft, wp: AirWaypoint, v: number): number {
  const next = ac.airRoute[ac.airIndex + 1];
  if (wp.tag !== "if" || !next) return 0;
  const bend = Math.min(120, Math.abs(angleDiff(ac.headingDeg, bearing(wp, next))));
  return Math.min(3500, (v / (TURN_RATE * (Math.PI / 180))) * Math.tan((bend * Math.PI) / 360));
}

/** Nobody on this side of the airport is in the levels it would descend through. */
function levelBelowFree(sim: Simulation, ac: Aircraft, down: number): boolean {
  const mine = sim.graph.runwayEnd(ac.assignedRunway)!;
  for (const o of sim.aircraft.values()) {
    if (o === ac || o.assignedRunway !== mine.end.designator || o.altitudeFt <= 200) continue;
    if (o.altitudeFt < down - 990 || o.altitudeFt > ac.altitudeFt) continue;
    if (dist(o.position, ac.position) < 3.3 * NM) return false;
  }
  return true;
}

/** No gap to turn into: one mile further downwind, then look again. */
function extendDownwind(sim: Simulation, ac: Aircraft, wp: AirWaypoint): boolean {
  if (ac.phase !== "go_around" || ac.priority === "emergency") return false;
  const ref = sim.graph.runwayEnd(ac.assignedRunway)!;
  const dir = headingVec(ref.end.headingDeg);
  const td = touchdownPoint(ref);
  const joinNm = -dot(sub(ac.position, td), dir) / NM;
  if (joinNm >= MOST_EXTENDED_NM) return false;
  const level = interceptAltFt(sim.graph, ref);
  const eta = touchdownIn(sim, ac);
  // Still above it, because somebody is underneath.
  const high = wp.altFt !== undefined && wp.altFt > level;
  const crowded = [...sim.aircraft.values()].some((o) => {
    if (o === ac || (o.phase !== "approach" && o.phase !== "landing")) return false;
    const theirs = sim.graph.runwayEnd(o.assignedRunway);
    if (!theirs || Math.abs(angleDiff(theirs.end.headingDeg, ref.end.headingDeg)) > 30) return false;
    if (Math.abs(crossTrack(ref, theirs.end.threshold)) < 0.7 * NM) return Math.abs(touchdownIn(sim, o) - eta) < REJOIN_GAP_SEC;
    // The other final is crossed at less than 3 NM only in the last part of the base leg.
    const theirNm = -dot(sub(o.position, td), dir) / NM - (o.speedKts * flyingSec(CIRCUIT_OUT_NM * NM)) / 3600;
    const theirFt = Math.min(interceptAltFt(sim.graph, theirs), glidepathAltFt(theirNm * NM));
    return Math.abs(theirNm - joinNm) < 3.5 && Math.abs(theirFt - level) < 1000;
  });
  if (!crowded && !high) return false;
  Object.assign(wp, sub(wp, scale(dir, NM)));
  const intercept = ac.airRoute[ac.airIndex + 1];
  if (intercept?.tag === "if") Object.assign(intercept, sub(td, scale(dir, Math.max(10, joinNm + 1) * NM)));
  return true;
}

function reachWaypoint(sim: Simulation, ac: Aircraft, wp: AirWaypoint): void {
  ac.airIndex++;
  if (wp.tag === "rejoin" && ac.phase === "go_around") {
    sim.setPhase(ac, "approach", { kind: "auto", rule: "approach_reestablished" });
    completeClearances(sim, ac.id, ["GO_AROUND", "VECTOR"], "re-established on approach");
    sim.emit("approach.established", {
      aircraftId: ac.id,
      attention: true,
      cause: { kind: "auto", rule: "approach_reestablished" },
      data: { runway: ac.assignedRunway },
    });
  } else if (wp.tag === "departure_exit") {
    sim.stats.departed++;
    removeAircraft(sim, ac, "aircraft.handed_off", { kind: "auto", rule: "left_tower_airspace" });
  }
}

// ------------------------------------------------------------------ takeoff

export function startTakeoffRoll(sim: Simulation, ac: Aircraft): void {
  const ref = sim.graph.runwayEnd(ac.assignedRunway);
  if (!ref) return;
  const clr = [...sim.clearances.values()].find(
    (c) => c.aircraftId === ac.id && c.type === "CLEARED_TAKEOFF" && c.active && c.status === "acknowledged",
  );
  const cause: Cause = clr ? { kind: "clearance", clearanceId: clr.id } : { kind: "auto", rule: "takeoff" };
  sim.setPhase(ac, "takeoff", cause, { runway: ac.assignedRunway });
  completeClearances(sim, ac.id, ["LINE_UP_AND_WAIT"], "takeoff roll started");
  ac.position = { ...ref.end.threshold };
  ac.route = [];
  ac.currentWaypointIndex = 0;
  ac.routeLimitIndex = 0;
  ac.distToNextM = 0;
  ac.flags.airborne = false;
  for (const [node, owner] of sim.nodeClaims) if (owner === ac.id) sim.nodeClaims.delete(node);
  const state = sim.runwayState.get(ref.runway.id)!;
  state.lastDepartureRollAt = sim.time;
  state.lastDepartureId = ac.id;
  sim.emit("aircraft.takeoff_roll", { aircraftId: ac.id, cause, data: { runway: ac.assignedRunway } });
  resolveEmergenciesFor(sim, ac.id, ["runway_incursion"]);
}

function stepTakeoff(sim: Simulation, ac: Aircraft): void {
  const dt = sim.config.dt;
  const ref = sim.graph.runwayEnd(ac.assignedRunway)!;
  const dir = headingVec(ref.end.headingDeg);
  ac.headingDeg = ref.end.headingDeg;
  ac.speedKts = Math.min(175, ac.speedKts + TAKEOFF_ACCEL_KTS * dt);
  ac.position = add(ac.position, scale(dir, ac.speedKts * KT * dt));
  if (!ac.flags.airborne && ac.speedKts >= performance(ac.type).vr) {
    ac.flags.airborne = true;
    sim.emit("aircraft.airborne", {
      aircraftId: ac.id,
      cause: { kind: "auto", rule: "rotation" },
      data: { runway: ac.assignedRunway },
    });
  }
  if (ac.flags.airborne) ac.altitudeFt += CLIMB_FPS * dt;

  const along = dot(sub(ac.position, ref.end.threshold), dir);
  if (ac.flags.airborne && (along >= ref.runway.lengthM || ac.altitudeFt >= 1000)) {
    sim.setPhase(ac, "departure", { kind: "auto", rule: "clear_of_runway" }, { runway: ac.assignedRunway });
    ac.airRoute = departureRoute(sim.graph, ac.assignedRunway!, sim.config.rules.handoffDistanceNm);
    ac.airIndex = 0;
    delete ac.runwayAuth[ref.runway.id];
    completeClearances(sim, ac.id, ["CLEARED_TAKEOFF"], "airborne");
    release(sim, ref.runway.id, ac.id, "departure airborne");
  }
}

// ---------------------------------------------------------------- go-around

/** Where to join downwind so as to be behind whoever is already flying it. */
function behindCircuitTraffic(sim: Simulation, ac: Aircraft, ref: RunwayEndRef): number {
  let behind = -Infinity;
  const dir = headingVec(ref.end.headingDeg);
  for (const o of sim.aircraft.values()) {
    if (o === ac || o.phase !== "go_around" || o.assignedRunway !== ref.end.designator || o.airIndex !== 1) continue;
    behind = Math.max(behind, dot(sub(o.position, touchdownPoint(ref)), dir) / NM + 5);
  }
  return behind;
}

export function goAround(sim: Simulation, ac: Aircraft, cause: Cause, reason: string): void {
  const ref = sim.graph.runwayEnd(ac.assignedRunway);
  if (!ref) return;
  ac.landingCleared = false;
  ac.flags.clearanceNeededNotified = false;
  closeOpenClearances(sim, ac.id, ["CLEARED_TO_LAND", "CONTINUE_APPROACH", "HOLD"], "cancelled", `go-around: ${reason}`);
  ac.flags.vectored = false;
  release(sim, ref.runway.id, ac.id, "go-around");
  sim.setPhase(ac, "go_around", cause, { reason });
  ac.airRoute = circuitRoute(sim.graph, ac.assignedRunway!, ac.type, ac.position, behindCircuitTraffic(sim, ac, ref));
  ac.airIndex = 0;
  sim.stats.goArounds++;
  const pilotInitiated = cause.kind !== "clearance";
  sim.emit("go_around.initiated", {
    aircraftId: ac.id,
    attention: pilotInitiated,
    cause,
    data: { runway: ac.assignedRunway, reason },
  });
  if (pilotInitiated) {
    enqueueTransmission(sim, {
      from: ac.id,
      to: "TOWER",
      kind: "report",
      text: `${ac.callsign}, going around, ${reason}.`,
      spoken: `${spokenCallsign(ac.callsign)}, going around, ${reason}.`,
      priority: 78,
    });
  }
}

// ---------------------------------------------------------------- touchdown

function touchdown(sim: Simulation, ac: Aircraft): void {
  const g = sim.graph;
  const ref = g.runwayEnd(ac.assignedRunway)!;
  const dir = headingVec(ref.end.headingDeg);
  const nodes = g.runwayNodesFrom(ref.end.designator);
  const along = nodes.map((id) => dot(sub(g.pos(id), ref.end.threshold), dir));
  const s = Math.min(Math.max(dot(sub(ac.position, ref.end.threshold), dir), 1), ref.runway.lengthM - 1);

  let behind = 0;
  for (let k = 0; k < nodes.length; k++) if (along[k] <= s) behind = k;
  behind = Math.min(behind, nodes.length - 2);

  const v = ac.speedKts * KT;
  const need = Math.max(0, (v * v - EXIT_SPEED * EXIT_SPEED) / (2 * ROLLOUT_DECEL));
  const gateNode = ac.gate ? g.gates.get(ac.gate)?.id : undefined;
  const holdFree = (hold: string) => {
    const owner = sim.nodeClaims.get(hold);
    return !owner || owner === ac.id;
  };

  // An exit is usable if the turn onto it is not a hairpin back the way the aircraft came.
  const turnOff = (k: number, hold: string) => Math.abs(angleDiff(ref.end.headingDeg, bearing(g.pos(nodes[k]), g.pos(hold))));
  const usable = (k: number) => g.holdsAtRunwayNode(nodes[k]).filter((h) => holdFree(h) && turnOff(k, h) <= MAX_EXIT_TURN_DEG);

  // The first exit the aircraft can slow down for, then any others a little further on:
  // rolling slightly longer is better than leaving on the far side of the runway from the gate.
  let first = -1;
  for (let k = behind + 1; k < nodes.length; k++) {
    if (along[k] - s >= need && usable(k).length > 0) {
      first = k;
      break;
    }
  }
  let exit = nodes.length - 1;
  let hold: string | undefined;
  if (first >= 0) {
    exit = first;
    let bestCost = Infinity;
    for (let k = first; k < nodes.length && along[k] - along[first] <= EXIT_LOOKAHEAD_M; k++) {
      for (const h of usable(k)) {
        const extra = along[k] - along[first];
        const cost = gateNode ? (g.shortestPath(h, gateNode)?.cost ?? Infinity) + extra : extra;
        if (cost < bestCost || hold === undefined) {
          bestCost = cost;
          exit = k;
          hold = h;
        }
      }
    }
  }
  if (hold === undefined) {
    // Nothing suitable: roll to the end and take whatever is there.
    const holds = g.holdsAtRunwayNode(nodes[exit]);
    const free = holds.filter(holdFree);
    hold = (free.length > 0 ? free : holds)[0];
  }

  const clr = [...sim.clearances.values()].find(
    (c) => c.aircraftId === ac.id && c.type === "CLEARED_TO_LAND" && c.active && c.status === "acknowledged",
  );
  const cause: Cause = clr ? { kind: "clearance", clearanceId: clr.id } : { kind: "auto", rule: "touchdown" };

  ac.position = add(ref.end.threshold, scale(dir, s));
  ac.altitudeFt = 0;
  completeClearances(sim, ac.id, ["RETURN_TO_LAND", "RUNWAY_CHANGE", "VECTOR"], "landed");
  ac.headingDeg = ref.end.headingDeg;
  ac.airRoute = [];
  ac.airIndex = 0;
  ac.route = [nodes[behind], ...nodes.slice(behind + 1, exit + 1), hold];
  ac.currentWaypointIndex = 1;
  ac.distToNextM = along[behind + 1] - s;
  ac.routeLimitIndex = ac.route.length - 1;
  sim.setPhase(ac, "rollout", cause, { runway: ac.assignedRunway });
  sim.emit("aircraft.touchdown", {
    aircraftId: ac.id,
    cause,
    data: { runway: ac.assignedRunway, plannedExit: g.node(hold).label ?? hold },
  });
}
