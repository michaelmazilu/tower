import { spokenCallsign } from "../radio/phraseology";
import type { Aircraft, CommandResult, Emergency, EmergencyType } from "../types";
import { AIRBORNE_PHASES, EMERGENCY_TYPES } from "../types";
import { circuitRoute, goAround } from "./air";
import { enqueueTransmission } from "./radio";
import { reassignRunways } from "./reassign";
import type { Simulation } from "./simulation";
import { freeGate, gateInUse } from "./spawn";

/**
 * Disruptions the operator (manual mode) or the seeded RNG (random mode)
 * can inject. They change the world; resolving them is the controller's job.
 */

const fail = (code: string, message: string): CommandResult => ({ ok: false, code, message });

function record(sim: Simulation, e: Omit<Emergency, "id" | "startedAt">): Emergency {
  const emergency: Emergency = { id: sim.nextId("EMG"), startedAt: sim.time, ...e };
  sim.emergencies.set(emergency.id, emergency);
  sim.emit("emergency.declared", {
    aircraftId: emergency.aircraftId,
    attention: true,
    cause: { kind: "emergency", emergencyId: emergency.id },
    data: {
      emergencyId: emergency.id,
      emergencyType: emergency.type,
      description: emergency.description,
      edgeId: emergency.edgeId,
      runwayId: emergency.runwayId,
      source: emergency.source,
    },
  });
  return emergency;
}

/** Index of the next hold line on the route the aircraft has no permission to pass. */
function nextUnclearedHold(sim: Simulation, ac: Aircraft): number {
  const g = sim.graph;
  for (let j = ac.currentWaypointIndex; j < ac.route.length; j++) {
    const n = g.node(ac.route[j]);
    if (n.kind !== "hold_short" || !n.guards || ac.runwayAuth[n.guards]) continue;
    if (j > 0 && g.node(ac.route[j - 1]).kind === "runway") continue; // leaving, not entering
    return j;
  }
  return -1;
}

function candidates(sim: Simulation, type: EmergencyType): Aircraft[] {
  const all = [...sim.aircraft.values()].filter((a) => !a.emergencyId);
  switch (type) {
    case "engine_failure":
      return all.filter((a) => AIRBORNE_PHASES.has(a.phase) && a.phase !== "landing");
    case "go_around":
      return all.filter((a) => (a.phase === "approach" || a.phase === "landing") && a.altitudeFt > 150);
    case "runway_incursion":
      return all.filter(
        (a) => (a.phase === "taxi_out" || a.phase === "taxi_in" || a.phase === "holding_short") && nextUnclearedHold(sim, a) >= 0,
      );
    case "taxiway_blocked":
      return [];
  }
}

