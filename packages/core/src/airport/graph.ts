import { dist } from "../geometry";
import type { Vec2 } from "../types";

export type NodeKind = "gate" | "apron" | "taxiway" | "hold_short" | "runway";
export type EdgeKind = "taxiway" | "apron" | "gate_stub" | "runway" | "runway_link";

export interface AirportNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  label?: string;
  /** hold_short: the physical runway this line protects. */
  guards?: string;
  /** runway: the physical runway this node lies on. */
  runway?: string;
  /** gate: public gate name and the apron node aircraft push back onto. */
  gate?: string;
  terminal?: string;
  pushbackNode?: string;
}

export interface AirportEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  name?: string;
  lengthM: number;
  speedLimitKts: number;
  runway?: string;
  /** Preferred direction of travel is from -> to; the reverse costs more to route. */
  flow?: boolean;
}

export interface RunwayEnd {
  designator: string;
  thresholdNode: string;
  threshold: Vec2;
  /** Heading flown when landing or departing from this end. */
  headingDeg: number;
}

export interface Runway {
  id: string;
  ends: [RunwayEnd, RunwayEnd];
  lengthM: number;
  widthM: number;
  /** Runway nodes ordered from ends[0]'s threshold to ends[1]'s. */
  nodeIds: string[];
  /**
   * The two ends of the pavement, where they differ from the thresholds
   * above (the usable part starts where the first taxiway joins).
   */
  paved?: [Vec2, Vec2];
}

/** Shapes for drawing the airport. Nothing here affects how aircraft move. */
export interface AirportDrawing {
  runways: { id: string; from: Vec2; to: Vec2; widthM: number }[];
  taxiways: { name?: string; kind: "taxiway" | "taxilane"; points: Vec2[] }[];
  aprons: { name?: string; polygon: Vec2[] }[];
  stands: { ref: string; points: Vec2[] }[];
  /**
   * Building outlines for a 3D view. `heightMapped` is false where the height
   * is only a typical figure for that kind of building.
   */
  buildings?: { kind: string; name?: string; heightM: number; heightMapped: boolean; polygon: Vec2[] }[];
}

export interface AirportData {
  icao: string;
  name: string;
  /** Honest label for the dashboard: what this layout is and is not. */
  disclaimer: string;
  /** Credit that must be shown wherever the layout is displayed. */
  attribution?: string;
  reference: { lat: number; lon: number };
  center: Vec2;
  nodes: AirportNode[];
  edges: AirportEdge[];
  runways: Runway[];
  terminals: { id: string; name: string; polygon: Vec2[] }[];
  drawing?: AirportDrawing;
}

export interface RunwayEndRef {
  runway: Runway;
  end: RunwayEnd;
  opposite: RunwayEnd;
}

export interface RouteOptions {
  closedEdges?: ReadonlySet<string>;
  /** Extra cost multiplier for travelling `from` -> `to` along an edge. */
  penalty?: (edge: AirportEdge, from: string, to: string) => number;
}

export interface RouteResult {
  path: string[];
  cost: number;
  lengthM: number;
}

const AGAINST_FLOW_FACTOR = 2.5;
const RUNWAY_CROSSING_COST_M = 400;

export class AirportGraph {
  readonly nodes = new Map<string, AirportNode>();
  readonly edges = new Map<string, AirportEdge>();
  readonly runways = new Map<string, Runway>();
  readonly gates = new Map<string, AirportNode>();
  private readonly adj = new Map<string, { to: string; edge: AirportEdge }[]>();
  private readonly ends = new Map<string, RunwayEndRef>();
  private readonly crossing = new Map<string, string[]>();
  /** Looked up for every aircraft on every step, so no key strings are built. */
  private readonly between = new Map<string, Map<string, AirportEdge>>();

