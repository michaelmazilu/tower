import { angleDiff, bearing, dist, round1 } from "../geometry";
import type { Vec2 } from "../types";
import type { AirportData, AirportDrawing, AirportEdge, AirportNode, EdgeKind, Runway } from "./graph";
import { AirportGraph } from "./graph";

/**
 * Turns an OpenStreetMap extract (see tools/osm/import-airport.mjs) into the
 * airport graph the simulation runs on.
 *
 * OpenStreetMap gives real runway centrelines, taxiway centrelines with their
 * names, and aircraft stands. It does not give hold lines, and stands are
 * mostly not joined to the taxiway network. This builder derives both:
 *
 *  - every taxiway that meets a runway gets a hold-short node where it
 *    leaves the runway strip (a fixed distance from the centreline), and a
 *    single straight link from that hold to the runway;
 *  - every stand that is kept becomes a gate, joined by a straight stub to
 *    the nearest taxilane.
 *
 * The rest of the taxiway geometry is kept, thinned to the points needed to
 * follow its shape.
 */

export type OsmWayKind = "runway" | "taxiway" | "taxilane" | "stand" | "apron" | "terminal" | "stopway";

export interface OsmWay {
  t: string;
  /** Indexes into `points`. Ways that share an index are joined there. */
  n: number[];
  ref?: string;
  name?: string;
  /** Width in metres, where mapped. */
  w?: number;
}

export interface OsmExtract {
  icao: string;
  source: string;
  attribution: string;
  license: string;
  dataTimestamp: string | null;
  reference: { lat: number; lon: number };
  /** Flat [x0, y0, x1, y1, ...], metres east / north of `reference`. */
  points: number[];
  ways: OsmWay[];
}

/** Building outlines from tools/osm/import-buildings.mjs. Drawing only. */
export interface OsmBuildings {
  icao: string;
  attribution: string;
  license: string;
  dataTimestamp: string | null;
  /** k: kind, h: height in metres, g: 1 if that height is a default, n: name, p: flat [x0, y0, ...] outline. */
  buildings: { k: string; h: number; g?: number; n?: string; p: number[] }[];
}

export interface OsmBuildOptions {
  name: string;
  disclaimer: string;
  /** Distance from the runway centreline at which hold lines are placed. */
  holdLateralM?: number;
  /** How far a thinned taxiway may deviate from the mapped centreline. */
  simplifyToleranceM?: number;
  /** Return the terminal a stand belongs to, or undefined to leave it out of the simulation. */
  standTerminal(ref: string, at: Vec2): string | undefined;
  /** Taxiways that are drawn but not used for routing. */
  skipTaxiway?(way: OsmWay): boolean;
  /** Maps an OpenStreetMap terminal name to a short id and display name. */
  terminal?(name: string): { id: string; name: string } | undefined;
  speedsKts?: Partial<Record<EdgeKind, number>>;
  /** Building outlines to pass through to the drawing data. They do not affect the taxi graph. */
  buildings?: OsmBuildings;
}

export interface OsmBuildReport {
  nodes: number;
  edges: number;
  gates: number;
  holds: number;
  runwayJunctions: number;
  /** Things a person should look at; an empty list means nothing unusual was found. */
  warnings: string[];
  /** Routine adjustments made to the mapped data. */
  notes: string[];
  droppedStands: string[];
}

const DEFAULT_SPEEDS: Record<EdgeKind, number> = {
  taxiway: 25,
  apron: 12,
  gate_stub: 6,
  runway_link: 15,
  runway: 30,
};

interface RawEdge {
  a: number;
  b: number;
  name?: string;
  kind: "taxiway" | "apron";
}

interface RunwayAxis {
  id: string;
  designators: [string, string];
  a: Vec2;
  b: Vec2;
  length: number;
  widthM: number;
  points: Set<number>;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 === 0) return dist(p, a);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function along(p: Vec2, a: Vec2, b: Vec2): number {
  const l = dist(a, b);
  return ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l;
}

