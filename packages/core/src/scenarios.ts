import { createSchematicGraph } from "./airport/cyyz";
import type { AirportGraph } from "./airport/graph";
import { createPearsonGraph } from "./airport/pearson";
import { Simulation } from "./sim/simulation";
import { spawnAircraft } from "./sim/spawn";
import type { CommandRecord, EmergencyMode, SimConfig, SpawnSpec } from "./types";

/**
 * "cyyz" is Toronto Pearson as mapped (real taxiways and stands).
 * "cyyz-schematic" is the small hand-authored layout used by most tests.
 */
export type AirportId = "cyyz" | "cyyz-schematic";

export const AIRPORTS: Record<AirportId, () => AirportGraph> = {
  cyyz: createPearsonGraph,
  "cyyz-schematic": createSchematicGraph,
};

export interface Scenario {
  id: string;
  name: string;
  description: string;
  airport: AirportId;
  seed: number;
  activeRunways: { arrivals: string[]; departures: string[] };
  emergencyMode: EmergencyMode;
  /** One radio frequency per control position; see SimConfig. */
  separateFrequencies?: boolean;
  /** One voice at a time across all positions; see SimConfig. */
  oneSpeaker?: boolean;
  aircraft: SpawnSpec[];
}

/**
 * The guided demo from the plan: eight aircraft, the same starting
 * position every time. What the controller does with them is not scripted.
 */
export const GUIDED_DEMO: Scenario = {
  id: "guided-demo",
  name: "Guided demo",
  description:
    "Toronto Pearson, west flow. Two arrivals inbound, two departures waiting at the runway, two taxiing out, one at the gate about to push, one arrival taxiing to its gate.",
  airport: "cyyz",
  seed: 20260,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "off",
  aircraft: [
    { callsign: "ACA214", type: "A320", pilotType: "ai", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 7 } },
    { callsign: "DAL482", type: "B739", pilotType: "scripted", flight: "arrival", runway: "24R", gate: "B11", start: { kind: "approach", distanceNm: 13 } },
    { callsign: "WJA302", type: "B38M", pilotType: "ai", flight: "departure", runway: "23", start: { kind: "holding_short" } },
    { callsign: "UAL119", type: "A319", pilotType: "scripted", flight: "departure", runway: "24L", start: { kind: "holding_short" } },
    // Westbound on taxiway A toward runway 23.
    { callsign: "JZA781", type: "CRJ9", pilotType: "ai", flight: "departure", runway: "23", start: { kind: "taxiing", from: "A.15" } },
    // On taxiway D, about to reach the runway 24R crossing on its way to 24L.
    { callsign: "POE245", type: "DH8D", pilotType: "scripted", flight: "departure", runway: "24L", start: { kind: "taxiing", from: "D.29" } },
    { callsign: "TSC330", type: "A333", pilotType: "ai", flight: "departure", runway: "23", gate: "164", start: { kind: "gate" }, readyInSec: 20 },
    // Just off taxiway A, entering the Terminal 1 apron.
    { callsign: "ROU1861", type: "A321", pilotType: "scripted", flight: "arrival", runway: "23", gate: "135", start: { kind: "taxiing", from: "X.204" } },
  ],
};

/**
 * What a judge sees first: a busy Pearson with every kind of work in progress.
 * The disruptions are injected by the server's director through ordinary
 * commands; the controller's answers to them are not scripted.
 */
export const JUDGE_DEMO: Scenario = {
  id: "judge-demo",
  name: "Judge demo",
  description:
    "Toronto Pearson under pressure, west flow. Continuous synthetic traffic with an incursion, a request for a human, an emergency return, weather and a runway closure in the first three minutes.",
  airport: "cyyz",
  seed: 20261122,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "manual",
  separateFrequencies: true,
  oneSpeaker: true,
  aircraft: [
    { callsign: "ACA214", type: "A320", pilotType: "ai", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 3.1 } },
    { callsign: "UAL119", type: "A319", pilotType: "ai", flight: "departure", runway: "24L", start: { kind: "holding_short", cleared: true } },
    { callsign: "DAL482", type: "B739", pilotType: "ai", flight: "arrival", runway: "24R", gate: "B11", start: { kind: "approach", distanceNm: 2, cleared: true } },
    { callsign: "WJA302", type: "B38M", pilotType: "ai", flight: "departure", runway: "23", start: { kind: "holding_short" } },
    { callsign: "DLH471", type: "A333", pilotType: "ai", flight: "arrival", runway: "23", gate: "173", start: { kind: "approach", distanceNm: 16.2 } },
    { callsign: "AFR356", type: "B789", pilotType: "ai", flight: "arrival", runway: "24R", gate: "C32", start: { kind: "approach", distanceNm: 21.5 } },
    { callsign: "KLM691", type: "B789", pilotType: "ai", flight: "arrival", runway: "23", gate: "176", start: { kind: "approach", distanceNm: 24 } },
    { callsign: "WEN3412", type: "DH8D", pilotType: "ai", flight: "arrival", runway: "24R", gate: "B20", start: { kind: "approach", distanceNm: 29 } },
    { callsign: "ROU1861", type: "A321", pilotType: "ai", flight: "arrival", runway: "23", gate: "135", start: { kind: "taxiing", from: "X.204" } },
    { callsign: "JZA781", type: "CRJ9", pilotType: "ai", flight: "departure", runway: "23", start: { kind: "taxiing", from: "A.15" } },
    { callsign: "POE245", type: "DH8D", pilotType: "ai", flight: "departure", runway: "24L", start: { kind: "taxiing", from: "D.29" } },
    { callsign: "TSC330", type: "A333", pilotType: "ai", flight: "departure", runway: "23", gate: "164", start: { kind: "gate" }, readyInSec: 185 },
    { callsign: "ACA101", type: "B77W", pilotType: "ai", flight: "departure", runway: "23", gate: "170", start: { kind: "gate" }, readyInSec: 380 },
    { callsign: "FLE612", type: "B38M", pilotType: "ai", flight: "departure", runway: "24L", gate: "B7D", start: { kind: "gate" }, readyInSec: 470 },
    { callsign: "BAW92", type: "B789", pilotType: "ai", flight: "departure", runway: "23", gate: "178", start: { kind: "gate" }, readyInSec: 560 },
    { callsign: "AAL1204", type: "E175", pilotType: "ai", flight: "departure", runway: "24L", gate: "C25", start: { kind: "gate" }, readyInSec: 650 },
  ],
};

