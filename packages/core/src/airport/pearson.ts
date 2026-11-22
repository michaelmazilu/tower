import { CYYZ_BUILDINGS } from "./data/cyyzBuildings";
import { CYYZ_OSM } from "./data/cyyzOsm";
import type { AirportData } from "./graph";
import { AirportGraph } from "./graph";
import { buildAirportFromOsm, type OsmBuildReport } from "./osm";

/**
 * Toronto Pearson (CYYZ) from OpenStreetMap: the real runways, the real
 * taxiway network with its names, and the Terminal 1 and Terminal 3 stands.
 *
 * Terminal 3 stands carry their gate names (B7, C33). Terminal 1 stands
 * carry stand numbers (131, 164), as mapped; nothing is renamed here.
 * Cargo, FedEx, infield and de-icing areas are drawn but nothing parks there.
 */

/** The central de-icing facility's bays (1N..6S, 1C..6C) are a parking area, not a through route. */
const DEICING_BAY = /^[1-6][NSC]$/;

const built = buildAirportFromOsm(CYYZ_OSM, {
  name: "Toronto Pearson International Airport",
  disclaimer:
    "Layout from OpenStreetMap: real runway and taxiway centrelines and stand positions. Hold lines are placed 90 m from each runway centreline, not surveyed. Not for navigation.",
  standTerminal(ref) {
    if (/^[ABC]\d/.test(ref)) return "T3";
    const n = Number.parseInt(ref, 10);
    if (/^\d/.test(ref) && n >= 100 && n <= 199) return "T1";
    return undefined;
  },
  skipTaxiway: (way) => DEICING_BAY.test(way.ref ?? ""),
  buildings: CYYZ_BUILDINGS,
  terminal(name) {
    if (/terminal 1/i.test(name)) return { id: "T1", name: "Terminal 1" };
    if (/terminal 3/i.test(name)) return { id: "T3", name: "Terminal 3" };
    if (/infield/i.test(name)) return { id: "IFC", name: "Infield Concourse" };
    return undefined;
  },
});

export const PEARSON: AirportData = built.data;
export const PEARSON_BUILD_REPORT: OsmBuildReport = built.report;

export function createPearsonGraph(): AirportGraph {
  return new AirportGraph(PEARSON);
}
