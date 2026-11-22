import { NM } from "../geometry";
import type { Aircraft, Clearance, PilotRequest, SimEvent } from "../types";
import { isOpenClearance } from "./clearances";
import { wantedRequest } from "./pilots";
import { distanceToThreshold, inboundArrivals } from "./runways";
import type { Simulation } from "./simulation";

/**
 * Read-only views of the world, shaped for a controller that reads text:
 * compact, labelled, and free of raw coordinates.
 */

const PRIORITY_ORDER = { emergency: 0, urgent: 1, normal: 2 } as const;

export function describeLocation(sim: Simulation, ac: Aircraft): string {
  const g = sim.graph;
  switch (ac.phase) {
    case "at_gate":
      return `at gate ${ac.gate ?? "?"}`;
    case "pushback":
      return ac.flags.pushbackComplete ? `pushed back from gate ${ac.gate}, stopped on the apron` : `pushing back from gate ${ac.gate}`;
    case "approach":
    case "landing":
      return `${(distanceToThreshold(sim, ac) / NM).toFixed(1)} NM final runway ${ac.assignedRunway}, ${Math.round(ac.altitudeFt)} ft`;
    case "holding":
      return `holding, ${(distanceToThreshold(sim, ac) / NM).toFixed(1)} NM from runway ${ac.assignedRunway}`;
    case "go_around":
      return `going around runway ${ac.assignedRunway}, ${Math.round(ac.altitudeFt)} ft`;
    case "takeoff":
      return `takeoff roll runway ${ac.assignedRunway}`;
    case "departure":
      return `departing runway ${ac.assignedRunway}, ${Math.round(ac.altitudeFt)} ft`;
    case "line_up":
      return `lining up runway ${ac.assignedRunway}`;
    case "rollout":
      return `landing roll runway ${ac.assignedRunway}`;
    case "holding_short": {
      const node = g.node(ac.route[ac.currentWaypointIndex]);
      return `holding short of runway ${node.guards} at ${node.label ?? node.id}`;
    }
    case "taxi_out":
    case "taxi_in": {
      const i = ac.currentWaypointIndex;
      const edge = ac.distToNextM > 0 && i > 0 ? g.edgeBetween(ac.route[i - 1], ac.route[i]) : undefined;
      const where = edge?.name ? `on taxiway ${edge.name}` : `at ${g.node(ac.route[i]).label ?? ac.route[i]}`;
      const moving = ac.speedKts > 0.5 ? "taxiing" : "stopped";
      const dest = ac.flight === "departure" ? `to runway ${ac.assignedRunway}` : `to gate ${ac.gate}`;
      return `${moving} ${where} ${dest}`;
    }
  }
}

function aircraftSummary(sim: Simulation, ac: Aircraft) {
  return {
    id: ac.id,
    type: ac.type,
    flight: ac.flight,
    phase: ac.phase,
    location: describeLocation(sim, ac),
    runway: ac.assignedRunway ?? null,
    gate: ac.gate ?? null,
    priority: ac.priority,
    pilot: ac.externallyControlled ? ac.pilotType : "scripted",
    speedKts: Math.round(ac.speedKts),
    lastClearance: ac.clearance ? `${ac.clearance.type} (${ac.clearance.status})` : null,
    ...(ac.humanControl ? { control: "human" } : {}),
    emergency: ac.emergencyId ? (sim.emergencies.get(ac.emergencyId)?.type ?? null) : null,
  };
}

function requestView(sim: Simulation, r: PilotRequest) {
  return {
    requestId: r.id,
    aircraftId: r.aircraftId,
    type: r.type,
    runway: r.runway ?? null,
    text: r.text,
    priority: r.priority,
    waitingSec: Math.round(sim.time - (r.heardAt ?? r.createdAt)),
    deferred: Boolean(r.deferredBy),
    reminders: r.reminders,
  };
}

/** Requests the controller has heard and not yet resolved, most urgent first. */
export function getPendingRequests(sim: Simulation) {
  return [...sim.requests.values()]
    // A flight a person has taken is not the controller's work.
    .filter((r) => r.status === "pending" && !sim.get(r.aircraftId)?.humanControl)
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.heardAt ?? a.createdAt) - (b.heardAt ?? b.createdAt),
    )
    .map((r) => requestView(sim, r));
}

