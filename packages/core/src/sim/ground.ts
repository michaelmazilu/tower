import { angleDiff, bearing, headingVec, KT, normDeg, projectOnSegment, turnToward } from "../geometry";
import type { Aircraft, Cause } from "../types";
import { startTakeoffRoll } from "./air";
import { completeClearances, grantingClearance } from "./clearances";
import { resolveEmergenciesFor } from "./emergencies";
import { occupiedByOthers, release } from "./runways";
import type { Simulation } from "./simulation";

/**
 * Ground movement. Aircraft follow their assigned route through the
 * airport graph and stop on their own for: the clearance limit, a runway
 * hold line they are not cleared past, a closed taxiway, traffic ahead,
 * a junction someone else holds, and oncoming traffic in a shared stretch.
 */

const HOLDBACK_M = 45;
const SPACING_M = 60;
const LATERAL_M = 25;
const TAXI_ACCEL = 0.8;
const TAXI_DECEL = 1.0;
const TAXI_BRAKE_MAX = 2.0;
const ROLLOUT_DECEL = 1.7;
const ROLLOUT_BRAKE_MAX = 2.8;
const EXIT_SPEED = 8; // m/s through a runway exit
const PUSHBACK_KTS = 4;
const TURN_RATE = 25; // deg/s on the ground

export interface TrafficSegment {
  /** "from>to" */
  key: string;
  /** "to>from" */
  rev: string;
  /** Metres from the aircraft to the start of this segment (0 if it is on it). */
  start: number;
  on: boolean;
}

export interface Traffic {
  /** Directed segment "from>to" -> aircraft whose cleared route uses it. */
  directed: Map<string, { id: string; on: boolean }[]>;
  /** Aircraft -> the rest of its cleared route, in order. */
  routes?: Map<string, TrafficSegment[]>;
}

const key = (from: string, to: string) => `${from}>${to}`;

function hasRoute(ac: Aircraft): boolean {
  return ac.altitudeFt === 0 && ac.phase !== "takeoff" && ac.route.length > 0;
}

function edgeLen(sim: Simulation, a: string, b: string): number {
  return sim.graph.edgeBetween(a, b)?.lengthM ?? 0;
}

/** The remainder of the aircraft's cleared route as directed segments. */
function upcoming(sim: Simulation, ac: Aircraft): TrafficSegment[] {
  const out: TrafficSegment[] = [];
  const i = ac.currentWaypointIndex;
  let d = ac.distToNextM;
  if (d > 0 && i > 0) {
    out.push({ key: key(ac.route[i - 1], ac.route[i]), rev: key(ac.route[i], ac.route[i - 1]), start: 0, on: true });
  }
  const last = Math.min(ac.routeLimitIndex, ac.route.length - 1);
  for (let j = i; j < last; j++) {
    out.push({ key: key(ac.route[j], ac.route[j + 1]), rev: key(ac.route[j + 1], ac.route[j]), start: d, on: false });
    d += edgeLen(sim, ac.route[j], ac.route[j + 1]);
  }
  return out;
}

export function buildTraffic(sim: Simulation): Traffic {
  const directed: Traffic["directed"] = new Map();
  const routes = new Map<string, TrafficSegment[]>();
  for (const ac of sim.aircraft.values()) {
    if (!hasRoute(ac) || ac.phase === "at_gate") continue;
    const segs = upcoming(sim, ac);
    routes.set(ac.id, segs);
    for (const seg of segs) {
      let list = directed.get(seg.key);
      if (!list) directed.set(seg.key, (list = []));
      list.push({ id: ac.id, on: seg.on });
    }
  }
  return { directed, routes };
}

interface Stop {
  dist: number;
  reason?: "limit" | "hold_short" | "blocked_edge" | "traffic" | "opposing" | "hold_position";
  by?: string;
  runwayId?: string;
}

/** Metres remaining along the route to a given route index. */
export function distanceAlongRoute(sim: Simulation, ac: Aircraft, toIndex: number): number {
  let d = ac.distToNextM;
  for (let j = ac.currentWaypointIndex; j < toIndex; j++) d += edgeLen(sim, ac.route[j], ac.route[j + 1]);
  return d;
}

