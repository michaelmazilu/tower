import { angleDiff, dist, dot, headingVec, NM, sub } from "../geometry";
import type { Aircraft } from "../types";
import { approachRoute, circuitRoute, goAround, touchdownPoint } from "./air";
import { closeOpenClearances, issueClearance, mayLand, stopAfterTaxiCancellation } from "./clearances";
import { runwayOccupiedBy } from "./runways";
import type { Simulation } from "./simulation";

/**
 * When a runway stops being available, everyone planned onto it loses the
 * permissions for it at once and is offered the nearest active runway in the same
 * direction as a clearance: nothing moves until that has been read back. A flight a
 * person holds is left to that person.
 */

/** Closest approach point to the new threshold at which a side-step is still flown. */
const SIDESTEP_MIN_NM = 4;
const SIDESTEP_PER_LATERAL_NM = 4.5;

function nearest(sim: Simulation, from: string, options: string[]): string | undefined {
  const old = sim.graph.runwayEnd(from)!.end;
  const cost = (designator: string) => {
    const end = sim.graph.runwayEnd(designator)!.end;
    return (Math.abs(angleDiff(old.headingDeg, end.headingDeg)) > 30 ? 1e6 : 0) + dist(old.threshold, end.threshold);
  };
  return [...options].sort((a, b) => cost(a) - cost(b) || a.localeCompare(b))[0];
}

function canSidestep(sim: Simulation, ac: Aircraft, to: string): { ok: boolean; alongNm: number } {
  const ref = sim.graph.runwayEnd(to)!;
  const toTouchdown = sub(touchdownPoint(ref), ac.position);
  const dir = headingVec(ref.end.headingDeg);
  const alongNm = dot(toTouchdown, dir) / NM;
  const lateral = Math.abs(toTouchdown.x * dir.y - toTouchdown.y * dir.x) / NM;
  const ok =
    (ac.phase === "holding" || Math.abs(angleDiff(ac.headingDeg, ref.end.headingDeg)) < 45) &&
    alongNm >= Math.max(SIDESTEP_MIN_NM, lateral * SIDESTEP_PER_LATERAL_NM);
  return { ok, alongNm };
}

/** The effect of a change of runway that has been read back. */
export function moveToRunway(sim: Simulation, ac: Aircraft, to: string): void {
  const from = ac.assignedRunway!;
  ac.flags.runwayUnavailable = false;
  if (ac.phase !== "approach" && ac.phase !== "holding" && ac.phase !== "go_around") {
    ac.assignedRunway = to;
  } else {
    moveAirborne(sim, ac, to);
  }
  sim.emit("aircraft.runway_changed", {
    aircraftId: ac.id,
    attention: true,
    cause: { kind: "clearance", clearanceId: ac.clearance?.id ?? "" },
    data: { from, to },
  });
}

function moveAirborne(sim: Simulation, ac: Aircraft, to: string): void {
  const from = ac.assignedRunway;
  const { ok, alongNm: along } = canSidestep(sim, ac, to);
  if (ac.phase !== "go_around" && !ok) goAround(sim, ac, { kind: "auto", rule: "runway_unavailable" }, `runway ${from} not available`);
  ac.assignedRunway = to;
  ac.flags.clearanceNeededNotified = false;
  ac.flags.priorityReturn = false;
  if (ac.phase === "go_around") {
    ac.airRoute = circuitRoute(sim.graph, to, ac.type, ac.position);
    // Already on downwind or later: do not fly the whole circuit again.
    ac.airIndex = Math.min(ac.airIndex, 2);
    return;
  }
  ac.airRoute = approachRoute(sim.graph, to, ac.type);
  ac.airIndex = along > 10.5 ? 0 : along > 5.5 ? 1 : 2;
}

const inboundPhase = (ac: Aircraft) => ac.phase === "approach" || ac.phase === "holding" || ac.phase === "go_around";

