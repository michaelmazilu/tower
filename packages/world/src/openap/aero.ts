// SPDX-License-Identifier: LGPL-3.0-only
// Modified TypeScript port (2026-11-22) of openap/aero.py from OpenAP
// (https://github.com/junzis/openap), Junzi Sun and contributors. See ./LICENSE.

export const kts = 0.514444;
export const ft = 0.3048;
const g0 = 9.80665;
const R = 287.05287;
const p0 = 101325;
const rho0 = 1.225;
const T0 = 288.15;
const beta = -0.0065;
const gamma = 1.4;
const a0 = 340.293988;

export function atmos(h: number): { p: number; rho: number; T: number } {
  const T = Math.max(T0 + beta * h, 216.65);
  const rho = rho0 * (T / T0) ** 4.256848030018761 * Math.exp(-Math.max(0, h - 11000) / 6341.552161);
  return { p: rho * R * T, rho, T };
}

export const vsound = (h: number) => Math.sqrt(gamma * R * atmos(h).T);
export const mach2tas = (mach: number, h: number) => mach * vsound(h);
export const tas2mach = (tas: number, h: number) => tas / vsound(h);

export function cas2tas(cas: number, h: number): number {
  const { p, rho } = atmos(h);
  const qdyn = p0 * ((1 + (rho0 * cas * cas) / (7 * p0)) ** 3.5 - 1);
  return Math.sqrt(((7 * p) / rho) * ((1 + qdyn / p) ** (2 / 7) - 1));
}

export function tas2cas(tas: number, h: number): number {
  const { p, rho } = atmos(h);
  const qdyn = p * ((1 + (rho * tas * tas) / (7 * p)) ** 3.5 - 1);
  return Math.sqrt(((7 * p0) / rho0) * ((qdyn / p0 + 1) ** (2 / 7) - 1));
}

/** Altitude in metres where a constant CAS equals a constant Mach. */
export function crossoverAlt(cas: number, mach: number): number {
  const delta = ((0.2 * (cas / a0) ** 2 + 1) ** 3.5 - 1) / ((0.2 * mach ** 2 + 1) ** 3.5 - 1);
  return (T0 / beta) * (delta ** ((-R * beta) / g0) - 1);
}