function computeStop(sim: Simulation, ac: Aircraft, v: number): Stop {
  const g = sim.graph;
  const i = ac.currentWaypointIndex;
  const braking = (v * v) / (2 * TAXI_DECEL);
  const claimDist = Math.max(60, braking + 50);
  const mine = new Set<string>();
  let best: Stop = { dist: Infinity };
  const consider = (s: Stop) => {
    if (s.dist < best.dist) best = { ...s, dist: Math.max(0, s.dist) };
  };

  // Junctions we rolled through stay ours until our tail is clear of them. On a
  // finely drawn taxiway that can be several points back, not just the last one.
  if (i > 0) {
    let behind = edgeLen(sim, ac.route[i - 1], ac.route[i]) - ac.distToNextM;
    for (let j = i - 1; j >= 0 && behind < HOLDBACK_M; j--) {
      if (sim.nodeClaims.get(ac.route[j]) === ac.id) mine.add(ac.route[j]);
      if (j > 0) behind += edgeLen(sim, ac.route[j - 1], ac.route[j]);
    }
  }

  // The reverse of every segment still ahead of us: anyone whose route contains
  // one of these is coming the other way through a stretch we share. Worked out
  // only when somebody is, which is rare.
  let myReversed: Set<string> | undefined;
  let onSeg: TrafficSegment | undefined;
  const lastIndex = Math.min(ac.routeLimitIndex, ac.route.length - 1);

  let d = ac.distToNextM;
  for (let j = i; ; j++) {
    const nodeId = ac.route[j];
    const next = j < lastIndex ? ac.route[j + 1] : undefined;

    // Oncoming traffic in the stretch beyond this node, treated like a
    // single-track line: whoever is already in it goes first, otherwise
    // whoever is closer. The loser waits short of the node and leaves the
    // junction itself free for the other aircraft to turn off.
    if (next !== undefined) {
      const oncoming = sim.traffic.directed.get(key(next, nodeId));
      let yieldTo: string | undefined;
      if (oncoming) {
        if (!myReversed) {
          const mySegs = upcoming(sim, ac);
          myReversed = new Set(mySegs.map((s) => s.rev));
          onSeg = mySegs[0]?.on ? mySegs[0] : undefined;
        }
        for (const o of oncoming) {
          if (o.id === ac.id) continue;
          const theirs = sim.traffic.routes?.get(o.id);
          if (onSeg && theirs?.some((seg) => seg.key === onSeg!.rev)) continue; // we are already inside it
          const theirEntry = theirs?.find((seg) => myReversed!.has(seg.key));
          if (!theirEntry) continue;
          if (theirEntry.on || theirEntry.start < d || (theirEntry.start === d && o.id < ac.id)) {
            yieldTo = o.id;
            break;
          }
        }
      }
      if (yieldTo && d > 0) {
        consider({ dist: d - HOLDBACK_M, reason: "opposing", by: yieldTo });
        break;
      }
    }

    if (d <= claimDist) {
      const owner = sim.nodeClaims.get(nodeId);
      if (owner && owner !== ac.id && sim.aircraft.has(owner)) {
        consider({ dist: d - HOLDBACK_M, reason: "traffic", by: owner });
        break;
      }
      sim.nodeClaims.set(nodeId, ac.id);
      mine.add(nodeId);
    }
    if (next === undefined) {
      consider({ dist: d, reason: "limit" });
      break;
    }
    const node = g.node(nodeId);
    const nextNode = g.node(next);
    if (node.kind === "hold_short" && nextNode.kind === "runway" && node.guards) {
      const authorized = ac.runwayAuth[node.guards] && sim.runwayState.get(node.guards)?.reservation?.aircraftId === ac.id;
      // A crew about to blunder past the line still stops for an aircraft sitting right there on the runway.
      const someoneThere = sim.nodeClaims.get(next);
      const blunder = ac.flags.ignoreNextHold && !(someoneThere && someoneThere !== ac.id && sim.aircraft.has(someoneThere));
      if (!authorized && !blunder) {
        consider({ dist: d, reason: "hold_short", runwayId: node.guards });
        break;
      }
      const [occupant] = authorized ? occupiedByOthers(sim, node.guards, ac.id) : [];
      if (occupant) {
        consider({ dist: d, reason: "traffic", by: occupant });
        break;
      }
    }
    const edge = g.edgeBetween(nodeId, next);
    if (edge && sim.closedEdges.has(edge.id)) {
      consider({ dist: d, reason: "blocked_edge", by: edge.id });
      break;
    }
    d += edge?.lengthM ?? 0;
  }

  for (const [node, owner] of sim.nodeClaims) {
    if (owner === ac.id && !mine.has(node)) sim.nodeClaims.delete(node);
  }

  // Aircraft physically ahead on our path.
  const lookahead = Math.max(250, braking * 1.5 + 100);
  for (const b of sim.aircraft.values()) {
    if (b.id === ac.id || b.altitudeFt > 0 || b.phase === "at_gate") continue;
    let acc = 0;
    let a = ac.position;
    for (let j = i; j <= lastIndex && acc <= lookahead; j++) {
      const p = g.pos(ac.route[j]);
      const segLen = j === i ? ac.distToNextM : edgeLen(sim, ac.route[j - 1], ac.route[j]);
      if (segLen > 0) {
        const pr = projectOnSegment(b.position, a, p);
        if (pr.lateral < LATERAL_M && pr.t > 1 && pr.t <= segLen + 1) {
          consider({ dist: acc + pr.t - SPACING_M, reason: "traffic", by: b.id });
          break;
        }
      }
      acc += segLen;
      a = p;
    }
  }

  if (ac.holdPosition) consider({ dist: 0, reason: "hold_position" });
  return best;
}

