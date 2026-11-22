// SPDX-License-Identifier: LGPL-3.0-only
// Modified TypeScript port (2026-11-22) of the segment structure of openap/gen.py
// from OpenAP (https://github.com/junzis/openap), Junzi Sun and contributors.
// See ./LICENSE. No WRAP coefficients or other OpenAP data: callers supply the profile.
import { cas2tas, crossoverAlt, ft, kts, mach2tas } from "./aero";

export interface Profile {
  climbCasKt: number;
  descentCasKt: number;
  mach: number;
  approachCasKt: number;
  /** ft/min for initial climb, pre-constant-CAS, constant CAS, constant Mach. */
  climbFpm: [number, number, number, number];
  /** ft/min for constant Mach, constant CAS, post-constant-CAS, final approach. */
  descentFpm: [number, number, number, number];
}

export function climb(p: Profile, altFt: number, aglFt: number): { casKt: number; fpm: number } {
  if (aglFt < 1500) return { casKt: p.approachCasKt + 30, fpm: p.climbFpm[0] };
  if (altFt < 10000) return { casKt: 250, fpm: p.climbFpm[1] };
  const inCas = altFt * ft < crossoverAlt(p.climbCasKt * kts, p.mach);
  return { casKt: p.climbCasKt, fpm: p.climbFpm[inCas ? 2 : 3] };
}

export function descent(p: Profile, altFt: number, aglFt: number): { casKt: number; fpm: number } {
  if (altFt * ft > crossoverAlt(p.descentCasKt * kts, p.mach)) return { casKt: p.descentCasKt, fpm: p.descentFpm[0] };
  if (altFt > 10500) return { casKt: p.descentCasKt, fpm: p.descentFpm[1] };
  if (aglFt > 2500) return { casKt: 250, fpm: p.descentFpm[2] };
  return { casKt: p.approachCasKt, fpm: p.descentFpm[3] };
}

/** Above crossover the Mach number limits; below it the CAS does. */
export function trueAirspeedKt(casKt: number, mach: number, altFt: number): number {
  const h = altFt * ft;
  return Math.min(cas2tas(casKt * kts, h), mach2tas(mach, h)) / kts;
}