export function triggerEmergency(
  sim: Simulation,
  type: EmergencyType,
  opts: { aircraftId?: string; edgeId?: string },
  source: "operator" | "random",
): CommandResult {
  if (!EMERGENCY_TYPES.includes(type)) return fail("UNKNOWN_EMERGENCY", `Unknown emergency type "${type}".`);
  const g = sim.graph;

  if (type === "taxiway_blocked") {
    let edgeId = opts.edgeId;
    if (!edgeId) {
      const inUse = new Set<string>();
      for (const ac of sim.aircraft.values()) {
        const i = ac.currentWaypointIndex;
        if (ac.distToNextM > 0 && i > 0) inUse.add(`${ac.route[i - 1]}|${ac.route[i]}`).add(`${ac.route[i]}|${ac.route[i - 1]}`);
      }
      const options = [...g.edges.values()].filter(
        (e) => e.kind === "taxiway" && !sim.closedEdges.has(e.id) && !inUse.has(e.id) && e.lengthM > 200,
      );
      edgeId = sim.rng.pick(options)?.id;
    }
    const edge = edgeId ? g.edges.get(edgeId) : undefined;
    if (!edge) return fail("UNKNOWN_EDGE", `No taxiway segment "${opts.edgeId ?? ""}".`);
    if (edge.kind === "runway") return fail("INVALID_EDGE", "Runways cannot be blocked with this emergency.");
    if (sim.closedEdges.has(edge.id)) return fail("ALREADY_BLOCKED", `${edge.id} is already blocked.`);
    sim.closedEdges.add(edge.id);
    const e = record(sim, {
      type,
      edgeId: edge.id,
      description: `Taxiway ${edge.name ?? ""} blocked between ${edge.from} and ${edge.to}.`,
      source,
    });
    sim.timers.push({
      at: sim.time + sim.config.rules.taxiwayBlockDurationSec,
      action: { kind: "resolve_emergency", emergencyId: e.id },
    });
    return { ok: true, emergencyId: e.id, edgeId: edge.id };
  }

  const pool = candidates(sim, type);
  const wanted = opts.aircraftId?.toUpperCase();
  const ac = wanted ? pool.find((a) => a.id === wanted) : sim.rng.pick(pool);
  if (!ac) {
    return fail(
      "NO_ELIGIBLE_AIRCRAFT",
      opts.aircraftId ? `${opts.aircraftId} cannot have a ${type} right now.` : `No aircraft can have a ${type} right now.`,
    );
  }

  if (type === "go_around") {
    const e = record(sim, { type, aircraftId: ac.id, description: `${ac.callsign} is going around: unstable approach.`, source });
    goAround(sim, ac, { kind: "emergency", emergencyId: e.id }, "unstable approach");
    e.resolvedAt = sim.time;
    return { ok: true, emergencyId: e.id, aircraftId: ac.id };
  }

  if (type === "engine_failure") {
    const returning = ac.phase === "departure";
    const intentions = `${returning ? "returning to land" : "inbound"} runway ${ac.assignedRunway}`;
    const note = returning ? ` Runway ${ac.assignedRunway} is open to it for landing.` : "";
    const e = record(sim, {
      type,
      aircraftId: ac.id,
      description: `${ac.callsign} has declared an emergency: engine failure, ${intentions}.${note}`,
      source,
    });
    ac.emergencyId = e.id;
    const before = ac.priority;
    ac.priority = "emergency";
    for (const r of sim.requests.values()) if (r.aircraftId === ac.id) r.priority = "emergency";
    sim.emit("aircraft.priority_changed", {
      aircraftId: ac.id,
      cause: { kind: "emergency", emergencyId: e.id },
      data: { from: before, to: "emergency", reason: "engine failure" },
    });
    if (returning) {
      // Come straight back: fly the circuit and land on the departure runway.
      ac.flight = "arrival";
      ac.flags.emergencyReturn = true;
      // Its old gate may have been given away since it left.
      if (!ac.gate || gateInUse(sim, ac.gate, ac.id)) ac.gate = freeGate(sim);
      sim.setPhase(ac, "go_around", { kind: "emergency", emergencyId: e.id }, { reason: "returning to land" });
      // The crew turns back on its own authority; the priority pattern needs the controller's clearance.
      ac.airRoute = circuitRoute(g, ac.assignedRunway!, ac.type, ac.position);
      ac.airRoute[0]!.altFt = 2000;
      ac.airRoute[1]!.altFt = 3000;
      ac.airIndex = 0;
    }
    enqueueTransmission(sim, {
      from: ac.id,
      to: "TOWER",
      kind: "emergency",
      text: `MAYDAY MAYDAY MAYDAY, ${ac.callsign}, engine failure, ${intentions}.`,
      spoken: `Mayday, mayday, mayday, ${spokenCallsign(ac.callsign)}, engine failure, ${intentions}.`,
      priority: 100,
    });
    if (returning) reassignRunways(sim);
    return { ok: true, emergencyId: e.id, aircraftId: ac.id };
  }

  // runway_incursion: the crew will roll through its next hold line.
  const at = nextUnclearedHold(sim, ac);
  const hold = g.node(ac.route[at]);
  if (at === ac.route.length - 1) {
    const runwayNode = g.neighbors(hold.id).find((n) => n.edge.kind === "runway_link");
    if (!runwayNode) return fail("NO_ELIGIBLE_AIRCRAFT", `${ac.callsign} has no runway ahead.`);
    ac.route = [...ac.route, runwayNode.to];
  }
  ac.routeLimitIndex = Math.max(ac.routeLimitIndex, at + 1);
  ac.flags.ignoreNextHold = true;
  const e = record(sim, {
    type,
    aircraftId: ac.id,
    runwayId: hold.guards,
    description: `${ac.callsign} is about to enter runway ${hold.guards} without a clearance.`,
    source,
  });
  ac.emergencyId = e.id;
  return { ok: true, emergencyId: e.id, aircraftId: ac.id, runwayId: hold.guards };
}

export function resolveEmergency(sim: Simulation, emergencyId: string, by: "operator" | "auto"): CommandResult {
  const e = sim.emergencies.get(emergencyId);
  if (!e) return fail("UNKNOWN_EMERGENCY", `No emergency ${emergencyId}.`);
  if (e.resolvedAt !== undefined) return { ok: true, emergencyId, alreadyResolved: true };
  e.resolvedAt = sim.time;
  if (e.edgeId) sim.closedEdges.delete(e.edgeId);
  const ac = e.aircraftId ? sim.get(e.aircraftId) : undefined;
  if (ac && ac.emergencyId === e.id) {
    ac.emergencyId = undefined;
    ac.flags.ignoreNextHold = false;
  }
  sim.emit("emergency.resolved", {
    aircraftId: e.aircraftId,
    attention: true,
    cause: { kind: "emergency", emergencyId: e.id },
    data: { emergencyId: e.id, emergencyType: e.type, by, edgeId: e.edgeId },
  });
  return { ok: true, emergencyId };
}

/** Called by the movement code when an aircraft's emergency has run its course. */
export function resolveEmergenciesFor(sim: Simulation, aircraftId: string, types: EmergencyType[]): void {
  for (const e of sim.emergencies.values()) {
    if (e.aircraftId === aircraftId && e.resolvedAt === undefined && types.includes(e.type)) {
      resolveEmergency(sim, e.id, "auto");
    }
  }
}

/** Random mode: roughly one event per configured interval, from the seeded RNG. */
export function stepEmergencies(sim: Simulation): void {
  if (sim.emergencyMode !== "random") return;
  const active = [...sim.emergencies.values()].filter((e) => e.resolvedAt === undefined).length;
  if (active >= 1) return;
  if (!sim.rng.chance(1 / sim.config.rules.randomEmergencyMeanIntervalSec)) return;
  const feasible = EMERGENCY_TYPES.filter((t) => t === "taxiway_blocked" || candidates(sim, t).length > 0);
  const type = sim.rng.pick(feasible);
  if (type) triggerEmergency(sim, type, {}, "random");
}