function segmentIntersection(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): Vec2 | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q1.x - p1.x) * sy - (q1.y - p1.y) * sx) / den;
  const u = ((q1.x - p1.x) * ry - (q1.y - p1.y) * rx) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: p1.x + rx * t, y: p1.y + ry * t };
}

/** Douglas-Peucker: indexes of the points to keep, always including both ends. */
function simplify(points: Vec2[], tolerance: number): number[] {
  const keep = new Set<number>([0, points.length - 1]);
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(points[i], points[lo], points[hi]);
      if (d > worstDist) {
        worst = i;
        worstDist = d;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

/** A first or last taxiway connection this close to the pavement end is treated as being at the end. */
const END_SNAP_M = 260;

/** Parked positions closer than this are alternative layouts of the same apron space; one is kept. */
const MIN_STAND_SPACING_M = 38;

/** Minimum distance between one stand's pushback line and an aircraft parked on another. */
const STUB_CLEARANCE_M = 30;

const naturalCompare = (x: string, y: string) => x.localeCompare(y, "en", { numeric: true });
const runwayCode = (id: string) => id.replace("/", "");

export function buildAirportFromOsm(osm: OsmExtract, opts: OsmBuildOptions): { data: AirportData; report: OsmBuildReport } {
  const HOLD = opts.holdLateralM ?? 90;
  const TOLERANCE = opts.simplifyToleranceM ?? 2;
  const speeds = { ...DEFAULT_SPEEDS, ...opts.speedsKts };
  const warnings: string[] = [];
  const notes: string[] = [];

  // ------------------------------------------------------------------ points
  const pts: Vec2[] = [];
  for (let i = 0; i < osm.points.length; i += 2) pts.push({ x: osm.points[i], y: osm.points[i + 1] });
  const newPoint = (p: Vec2): number => pts.push({ x: p.x, y: p.y }) - 1;
  const polyline = (way: OsmWay): Vec2[] => way.n.map((i) => ({ x: round1(pts[i].x), y: round1(pts[i].y) }));

  // ----------------------------------------------------------------- runways
  const runwayWays = new Map<string, OsmWay[]>();
  for (const w of osm.ways) {
    if (w.t !== "runway" || !w.ref) continue;
    const list = runwayWays.get(w.ref) ?? [];
    list.push(w);
    runwayWays.set(w.ref, list);
  }
  const axes: RunwayAxis[] = [];
  const runwayOf = new Map<number, string>();
  /** Points where two runways cross. */
  const runwayCrossings = new Set<number>();
  for (const [ref, ways] of [...runwayWays].sort((x, y) => naturalCompare(x[0], y[0]))) {
    const points = new Set(ways.flatMap((w) => w.n));
    const list = [...points];
    let far: [number, number, number] = [0, list[0], list[0]];
    for (const i of list) {
      for (const j of list) {
        const d = dist(pts[i], pts[j]);
        if (d > far[0]) far = [d, i, j];
      }
    }
    const designators = ref.split("/") as [string, string];
    const wanted = Number.parseInt(designators[0], 10) * 10;
    // Runway "05" is flown on a heading of about 050: its threshold is the end you fly away from.
    const forward = Math.abs(angleDiff(bearing(pts[far[1]], pts[far[2]]), wanted)) < 90;
    const a = forward ? pts[far[1]] : pts[far[2]];
    const b = forward ? pts[far[2]] : pts[far[1]];
    const widthM = Math.max(...ways.map((w) => w.w ?? 0)) || 60;
    axes.push({ id: ref, designators, a: { ...a }, b: { ...b }, length: far[0], widthM, points });
    for (const i of points) {
      if (runwayOf.has(i)) runwayCrossings.add(i);
      runwayOf.set(i, ref);
    }
  }

  // --------------------------------------------------------- raw taxi network
  const adj = new Map<number, Map<number, RawEdge>>();
  const link = (a: number, b: number, name: string | undefined, kind: RawEdge["kind"]) => {
    if (a === b || adj.get(a)?.has(b)) return;
    const edge: RawEdge = { a, b, name, kind };
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a)!.set(b, edge);
    adj.get(b)!.set(a, edge);
  };
  const unlink = (a: number, b: number) => {
    adj.get(a)?.delete(b);
    adj.get(b)?.delete(a);
  };
  const dropNode = (n: number) => {
    for (const other of [...(adj.get(n)?.keys() ?? [])]) unlink(n, other);
    adj.delete(n);
  };

  for (const w of osm.ways) {
    if (w.t !== "taxiway" && w.t !== "taxilane") continue;
    if (opts.skipTaxiway?.(w)) continue;
    const kind = w.t === "taxilane" ? "apron" : "taxiway";
    for (let i = 1; i < w.n.length; i++) {
      const a = w.n[i - 1];
      const b = w.n[i];
      // A taxiway mapped along a runway centreline is the runway, not a taxi route.
      if (runwayOf.has(a) && runwayOf.get(a) === runwayOf.get(b)) continue;
      link(a, b, w.ref, kind);
    }
  }

  // Nothing taxis through the point where two runways cross: a route there would be on both at once.
  for (const n of runwayCrossings) {
    if ((adj.get(n)?.size ?? 0) > 0) notes.push(`taxiway connection at a runway/runway crossing was removed`);
    dropNode(n);
  }

  // A taxiway drawn across a runway without sharing a point with it would be an
  // unprotected crossing. Give every such crossing a point on the centreline.
  for (const axis of axes) {
    const pending: { a: number; b: number; at: Vec2; edge: RawEdge }[] = [];
    for (const [a, nbrs] of adj) {
      for (const [b, edge] of nbrs) {
        if (a > b || runwayOf.get(a) === axis.id || runwayOf.get(b) === axis.id) continue;
        const at = segmentIntersection(pts[a], pts[b], axis.a, axis.b);
        if (at) pending.push({ a, b, at, edge });
      }
    }
    for (const { a, b, at, edge } of pending) {
      const x = newPoint(at);
      runwayOf.set(x, axis.id);
      axis.points.add(x);
      unlink(a, b);
      link(a, x, edge.name, edge.kind);
      link(x, b, edge.name, edge.kind);
      warnings.push(`taxiway ${edge.name ?? "(unnamed)"} crossed runway ${axis.id} without a shared point; one was added`);
    }
  }

  // ------------------------------------------- hold lines and runway links
  interface Hold {
    id: number;
    runway: string;
    name?: string;
  }
  interface Link {
    junction: number;
    hold: number;
    runway: string;
    name?: string;
  }
  const holds = new Map<number, Hold>();
  const links: Link[] = [];
  const strip = new Set<number>();
  /** Holds placed on one original taxi edge, by position along it from the lower-numbered end. */
  const onEdge = new Map<string, { lo: number; hi: number; edge: RawEdge; holds: { t: number; id: number }[] }>();
  const holdFor = new Map<string, number>();

  for (const axis of axes) {
    const junctions = [...axis.points].filter((i) => (adj.get(i)?.size ?? 0) > 0).sort((x, y) => x - y);
    for (const junction of junctions) {
      const visited = new Set<number>([junction]);
      const queue: { node: number; name?: string }[] = [{ node: junction }];
      while (queue.length > 0) {
        const { node: u, name: carried } = queue.shift()!;
        for (const [v, edge] of adj.get(u) ?? []) {
          if (runwayOf.get(v) === axis.id || visited.has(v)) continue;
          const name = carried ?? edge.name;
          const otherRunway = runwayOf.get(v);
          const dv = distToSegment(pts[v], axis.a, axis.b);
          if (otherRunway === undefined && dv < HOLD) {
            visited.add(v);
            strip.add(v);
            queue.push({ node: v, name });
            continue;
          }
          // The taxiway leaves this runway's strip somewhere along u -> v.
          const key = `${axis.id}|${u}>${v}`;
          let hold = holdFor.get(key);
          if (hold === undefined) {
            const du = distToSegment(pts[u], axis.a, axis.b);
            let t = otherRunway !== undefined ? 1 / 3 : (HOLD - du) / Math.max(dv - du, 1e-6);
            t = Math.min(0.92, Math.max(0.08, t));
            if (otherRunway !== undefined) {
              warnings.push(`taxiway ${edge.name ?? "(unnamed)"} joins runways ${axis.id} and ${otherRunway} with no room for full hold lines`);
            }
            hold = newPoint({ x: pts[u].x + (pts[v].x - pts[u].x) * t, y: pts[u].y + (pts[v].y - pts[u].y) * t });
            holdFor.set(key, hold);
            holds.set(hold, { id: hold, runway: axis.id, name: edge.name ?? name });
            const lo = Math.min(u, v);
            const hi = Math.max(u, v);
            const slot = onEdge.get(`${lo}-${hi}`) ?? { lo, hi, edge, holds: [] };
            slot.holds.push({ t: u === lo ? t : 1 - t, id: hold });
            onEdge.set(`${lo}-${hi}`, slot);
          }
          if (!links.some((l) => l.junction === junction && l.hold === hold)) {
            links.push({ junction, hold, runway: axis.id, name: name ?? edge.name });
          }
        }
      }
    }
  }

  // A hold on an unnamed lead-off line takes the name of the taxiway it leads to.
  for (const slot of onEdge.values()) {
    for (const h of slot.holds) {
      const hold = holds.get(h.id)!;
      if (hold.name) continue;
      const seen = new Set<number>([slot.lo, slot.hi]);
      let frontier = [slot.lo, slot.hi].filter((n) => !strip.has(n) && !runwayOf.has(n));
      for (let hop = 0; hop < 8 && !hold.name && frontier.length > 0; hop++) {
        const next: number[] = [];
        for (const n of frontier) {
          for (const [m, edge] of adj.get(n) ?? []) {
            if (seen.has(m) || strip.has(m) || runwayOf.has(m)) continue;
            seen.add(m);
            if (edge.name && !hold.name) hold.name = edge.name;
            next.push(m);
          }
        }
        frontier = next;
      }
    }
  }

  // Replace everything inside the runway strips with the holds just placed.
  const insideStrip = (n: number) => strip.has(n) || runwayOf.has(n);
  for (const slot of onEdge.values()) {
    slot.holds.sort((x, y) => x.t - y.t);
    unlink(slot.lo, slot.hi);
    const chain: number[] = [];
    if (!insideStrip(slot.lo)) chain.push(slot.lo);
    chain.push(...slot.holds.map((h) => h.id));
    if (!insideStrip(slot.hi)) chain.push(slot.hi);
    for (let i = 1; i < chain.length; i++) link(chain[i - 1], chain[i], slot.edge.name, slot.edge.kind);
  }
  for (const n of strip) dropNode(n);
  for (const n of runwayOf.keys()) dropNode(n);

  // ------------------------------------------------------------------ stands
  interface Gate {
    id: number;
    ref: string;
    terminal: string;
    lane: number;
  }
  const gates: Gate[] = [];
  const droppedStands: string[] = [];
  const nearestEdge = (p: Vec2): { d: number; a: number; b: number; at: Vec2 } | undefined => {
    let best: { d: number; a: number; b: number; at: Vec2 } | undefined;
    for (const [a, nbrs] of adj) {
      for (const b of nbrs.keys()) {
        if (a > b || holds.has(a) || holds.has(b)) continue;
        const pa = pts[a];
        const pb = pts[b];
        const l2 = (pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2;
        const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - pa.x) * (pb.x - pa.x) + (p.y - pa.y) * (pb.y - pa.y)) / l2));
        const at = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
        const d = dist(p, at);
        if (!best || d < best.d) best = { d, a, b, at };
      }
    }
    return best;
  };

  const candidates = osm.ways
    .filter((w) => w.t === "stand" && w.ref && w.n.length >= 2)
    .map((w) => {
      const first = pts[w.n[0]];
      const last = pts[w.n[w.n.length - 1]];
      const dFirst = nearestEdge(first)?.d ?? Infinity;
      const dLast = nearestEdge(last)?.d ?? Infinity;
      // The lead-in line runs from the taxilane to the parked position.
      const [entry, parked] = dFirst <= dLast ? [w.n[0], w.n[w.n.length - 1]] : [w.n[w.n.length - 1], w.n[0]];
      return { ref: w.ref!.toUpperCase().replace(/\s+/g, ""), entry, parked, plain: /^[A-Z]?\d+$/i.test(w.ref!) };
    })
    .sort((x, y) => Number(y.plain) - Number(x.plain) || naturalCompare(x.ref, y.ref));

  const usedRefs = new Set<string>();
  for (const stand of candidates) {
    const terminal = opts.standTerminal(stand.ref, pts[stand.parked]);
    if (!terminal || usedRefs.has(stand.ref)) continue;
    // Overlapping alternative layouts of one stand ("165" / "165A") cannot both hold an aircraft.
    if (gates.some((g) => dist(pts[g.id], pts[stand.parked]) < MIN_STAND_SPACING_M)) {
      droppedStands.push(`${stand.ref} (overlaps another stand)`);
      continue;
    }
    let lane: number;
    if ((adj.get(stand.entry)?.size ?? 0) > 0 && !holds.has(stand.entry)) {
      lane = stand.entry;
    } else {
      const near = nearestEdge(pts[stand.entry]);
      if (!near || near.d > 150) {
        droppedStands.push(`${stand.ref} (no taxilane within 150 m)`);
        continue;
      }
      if (dist(near.at, pts[near.a]) < 10) lane = near.a;
      else if (dist(near.at, pts[near.b]) < 10) lane = near.b;
      else {
        const edge = adj.get(near.a)!.get(near.b)!;
        lane = newPoint(near.at);
        unlink(near.a, near.b);
        link(near.a, lane, edge.name, edge.kind);
        link(lane, near.b, edge.name, edge.kind);
      }
    }
    if (dist(pts[stand.parked], pts[lane]) < 25) {
      droppedStands.push(`${stand.ref} (too close to its taxilane)`);
      continue;
    }
    // Pushing back from one stand must not sweep through an aircraft parked on the next.
    const sweeps = gates.some(
      (g) =>
        distToSegment(pts[g.id], pts[stand.parked], pts[lane]) < STUB_CLEARANCE_M ||
        distToSegment(pts[stand.parked], pts[g.id], pts[g.lane]) < STUB_CLEARANCE_M,
    );
    if (sweeps) {
      droppedStands.push(`${stand.ref} (its pushback path crosses a neighbouring stand)`);
      continue;
    }
    const id = newPoint(pts[stand.parked]);
    gates.push({ id, ref: stand.ref, terminal, lane });
    usedRefs.add(stand.ref);
  }

  // ------------------------------------------- keep the connected airport
  const everything = new Map<number, Set<number>>();
  const join = (a: number, b: number) => {
    if (!everything.has(a)) everything.set(a, new Set());
    if (!everything.has(b)) everything.set(b, new Set());
    everything.get(a)!.add(b);
    everything.get(b)!.add(a);
  };
  for (const [a, nbrs] of adj) for (const b of nbrs.keys()) join(a, b);
  for (const l of links) join(l.junction, l.hold);
  for (const g of gates) join(g.id, g.lane);
  const component = new Map<number, number>();
  const sizes: number[] = [];
  for (const start of everything.keys()) {
    if (component.has(start)) continue;
    const c = sizes.length;
    let size = 0;
    const stack = [start];
    component.set(start, c);
    while (stack.length > 0) {
      const n = stack.pop()!;
      size++;
      for (const m of everything.get(n)!) {
        if (!component.has(m)) {
          component.set(m, c);
          stack.push(m);
        }
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const kept = (n: number) => component.get(n) === main;
  for (const n of [...adj.keys()]) if (!kept(n)) dropNode(n);
  const liveLinks = links.filter((l) => kept(l.junction) && kept(l.hold));
  const liveGates = gates.filter((g) => {
    if (kept(g.id)) return true;
    droppedStands.push(`${g.ref} (not connected to the taxiway network)`);
    return false;
  });
  for (const h of [...holds.keys()]) if (!kept(h)) holds.delete(h);

  // ------------------------------------------------- thin the taxiway shape
  const fixed = new Set<number>([...holds.keys(), ...liveGates.map((g) => g.lane)]);
  for (const [n, nbrs] of adj) {
    if (nbrs.size !== 2) {
      fixed.add(n);
      continue;
    }
    const [e1, e2] = [...nbrs.values()];
    if (e1.name !== e2.name || e1.kind !== e2.kind) fixed.add(n);
  }
  const finalEdges = new Map<string, { a: number; b: number; name?: string; kind: EdgeKind; runway?: string }>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const walked = new Set<string>();
  for (const start of [...fixed].sort((x, y) => x - y)) {
    for (const [first, edge] of adj.get(start) ?? []) {
      if (walked.has(`${start}>${first}`)) continue;
      const chain = [start, first];
      while (!fixed.has(chain[chain.length - 1])) {
        const cur = chain[chain.length - 1];
        const prev = chain[chain.length - 2];
        const next = [...adj.get(cur)!.keys()].find((n) => n !== prev);
        if (next === undefined) break;
        chain.push(next);
      }
      walked.add(`${start}>${first}`);
      walked.add(`${chain[chain.length - 1]}>${chain[chain.length - 2]}`);
      let keep = simplify(chain.map((i) => pts[i]), TOLERANCE);
      const end = chain[chain.length - 1];
      if (keep.length === 2 && chain.length > 2 && (start === end || finalEdges.has(pairKey(start, end)))) {
        // Two different taxiways between the same pair of junctions must stay distinguishable.
        const third = Math.max(1, Math.floor((chain.length - 1) / 3));
        keep = start === end ? [0, third, Math.min(chain.length - 2, third * 2), chain.length - 1] : [0, Math.floor(chain.length / 2), chain.length - 1];
        keep = [...new Set(keep)].sort((x, y) => x - y);
      }
      for (let i = 1; i < keep.length; i++) {
        const a = chain[keep[i - 1]];
        const b = chain[keep[i]];
        if (a === b) continue;
        if (finalEdges.has(pairKey(a, b))) {
          warnings.push(`two taxiway segments join the same points near (${Math.round(pts[a].x)}, ${Math.round(pts[a].y)}); one was dropped`);
          continue;
        }
        finalEdges.set(pairKey(a, b), { a, b, name: edge.name, kind: edge.kind });
      }
    }
  }

  // --------------------------------------------------------------- node ids
  const used = new Set<number>();
  for (const e of finalEdges.values()) {
    used.add(e.a);
    used.add(e.b);
  }
  const ids = new Map<number, string>();
  const taken = new Set<string>();
  const unique = (base: string): string => {
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
    taken.add(id);
    return id;
  };

  const nodes: AirportNode[] = [];
  const edges: AirportEdge[] = [];
  const position = new Map<number, Vec2>();
  const place = (n: number, p: Vec2 = pts[n]) => {
    const rounded = { x: round1(p.x), y: round1(p.y) };
    position.set(n, rounded);
    return rounded;
  };
  const addEdge = (a: number, b: number, kind: EdgeKind, name?: string, runway?: string) => {
    const from = ids.get(a)!;
    const to = ids.get(b)!;
    edges.push({
      id: AirportGraph.edgeId(from, to),
      from,
      to,
      kind,
      ...(name ? { name } : {}),
      lengthM: round1(dist(position.get(a)!, position.get(b)!)),
      speedLimitKts: speeds[kind],
      ...(runway ? { runway } : {}),
    });
  };

  // Runway centreline nodes: one per place a taxiway joins, in order along the runway.
  const runways: Runway[] = [];
  let runwayJunctions = 0;
  for (const axis of axes) {
    const code = runwayCode(axis.id);
    const joined = [...new Set(liveLinks.filter((l) => l.runway === axis.id).map((l) => l.junction))]
      .map((n) => ({ n, s: along(pts[n], axis.a, axis.b) }))
      .sort((x, y) => x.s - y.s);
    if (joined.length < 2) {
      warnings.push(`runway ${axis.id} has fewer than two taxiway connections and was left out`);
      continue;
    }
    const dir = { x: (axis.b.x - axis.a.x) / axis.length, y: (axis.b.y - axis.a.y) / axis.length };
    // Taxiway centrelines are mapped along the painted lead-in lines, which curve onto the runway
    // well inside the pavement end. The aircraft itself enters at the end, so the first and last
    // connections are placed there and the runway keeps its full length.
    const firstJoin = joined[0];
    const lastJoin = joined[joined.length - 1];
    if (firstJoin.s <= END_SNAP_M) firstJoin.s = 0;
    else warnings.push(`runway ${axis.designators[0]}: the first taxiway joins ${Math.round(firstJoin.s)} m from the pavement end`);
    if (axis.length - lastJoin.s <= END_SNAP_M) lastJoin.s = axis.length;
    else warnings.push(`runway ${axis.designators[1]}: the first taxiway joins ${Math.round(axis.length - lastJoin.s)} m from the pavement end`);
    const nodeIds: string[] = [];
    for (const { n, s } of joined) {
      const names = liveLinks.filter((l) => l.junction === n).map((l) => l.name ?? holds.get(l.hold)?.name).filter(Boolean) as string[];
      const label = names.sort(naturalCompare)[0];
      const id = unique(`RW${code}_${label ?? Math.round(s)}`);
      ids.set(n, id);
      const p = place(n, { x: axis.a.x + dir.x * s, y: axis.a.y + dir.y * s });
      nodes.push({ id, kind: "runway", ...p, runway: axis.id, ...(label ? { label } : {}) });
      nodeIds.push(id);
      runwayJunctions++;
    }
    for (let i = 1; i < joined.length; i++) addEdge(joined[i - 1].n, joined[i].n, "runway", axis.id, axis.id);
    const first = position.get(joined[0].n)!;
    const last = position.get(joined[joined.length - 1].n)!;
    runways.push({
      id: axis.id,
      ends: [
        { designator: axis.designators[0], thresholdNode: nodeIds[0], threshold: { ...first }, headingDeg: round1(bearing(first, last)) },
        {
          designator: axis.designators[1],
          thresholdNode: nodeIds[nodeIds.length - 1],
          threshold: { ...last },
          headingDeg: round1(bearing(last, first)),
        },
      ],
      lengthM: round1(dist(first, last)),
      widthM: axis.widthM,
      nodeIds,
      paved: [
        { x: round1(axis.a.x), y: round1(axis.a.y) },
        { x: round1(axis.b.x), y: round1(axis.b.y) },
      ],
    });
  }
  const liveRunways = new Set(runways.map((r) => r.id));

  // Hold lines.
  for (const h of [...holds.values()].sort((x, y) => x.id - y.id)) {
    if (!liveRunways.has(h.runway) || !liveLinks.some((l) => l.hold === h.id)) continue;
    const id = unique(`HS_${h.name ?? "X"}_${runwayCode(h.runway)}`);
    ids.set(h.id, id);
    nodes.push({ id, kind: "hold_short", ...place(h.id), guards: h.runway, ...(h.name ? { label: h.name } : {}) });
  }
  for (const l of liveLinks) {
    if (ids.has(l.junction) && ids.has(l.hold)) addEdge(l.junction, l.hold, "runway_link", l.name ?? holds.get(l.hold)?.name, l.runway);
  }

  // Taxiway and apron points.
  const counters = new Map<string, number>();
  for (const n of [...used].sort((x, y) => x - y)) {
    if (ids.has(n)) continue;
    const around = [...finalEdges.values()].filter((e) => e.a === n || e.b === n);
    const names = [...new Set(around.map((e) => e.name).filter(Boolean) as string[])].sort(naturalCompare);
    const base = names[0] ?? "X";
    const k = (counters.get(base) ?? 0) + 1;
    counters.set(base, k);
    const id = unique(`${base}.${k}`);
    ids.set(n, id);
    const kind = around.every((e) => e.kind === "apron") ? "apron" : "taxiway";
    nodes.push({ id, kind, ...place(n), ...(names.length > 1 ? { label: names.join("/") } : {}) });
  }
  for (const e of finalEdges.values()) {
    if (ids.has(e.a) && ids.has(e.b)) addEdge(e.a, e.b, e.kind, e.name);
  }

  // Gates.
  for (const g of liveGates.sort((x, y) => naturalCompare(x.ref, y.ref))) {
    if (!ids.has(g.lane)) {
      droppedStands.push(`${g.ref} (its taxilane was removed)`);
      continue;
    }
    const id = unique(`GATE_${g.ref}`);
    ids.set(g.id, id);
    nodes.push({ id, kind: "gate", ...place(g.id), gate: g.ref, terminal: g.terminal, pushbackNode: ids.get(g.lane)!, label: g.ref });
    addEdge(g.id, g.lane, "gate_stub", g.ref);
  }

  // ---------------------------------------------------------------- drawing
  const drawing: AirportDrawing = {
    runways: axes.map((axis) => ({
      id: axis.id,
      from: { x: round1(axis.a.x), y: round1(axis.a.y) },
      to: { x: round1(axis.b.x), y: round1(axis.b.y) },
      widthM: axis.widthM,
    })),
    taxiways: osm.ways
      .filter((w) => w.t === "taxiway" || w.t === "taxilane")
      .map((w) => ({ ...(w.ref ? { name: w.ref } : {}), kind: w.t === "taxilane" ? ("taxilane" as const) : ("taxiway" as const), points: polyline(w) })),
    aprons: osm.ways.filter((w) => w.t === "apron").map((w) => ({ ...(w.name ? { name: w.name } : {}), polygon: polyline(w) })),
    stands: osm.ways.filter((w) => w.t === "stand" && w.ref).map((w) => ({ ref: w.ref!, points: polyline(w) })),
    ...(opts.buildings
      ? {
          buildings: opts.buildings.buildings.map((b) => {
            const polygon: Vec2[] = [];
            for (let i = 0; i < b.p.length; i += 2) polygon.push({ x: b.p[i], y: b.p[i + 1] });
            return { kind: b.k, ...(b.n ? { name: b.n } : {}), heightM: b.h, heightMapped: !b.g, polygon };
          }),
        }
      : {}),
  };
  const terminals = osm.ways
    .filter((w) => w.t === "terminal")
    .map((w, i) => {
      const named = w.name ? opts.terminal?.(w.name) : undefined;
      const outline = polyline(w);
      const keep = simplify(outline, 3);
      return {
        id: named?.id ?? `B${i + 1}`,
        name: named?.name ?? w.name ?? "Terminal building",
        polygon: keep.map((k) => outline[k]),
      };
    });

  const xs = drawing.runways.flatMap((r) => [r.from.x, r.to.x]);
  const ys = drawing.runways.flatMap((r) => [r.from.y, r.to.y]);
  const data: AirportData = {
    icao: osm.icao,
    name: opts.name,
    disclaimer: opts.disclaimer,
    attribution: `${osm.attribution} (${osm.license})`,
    reference: osm.reference,
    center: { x: round1((Math.min(...xs) + Math.max(...xs)) / 2), y: round1((Math.min(...ys) + Math.max(...ys)) / 2) },
    nodes,
    edges,
    runways,
    terminals,
    drawing,
  };

  return {
    data,
    report: {
      nodes: nodes.length,
      edges: edges.length,
      gates: nodes.filter((n) => n.kind === "gate").length,
      holds: nodes.filter((n) => n.kind === "hold_short").length,
      runwayJunctions,
      warnings,
      notes,
      droppedStands,
    },
  };
}