function taxiPhase(ac: Aircraft): "taxi_out" | "taxi_in" {
  return ac.flight === "departure" ? "taxi_out" : "taxi_in";
}

function causeFor(sim: Simulation, ac: Aircraft, runwayId?: string): Cause {
  const c = grantingClearance(sim, ac, runwayId);
  return c ? { kind: "clearance", clearanceId: c.id } : { kind: "auto", rule: "route_progress" };
}

/** The aircraft is rolling off node route[i] toward route[i+1]. */
function onLeaveNode(sim: Simulation, ac: Aircraft): void {
  const g = sim.graph;
  const from = g.node(ac.route[ac.currentWaypointIndex]);
  const to = g.node(ac.route[ac.currentWaypointIndex + 1]);
  if (from.kind === "hold_short" && to.kind === "runway" && from.guards) {
    const auth = ac.runwayAuth[from.guards];
    if (!auth) {
      ac.flags.ignoreNextHold = false;
      ac.flags.incursionActive = true;
      const incursionCause: Cause = ac.emergencyId
        ? { kind: "emergency", emergencyId: ac.emergencyId }
        : { kind: "auto", rule: "incursion" };
      if (ac.phase === "holding_short") sim.setPhase(ac, taxiPhase(ac), incursionCause);
      sim.emit("emergency.runway_incursion", {
        aircraftId: ac.id,
        attention: true,
        cause: incursionCause,
        data: { runwayId: from.guards, hold: from.label ?? from.id },
      });
      return;
    }
    if (auth === "cross") {
      if (ac.phase === "holding_short") sim.setPhase(ac, taxiPhase(ac), causeFor(sim, ac, from.guards));
    } else {
      sim.setPhase(ac, "line_up", causeFor(sim, ac, from.guards), { runwayId: from.guards });
    }
    return;
  }
  if (ac.phase === "holding_short") sim.setPhase(ac, taxiPhase(ac), causeFor(sim, ac));
}