  constructor(readonly data: AirportData) {
    for (const n of data.nodes) {
      if (this.nodes.has(n.id)) throw new Error(`duplicate node ${n.id}`);
      this.nodes.set(n.id, n);
      this.adj.set(n.id, []);
      if (n.kind === "gate" && n.gate) this.gates.set(n.gate, n);
      this.between.set(n.id, new Map());
    }
    for (const e of data.edges) {
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to)) {
        throw new Error(`edge ${e.id} references a missing node`);
      }
      this.edges.set(e.id, e);
      this.adj.get(e.from)!.push({ to: e.to, edge: e });
      this.adj.get(e.to)!.push({ to: e.from, edge: e });
      this.between.get(e.from)!.set(e.to, e);
      this.between.get(e.to)!.set(e.from, e);
    }
    for (const r of data.runways) {
      this.runways.set(r.id, r);
      this.ends.set(r.ends[0].designator, { runway: r, end: r.ends[0], opposite: r.ends[1] });
      this.ends.set(r.ends[1].designator, { runway: r, end: r.ends[1], opposite: r.ends[0] });
    }
    for (const r of data.runways) {
      this.crossing.set(
        r.id,
        data.runways.filter((o) => o.id !== r.id && pavementsCross(r, o)).map((o) => o.id),
      );
    }
  }

  /** Which side of a runway's centreline a node is on: -1, +1, or 0 if it cannot be told. */
  private sideOfRunway(nodeId: string, runwayId: string | undefined): number {
    const r = runwayId ? this.runways.get(runwayId) : undefined;
    if (!r) return 0;
    const a = r.ends[0].threshold;
    const b = r.ends[1].threshold;
    const p = this.node(nodeId);
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    return Math.abs(cross) < 1e-6 ? 0 : Math.sign(cross);
  }

  /** Physical runways whose pavement crosses this one. */
  intersecting(runwayId: string): string[] {
    return this.crossing.get(runwayId) ?? [];
  }

  static edgeId(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  node(id: string): AirportNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  pos(id: string): Vec2 {
    const n = this.node(id);
    return { x: n.x, y: n.y };
  }

  edgeBetween(a: string, b: string): AirportEdge | undefined {
    return this.between.get(a)?.get(b);
  }

  neighbors(id: string): { to: string; edge: AirportEdge }[] {
    return this.adj.get(id) ?? [];
  }

  /** Accepts "23", "5", "06l", "runway 24R". Returns undefined if unknown. */
  runwayEnd(designator: string | undefined): RunwayEndRef | undefined {
    if (!designator) return undefined;
    return this.ends.get(normalizeDesignator(designator));
  }

  /** Accepts an end designator or a physical id like "05/23". */
  physicalRunway(input: string | undefined): Runway | undefined {
    if (!input) return undefined;
    const cleaned = input.toUpperCase().replace(/RUNWAY|RWY|\s/g, "");
    if (cleaned.includes("/")) {
      const parts = cleaned.split("/").map(normalizeDesignator);
      for (const r of this.runways.values()) {
        const ds = r.ends.map((e) => e.designator);
        if (parts.every((p) => ds.includes(p))) return r;
      }
      return undefined;
    }
    return this.runwayEnd(cleaned)?.runway;
  }

  /** Hold-short nodes from which an aircraft can line up at this end's threshold. */
  departureHolds(designator: string): string[] {
    const ref = this.runwayEnd(designator);
    if (!ref) return [];
    return this.holdsAtRunwayNode(ref.end.thresholdNode);
  }

  holdsAtRunwayNode(runwayNodeId: string): string[] {
    return this.neighbors(runwayNodeId)
      .filter((n) => n.edge.kind === "runway_link")
      .map((n) => n.to);
  }

  /** Runway nodes in the order an aircraft using `designator` passes them. */
  runwayNodesFrom(designator: string): string[] {
    const ref = this.runwayEnd(designator);
    if (!ref) return [];
    const ids = ref.runway.nodeIds;
    return ref.runway.ends[0].designator === ref.end.designator ? [...ids] : [...ids].reverse();
  }

  /**
   * Dijkstra over taxi surfaces. Runway centreline edges are never used
   * for taxi routes; a route may cross a runway hold-to-hold, which costs
   * extra so crossings are only chosen when they are genuinely shorter.
   */
  shortestPath(from: string, targets: string | string[], opts: RouteOptions = {}): RouteResult | null {
    const targetSet = new Set(Array.isArray(targets) ? targets : [targets]);
    if (!this.nodes.has(from) || targetSet.size === 0) return null;
    const best = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const done = new Set<string>();
    const open: string[] = [from];

    while (open.length > 0) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        if (best.get(open[i])! < best.get(open[bi])!) bi = i;
      }
      const cur = open.splice(bi, 1)[0];
      if (done.has(cur)) continue;
      done.add(cur);
      if (targetSet.has(cur)) {
        const path = [cur];
        while (prev.has(path[0])) path.unshift(prev.get(path[0])!);
        return { path, cost: best.get(cur)!, lengthM: this.pathLength(path) };
      }
      const curNode = this.node(cur);
      // Gates are dead ends: start from one or end at one, never pass through.
      if (curNode.kind === "gate" && cur !== from) continue;
      // Stepping onto a runway is only allowed straight across, hold to hold.
      const cameFrom = prev.get(cur);

      for (const { to, edge } of this.neighbors(cur)) {
        if (done.has(to)) continue;
        if (edge.kind === "runway") continue;
        if (opts.closedEdges?.has(edge.id)) continue;
        const toNode = this.node(to);
        if (toNode.kind === "gate" && !targetSet.has(to)) continue;
        if (curNode.kind === "runway" && cameFrom === to) continue;
        // ...and across means across: not on at one taxiway and straight back off on the same side.
        if (curNode.kind === "runway" && cameFrom !== undefined && toNode.kind === "hold_short") {
          const from = this.sideOfRunway(cameFrom, curNode.runway);
          if (from !== 0 && from === this.sideOfRunway(to, curNode.runway)) continue;
        }
        let cost = edge.lengthM;
        if (edge.flow && edge.to === cur) cost *= AGAINST_FLOW_FACTOR;
        if (opts.penalty) cost *= opts.penalty(edge, cur, to);
        if (toNode.kind === "runway") cost += RUNWAY_CROSSING_COST_M;
        const total = best.get(cur)! + cost;
        if (total < (best.get(to) ?? Infinity)) {
          best.set(to, total);
          prev.set(to, cur);
          open.push(to);
        }
      }
    }
    return null;
  }

  pathLength(path: string[]): number {
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += this.edgeBetween(path[i - 1], path[i])?.lengthM ?? dist(this.pos(path[i - 1]), this.pos(path[i]));
    }
    return total;
  }

  /** Returns an error string if `path` is not a legal taxi route. */
  validatePath(path: string[], closedEdges?: ReadonlySet<string>): string | null {
    if (path.length === 0) return "route is empty";
    for (const id of path) {
      if (!this.nodes.has(id)) return `unknown node ${id}`;
    }
    for (let i = 1; i < path.length; i++) {
      const edge = this.edgeBetween(path[i - 1], path[i]);
      if (!edge) return `${path[i - 1]} and ${path[i]} are not connected`;
      if (edge.kind === "runway") return `route taxis along runway ${edge.runway}`;
      if (closedEdges?.has(edge.id)) return `taxiway segment ${edge.id} is closed`;
      const mid = this.node(path[i]);
      if (mid.kind === "gate" && i !== path.length - 1) return `route passes through gate ${mid.gate}`;
    }
    return null;
  }

  /** Taxiway names along a path, in order, without repeats ("C", "A", "A6"). */
  viaNames(path: string[]): string[] {
    const names: string[] = [];
    for (let i = 1; i < path.length; i++) {
      const edge = this.edgeBetween(path[i - 1], path[i]);
      if (!edge?.name || edge.kind === "gate_stub" || edge.kind === "apron") continue;
      if (names[names.length - 1] !== edge.name) names.push(edge.name);
    }
    return names;
  }

  /** Physical runways a path crosses hold-to-hold. */
  crossings(path: string[]): string[] {
    const out: string[] = [];
    for (let i = 1; i < path.length - 1; i++) {
      const a = this.node(path[i - 1]);
      const b = this.node(path[i]);
      const c = this.node(path[i + 1]);
      if (a.kind === "hold_short" && b.kind === "runway" && c.kind === "hold_short" && b.runway) {
        out.push(b.runway);
      }
    }
    return out;
  }

  /** Structural self-check. An empty array means the graph is usable. */
  validate(): string[] {
    const problems: string[] = [];
    for (const e of this.edges.values()) {
      const geometric = dist(this.pos(e.from), this.pos(e.to));
      if (Math.abs(geometric - e.lengthM) > 1) problems.push(`edge ${e.id} length does not match its coordinates`);
      if (e.lengthM <= 0) problems.push(`edge ${e.id} has no length`);
    }
    for (const n of this.nodes.values()) {
      if (this.neighbors(n.id).length === 0) problems.push(`node ${n.id} is isolated`);
      if (n.kind === "hold_short" && !this.runways.has(n.guards ?? "")) {
        problems.push(`hold ${n.id} guards an unknown runway`);
      }
      if (n.kind === "gate" && (!n.pushbackNode || !this.edgeBetween(n.id, n.pushbackNode))) {
        problems.push(`gate ${n.id} has no pushback node`);
      }
    }
    for (const r of this.runways.values()) {
      for (const end of r.ends) {
        if (this.departureHolds(end.designator).length === 0) {
          problems.push(`runway end ${end.designator} has no departure hold`);
        }
      }
      for (let i = 1; i < r.nodeIds.length; i++) {
        if (this.edgeBetween(r.nodeIds[i - 1], r.nodeIds[i])?.kind !== "runway") {
          problems.push(`runway ${r.id} centreline is broken at ${r.nodeIds[i]}`);
        }
      }
    }
    const gate = [...this.gates.values()][0];
    if (gate) {
      for (const g of this.gates.values()) {
        for (const r of this.runways.values()) {
          for (const end of r.ends) {
            if (!this.shortestPath(g.pushbackNode!, this.departureHolds(end.designator))) {
              problems.push(`no taxi route from gate ${g.gate} to runway ${end.designator}`);
            }
          }
        }
      }
    }
    return problems;
  }
}

function pavementsCross(a: Runway, b: Runway): boolean {
  const [p1, p2] = a.paved ?? [a.ends[0].threshold, a.ends[1].threshold];
  const [q1, q2] = b.paved ?? [b.ends[0].threshold, b.ends[1].threshold];
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((q1.x - p1.x) * sy - (q1.y - p1.y) * sx) / den;
  const u = ((q1.x - p1.x) * ry - (q1.y - p1.y) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function normalizeDesignator(input: string): string {
  const cleaned = input.toUpperCase().replace(/RUNWAY|RWY|\s/g, "");
  const m = /^(\d{1,2})([LRC]?)$/.exec(cleaned);
  if (!m) return cleaned;
  return `${m[1].padStart(2, "0")}${m[2]}`;
}
