import { bearing, headingVec, NM, scale, sub } from "../geometry";
import { clearancePhrase, readbackPhrase } from "../radio/phraseology";
import type { Aircraft, Cause, Clearance, CommandResult, SpawnSpec } from "../types";
import { approachRoute, glidepathAltFt, interceptAltFt, touchdownPoint } from "./air";
import { closeOpenClearances } from "./clearances";
import { reserve } from "./runways";
import { CLEARANCE_TYPES } from "../types";
import type { Simulation } from "./simulation";

const fail = (code: string, message: string): CommandResult => ({ ok: false, code, message });

export function gateInUse(sim: Simulation, gate: string, exceptId?: string): boolean {
  for (const ac of sim.aircraft.values()) {
    if (ac.id === exceptId || ac.gate !== gate) continue;
    if (ac.flight === "arrival" || ac.phase === "at_gate" || ac.phase === "pushback") return true;
  }
  return false;
}

export function freeGate(sim: Simulation): string | undefined {
  for (const name of sim.graph.gates.keys()) if (!gateInUse(sim, name)) return name;
  return undefined;
}

function blank(sim: Simulation, spec: SpawnSpec, callsign: string): Aircraft {
  return {
    id: callsign,
    callsign,
    type: (spec.type ?? "A320").toUpperCase(),
    pilotType: spec.pilotType ?? "scripted",
    externallyControlled: false,
    flight: spec.flight,
    position: { x: 0, y: 0 },
    altitudeFt: 0,
    speedKts: 0,
    headingDeg: 0,
    phase: "at_gate",
    phaseSince: sim.time,
    route: [],
    currentWaypointIndex: 0,
    distToNextM: 0,
    routeLimitIndex: 0,
    holdPosition: false,
    runwayAuth: {},
    airRoute: [],
    airIndex: 0,
    landingCleared: false,
    priority: spec.priority ?? "normal",
    readyAt: sim.time + (spec.readyInSec ?? 10),
    flightComplete: false,
    spawnedAt: sim.time,
    flags: {},
  };
}

/** A runway clearance from before the scenario began, on record like any other. */
function seedRunwayClearance(sim: Simulation, ac: Aircraft, type: "CLEARED_TAKEOFF" | "CLEARED_TO_LAND"): void {
  const ref = sim.graph.runwayEnd(ac.assignedRunway)!;
  const input = { callsign: ac.callsign, type, runway: ref.end.designator, flight: ac.flight };
  const phrase = clearancePhrase(input);
  const clr: Clearance = {
    id: sim.nextId("CLR"),
    aircraftId: ac.id,
    type,
    runway: ref.end.designator,
    runwayId: ref.runway.id,
    reason: "Issued before the scenario began.",
    issuedBy: "scenario",
    status: "acknowledged",
    active: true,
    issuedAt: sim.time,
    transmittedAt: sim.time,
    acknowledgedAt: sim.time,
    phraseology: phrase.text,
    spoken: phrase.spoken,
    expectedReadback: readbackPhrase(input).text,
  };
  sim.clearances.set(clr.id, clr);
  ac.clearance = { id: clr.id, type, issuedAt: sim.time, status: "acknowledged" };
  reserve(sim, ref.runway.id, ac.id, type === "CLEARED_TO_LAND" ? "landing" : "takeoff", clr.id);
  if (type === "CLEARED_TO_LAND") {
    ac.landingCleared = true;
  } else {
    ac.runwayAuth[ref.runway.id] = "takeoff";
    ac.route = [ac.route[0], ref.end.thresholdNode];
    ac.routeLimitIndex = 1;
  }
}

