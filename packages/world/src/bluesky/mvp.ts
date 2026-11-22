// Port of bluesky/traffic/asas/mvp.py from BlueSky, Copyright (c) 2025 TU Delft.
// MIT License, see ../../licenses/BlueSky-MIT.txt.
// One aircraft is cleared and the intruder is treated as "noreso", so ownship
// takes the whole resolution.
import { ft } from "../openap/aero";
import { east, north, up, type Predicted, type State } from "./detect";
import { mod, nm, rad } from "./geo";

export function mvp(own: State, intruder: State, c: Predicted, rpzNm: number, hpzFt: number, lookaheadS: number): { hdg: number; gsKt: number; vsFpm: number } {
  const rpz = rpzNm * nm;
  const hpz = hpzFt * ft;
  const drel: [number, number, number] = [Math.sin(c.qdr * rad) * c.dist, Math.cos(c.qdr * rad) * c.dist, (intruder.altFt - own.altFt) * ft];
  const vrel: [number, number, number] = [east(intruder) - east(own), north(intruder) - north(own), up(intruder) - up(own)];

  let cx = drel[0] + vrel[0] * c.tcpa;
  let cy = drel[1] + vrel[1] * c.tcpa;
  let dabsH = Math.hypot(cx, cy);
  const iH = rpz - dabsH;
  if (dabsH <= 10) {
    dabsH = 10;
    cx = (drel[1] / c.dist) * dabsH;
    cy = (-drel[0] / c.dist) * dabsH;
  }
  let push = iH;
  if (rpz < c.dist && dabsH < c.dist) push = rpz / Math.cos(Math.asin(rpz / c.dist) - Math.asin(dabsH / c.dist)) - dabsH;
  const k = push / (Math.abs(c.tcpa) * dabsH);

  let iV = Math.abs(vrel[2]) > 0 ? hpz : hpz - Math.abs(drel[2]);
  let tsolV = Math.abs(vrel[2]) > 0 ? Math.abs(drel[2] / vrel[2]) : c.tlos;
  if (tsolV > lookaheadS) {
    tsolV = c.tlos;
    iV = hpz;
  }
  const dir = Math.abs(vrel[2]) > 0 ? -Math.sign(vrel[2]) : Math.sign(drel[2]) || 1;
  const dv3 = (iV / Math.max(tsolV, 1)) * dir;

  const e = east(own) - k * cx;
  const n = north(own) - k * cy;
  return { hdg: mod(Math.atan2(e, n) / rad, 360), gsKt: Math.hypot(e, n) / 0.514444, vsFpm: ((up(own) - dv3) / ft) * 60 };
}
