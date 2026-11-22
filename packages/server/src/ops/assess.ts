import type { Attention, Risk, RiskLevel, SeparationSample } from "@towerai/contracts";
import {
  AIRBORNE_PHASES,
  NM,
  SEPARATION,
  dist,
  distanceToThreshold,
  independentPaths,
  minimumNm,
  type Aircraft,
  type PilotRequest,
  type Simulation,
} from "@towerai/core";

/** Every rule that can put a flight on the operator's screen, in one place. No model is involved. */

export interface Assessment {
  risk: Risk;
  attention: Attention;
  need: string | null;
}

export const levelOf = (score: number): RiskLevel =>
  score >= 85 ? "critical" : score >= 60 ? "high" : score >= 25 ? "watch" : "normal";

const SCORE = { critical: 92, warning: 64, advisory: 30 };
const SLOW_ANSWER_SEC = 120;
const NO_ANSWER_SEC = 240;
const CHANGE_FRESH_SEC = 90;

/**
 * The pair to show: the tightest one the minima apply to, unless an independent
 * parallel is nearer, which is shown with no minimum (requiredNm 0).
 */
export function nearestTraffic(sim: Simulation, ac: Aircraft): Omit<SeparationSample, "t"> | null {
  if (!AIRBORNE_PHASES.has(ac.phase) || ac.altitudeFt <= 200) return null;
  type Pair = Omit<SeparationSample, "t"> & { margin: number };
  let nearest: Pair | null = null;
  let tightest: Pair | null = null;
  for (const other of sim.aircraft.values()) {
    if (other === ac || !AIRBORNE_PHASES.has(other.phase) || other.altitudeFt <= 200) continue;
    const apart = independentPaths(sim, ac, other);
    const requiredNm = apart ? 0 : minimumNm(sim, ac, other);
    const requiredFt = apart ? 0 : SEPARATION.verticalFt;
    const lateralNm = Math.round((dist(ac.position, other.position) / NM) * 100) / 100;
    const verticalFt = Math.round(Math.abs(ac.altitudeFt - other.altitudeFt));
    const margin = apart ? Infinity : Math.max(lateralNm / requiredNm, verticalFt / requiredFt);
    const pair = { otherFlightId: other.id, lateralNm, verticalFt, requiredNm, requiredFt, margin };
    if (!nearest || lateralNm < nearest.lateralNm) nearest = pair;
    if (!apart && (!tightest || margin < tightest.margin)) tightest = pair;
  }
  const shown = tightest && tightest.margin < 2 ? tightest : nearest;
  if (!shown) return null;
  const { margin: _, ...sample } = shown;
  return sample;
}