/** Aircraft that start mid-taxi carry a clearance on record, so every movement stays traceable. */
function seedTaxiClearance(sim: Simulation, ac: Aircraft, route: string[]): Clearance {
  const via = sim.graph.viaNames(route);
  const input = {
    callsign: ac.callsign,
    type: "TAXI" as const,
    runway: ac.flight === "departure" ? ac.assignedRunway : undefined,
    gate: ac.flight === "arrival" ? ac.gate : undefined,
    via,
    flight: ac.flight,
  };
  const phrase = clearancePhrase(input);
  const clr: Clearance = {
    id: sim.nextId("CLR"),
    aircraftId: ac.id,
    type: "TAXI",
    runway: input.runway,
    runwayId: sim.graph.runwayEnd(input.runway)?.runway.id,
    gate: input.gate,
    route,
    via,
    reason: "Issued before the scenario began.",
    issuedBy: "scenario",
    status: "acknowledged",
    active: true,
    issuedAt: sim.time,
    transmittedAt: sim.time,
    acknowledgedAt: sim.time,
    phraseology: phrase.text,
    spoken: phrase.spoken,
    expectedReadback: readbackPhrase(input).text,
  };
  sim.clearances.set(clr.id, clr);
  ac.clearance = { id: clr.id, type: clr.type, issuedAt: clr.issuedAt, status: "acknowledged" };
  return clr;
}

