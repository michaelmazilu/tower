import { dist, round1 } from "../geometry";
import type { Vec2 } from "../types";
import type { AirportData, AirportEdge, AirportNode, EdgeKind, NodeKind, Runway } from "./graph";
import { AirportGraph } from "./graph";

/**
 * Schematic Toronto Pearson (CYYZ): a small hand-authored layout kept as a
 * fast, easy-to-read test airport. The real layout lives in pearson.ts.
 *
 * The five runways have their real designators, real lengths and the real
 * relationship to each other (05/23 north, the 06/24 pair south with the
 * outer runway reached by crossing the inner one, the 15/33 pair west).
 * Taxiways, gates and exact positions are a schematic built for routing,
 * not a survey: the layout is authored on a grid aligned with the 05/23
 * axis and rotated into east/north metres.
 *
 * (u, v) authoring frame: u runs along heading 057 (the 05 -> 23 direction),
 * v along heading 327.
 */

const AXIS_DEG = 57;
const rad = (AXIS_DEG * Math.PI) / 180;
const U: Vec2 = { x: Math.sin(rad), y: Math.cos(rad) };
const V: Vec2 = { x: Math.sin(rad - Math.PI / 2), y: Math.cos(rad - Math.PI / 2) };

export function uv(u: number, v: number): Vec2 {
  return { x: round1(u * U.x + v * V.x), y: round1(u * U.y + v * V.y) };
}

const SPEED_KTS: Record<EdgeKind, number> = {
  taxiway: 20,
  apron: 12,
  gate_stub: 6,
  runway_link: 15,
  runway: 30,
};

