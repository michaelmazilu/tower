// The map lives in one flat coordinate space: Mercator units, 360 to a turn,
// centred on the Atlantic. A camera is a plain translate and scale over it.
import type { FlightRecord } from "@towerai/contracts";
import { geoInterpolate, geoMercator, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import atlasUrl from "world-atlas/countries-50m.json?url";

const TURN = 360;
const CENTRE_LON = -30;
const projection = geoMercator()
  .scale(TURN / (2 * Math.PI))
  .translate([0, 0])
  .rotate([-CENTRE_LON, 0]);

export type XY = [x: number, y: number];

export function project(lat: number, lon: number): XY {
  const phi = (Math.max(-84, Math.min(84, lat)) * Math.PI) / 180;
  return [((lon - CENTRE_LON + 540) % 360) - 180, -Math.log(Math.tan(Math.PI / 4 + phi / 2)) * (180 / Math.PI)];
}

/** The same x, one turn over, nearest to `ref`. */
export const nearX = (x: number, ref: number) => x + Math.round((ref - x) / TURN) * TURN;

export function pathOf(points: XY[], into = new Path2D()) {
  let last: number | null = null;
  for (const [raw, y] of points) {
    const x: number = last === null ? raw : nearX(raw, last);
    if (last === null) into.moveTo(x, y);
    else into.lineTo(x, y);
    last = x;
  }
  return into;
}

export const trackPoints = (f: FlightRecord) => f.track.map((p) => project(p[1], p[2]));

export function greatCircle(from: [number, number], to: [number, number]) {
  const along = geoInterpolate([from[1], from[0]], [to[1], to[0]]);
  return (k: number): XY => {
    const [lon, lat] = along(k);
    return project(lat, lon);
  };
}

export interface Land {
  land: Path2D;
  borders: Path2D;
  dots: Path2D;
}

const DOT_STEP = TURN / 216;

async function load(): Promise<Land> {
  const topo = await (await fetch(atlasUrl)).json();
  const path = geoPath(projection);
  const land = new Path2D(path(feature(topo, topo.objects.land))!);
  const borders = new Path2D(path(mesh(topo, topo.objects.countries, (a, b) => a !== b))!);

  // Land as a grid of squares: rasterise once, keep the cells that land covers.
  const n = Math.round(TURN / DOT_STEP);
  const raster = document.createElement("canvas");
  raster.width = raster.height = n;
  const g = raster.getContext("2d", { willReadFrequently: true })!;
  g.setTransform(1 / DOT_STEP, 0, 0, 1 / DOT_STEP, n / 2, n / 2);
  g.fill(land);
  const alpha = g.getImageData(0, 0, n, n).data;
  const dots = new Path2D();
  const side = DOT_STEP * 0.62;
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      if (alpha[(row * n + col) * 4 + 3]! < 100) continue;
      const x = (col + 0.5 - n / 2) * DOT_STEP;
      const y = (row + 0.5 - n / 2) * DOT_STEP;
      dots.rect(x - side / 2, y - side / 2, side, side);
    }
  return { land, borders, dots };
}

let loading: Promise<Land> | undefined;
export const loadLand = () => (loading ??= load());

export interface Camera {
  x: number;
  y: number;
  /** Pixels per map unit. */
  k: number;
}

/** The whole inhabited world, filling the frame. */
export const overview = (w: number, h: number): Camera => ({
  x: 0,
  y: -27,
  k: Math.max(w / TURN, h / 236),
});

/** Keeps the poles out and the world at least as wide as the frame. */
export function bound(cam: Camera, w: number, h: number): Camera {
  const k = Math.max(w / TURN, h / 300, Math.min(700, cam.k));
  const half = h / 2 / k;
  return { k, x: cam.x, y: Math.max(-165 + half, Math.min(150 - half, cam.y)) };
}

export function ease(from: Camera, to: Camera, dtMs: number): Camera {
  const a = 1 - Math.exp(-dtMs / 220);
  const x = nearX(to.x, from.x);
  const k = from.k * (to.k / from.k) ** a;
  const settled = Math.abs(x - from.x) * k < 0.3 && Math.abs(to.y - from.y) * k < 0.3 && Math.abs(to.k - from.k) < from.k / 1000;
  return settled ? { ...to, x } : { x: from.x + (x - from.x) * a, y: from.y + (to.y - from.y) * a, k };
}