export function getRunwayStatus(sim: Simulation, runway?: string) {
  const g = sim.graph;
  const only = runway ? g.physicalRunway(runway) : undefined;
  if (runway && !only) return null;
  const states = [...sim.runwayState.values()].filter((s) => !only || s.id === only.id);
  return states.map((s) => {
    const rw = g.runways.get(s.id)!;
    const ends = rw.ends.map((e) => e.designator);
    const arrivals = inboundArrivals(sim, s.id);
    const holdingShort = [...sim.aircraft.values()]
      .filter((a) => a.phase === "holding_short" && g.node(a.route[a.currentWaypointIndex]).guards === s.id)
      .map((a) => ({ id: a.id, at: g.node(a.route[a.currentWaypointIndex]).label ?? "", wants: wantedRequest(sim, a)?.type ?? null }));
    const sinceDeparture = s.lastDepartureRollAt !== undefined ? Math.round(sim.time - s.lastDepartureRollAt) : null;
    return {
      runwayId: s.id,
      ends,
      closed: sim.closedRunways.includes(s.id),
      /** Runways that physically cross this one; a takeoff or landing here blocks them, and theirs block this one. */
      crossedBy: g.intersecting(s.id),
      activeForArrivals: ends.filter((e) => sim.activeRunways.arrivals.includes(e)),
      activeForDepartures: ends.filter((e) => sim.activeRunways.departures.includes(e)),
      occupiedBy: s.occupants,
      reservedFor: s.reservation ? { aircraftId: s.reservation.aircraftId, purpose: s.reservation.kind } : null,
      clear: s.occupants.length === 0 && !s.reservation,
      inboundArrivals: arrivals.map((a) => ({
        id: a.aircraft.id,
        runway: a.aircraft.assignedRunway,
        distanceNm: Math.round(a.distanceNm * 10) / 10,
        etaSec: Math.round(a.etaSec),
        clearedToLand: a.cleared,
        priority: a.aircraft.priority,
      })),
      holdingShort,
      secondsSinceLastDeparture: sinceDeparture,
    };
  });
}

export function getConflicts(sim: Simulation) {
  return [...sim.conflicts.values()].map((c) => ({
    type: c.type,
    severity: c.severity,
    aircraft: c.aircraftIds,
    runwayId: c.runwayId ?? null,
    description: c.description,
    ageSec: Math.round(sim.time - c.detectedAt),
  }));
}

export function getAirportState(sim: Simulation) {
  return {
    airport: sim.graph.data.icao,
    simTimeSec: Math.round(sim.time),
    activeRunways: sim.activeRunways,
    closedRunways: sim.closedRunways,
    aircraft: [...sim.aircraft.values()].map((a) => aircraftSummary(sim, a)),
    runways: getRunwayStatus(sim)!.map((r) => ({
      runwayId: r.runwayId,
      occupiedBy: r.occupiedBy,
      reservedFor: r.reservedFor,
      nextArrival: r.inboundArrivals[0] ?? null,
    })),
    pendingRequests: getPendingRequests(sim),
    emergencies: [...sim.emergencies.values()]
      .filter((e) => e.resolvedAt === undefined)
      .map((e) => ({ id: e.id, type: e.type, aircraftId: e.aircraftId ?? null, description: e.description })),
    conflicts: getConflicts(sim),
    closedTaxiways: [...sim.closedEdges],
    radio: { busy: sim.radio.active !== null, queued: sim.radio.queue.length },
  };
}

function clearanceView(c: Clearance) {
  return {
    clearanceId: c.id,
    type: c.type,
    runway: c.runway ?? null,
    gate: c.gate ?? null,
    via: c.via ?? null,
    status: c.status,
    reason: c.reason,
    issuedBy: c.issuedBy,
    issuedAtSec: Math.round(c.issuedAt),
    phraseology: c.phraseology,
    closeReason: c.closeReason ?? null,
  };
}

function objective(ac: Aircraft): string {
  if (ac.flightComplete) return `Flight complete, parked at gate ${ac.gate}.`;
  if (ac.flight === "departure") return `Depart from runway ${ac.assignedRunway ?? "?"}.`;
  return `Land on runway ${ac.assignedRunway ?? "?"} and taxi to gate ${ac.gate ?? "?"}.`;
}

