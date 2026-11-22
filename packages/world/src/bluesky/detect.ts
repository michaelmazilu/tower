// Port of bluesky/traffic/asas/statebased.py from BlueSky, Copyright (c) 2025 TU Delft.
// MIT License, see ../../licenses/BlueSky-MIT.txt.
import { ft } from "../openap/aero";
import { kwikqdrdist, nm, rad } from "./geo";

export interface State {
  lat: number;
  lon: number;
  altFt: number;
  gsKt: number;
  hdg: number;
  vsFpm: number;
}

export interface Predicted {
  qdr: number;
  /** metres */
  dist: number;
  dcpa: number;
  tcpa: number;
  /** seconds until both minima are lost together */
  tlos: number;
}

const ms = 0.514444;
const fpm = ft / 60;
export const east = (s: State) => s.gsKt * ms * Math.sin(s.hdg * rad);
export const north = (s: State) => s.gsKt * ms * Math.cos(s.hdg * rad);
export const up = (s: State) => s.vsFpm * fpm;

export function detect(own: State, intruder: State, rpzNm: number, hpzFt: number, lookaheadS: number): Predicted | null {
  const [bearing, distNm] = kwikqdrdist(own.lat, own.lon, intruder.lat, intruder.lon);
  const dist = distNm * nm;
  const dx = dist * Math.sin(bearing * rad);
  const dy = dist * Math.cos(bearing * rad);
  const du = east(intruder) - east(own);
  const dv = north(intruder) - north(own);
  const dv2 = Math.max(du * du + dv * dv, 1e-6);
  const tcpa = -(du * dx + dv * dy) / dv2;
  const dcpa2 = Math.abs(dist * dist - tcpa * tcpa * dv2);
  const R2 = (rpzNm * nm) ** 2;
  if (dcpa2 >= R2) return null;

  const dtinhor = Math.sqrt(R2 - dcpa2) / Math.sqrt(dv2);
  const dalt = (intruder.altFt - own.altFt) * ft;
  const dvs = up(intruder) - up(own);
  const hi = (dalt + hpzFt * ft) / -dvs;
  const lo = (dalt - hpzFt * ft) / -dvs;
  const tin = Math.max(Math.min(hi, lo), tcpa - dtinhor);
  const tout = Math.min(Math.max(hi, lo), tcpa + dtinhor);
  if (!(tin <= tout && tout > 0 && tin < lookaheadS)) return null;
  return { qdr: bearing, dist, dcpa: Math.sqrt(dcpa2), tcpa, tlos: tin };
}
