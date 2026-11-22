import { angleDiff, bearing, dist, dot, headingVec, NM, scale, sub } from "../geometry";
import type { Aircraft, Conflict } from "../types";
import { AIRBORNE_PHASES } from "../types";
import { crossTrack, established } from "./air";
import { inboundArrivals } from "./runways";
import type { Simulation } from "./simulation";

/** Terminal minima. Aircraft in trail on one final may close to the smaller figure. */
export const SEPARATION = { lateralNm: 3, sameFinalNm: 2.5, verticalFt: 1000 };
/** Altitudes held exactly 1000 ft apart must not flicker into a breach. */
const VERTICAL_TOLERANCE_FT = 5;
/** Centrelines at least this far apart (4300 ft) take simultaneous independent approaches. */
const INDEPENDENT_NM = 0.7;

/** Climbing out on a path that has been turned away from the other runway, not just heading that way. */
function leaving(ac: Aircraft): boolean {
  if (ac.phase === "departure") return true;
  return ac.phase === "go_around" && ac.airIndex === 0;
}

/**
 * Pairs the minima do not apply to: both established on finals far enough apart,
 * a climb-out beside a final, or climb-outs and missed approaches on diverging paths.
 */
export function independentPaths(sim: Simulation, a: Aircraft, b: Aircraft): boolean {
  const ra = sim.graph.runwayEnd(a.assignedRunway);
  const rb = sim.graph.runwayEnd(b.assignedRunway);
  if (!ra || !rb || ra.runway.id === rb.runway.id) return false;
  const finalA = established(sim, a);
  const finalB = established(sim, b);
  if (finalA && finalB) {
    return Math.abs(angleDiff(ra.end.headingDeg, rb.end.headingDeg)) < 5 && Math.abs(crossTrack(ra, rb.end.threshold)) >= INDEPENDENT_NM * NM;
  }
  if (!(finalA || leaving(a)) || !(finalB || leaving(b))) return false;
  const path = (ac: Aircraft) => (ac.airRoute[ac.airIndex] ? bearing(ac.position, ac.airRoute[ac.airIndex]!) : ac.headingDeg);
  const ga = a.phase === "go_around";
  const gb = b.phase === "go_around";
  // A departure climbs out ahead of where the other runway's arrivals descend.
  if (!ga && !gb) return finalA || finalB || Math.abs(angleDiff(path(a), path(b))) >= 15;
  // A missed approach must be pointed away from whatever is on the other runway.
  const away = (ac: Aircraft, other: Aircraft, runway: typeof ra) => {
    const right = headingVec(runway.end.headingDeg + 90);
    const turned = dot(sub(ac.airRoute[0] ?? ac.position, runway.end.threshold), right);
    return dot(scale(right, Math.sign(turned)), sub(other.position, ac.position)) < 0;
  };
  return (!ga || away(a, b, ra)) && (!gb || away(b, a, rb)) && Math.abs(angleDiff(path(a), path(b))) >= 15;
}

/** The lateral minimum between these two. */
export function minimumNm(sim: Simulation, a: Aircraft, b: Aircraft): number {
  if (!established(sim, a) || !established(sim, b)) return SEPARATION.lateralNm;
  const ra = sim.graph.runwayEnd(a.assignedRunway)!;
  const rb = sim.graph.runwayEnd(b.assignedRunway)!;
  const oneFinal = Math.abs(crossTrack(ra, rb.end.threshold)) < INDEPENDENT_NM * NM && Math.abs(angleDiff(ra.end.headingDeg, rb.end.headingDeg)) < 5;
  return oneFinal ? SEPARATION.sameFinalNm : SEPARATION.lateralNm;
}

const SEVERITY = { advisory: 0, warning: 1, critical: 2 } as const;

/**
 * Predicted and actual conflicts, recomputed once per simulated second.
 * These are advisory: they tell the controller where to look. The hard
 * guarantees live in clearance validation and in the aircraft's own
 * stop-and-go-around behaviour.
 */