/** An empty airport for the free-play sandbox. */
export const SANDBOX: Scenario = {
  id: "sandbox",
  name: "Free-play sandbox",
  description: "Empty Toronto Pearson, west flow. Add aircraft and trigger events by hand.",
  airport: "cyyz",
  seed: 1,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "manual",
  aircraft: [],
};

/** The guided demo on the schematic layout: short taxi distances, quick to run. */
export const SCHEMATIC_GUIDED_DEMO: Scenario = {
  id: "guided-demo-schematic",
  name: "Guided demo (schematic airport)",
  description:
    "Schematic layout, west flow. Two arrivals inbound, two departures waiting at the runway, two taxiing out, one at the gate about to push, one arrival taxiing to its gate.",
  airport: "cyyz-schematic",
  seed: 20260,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "off",
  aircraft: [
    { callsign: "ACA214", type: "A320", pilotType: "ai", flight: "arrival", runway: "23", gate: "D22", start: { kind: "approach", distanceNm: 7 } },
    { callsign: "DAL482", type: "B739", pilotType: "scripted", flight: "arrival", runway: "24R", gate: "B7", start: { kind: "approach", distanceNm: 13 } },
    { callsign: "WJA302", type: "B38M", pilotType: "ai", flight: "departure", runway: "23", start: { kind: "holding_short" } },
    { callsign: "UAL119", type: "A319", pilotType: "scripted", flight: "departure", runway: "24L", start: { kind: "holding_short" } },
    { callsign: "JZA781", type: "CRJ9", pilotType: "ai", flight: "departure", runway: "23", start: { kind: "taxiing", from: "C_T1" } },
    { callsign: "POE245", type: "DH8D", pilotType: "scripted", flight: "departure", runway: "24L", start: { kind: "taxiing", from: "J_T3" } },
    { callsign: "TSC330", type: "A333", pilotType: "ai", flight: "departure", runway: "23", gate: "D24", start: { kind: "gate" }, readyInSec: 20 },
    { callsign: "ROU1861", type: "A321", pilotType: "scripted", flight: "arrival", runway: "23", gate: "D28", start: { kind: "taxiing", from: "A_A4" } },
  ],
};

export const SCHEMATIC_SANDBOX: Scenario = {
  id: "sandbox-schematic",
  name: "Free-play sandbox (schematic airport)",
  description: "Empty schematic layout, west flow. Add aircraft and trigger events by hand.",
  airport: "cyyz-schematic",
  seed: 1,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "manual",
  aircraft: [],
};

export const SCENARIOS: Record<string, Scenario> = {
  [JUDGE_DEMO.id]: JUDGE_DEMO,
  [GUIDED_DEMO.id]: GUIDED_DEMO,
  [SANDBOX.id]: SANDBOX,
  [SCHEMATIC_GUIDED_DEMO.id]: SCHEMATIC_GUIDED_DEMO,
  [SCHEMATIC_SANDBOX.id]: SCHEMATIC_SANDBOX,
};

export function createSimulation(
  scenario: Scenario,
  overrides: Partial<SimConfig> = {},
  graph: AirportGraph = AIRPORTS[scenario.airport](),
): Simulation {
  const sim = new Simulation(graph, {
    seed: scenario.seed,
    emergencyMode: scenario.emergencyMode,
    separateFrequencies: scenario.separateFrequencies ?? false,
    oneSpeaker: scenario.oneSpeaker ?? false,
    ...overrides,
  });
  sim.activeRunways = {
    arrivals: [...scenario.activeRunways.arrivals],
    departures: [...scenario.activeRunways.departures],
  };
  sim.emit("scenario.loaded", {
    cause: { kind: "scenario" },
    data: { scenarioId: scenario.id, name: scenario.name, seed: sim.config.seed, activeRunways: sim.activeRunways },
  });
  for (const spec of scenario.aircraft) {
    const res = spawnAircraft(sim, spec, { kind: "scenario" });
    if (!res.ok) throw new Error(`scenario ${scenario.id}: cannot place ${spec.callsign}: ${res.message}`);
  }
  // Setup events are in the log; nobody is listening yet, so do not re-deliver them later.
  sim.flush();
  return sim;
}

/**
 * Re-run a recorded session. The scenario and seed rebuild the starting
 * world; the recorded commands are fed back on the ticks they originally
 * arrived on. No controller, no LLM and no voice are involved, and the
 * result is identical to the original run.
 */
export function replay(
  scenario: Scenario,
  commands: readonly CommandRecord[],
  untilTick: number,
  overrides: Partial<SimConfig> = {},
): Simulation {
  const sim = createSimulation(scenario, overrides);
  let next = 0;
  const feed = () => {
    while (next < commands.length && commands[next].tick <= sim.tick) {
      sim.dispatch(commands[next].command);
      next++;
    }
  };
  feed();
  while (sim.tick < untilTick) {
    sim.step();
    feed();
  }
  return sim;
}
