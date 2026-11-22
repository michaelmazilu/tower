// Port of bluesky/tools/geo/_geo.py from BlueSky, Copyright (c) 2025 TU Delft.
// MIT License, see ../../licenses/BlueSky-MIT.txt.

export const nm = 1852;
export const rad = Math.PI / 180;
export const mod = (x: number, m: number) => ((x % m) + m) % m;
/** Signed turn from a to b, -180..180. */
export const turn = (a: number, b: number) => mod(b - a + 180, 360) - 180;

export function rwgs84(lat: number): number {
  const a = 6378137;
  const b = 6356752.314245;
  const c = Math.cos(lat * rad);
  const s = Math.sin(lat * rad);
  return Math.sqrt(((a * a * c) ** 2 + (b * b * s) ** 2) / ((a * c) ** 2 + (b * s) ** 2));
}

export function kwikqdrdist(lata: number, lona: number, latb: number, lonb: number): [qdr: number, distNm: number] {
  const dlat = (latb - lata) * rad;
  const dlon = turn(lona, lonb) * rad;
  const cavelat = Math.cos((lata + latb) * 0.5 * rad);
  const dist = (6371000 * Math.sqrt(dlat * dlat + dlon * dlon * cavelat * cavelat)) / nm;
  return [mod(Math.atan2(dlon * cavelat, dlat) / rad, 360), dist];
}

export function kwikdist(lata: number, lona: number, latb: number, lonb: number): number {
  return kwikqdrdist(lata, lona, latb, lonb)[1];
}

/** Initial great-circle bearing, the bearing half of qdrdist. */
export function qdr(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlon = (lon2 - lon1) * rad;
  const c2 = Math.cos(lat2 * rad);
  const y = Math.sin(dlon) * c2;
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * c2 * Math.cos(dlon);
  return mod(Math.atan2(y, x) / rad, 360);
}

export function qdrpos(lat1: number, lon1: number, bearing: number, distNm: number): [lat: number, lon: number] {
  const d = distNm / (rwgs84(lat1) / nm);
  const p1 = lat1 * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearing * rad));
  const l2 = lon1 * rad + Math.atan2(Math.sin(bearing * rad) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, turn(0, l2 / rad)];
}
