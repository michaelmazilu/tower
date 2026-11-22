#!/usr/bin/env node
/**
 * Pulls building outlines and heights around the airport out of OpenStreetMap
 * and writes them as a checked-in TypeScript module. They are only used for
 * drawing the 3D view; the simulation's taxi graph does not depend on them.
 *
 *   node tools/osm/import-buildings.mjs                 fetch and regenerate
 *   node tools/osm/import-buildings.mjs --from raw.json reuse a saved Overpass response
 *   node tools/osm/import-buildings.mjs --save raw.json also keep the raw response
 *
 * Data © OpenStreetMap contributors, Open Database License (ODbL) 1.0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AIRPORT = {
  icao: "CYYZ",
  exportName: "CYYZ_BUILDINGS",
  out: "packages/core/src/airport/data/cyyzBuildings.ts",
  bbox: [43.645, -79.675, 43.715, -79.575],
  // Must match tools/osm/import-airport.mjs so buildings line up with the taxiways.
  reference: { lat: 43.6772, lon: -79.6306 },
};
/** Footprints smaller than this (houses, sheds) are left out. */
const MIN_AREA_M2 = 250;
const LEVEL_HEIGHT_M = 3.6;

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function query() {
  const b = AIRPORT.bbox.join(",");
  return `[out:json][timeout:120];
(
  way["building"](${b});
  relation["building"](${b});
  nwr["aeroway"~"^(terminal|hangar|tower)$"](${b});
  way["man_made"="tower"](${b});
);
out body;
>;
out skel qt;`;
}

async function fetchRaw() {
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "osm-airport-import/0.1" },
        body: `data=${encodeURIComponent(query())}`,
        signal: AbortSignal.timeout(150_000),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith("{")) return text;
      lastError = `${url}: HTTP ${res.status}`;
    } catch (err) {
      lastError = `${url}: ${err.message}`;
    }
    const waitSec = 5 * 2 ** attempt;
    console.error(`  ${lastError}; retrying in ${waitSec} s`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
  throw new Error(`OpenStreetMap could not be reached: ${lastError}`);
}

function kindOf(tags) {
  if (tags.aeroway === "terminal") return "terminal";
  if (tags.aeroway === "tower" || tags["tower:type"] === "airport_control" || tags.man_made === "tower") return "tower";
  if (tags.aeroway === "hangar" || tags.building === "hangar") return "hangar";
  if (tags.building === "parking" || tags.parking) return "parking";
  return "building";
}

const DEFAULT_HEIGHT = { terminal: 22, tower: 60, hangar: 16, parking: 18, building: 9 };

function heightOf(tags, kind) {
  const h = Number.parseFloat(tags.height ?? tags["building:height"]);
  if (Number.isFinite(h) && h > 1 && h < 400) return { h: Math.round(h * 10) / 10, mapped: true };
  const levels = Number.parseFloat(tags["building:levels"]);
  if (Number.isFinite(levels) && levels > 0 && levels < 100) return { h: Math.round(levels * LEVEL_HEIGHT_M * 10) / 10, mapped: true };
  return { h: DEFAULT_HEIGHT[kind], mapped: false };
}

function simplify(points, tolerance) {
  if (points.length < 4) return points;
  const distSeg = (p, a, b) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], l2 = abx * abx + aby * aby;
    const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
    return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
  };
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let worst = -1, worstD = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = distSeg(points[i], points[lo], points[hi]);
      if (d > worstD) { worst = i; worstD = d; }
    }
    if (worst >= 0) { keep.add(worst); stack.push([lo, worst], [worst, hi]); }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

function area(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function convert(raw) {
  const nodes = new Map(), ways = new Map(), relations = [];
  for (const e of raw.elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.set(e.id, e);
    else relations.push(e);
  }
  const R = 6371008.8;
  const { lat: lat0, lon: lon0 } = AIRPORT.reference;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const project = (n) => [(((n.lon - lon0) * Math.PI) / 180) * R * k, (((n.lat - lat0) * Math.PI) / 180) * R];
  const ring = (way) => {
    const pts = way.nodes.map((id) => nodes.get(id)).filter(Boolean).map(project);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return pts;
  };

  const out = [];
  const used = new Set();
  const add = (tags, way) => {
    if (!way || used.has(way.id) || way.nodes[0] !== way.nodes[way.nodes.length - 1]) return;
    used.add(way.id);
    let pts = ring(way);
    if (pts.length < 3) return;
    const kind = kindOf(tags);
    if (area(pts) < MIN_AREA_M2 && kind === "building") return;
    pts = simplify([...pts, pts[0]], 1).slice(0, -1);
    if (pts.length < 3) return;
    const { h, mapped } = heightOf(tags, kind);
    const entry = { k: kind, h, p: pts.flatMap(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) };
    if (!mapped) entry.g = 1; // height is a default for this kind of building, not mapped
    const name = tags.name?.trim();
    if (name && kind !== "building") entry.n = name;
    out.push(entry);
  };

  // Multipolygon buildings: each outer ring becomes a block with the relation's tags.
  for (const rel of relations.sort((a, b) => a.id - b.id)) {
    const tags = rel.tags ?? {};
    if (!tags.building && !tags.aeroway) continue;
    for (const m of rel.members ?? []) if (m.type === "way" && m.role !== "inner") add(tags, ways.get(m.ref));
  }
  for (const way of [...ways.values()].sort((a, b) => a.id - b.id)) {
    const tags = way.tags ?? {};
    if (tags.building || tags.aeroway === "terminal" || tags.aeroway === "hangar" || tags.aeroway === "tower" || tags.man_made === "tower") add(tags, way);
  }
  return {
    icao: AIRPORT.icao,
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    dataTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
    buildings: out,
  };
}

function emit(data) {
  const { buildings, ...head } = data;
  const lines = [
    "// GENERATED by tools/osm/import-buildings.mjs. Do not edit by hand; re-run the script instead.",
    "// Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.",
    "// https://www.openstreetmap.org/copyright",
    'import type { OsmBuildings } from "../osm";',
    "",
    `export const ${AIRPORT.exportName}: OsmBuildings = {`,
    ...Object.entries(head).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`),
    "  // k: kind, h: height in metres (g: 1 means a default for that kind, not a mapped height),",
    "  // p: flat [x0, y0, x1, y1, ...] outline in metres east / north of the airport reference point.",
    "  buildings: [",
    ...buildings.map((b) => `    ${JSON.stringify(b)},`),
    "  ],",
    "};",
    "",
  ];
  return lines.join("\n");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const from = arg("--from");
console.error(from ? `Reading ${from}` : `Fetching ${AIRPORT.icao} buildings from OpenStreetMap`);
const text = from ? readFileSync(from, "utf8") : await fetchRaw();
const save = arg("--save");
if (save) writeFileSync(save, text);
const data = convert(JSON.parse(text));
const outPath = resolve(root, arg("--out") ?? AIRPORT.out);
writeFileSync(outPath, emit(data));
const by = {};
for (const b of data.buildings) by[b.k] = (by[b.k] ?? 0) + 1;
console.error(`Wrote ${outPath}\n  ${data.buildings.length} buildings: ${JSON.stringify(by)}; ${data.buildings.filter((b) => !b.g).length} with a mapped height`);