/** The aircraft has just arrived on node route[i]. */
function onReachNode(sim: Simulation, ac: Aircraft): void {
  const g = sim.graph;
  const i = ac.currentWaypointIndex;
  const node = g.node(ac.route[i]);
  const prev = i > 0 ? g.node(ac.route[i - 1]) : undefined;

  // Coming off a runway onto the far side of a hold line.
  if (node.kind === "hold_short" && prev?.kind === "runway" && prev.runway) {
    const rw = prev.runway;
    if (ac.phase === "rollout") {
      sim.setPhase(ac, "taxi_in", { kind: "auto", rule: "runway_vacated" }, { runwayId: rw });
      ac.flags.vacated = true;
      ac.landingCleared = false;
      completeClearances(sim, ac.id, ["CLEARED_TO_LAND"], "landed and vacated");
      release(sim, rw, ac.id, "vacated after landing");
      sim.emit("aircraft.vacated_runway", {
        aircraftId: ac.id,
        cause: { kind: "auto", rule: "runway_vacated" },
        data: { runwayId: rw, exit: node.label ?? node.id },
      });
      resolveEmergenciesFor(sim, ac.id, ["engine_failure"]);
    } else {
      delete ac.runwayAuth[rw];
      ac.flags.incursionActive = false;
      completeClearances(sim, ac.id, ["CROSS_RUNWAY"], "crossing complete", rw);
      release(sim, rw, ac.id, "crossing complete");
      resolveEmergenciesFor(sim, ac.id, ["runway_incursion"]);
    }
  }

  const atLimit = i >= Math.min(ac.routeLimitIndex, ac.route.length - 1);
  if (!atLimit) return;

  if (ac.phase === "pushback") {
    ac.flags.pushbackComplete = true;
    completeClearances(sim, ac.id, ["PUSHBACK"], "pushback complete");
    sim.emit("aircraft.pushback_complete", {
      aircraftId: ac.id,
      cause: causeFor(sim, ac),
      data: { node: node.id },
    });
  } else if (node.kind === "gate" && ac.phase === "taxi_in") {
    const cause = causeFor(sim, ac);
    sim.setPhase(ac, "at_gate", cause, { gate: node.gate });
    ac.flightComplete = true;
    ac.route = [node.id];
    ac.currentWaypointIndex = 0;
    ac.routeLimitIndex = 0;
    sim.stats.arrived++;
    completeClearances(sim, ac.id, ["TAXI"], "arrived at gate");
    sim.emit("aircraft.arrived_gate", { aircraftId: ac.id, cause, data: { gate: node.gate } });
    resolveEmergenciesFor(sim, ac.id, ["engine_failure", "runway_incursion"]);
  } else if (node.kind === "runway" && ac.phase === "line_up") {
    sim.emit("aircraft.lined_up", {
      aircraftId: ac.id,
      cause: causeFor(sim, ac, node.runway),
      data: { runwayId: node.runway, runway: ac.assignedRunway },
    });
  } else if (node.kind === "hold_short" && (ac.phase === "taxi_out" || ac.phase === "taxi_in")) {
    completeClearances(sim, ac.id, ["TAXI"], "reached clearance limit");
  }
}