function build(): AirportData {
  const nodes: AirportNode[] = [];
  const edges: AirportEdge[] = [];
  const runways: Runway[] = [];
  const byId = new Map<string, AirportNode>();

  const N = (id: string, kind: NodeKind, u: number, v: number, extra: Partial<AirportNode> = {}) => {
    const p = uv(u, v);
    const node: AirportNode = { id, kind, x: p.x, y: p.y, ...extra };
    nodes.push(node);
    byId.set(id, node);
  };

  const E = (from: string, to: string, kind: EdgeKind, name?: string, extra: Partial<AirportEdge> = {}) => {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) throw new Error(`cyyz: edge ${from} -> ${to} references a missing node`);
    edges.push({
      id: AirportGraph.edgeId(from, to),
      from,
      to,
      kind,
      name,
      lengthM: round1(dist(a, b)),
      speedLimitKts: SPEED_KTS[kind],
      ...extra,
    });
  };

  /** Chain of nodes joined into one named taxiway. `flow` = listing order is preferred. */
  const taxiway = (name: string, ids: string[], kind: EdgeKind = "taxiway", flow = false) => {
    for (let i = 1; i < ids.length; i++) E(ids[i - 1], ids[i], kind, name, flow ? { flow: true } : {});
  };

  const runway = (
    id: string,
    endA: { designator: string; headingDeg: number },
    endB: { designator: string; headingDeg: number },
    nodeIds: string[],
  ) => {
    for (let i = 1; i < nodeIds.length; i++) E(nodeIds[i - 1], nodeIds[i], "runway", id, { runway: id });
    const first = byId.get(nodeIds[0])!;
    const last = byId.get(nodeIds[nodeIds.length - 1])!;
    runways.push({
      id,
      ends: [
        { ...endA, thresholdNode: first.id, threshold: { x: first.x, y: first.y } },
        { ...endB, thresholdNode: last.id, threshold: { x: last.x, y: last.y } },
      ],
      lengthM: round1(dist(first, last)),
      widthM: 60,
      nodeIds,
    });
  };

  // ------------------------------------------------ north: runway 05/23, taxiway A
  const A_U = [-1700, -900, -300, 300, 900, 1689];
  A_U.forEach((u, i) => {
    const k = i + 1;
    N(`RW0523_A${k}`, "runway", u, 1500, { runway: "05/23" });
    N(`HS_A${k}`, "hold_short", u, 1350, { guards: "05/23", label: `A${k}` });
    N(`A_A${k}`, "taxiway", u, 1200);
    E(`A_A${k}`, `HS_A${k}`, "taxiway", `A${k}`);
    E(`HS_A${k}`, `RW0523_A${k}`, "runway_link", `A${k}`, { runway: "05/23" });
  });
  N("A_H", "taxiway", -1200, 1200);
  N("A_C", "taxiway", 0, 1200);
  N("A_E", "taxiway", 1100, 1200);
  taxiway("A", ["A_A1", "A_H", "A_A2", "A_A3", "A_C", "A_A4", "A_A5", "A_E", "A_A6"], "taxiway", true);
  runway(
    "05/23",
    { designator: "05", headingDeg: 57 },
    { designator: "23", headingDeg: 237 },
    A_U.map((_, i) => `RW0523_A${i + 1}`),
  );

  // ------------------------------- south: runway 06L/24R (inner), taxiway D north of it
  const D_U = [-800, 0, 450, 1300, 2156];
  D_U.forEach((u, i) => {
    const k = i + 1;
    N(`RW0624N_D${k}`, "runway", u, -1300, { runway: "06L/24R" });
    N(`HS_D${k}`, "hold_short", u, -1150, { guards: "06L/24R", label: `D${k}` });
    N(`D_D${k}`, "taxiway", u, -1000);
    E(`D_D${k}`, `HS_D${k}`, "taxiway", `D${k}`);
    E(`HS_D${k}`, `RW0624N_D${k}`, "runway_link", `D${k}`, { runway: "06L/24R" });
  });
  N("D_H", "taxiway", -1200, -1000);
  N("D_E", "taxiway", 1100, -1000);
  N("D_J", "taxiway", 1689, -1000);
  taxiway("D", ["D_H", "D_D1", "D_D2", "D_D3", "D_E", "D_D4", "D_J", "D_D5"]);
  runway(
    "06L/24R",
    { designator: "06L", headingDeg: 57 },
    { designator: "24R", headingDeg: 237 },
    D_U.map((_, i) => `RW0624N_D${i + 1}`),
  );

  // -------------------- south: runway 06R/24L (outer), taxiway F between the pair
  const F_U = [-587, 0, 450, 1300, 2156];
  F_U.forEach((u, i) => {
    const k = i + 1;
    N(`F_F${k}`, "taxiway", u, -1550);
    N(`HS_F${k}`, "hold_short", u, -1650, { guards: "06R/24L", label: `F${k}` });
    N(`RW0624S_F${k}`, "runway", u, -1800, { runway: "06R/24L" });
    E(`F_F${k}`, `HS_F${k}`, "taxiway", `F${k}`);
    E(`HS_F${k}`, `RW0624S_F${k}`, "runway_link", `F${k}`, { runway: "06R/24L" });
  });
  taxiway("F", F_U.map((_, i) => `F_F${i + 1}`));
  runway(
    "06R/24L",
    { designator: "06R", headingDeg: 57 },
    { designator: "24L", headingDeg: 237 },
    F_U.map((_, i) => `RW0624S_F${i + 1}`),
  );
  // Crossings of the inner runway: D2, D4 and D5 continue south to F.
  for (const k of [2, 4, 5]) {
    N(`HS_D${k}S`, "hold_short", D_U[k - 1], -1450, { guards: "06L/24R", label: `D${k}` });
    E(`RW0624N_D${k}`, `HS_D${k}S`, "runway_link", `D${k}`, { runway: "06L/24R" });
    E(`HS_D${k}S`, `F_F${k}`, "taxiway", `D${k}`);
  }

  // ----------------------------- west: runway 15L/33R (inner), taxiway H east of it
  const H_V = [1100, 300, -400, -1300, -2268];
  H_V.forEach((v, i) => {
    const k = i + 1;
    N(`RW1533E_H${k}`, "runway", -1500, v, { runway: "15L/33R" });
    N(`HS_H${k}`, "hold_short", -1350, v, { guards: "15L/33R", label: `H${k}` });
    N(`H_H${k}`, "taxiway", -1200, v);
    E(`H_H${k}`, `HS_H${k}`, "taxiway", `H${k}`);
    E(`HS_H${k}`, `RW1533E_H${k}`, "runway_link", `H${k}`, { runway: "15L/33R" });
  });
  taxiway("H", ["A_H", "H_H1", "H_H2", "H_H3", "D_H", "H_H4", "H_H5"]);
  runway(
    "15L/33R",
    { designator: "15L", headingDeg: 147 },
    { designator: "33R", headingDeg: 327 },
    H_V.map((_, i) => `RW1533E_H${i + 1}`),
  );

  // ----------------------- west: runway 15R/33L (outer), taxiway K between the pair
  const K_V = [900, 300, -400, -1300, -1870];
  K_V.forEach((v, i) => {
    const k = i + 1;
    N(`K_K${k}`, "taxiway", -1850, v);
    N(`HS_K${k}`, "hold_short", -2050, v, { guards: "15R/33L", label: `K${k}` });
    N(`RW1533W_K${k}`, "runway", -2200, v, { runway: "15R/33L" });
    E(`K_K${k}`, `HS_K${k}`, "taxiway", `K${k}`);
    E(`HS_K${k}`, `RW1533W_K${k}`, "runway_link", `K${k}`, { runway: "15R/33L" });
  });
  taxiway("K", K_V.map((_, i) => `K_K${i + 1}`));
  runway(
    "15R/33L",
    { designator: "15R", headingDeg: 147 },
    { designator: "33L", headingDeg: 327 },
    K_V.map((_, i) => `RW1533W_K${i + 1}`),
  );
  // Crossings of the inner west runway: H2 and H4 continue west to K.
  for (const k of [2, 4]) {
    N(`HS_H${k}W`, "hold_short", -1650, H_V[k - 1], { guards: "15L/33R", label: `H${k}` });
    E(`RW1533E_H${k}`, `HS_H${k}W`, "runway_link", `H${k}`, { runway: "15L/33R" });
    E(`HS_H${k}W`, `K_K${k}`, "taxiway", `H${k}`);
  }

  // --------------------------------------------- links between the north and south
  N("C_T1", "apron", 0, 100);
  N("E_T1", "apron", 1100, 100);
  N("E_T3", "apron", 1100, -300);
  N("J_T3", "apron", 1689, -300);
  taxiway("C", ["D_D2", "C_T1", "A_C"], "taxiway", true); // preferred northbound
  taxiway("E", ["A_E", "E_T1", "E_T3", "D_E"], "taxiway", true); // preferred southbound
  taxiway("J", ["A_A6", "J_T3", "D_J"]);

  // ------------------------------------------------------------ Terminal 1 apron
  const T1_LANE_U = [1000, 800, 700, 600, 500, 400, 300, 200];
  for (const u of T1_LANE_U) N(`L1_${u}`, "apron", u, 100);
  taxiway("T1", ["E_T1", ...T1_LANE_U.map((u) => `L1_${u}`), "C_T1"], "apron", true); // preferred westbound
  const gate = (name: string, terminal: string, u: number, v: number, lane: string) => {
    N(`G_${name}`, "gate", u, v, { gate: name, terminal, pushbackNode: lane, label: name });
    E(`G_${name}`, lane, "gate_stub", name);
  };
  gate("D20", "T1", 200, 250, "L1_200");
  gate("D22", "T1", 400, 250, "L1_400");
  gate("D24", "T1", 600, 250, "L1_600");
  gate("D26", "T1", 800, 250, "L1_800");
  gate("D28", "T1", 1000, 250, "L1_1000");
  gate("D31", "T1", 300, -50, "L1_300");
  gate("D33", "T1", 500, -50, "L1_500");
  gate("D35", "T1", 700, -50, "L1_700");

  // ------------------------------------------------------------ Terminal 3 apron
  const T3_LANE_U = [1220, 1340, 1460, 1580];
  for (const u of T3_LANE_U) N(`L3_${u}`, "apron", u, -300);
  taxiway("T3", ["E_T3", ...T3_LANE_U.map((u) => `L3_${u}`), "J_T3"], "apron", true); // preferred eastbound
  gate("B5", "T3", 1220, -450, "L3_1220");
  gate("B7", "T3", 1340, -450, "L3_1340");
  gate("B9", "T3", 1460, -450, "L3_1460");
  gate("B11", "T3", 1580, -450, "L3_1580");

  const rect = (u0: number, u1: number, v0: number, v1: number): Vec2[] => [
    uv(u0, v0),
    uv(u1, v0),
    uv(u1, v1),
    uv(u0, v1),
  ];

  return {
    icao: "CYYZ",
    name: "Toronto Pearson International Airport",
    disclaimer:
      "Schematic for simulation. Runway designators and lengths are real; taxiways, gates and positions are simplified. Not for navigation.",
    reference: { lat: 43.6772, lon: -79.6306 },
    center: uv(300, 0),
    nodes,
    edges,
    runways,
    terminals: [
      { id: "T1", name: "Terminal 1", polygon: rect(130, 1070, 290, 470) },
      { id: "T3", name: "Terminal 3", polygon: rect(1150, 1650, -490, -650) },
    ],
  };
}

export const CYYZ_SCHEMATIC: AirportData = build();

export function createSchematicGraph(): AirportGraph {
  return new AirportGraph(CYYZ_SCHEMATIC);
}
