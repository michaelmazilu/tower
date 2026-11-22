#!/usr/bin/env node
/**
 * Pulls an airport's movement-area geometry out of OpenStreetMap and writes
 * it as a compact, checked-in TypeScript module. The simulation never talks
 * to OpenStreetMap at runtime: it builds its taxi graph from that module.
 *
 *   node tools/osm/import-airport.mjs                 fetch CYYZ and regenerate
 *   node tools/osm/import-airport.mjs --from raw.json reuse a saved Overpass response
 *   node tools/osm/import-airport.mjs --save raw.json also keep the raw response
 *
 * Data © OpenStreetMap contributors, Open Database License (ODbL) 1.0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AIRPORT = {
  icao: "CYYZ",
  exportName: "CYYZ_OSM",
  out: "packages/core/src/airport/data/cyyzOsm.ts",
  // south, west, north, east
  bbox: [43.645, -79.675, 43.715, -79.575],
  // Airport reference point: the origin of the local x-east / y-north metre grid.
  reference: { lat: 43.6772, lon: -79.6306 },
};

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
  return `[out:json][timeout:90];
(
  way["aeroway"~"^(runway|taxiway|taxilane|apron|parking_position|stopway)$"](${b});
  nwr["aeroway"="terminal"](${b});
  nwr["building"]["name"~"Terminal",i](${b});
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
        signal: AbortSignal.timeout(120_000),
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

const KIND = {
  runway: "runway",
  taxiway: "taxiway",
  taxilane: "taxilane",
  parking_position: "stand",
  apron: "apron",
  stopway: "stopway",
};

function convert(raw) {
  const nodes = new Map();
  const ways = new Map();
  const relations = [];
  for (const e of raw.elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.set(e.id, e);
    else if (e.type === "relation") relations.push(e);
  }

  const R = 6371008.8;
  const { lat: lat0, lon: lon0 } = AIRPORT.reference;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const project = (n) => [
    Math.round((((n.lon - lon0) * Math.PI) / 180) * R * k * 10) / 10,
    Math.round((((n.lat - lat0) * Math.PI) / 180) * R * 10) / 10,
  ];

  const points = [];
  const index = new Map();
  const point = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      const n = nodes.get(id);
      if (!n) throw new Error(`way references node ${id}, which is missing from the response`);
      i = points.length / 2;
      index.set(id, i);
      points.push(...project(n));
    }
    return i;
  };

  const out = [];
  const push = (t, w, tags) => {
    const entry = { t, n: w.nodes.map(point) };
    const ref = tags.ref?.trim();
    const name = tags.name?.trim();
    if (ref) entry.ref = ref;
    if (name) entry.name = name;
    const width = Number.parseFloat(tags.width);
    if (Number.isFinite(width)) entry.w = Math.round(width * 10) / 10;
    out.push(entry);
  };

  // Stable order: by OSM id, so regenerating from unchanged data gives an identical file.
  const sorted = [...ways.values()].sort((a, b) => a.id - b.id);
  const inRelation = new Set();
  for (const rel of relations) {
    const tags = rel.tags ?? {};
    const terminal = tags.aeroway === "terminal" || (tags.building && /terminal/i.test(tags.name ?? ""));
    if (!terminal) continue;
    for (const m of rel.members ?? []) {
      if (m.type !== "way" || m.role === "inner") continue;
      const w = ways.get(m.ref);
      if (!w) continue;
      inRelation.add(w.id);
      push("terminal", w, tags);
    }
  }
  for (const w of sorted) {
    const tags = w.tags ?? {};
    const t = KIND[tags.aeroway];
    if (t) push(t, w, tags);
    else if (!inRelation.has(w.id) && (tags.aeroway === "terminal" || (tags.building && /terminal/i.test(tags.name ?? "")))) {
      push("terminal", w, tags);
    }
  }

  return {
    icao: AIRPORT.icao,
    source: "OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    dataTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
    reference: AIRPORT.reference,
    points,
    ways: out,
  };
}

function emit(extract) {
  const { ways, points, ...head } = extract;
  const lines = [
    "// GENERATED by tools/osm/import-airport.mjs. Do not edit by hand; re-run the script instead.",
    "// Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.",
    "// https://www.openstreetmap.org/copyright",
    'import type { OsmExtract } from "../osm";',
    "",
    `export const ${AIRPORT.exportName}: OsmExtract = {`,
    ...Object.entries(head).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`),
    "  // Flat [x0, y0, x1, y1, ...] in metres east / north of the reference point.",
    "  points: [",
  ];
  for (let i = 0; i < points.length; i += 16) lines.push(`    ${points.slice(i, i + 16).join(",")},`);
  lines.push("  ],", "  ways: [");
  for (const w of ways) lines.push(`    ${JSON.stringify(w)},`);
  lines.push("  ],", "};", "");
  return lines.join("\n");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const from = arg("--from");
console.error(from ? `Reading ${from}` : `Fetching ${AIRPORT.icao} from OpenStreetMap`);
const text = from ? readFileSync(from, "utf8") : await fetchRaw();
const save = arg("--save");
if (save) writeFileSync(save, text);
const extract = convert(JSON.parse(text));
const outPath = resolve(root, arg("--out") ?? AIRPORT.out);
writeFileSync(outPath, emit(extract));
const count = (t) => extract.ways.filter((w) => w.t === t).length;
console.error(
  `Wrote ${outPath}\n  ${extract.points.length / 2} points, ${count("runway")} runway ways, ${count("taxiway")} taxiways, ` +
    `${count("taxilane")} taxilanes, ${count("stand")} stands, ${count("apron")} aprons, ${count("terminal")} terminal outlines`,
);
