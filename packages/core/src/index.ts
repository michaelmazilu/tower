export * from "./types";
export * from "./geometry";
export { Rng } from "./rng";

export { AirportGraph, normalizeDesignator } from "./airport/graph";
export type {
  AirportData,
  AirportEdge,
  AirportNode,
  EdgeKind,
  NodeKind,
  RouteOptions,
  RouteResult,
  Runway,
  RunwayEnd,
  RunwayEndRef,
} from "./airport/graph";
export type { AirportDrawing } from "./airport/graph";
export { CYYZ_SCHEMATIC, createSchematicGraph } from "./airport/cyyz";
export { PEARSON, PEARSON_BUILD_REPORT, createPearsonGraph } from "./airport/pearson";
export { buildAirportFromOsm } from "./airport/osm";
export type { OsmBuildOptions, OsmBuildReport, OsmBuildings, OsmExtract, OsmWay } from "./airport/osm";

export { Simulation, PHASE_TRANSITIONS } from "./sim/simulation";
export type { SimSnapshot } from "./sim/simulation";
export { performance, KNOWN_TYPES } from "./sim/performance";
export {
  describeLocation,
  explainAircraft,
  getAircraftDetails,
  getAirportState,
  getConflicts,
  getPendingRequests,
  getRunwayStatus,
} from "./sim/queries";
export { distanceToThreshold, flyingSec, inboundArrivals, runwayOccupiedBy, touchdownIn } from "./sim/runways";
export { TOWER_WITHIN_NM, controlPosition } from "./sim/positions";
export type { Position } from "./sim/positions";
export { availableClearances } from "./sim/clearances";
export { SEPARATION, independentPaths, minimumNm } from "./sim/conflicts";
export { estimateDurationSec } from "./sim/radio";

export {
  clearancePhrase,
  matchReadback,
  normalizeSpeech,
  readbackPhrase,
  requestPhrase,
  spokenAlnum,
  spokenCallsign,
  spokenDigits,
  spokenRunway,
} from "./radio/phraseology";

export { DecisionTurn } from "./tools/decisionTurn";
export { ToolGateway, TOOL_DEFINITIONS } from "./tools/gateway";
export type { ToolCallMeta, ToolDefinition, ToolResult } from "./tools/gateway";

export {
  AIRPORTS,
  GUIDED_DEMO,
  JUDGE_DEMO,
  SANDBOX,
  SCENARIOS,
  SCHEMATIC_GUIDED_DEMO,
  SCHEMATIC_SANDBOX,
  createSimulation,
  replay,
} from "./scenarios";
export type { AirportId, Scenario } from "./scenarios";

export { BaselineController } from "./dev/baselineController";
export { wantedRequest } from "./sim/pilots";
