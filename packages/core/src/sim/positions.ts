import { NM } from "../geometry";
import type { Aircraft } from "../types";
import { distanceToThreshold } from "./runways";
import type { Simulation } from "./simulation";

/** An arrival changes from approach to tower here. */
export const TOWER_WITHIN_NM = 8;

export type Position = "ground" | "tower" | "departure" | "approach";

/** Which controller position works this aircraft now. */
export function controlPosition(sim: Simulation, ac: Aircraft): Position {
  switch (ac.phase) {
    case "at_gate":
    case "pushback":
      return "ground";
    case "taxi_out":
    case "taxi_in":
      // Rolled onto a runway uncleared: that is the tower's problem.
      return ac.flags.incursionHold || ac.flags.incursionActive ? "tower" : "ground";
    case "holding_short":
    case "line_up":
    case "takeoff":
    case "landing":
    case "rollout":
      return "tower";
    case "departure":
      return "departure";
    case "approach":
      return distanceToThreshold(sim, ac) <= TOWER_WITHIN_NM * NM ? "tower" : "approach";
    case "holding":
    case "go_around":
      return "approach";
  }
}