export function stepGround(sim: Simulation, ac: Aircraft): void {
  const g = sim.graph;
  const dt = sim.config.dt;
  if (ac.route.length === 0) return;

  let v = ac.speedKts * KT;
  const stop = computeStop(sim, ac, v);
  const lastIndex = Math.min(ac.routeLimitIndex, ac.route.length - 1);
  const i0 = ac.currentWaypointIndex;

  // --- speed limit for the segment we are on (or about to enter)
  const segEdge =
    ac.distToNextM > 0 && i0 > 0
      ? g.edgeBetween(ac.route[i0 - 1], ac.route[i0])
      : i0 < lastIndex
        ? g.edgeBetween(ac.route[i0], ac.route[i0 + 1])
        : undefined;
  let limit = (segEdge?.speedLimitKts ?? 10) * KT;
  const rollout = ac.phase === "rollout";
  if (ac.phase === "pushback") limit = PUSHBACK_KTS * KT;
  if (rollout) limit = segEdge?.kind === "runway" ? Math.max(v, 30 * KT) : EXIT_SPEED;

  const decel = rollout ? ROLLOUT_DECEL : TAXI_DECEL;
  const brakeMax = rollout ? ROLLOUT_BRAKE_MAX : TAXI_BRAKE_MAX;
  let target = Math.min(limit, Math.sqrt(2 * decel * Math.max(0, stop.dist - 0.3)));
  if (rollout) {
    const exitIndex = ac.route.length - 2;
    if (i0 <= exitIndex) {
      const toExit = distanceAlongRoute(sim, ac, exitIndex);
      target = Math.min(target, Math.sqrt(EXIT_SPEED * EXIT_SPEED + 2 * decel * toExit));
    }
  }
  v = target > v ? Math.min(target, v + TAXI_ACCEL * dt) : Math.max(target, v - brakeMax * dt);

  // --- advance along the route, never past the stop point
  let move = Math.min(v * dt, stop.dist);
  if (stop.dist <= 0.5 && v <= 1.5) {
    move = stop.dist;
    v = 0;
  }
  const routeRef = ac.route;
  while (move > 0 || ac.distToNextM > 0) {
    if (ac.distToNextM > move) {
      ac.distToNextM -= move;
      break;
    }
    if (ac.distToNextM > 0) {
      move -= ac.distToNextM;
      ac.distToNextM = 0;
      onReachNode(sim, ac);
      if (ac.route !== routeRef) break;
    }
    if (move <= 1e-6) break;
    if (ac.currentWaypointIndex >= Math.min(ac.routeLimitIndex, ac.route.length - 1)) break;
    onLeaveNode(sim, ac);
    ac.currentWaypointIndex++;
    ac.distToNextM = edgeLen(sim, ac.route[ac.currentWaypointIndex - 1], ac.route[ac.currentWaypointIndex]);
  }
  ac.speedKts = v / KT;

  // --- position and heading from the segment
  const i = ac.currentWaypointIndex;
  const nodePos = g.pos(ac.route[i]);
  let targetHeading: number | undefined;
  if (ac.distToNextM > 0 && i > 0) {
    const prevPos = g.pos(ac.route[i - 1]);
    const brg = bearing(prevPos, nodePos);
    const dir = headingVec(brg);
    ac.position = { x: nodePos.x - dir.x * ac.distToNextM, y: nodePos.y - dir.y * ac.distToNextM };
    targetHeading = ac.phase === "pushback" ? normDeg(brg + 180) : brg;
  } else {
    ac.position = nodePos;
  }

  const node = g.node(ac.route[i]);
  const standing = ac.distToNextM <= 0 && ac.speedKts === 0;

  // A crew that rolled through a hold line notices and stops on the runway.
  if (ac.flags.incursionActive && ac.distToNextM > 0 && i > 0) {
    const passed = edgeLen(sim, ac.route[i - 1], ac.route[i]) - ac.distToNextM;
    if (passed >= 40) {
      ac.flags.incursionActive = false;
      ac.holdPosition = true;
      ac.flags.incursionHold = true;
    }
  }

  // Stopped at a hold line with the runway ahead: that is "holding short".
  if (standing && node.kind === "hold_short" && (ac.phase === "taxi_out" || ac.phase === "taxi_in")) {
    const prevKind = i > 0 ? g.node(ac.route[i - 1]).kind : undefined;
    const cameOffRunway = prevKind === "runway";
    const runwayAhead = i < ac.route.length - 1 && g.node(ac.route[i + 1]).kind === "runway";
    if (!cameOffRunway && (runwayAhead || i >= lastIndex) && node.guards && !ac.runwayAuth[node.guards]) {
      sim.setPhase(ac, "holding_short", { kind: "auto", rule: "hold_short_line" }, { runwayId: node.guards });
      sim.emit("aircraft.holding_short", {
        aircraftId: ac.id,
        attention: true,
        cause: { kind: "auto", rule: "hold_short_line" },
        data: { runwayId: node.guards, hold: node.label ?? node.id },
      });
    }
  }

  // Lined up on the threshold: turn onto the runway heading, then roll if cleared.
  if (standing && ac.phase === "line_up" && node.kind === "runway") {
    const ref = g.runwayEnd(ac.assignedRunway);
    if (ref && ref.end.thresholdNode === node.id) {
      targetHeading = ref.end.headingDeg;
      const aligned = Math.abs(angleDiff(ac.headingDeg, ref.end.headingDeg)) < 2;
      const reserved = sim.runwayState.get(ref.runway.id)?.reservation?.aircraftId === ac.id;
      if (aligned && reserved && ac.runwayAuth[ref.runway.id] === "takeoff" && occupiedByOthers(sim, ref.runway.id, ac.id).length === 0) {
        ac.headingDeg = ref.end.headingDeg;
        startTakeoffRoll(sim, ac);
        return;
      }
    }
  }

  if (targetHeading !== undefined) ac.headingDeg = turnToward(ac.headingDeg, targetHeading, TURN_RATE * dt);

  // --- remember why we are stuck, for conflict detection and the pilot
  const stuck =
    ac.speedKts === 0 && (stop.reason === "traffic" || stop.reason === "opposing" || stop.reason === "blocked_edge");
  if (stuck) {
    if (ac.blockedSince === undefined) ac.blockedSince = sim.time;
    ac.blockedBy = stop.by;
    ac.blockedReason = stop.reason;
  } else {
    ac.blockedSince = undefined;
    ac.blockedBy = undefined;
    ac.blockedReason = undefined;
  }
}

/** Replace an aircraft's taxi route, keeping the segment it is already on. */
export function setRoute(ac: Aircraft, path: string[]): void {
  const moving = ac.distToNextM > 0 && ac.currentWaypointIndex > 0;
  if (moving) {
    const behind = ac.route[ac.currentWaypointIndex - 1];
    ac.route = [behind, ...path];
    ac.currentWaypointIndex = 1;
  } else {
    ac.route = [...path];
    ac.currentWaypointIndex = 0;
    ac.distToNextM = 0;
  }
  ac.routeLimitIndex = ac.route.length - 1;
}

/** The node a new route must start from. */
export function routeOrigin(ac: Aircraft): string {
  return ac.route[ac.currentWaypointIndex];
}