/** The runway to offer in place of the one this aircraft has. */
export function replacementRunway(sim: Simulation, ac: Aircraft): string | undefined {
  const { arrivals, departures } = sim.activeRunways;
  return ac.assignedRunway ? nearest(sim, ac.assignedRunway, inboundPhase(ac) ? arrivals : departures) : undefined;
}

/** Called when the runways in use change: withdraws what no longer holds. */
export function reassignRunways(sim: Simulation): void {
  const { departures } = sim.activeRunways;
  for (const ac of sim.aircraft.values()) {
    const from = ac.assignedRunway;
    if (!from || ac.flightComplete) continue;

    const inbound = inboundPhase(ac);
    const outbound =
      ac.flight === "departure" &&
      ["at_gate", "pushback", "taxi_out", "holding_short"].includes(ac.phase) &&
      runwayOccupiedBy(sim, ac) !== sim.graph.runwayEnd(from)?.runway.id;
    const affected = (inbound || outbound) && (inbound ? !mayLand(ac, from, sim.activeRunways) : !departures.includes(from));
    if (!affected) {
      if (ac.flags.runwayUnavailable) {
        ac.flags.runwayUnavailable = false;
        closeOpenClearances(sim, ac.id, ["RUNWAY_CHANGE"], "cancelled", `runway ${from} is available again`);
      }
      continue;
    }
    if (ac.flags.runwayUnavailable) continue;
    const to = replacementRunway(sim, ac);
    if (!to) continue;

    ac.flags.runwayUnavailable = true;
    ac.flags.clearanceNeededNotified = false;
    if (inbound) {
      closeOpenClearances(sim, ac.id, ["CLEARED_TO_LAND", "CONTINUE_APPROACH"], "cancelled", `runway ${from} not available`);
    } else if (ac.phase === "taxi_out" || ac.phase === "holding_short") {
      closeOpenClearances(sim, ac.id, ["TAXI", "HOLD_SHORT"], "cancelled", `runway ${from} not available`);
      stopAfterTaxiCancellation(sim, ac);
    }
    // Any request for the old runway is void; the crew asks again for the new one.
    for (const r of sim.requests.values()) {
      if (r.aircraftId !== ac.id || r.runway !== from || (r.status !== "pending" && r.status !== "transmitting")) continue;
      if (r.type === "CROSS" || r.type === "OTHER") continue;
      r.status = "withdrawn";
      r.closedAt = sim.time;
      sim.radio.queue = sim.radio.queue.filter((tx) => tx.requestId !== r.id);
      sim.emit("request.withdrawn", {
        aircraftId: ac.id,
        cause: { kind: "auto", rule: "runway_unavailable" },
        data: { requestId: r.id, requestType: r.type },
      });
    }
    sim.emit("runway.change_needed", {
      aircraftId: ac.id,
      attention: true,
      cause: { kind: "auto", rule: "runway_unavailable" },
      data: { from, to },
    });
  }
  offerRunwayChanges(sim);
}

/** Issues the change, or first the go-around if it is too close in to side-step, and repeats it if it was lost. */
export function offerRunwayChanges(sim: Simulation): void {
  for (const ac of sim.aircraft.values()) {
    if (!ac.flags.runwayUnavailable || ac.humanControl) continue;
    if ([...sim.clearances.values()].some((c) => c.aircraftId === ac.id && (c.status === "issued" || c.status === "transmitted") && (c.type === "RUNWAY_CHANGE" || c.type === "GO_AROUND"))) continue;
    const to = replacementRunway(sim, ac);
    if (!to) continue;
    const from = ac.assignedRunway!;
    const breakOff = ac.phase === "approach" && !canSidestep(sim, ac, to).ok;
    issueClearance(sim, {
      type: "clearance.issue",
      aircraftId: ac.id,
      clearanceType: breakOff ? "GO_AROUND" : "RUNWAY_CHANGE",
      runway: breakOff ? undefined : to,
      reason: breakOff ? `Runway ${from} is not available and it is too close in to side-step.` : `Runway ${from} is not available; ${to} is the nearest one in use.`,
      issuedBy: "runway-rules",
    });
  }
}