export function detectConflicts(sim: Simulation): void {
  const found = new Map<string, Conflict>();
  const add = (c: Omit<Conflict, "detectedAt">) => {
    found.set(c.key, { ...c, detectedAt: sim.conflicts.get(c.key)?.detectedAt ?? sim.time });
  };

  for (const state of sim.runwayState.values()) {
    const holder = state.reservation?.aircraftId;
    const arrivals = inboundArrivals(sim, state.id);

    // Someone is on a runway that was promised to someone else.
    for (const occupant of state.occupants) {
      if (holder && occupant !== holder) {
        add({
          key: `incursion:${state.id}:${occupant}`,
          type: "runway_incursion",
          severity: "critical",
          aircraftIds: [occupant, holder],
          runwayId: state.id,
          description: `${occupant} is on runway ${state.id}, which is reserved for ${holder}.`,
        });
      }
    }
    // An arrival is close and the runway is not its own.
    for (const arr of arrivals) {
      if (arr.etaSec > 90) continue;
      const others = state.occupants.filter((o) => o !== arr.aircraft.id);
      const blockedBy = others[0] ?? (holder && holder !== arr.aircraft.id ? holder : undefined);
      if (blockedBy) {
        add({
          key: `arrival:${state.id}:${arr.aircraft.id}`,
          type: "arrival_runway_occupied",
          severity: arr.etaSec < 45 ? "critical" : "warning",
          aircraftIds: [arr.aircraft.id, blockedBy],
          runwayId: state.id,
          description: `${arr.aircraft.callsign} is ${arr.distanceNm.toFixed(1)} NM from runway ${state.id} while ${blockedBy} has it.`,
        });
      }
    }
  }

  const list = [...sim.aircraft.values()];

  for (const ac of list) {
    // Standing still because of other traffic or a closed taxiway.
    if (ac.blockedSince !== undefined && sim.time - ac.blockedSince > 30) {
      const other = ac.blockedBy ? sim.get(ac.blockedBy) : undefined;
      const queueing = ac.blockedReason === "traffic" && other && other.blockedBy !== ac.id;
      if (!queueing) {
        const mutual = other?.blockedBy === ac.id;
        add({
          key: `blocked:${ac.id}`,
          type: "taxi_blocked",
          severity: mutual ? "critical" : "warning",
          aircraftIds: other ? [ac.id, other.id] : [ac.id],
          description:
            ac.blockedReason === "blocked_edge"
              ? `${ac.callsign} is stopped at a closed taxiway and needs a new route.`
              : mutual
                ? `${ac.callsign} and ${other!.callsign} are nose to nose and cannot pass.`
                : `${ac.callsign} has been waiting ${Math.round(sim.time - ac.blockedSince)} s for ${ac.blockedBy ?? "traffic"}.`,
        });
      }
    }
    // A closed taxiway lies ahead on the cleared route.
    if (ac.altitudeFt === 0 && sim.closedEdges.size > 0) {
      for (let j = Math.max(1, ac.currentWaypointIndex); j < ac.route.length; j++) {
        const edge = sim.graph.edgeBetween(ac.route[j - 1], ac.route[j]);
        if (edge && sim.closedEdges.has(edge.id)) {
          add({
            key: `closed:${ac.id}:${edge.id}`,
            type: "closed_edge_on_route",
            severity: "advisory",
            aircraftIds: [ac.id],
            description: `${ac.callsign}'s route uses closed taxiway ${edge.name ?? edge.id}.`,
          });
          break;
        }
      }
    }
  }

  // Airborne pairs too close together.
  const airborne = list.filter((a) => AIRBORNE_PHASES.has(a.phase) && a.altitudeFt > 200);
  for (let i = 0; i < airborne.length; i++) {
    for (let j = i + 1; j < airborne.length; j++) {
      const a = airborne[i];
      const b = airborne[j];
      if (independentPaths(sim, a, b)) continue;
      const lateral = dist(a.position, b.position);
      const vertical = Math.abs(a.altitudeFt - b.altitudeFt);
      if (lateral < minimumNm(sim, a, b) * NM && vertical < SEPARATION.verticalFt - VERTICAL_TOLERANCE_FT) {
        const [x, y] = [a.id, b.id].sort();
        add({
          key: `airborne:${x}:${y}`,
          type: "airborne_separation",
          severity: lateral < 1.5 * NM ? "critical" : "warning",
          aircraftIds: [x, y],
          description: `${a.callsign} and ${b.callsign} are ${(lateral / NM).toFixed(1)} NM and ${Math.round(vertical)} ft apart.`,
        });
      }
    }
  }

  for (const [key, c] of found) {
    const prior = sim.conflicts.get(key);
    const escalated = prior && SEVERITY[c.severity] > SEVERITY[prior.severity];
    if (!prior || escalated) {
      sim.emit(escalated ? "conflict.escalated" : "conflict.detected", {
        aircraftId: c.aircraftIds[0],
        attention: c.severity !== "advisory",
        cause: { kind: "auto", rule: "conflict_scan" },
        data: prior ? { ...c, previousSeverity: prior.severity } : { ...c },
      });
    }
    sim.conflicts.set(key, c);
  }
  for (const key of [...sim.conflicts.keys()]) {
    if (found.has(key)) continue;
    const c = sim.conflicts.get(key)!;
    sim.conflicts.delete(key);
    sim.emit("conflict.resolved", {
      aircraftId: c.aircraftIds[0],
      cause: { kind: "auto", rule: "conflict_scan" },
      data: { key, conflictType: c.type },
    });
  }
}