export function assess(
  sim: Simulation,
  ac: Aircraft,
  open: readonly PilotRequest[],
  near: Omit<SeparationSample, "t"> | null,
  runwayChangedAt: number | undefined,
  /** Why the pilot asked for a person, once that has been said. */
  escalation?: string,
): Assessment {
  const factors: [score: number, reason: string][] = [];
  const add = (score: number, reason: string) => factors.push([score, reason]);

  const emergency = ac.emergencyId ? sim.emergencies.get(ac.emergencyId) : undefined;
  const incursion = ac.flags.incursionActive || ac.flags.incursionHold;
  if (incursion || emergency?.type === "runway_incursion") {
    add(incursion ? 95 : 88, incursion ? "On a runway without a clearance" : "Rolling toward a runway without a clearance");
  }
  const flying = AIRBORNE_PHASES.has(ac.phase);
  if (emergency?.type === "engine_failure") add(flying ? 88 : 40, flying ? "Declared emergency: engine failure" : "Emergency aircraft on the ground");
  else if (ac.priority === "urgent") {
    if (flying) add(50, escalation ? `Priority: ${escalation}` : "Urgent priority");
  } else if (ac.priority === "emergency") add(ac.altitudeFt > 0 ? 75 : 30, "Emergency priority");

  for (const c of sim.conflicts.values()) {
    if (c.aircraftIds.includes(ac.id)) add(SCORE[c.severity], c.description);
  }

  const asked = open.find((r) => r.type === "OTHER");
  if (asked) add(66, "The pilot asked for a person");

  if (ac.phase === "approach" && !ac.landingCleared) {
    const out = distanceToThreshold(sim, ac) / NM;
    if (out < 2) add(72, `No landing clearance at ${out.toFixed(1)} NM; goes around at ${sim.config.rules.decisionDistanceNm} NM`);
    else if (out < sim.config.rules.clearanceNeededNm) add(40, `No landing clearance yet at ${out.toFixed(1)} NM`);
  }
  if (ac.phase === "go_around") add(38, ac.flags.emergencyReturn ? "Turning back to land" : "Flying a missed approach");
  if (runwayChangedAt !== undefined && sim.time - runwayChangedAt < CHANGE_FRESH_SEC) add(34, "Runway changed in flight plan");
  if (ac.flags.runwayUnavailable) {
    add(ac.humanControl ? 90 : 45, ac.humanControl ? `Runway ${ac.assignedRunway} shut: waiting for your instruction` : `Runway ${ac.assignedRunway} shut: change not yet read back`);
  }
  if (ac.clearance?.status === "readback_missing") add(55, "Readback missing");

  let unanswered = 0;
  for (const r of open) {
    if (r.type === "OTHER" || r.deferredBy || r.heardAt === undefined) continue;
    unanswered = Math.max(unanswered, sim.time - r.heardAt);
  }
  if (unanswered > NO_ANSWER_SEC) add(62, `Request unanswered for ${Math.floor(unanswered / 60)} min`);
  else if (unanswered > SLOW_ANSWER_SEC) add(30, `Request waiting ${Math.floor(unanswered / 60)} min`);

  if (near && near.requiredNm && near.lateralNm < near.requiredNm * 1.4 && near.verticalFt < near.requiredFt) {
    add(28, `${near.lateralNm.toFixed(1)} NM from ${near.otherFlightId}; minimum ${near.requiredNm} NM`);
  }

  factors.sort((a, b) => b[0] - a[0]);
  const score = factors.length ? Math.min(100, factors[0][0] + 2 * (factors.length - 1)) : 5;
  const level = levelOf(score);

  const attention: Attention = ac.humanControl
    ? "human_control"
    : asked
      ? "human_requested"
      : level === "critical" || unanswered > NO_ANSWER_SEC
        ? "intervene"
        : level === "normal"
          ? "none"
          : "monitor";

  return { risk: { score, level, reasons: factors.map((f) => f[1]) }, attention, need: needOf(sim, ac, open, asked, incursion === true, escalation) };
}

/** "Approach, DLH471, passenger medical emergency, request a human controller." needs no repeating in full. */
export function escalationReason(text: string, callsign: string): string {
  return text.split(callsign).at(-1)!.replace(/,?\s*request(ing)? (a )?human( controller)?/i, "").replace(/^[\s,.]+|[\s,.]+$/g, "");
}

/** For a box: "passenger medical emergency" is "medical". The flight's own panel has it in full. */
const inShort = (why: string) => why.replace(/^passenger /, "").replace(/ emergency$/, "");

function needOf(
  sim: Simulation, ac: Aircraft, open: readonly PilotRequest[], asked: PilotRequest | undefined, incursion: boolean, escalation?: string,
): string | null {
  if (incursion) return "a way off the runway";
  if (ac.flags.runwayUnavailable) return `another runway, ${ac.assignedRunway} shut`;
  if (asked) {
    const why = escalationReason(asked.text, ac.callsign);
    return why ? `human: ${inShort(why)}` : "a human controller";
  }
  const emergency = ac.emergencyId ? sim.emergencies.get(ac.emergencyId) : undefined;
  if (emergency?.type === "engine_failure" && ac.altitudeFt > 0) return `priority landing ${ac.assignedRunway}, rescue`;
  if (escalation && (ac.humanControl || AIRBORNE_PHASES.has(ac.phase))) return ac.humanControl ? escalation : `priority: ${inShort(escalation)}`;
  if (ac.holdPosition) return ac.flags.taxiClearanceCancelled ? "a new taxi route" : "release from hold position";
  if (ac.phase === "holding") return "release from the hold";
  const request = open[0];
  switch (request?.type) {
    case "PUSHBACK":
      return "pushback approval";
    case "TAXI":
      return ac.flight === "departure" ? `taxi to ${request.runway ?? ac.assignedRunway}` : `taxi to gate ${ac.gate}`;
    case "TAKEOFF":
      return `takeoff ${request.runway}`;
    case "LANDING":
      return request.deferredBy ? `sequence for ${request.runway}` : `landing ${request.runway}`;
    case "CROSS":
      return `cross ${request.runway}`;
  }
  return null;
}