export function spawnAircraft(sim: Simulation, spec: SpawnSpec, cause: Cause): CommandResult {
  const g = sim.graph;
  const callsign = (spec.callsign ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) return fail("INVALID_CALLSIGN", `"${spec.callsign}" is not a usable callsign.`);
  if (sim.aircraft.has(callsign)) return fail("DUPLICATE_CALLSIGN", `${callsign} is already in the simulation.`);
  if (spec.start.kind === "taxiing") {
    const from = spec.start.from;
    if (!g.hasNode(from)) return fail("UNKNOWN_NODE", `No node ${from}.`);
    if (g.node(from).kind === "runway") return fail("INVALID_START", "Taxiing aircraft must start clear of the runway.");
  }

  const ac = blank(sim, spec, callsign);
  const requireGate = (): string | CommandResult => {
    const name = spec.gate?.toUpperCase() ?? freeGate(sim);
    if (!name) return fail("NO_FREE_GATE", "Every gate is in use.");
    if (!g.gates.has(name)) return fail("UNKNOWN_GATE", `No gate ${name}.`);
    if (gateInUse(sim, name)) return fail("GATE_OCCUPIED", `Gate ${name} is in use.`);
    return name;
  };
  const startNode = (id: string): CommandResult | null => {
    const owner = sim.nodeClaims.get(id);
    if (owner && sim.aircraft.has(owner)) return fail("SPAWN_BLOCKED", `${owner} is already at ${id}.`);
    sim.nodeClaims.set(id, ac.id);
    ac.position = g.pos(id);
    return null;
  };

  if (spec.flight === "departure") {
    const designator = spec.runway ?? sim.activeRunways.departures[0];
    const ref = g.runwayEnd(designator);
    if (!ref) return fail("UNKNOWN_RUNWAY", `Unknown departure runway "${designator ?? ""}".`);
    ac.assignedRunway = ref.end.designator;

    if (spec.start.kind === "gate") {
      const gate = requireGate();
      if (typeof gate !== "string") return gate;
      const node = g.gates.get(gate)!;
      const blocked = startNode(node.id);
      if (blocked) return blocked;
      ac.gate = gate;
      ac.route = [node.id];
      ac.headingDeg = bearing(g.pos(node.pushbackNode!), node);
    } else if (spec.start.kind === "holding_short") {
      const hold = g.departureHolds(ref.end.designator).find((h) => !sim.nodeClaims.has(h));
      if (!hold) return fail("SPAWN_BLOCKED", `The runway ${ref.end.designator} holding point is occupied.`);
      startNode(hold);
      ac.route = [hold];
      ac.phase = "holding_short";
      ac.headingDeg = bearing(g.pos(hold), ref.end.threshold);
      ac.gate = spec.gate?.toUpperCase();
    } else if (spec.start.kind === "taxiing") {
      const res = g.shortestPath(spec.start.from, g.departureHolds(ref.end.designator), { closedEdges: sim.closedEdges });
      if (!res) return fail("NO_ROUTE", `No taxi route from ${spec.start.from} to runway ${ref.end.designator}.`);
      const blocked = startNode(spec.start.from);
      if (blocked) return blocked;
      ac.route = res.path;
      ac.routeLimitIndex = res.path.length - 1;
      ac.phase = "taxi_out";
      if (res.path.length > 1) ac.headingDeg = bearing(g.pos(res.path[0]), g.pos(res.path[1]));
      ac.gate = spec.gate?.toUpperCase();
      seedTaxiClearance(sim, ac, res.path);
    } else {
      return fail("INVALID_START", "A departure cannot start on approach.");
    }
  } else {
    const designator = spec.runway ?? sim.activeRunways.arrivals[0];
    const ref = g.runwayEnd(designator);
    if (!ref) return fail("UNKNOWN_RUNWAY", `Unknown arrival runway "${designator ?? ""}".`);
    ac.assignedRunway = ref.end.designator;
    const gate = requireGate();
    if (typeof gate !== "string") return gate;
    ac.gate = gate;

    if (spec.start.kind === "approach") {
      const nm = Math.min(Math.max(spec.start.distanceNm, 2), 32);
      const dir = headingVec(ref.end.headingDeg);
      const td = touchdownPoint(ref);
      ac.position = sub(td, scale(dir, nm * NM));
      ac.headingDeg = ref.end.headingDeg;
      ac.altitudeFt = Math.min(interceptAltFt(g, ref), glidepathAltFt(nm * NM));
      ac.speedKts = nm > 6 ? 180 : 160;
      ac.airRoute = approachRoute(g, ref.end.designator, ac.type);
      ac.airIndex = nm > 10.5 ? 0 : nm > 5.5 ? 1 : 2;
      ac.phase = "approach";
    } else if (spec.start.kind === "taxiing") {
      const res = g.shortestPath(spec.start.from, g.gates.get(gate)!.id, { closedEdges: sim.closedEdges });
      if (!res) return fail("NO_ROUTE", `No taxi route from ${spec.start.from} to gate ${gate}.`);
      const blocked = startNode(spec.start.from);
      if (blocked) return blocked;
      ac.route = res.path;
      ac.routeLimitIndex = res.path.length - 1;
      ac.phase = "taxi_in";
      ac.flags.vacated = true;
      if (res.path.length > 1) ac.headingDeg = bearing(g.pos(res.path[0]), g.pos(res.path[1]));
      seedTaxiClearance(sim, ac, res.path);
    } else if (spec.start.kind === "gate") {
      const node = g.gates.get(gate)!;
      const blocked = startNode(node.id);
      if (blocked) return blocked;
      ac.route = [node.id];
      ac.headingDeg = bearing(g.pos(node.pushbackNode!), node);
      ac.flightComplete = true;
    } else {
      return fail("INVALID_START", "An arrival cannot start holding short for departure.");
    }
  }

  sim.aircraft.set(ac.id, ac);
  if ("cleared" in spec.start && spec.start.cleared) {
    seedRunwayClearance(sim, ac, spec.flight === "arrival" ? "CLEARED_TO_LAND" : "CLEARED_TAKEOFF");
  }
  sim.emit("aircraft.spawned", {
    aircraftId: ac.id,
    cause,
    data: {
      callsign: ac.callsign,
      type: ac.type,
      flight: ac.flight,
      phase: ac.phase,
      runway: ac.assignedRunway,
      gate: ac.gate,
      pilotType: ac.pilotType,
    },
  });
  return { ok: true, aircraftId: ac.id, phase: ac.phase };
}

export function removeAircraft(sim: Simulation, ac: Aircraft, eventType: string, cause: Cause): void {
  closeOpenClearances(sim, ac.id, [...CLEARANCE_TYPES], eventType === "aircraft.handed_off" ? "completed" : "cancelled", "aircraft left the simulation");
  for (const r of sim.requests.values()) {
    if (r.aircraftId === ac.id && (r.status === "pending" || r.status === "transmitting")) {
      r.status = "withdrawn";
      r.closedAt = sim.time;
    }
  }
  sim.radio.queue = sim.radio.queue.filter((tx) => tx.from !== ac.id && tx.to !== ac.id);
  sim.forget(ac);
  sim.emit(eventType, { aircraftId: ac.id, cause, data: { callsign: ac.callsign, flight: ac.flight } });
}