function nextAction(sim: Simulation, ac: Aircraft): string {
  const need = wantedRequest(sim, ac);
  const pending = [...sim.clearances.values()].find(
    (c) => c.aircraftId === ac.id && (c.status === "issued" || c.status === "transmitted"),
  );
  if (pending?.status === "issued") return `Waiting for tower to transmit ${pending.type}.`;
  if (pending) return pending.active ? `Following ${pending.type}. Readback pending.` : `Read back ${pending.type}, then comply.`;
  if (ac.holdPosition && !ac.flags.taxiClearanceCancelled) return "Holding position until told to continue.";
  if (need) {
    const waiting: Record<string, string> = {
      PUSHBACK: "Waiting for pushback approval.",
      TAXI: "Waiting for taxi instructions.",
      TAKEOFF: `Waiting for takeoff clearance, runway ${ac.assignedRunway}.`,
      LANDING: `Continuing the approach; needs a landing clearance before ${sim.config.rules.decisionDistanceNm} NM or it goes around.`,
      CROSS: `Waiting for clearance to cross runway ${need.runway}.`,
      OTHER: "Waiting for the tower.",
    };
    return waiting[need.type];
  }
  switch (ac.phase) {
    case "at_gate":
      return ac.flightComplete ? "None." : `Will call for pushback in ${Math.max(0, Math.round(ac.readyAt - sim.time))} s.`;
    case "pushback":
      return "Completing pushback, then will request taxi.";
    case "taxi_out":
      return `Taxiing to the runway ${ac.assignedRunway} holding point; will stop there.`;
    case "taxi_in":
      return `Taxiing to gate ${ac.gate}.`;
    case "line_up":
      return "Lining up; will roll when aligned.";
    case "takeoff":
      return "Taking off.";
    case "departure":
      return "Climbing out; will leave tower airspace.";
    case "approach":
      return "Cleared to land; continuing to touchdown.";
    case "landing":
      return "Committed to land.";
    case "rollout":
      return "Slowing down and vacating the runway.";
    case "go_around":
      return "Flying the missed approach; will rejoin final and call again.";
    case "holding":
      return "Holding until released.";
    default:
      return "None.";
  }
}

/**
 * Why is this aircraft doing what it is doing? Built only from recorded
 * facts: the clearance on file, the reason the controller gave for it,
 * and what the aircraft's own rules will do next. Nothing is inferred
 * about the controller's internal reasoning.
 */
export function explainAircraft(sim: Simulation, aircraftId: string) {
  const ac = sim.get(aircraftId);
  if (!ac) return null;
  const mine = [...sim.clearances.values()].filter((c) => c.aircraftId === ac.id);
  const last = mine[mine.length - 1];
  const governing = [...mine].reverse().find((c) => c.active && isOpenClearance(c)) ?? last;
  const request = [...sim.requests.values()].find(
    (r) => r.aircraftId === ac.id && (r.status === "pending" || r.status === "transmitting"),
  );
  const blocked =
    ac.blockedSince !== undefined
      ? { forSec: Math.round(sim.time - ac.blockedSince), by: ac.blockedBy ?? null, why: ac.blockedReason ?? null }
      : null;
  return {
    aircraftId: ac.id,
    objective: objective(ac),
    location: describeLocation(sim, ac),
    lastClearance: last ? clearanceView(last) : null,
    governingClearance: governing ? clearanceView(governing) : null,
    controllerReason: governing?.reason ?? null,
    nextPlannedAction: nextAction(sim, ac),
    openRequest: request ? requestView(sim, request) : null,
    blocked,
  };
}

export function getAircraftDetails(sim: Simulation, aircraftId: string) {
  const ac = sim.get(aircraftId);
  if (!ac) return null;
  const history: SimEvent[] = [];
  for (let i = sim.events.length - 1; i >= 0 && history.length < 15; i--) {
    const e = sim.events[i];
    if (e.aircraftId === ac.id && !e.type.startsWith("radio.tx_queued")) history.unshift(e);
  }
  return {
    ...aircraftSummary(sim, ac),
    altitudeFt: Math.round(ac.altitudeFt),
    headingDeg: Math.round(ac.headingDeg),
    landingCleared: ac.landingCleared,
    holdPosition: ac.holdPosition,
    explanation: explainAircraft(sim, ac.id),
    clearances: [...sim.clearances.values()].filter((c) => c.aircraftId === ac.id).slice(-8).map(clearanceView),
    recentEvents: history.map((e) => ({ seq: e.seq, simTimeSec: Math.round(e.simTime), type: e.type, data: e.data })),
  };
}
