import { dist, KT, NM } from "../geometry";
import type { Aircraft, ReservationKind } from "../types";
import { GROUND_PHASES } from "../types";
import type { Simulation } from "./simulation";

/**
 * Runway model: a physical runway belongs to at most one aircraft at a
 * time. `occupants` is derived from where aircraft actually are;
 * `reservation` is the promise made when a clearance was accepted. A
 * clearance that needs the runway is only valid when both are clear of
 * everyone else.
 */

/** Physical runway id the aircraft is on (past a hold line), if any. */
export function runwayOccupiedBy(sim: Simulation, ac: Aircraft): string | undefined {
  const g = sim.graph;
  if (ac.phase === "takeoff") return g.runwayEnd(ac.assignedRunway)?.runway.id;
  if (!GROUND_PHASES.has(ac.phase) || ac.route.length === 0) return undefined;
  const i = ac.currentWaypointIndex;
  const cur = g.node(ac.route[i]);
  if (cur.kind === "runway") return cur.runway;
  if (ac.distToNextM > 0 && i > 0) {
    const prev = g.node(ac.route[i - 1]);
    if (prev.kind === "runway") return prev.runway;
  }
  return undefined;
}

export function updateOccupancy(sim: Simulation): void {
  const now = new Map<string, string[]>();
  for (const id of sim.runwayState.keys()) now.set(id, []);
  for (const ac of sim.aircraft.values()) {
    const rw = runwayOccupiedBy(sim, ac);
    if (rw) now.get(rw)?.push(ac.id);
  }
  for (const [id, state] of sim.runwayState) {
    const next = now.get(id)!;
    const entered = next.filter((a) => !state.occupants.includes(a));
    const left = state.occupants.filter((a) => !next.includes(a));
    state.occupants = next;
    for (const a of entered) {
      sim.emit("runway.occupied", { aircraftId: a, data: { runwayId: id, occupants: next } });
    }
    for (const a of left) {
      sim.emit("runway.vacated", {
        aircraftId: a,
        attention: next.length === 0,
        data: { runwayId: id, occupants: next, clear: next.length === 0 },
      });
    }
  }
}

export function occupiedByOthers(sim: Simulation, runwayId: string, aircraftId: string): string[] {
  // A command or another aircraft may have moved someone onto the runway since the last snapshot.
  const occupied: string[] = [];
  for (const ac of sim.aircraft.values()) {
    if (ac.id !== aircraftId && runwayOccupiedBy(sim, ac) === runwayId) occupied.push(ac.id);
  }
  return occupied;
}

export function reservedByOther(sim: Simulation, runwayId: string, aircraftId: string) {
  const r = sim.runwayState.get(runwayId)?.reservation;
  return r && r.aircraftId !== aircraftId ? r : undefined;
}

export function reserve(
  sim: Simulation,
  runwayId: string,
  aircraftId: string,
  kind: ReservationKind,
  clearanceId: string,
): void {
  const state = sim.runwayState.get(runwayId);
  if (!state) return;
  if (state.reservation && state.reservation.aircraftId !== aircraftId) {
    throw new Error(`runway ${runwayId} is already reserved by ${state.reservation.aircraftId}`);
  }
  state.reservation = { aircraftId, kind, clearanceId, since: sim.time };
  sim.emit("runway.reserved", {
    aircraftId,
    cause: { kind: "clearance", clearanceId },
    data: { runwayId, kind },
  });
}

export function release(sim: Simulation, runwayId: string, aircraftId: string, why: string): void {
  const state = sim.runwayState.get(runwayId);
  if (!state?.reservation || state.reservation.aircraftId !== aircraftId) return;
  const { kind, clearanceId } = state.reservation;
  state.reservation = undefined;
  sim.emit("runway.released", {
    aircraftId,
    attention: true,
    cause: { kind: "clearance", clearanceId },
    data: { runwayId, kind, why },
  });
}

export function releaseAllReservations(sim: Simulation, aircraftId: string): void {
  for (const state of sim.runwayState.values()) {
    if (state.reservation?.aircraftId === aircraftId) release(sim, state.id, aircraftId, "aircraft left");
  }
}

/** Metres from the aircraft to the threshold it is landing on. */
export function distanceToThreshold(sim: Simulation, ac: Aircraft): number {
  const ref = sim.graph.runwayEnd(ac.assignedRunway);
  return ref ? dist(ac.position, ref.end.threshold) : Infinity;
}

/** Seconds to fly this many metres to touchdown at the approach speeds in use: 180, 160, then about 140 kt. */
export function flyingSec(metres: number): number {
  const slow = Math.min(metres, 5 * NM);
  const middle = Math.min(metres - slow, 5 * NM);
  return slow / 72 + middle / 82 + (metres - slow - middle) / 92;
}

/** Seconds until an inbound lands, along the path it will really fly. */
export function touchdownIn(sim: Simulation, ac: Aircraft): number {
  if (ac.phase === "landing") return flyingSec(distanceToThreshold(sim, ac));
  let metres = 0;
  let from = ac.position;
  for (const waypoint of ac.airRoute.slice(ac.airIndex)) {
    metres += dist(from, waypoint);
    from = waypoint;
  }
  return flyingSec(metres);
}

/** An aircraft in distress that will use this runway next, including while it is still on the way round. */
export function emergencyInbound(sim: Simulation, runwayId: string, exceptId?: string): Aircraft | undefined {
  for (const ac of sim.aircraft.values()) {
    if (ac.id === exceptId || ac.priority !== "emergency") continue;
    if (ac.phase !== "approach" && ac.phase !== "go_around" && ac.phase !== "landing") continue;
    if (sim.graph.runwayEnd(ac.assignedRunway)?.runway.id === runwayId) return ac;
  }
  return undefined;
}

export interface InboundArrival {
  aircraft: Aircraft;
  etaSec: number;
  distanceNm: number;
  cleared: boolean;
}

/** Aircraft on approach to either end of a physical runway, nearest first. */
export function inboundArrivals(sim: Simulation, runwayId: string): InboundArrival[] {
  const out: InboundArrival[] = [];
  for (const ac of sim.aircraft.values()) {
    if (ac.phase !== "approach" && ac.phase !== "landing") continue;
    if (sim.graph.runwayEnd(ac.assignedRunway)?.runway.id !== runwayId) continue;
    const d = distanceToThreshold(sim, ac);
    out.push({
      aircraft: ac,
      etaSec: d / Math.max(ac.speedKts * KT, 40),
      distanceNm: d / NM,
      cleared: ac.landingCleared,
    });
  }
  return out.sort((a, b) => a.etaSec - b.etaSec);
}
