import { step, type Body } from "./body";
import { kwikdist } from "./bluesky/geo";

export const VERTICAL_FT = 1000;
/** Level flight exactly 1000 ft apart is separated. */
export const LOST_FT = 999;

/** 3 NM where both are in terminal airspace, 5 NM otherwise. */
export function minimumNm(a: Body, b: Body): number {
  return a.altFt < 15000 && b.altFt < 15000 ? 3 : 5;
}

/** Below 1000 ft above the field the tower separates by runway occupancy, not by radar. */
export function separationApplies(a: Body, b: Body): boolean {
  return a.mode === "air" && b.mode === "air" && a.altFt - a.elevFt >= 1000 && b.altFt - b.elevFt >= 1000;
}

export interface Breach<T> {
  other: T;
  /** Seconds from now until the minima are lost. */
  inS: number;
  /** The smallest lateral distance while vertical separation is lost. */
  nm: number;
  atS: number;
}

export interface Change {
  apply: (b: Body) => void;
  afterS: number;
}

/** Fly the cleared intent of `own` and `others` forward. `marginNm` is added to the minimum. */
export function probe<T extends { body: Body }>(own: Body, others: T[], horizonS: number, marginNm = 0, change?: Change): Breach<T> | null {
  const me = { ...own };
  const reach = (horizonS * 1150) / 3600 + 8;
  const them = others
    .filter((o) => o.body !== own && o.body.mode === "air" && kwikdist(own.lat, own.lon, o.body.lat, o.body.lon) < reach)
    .map((other) => ({ other, b: { ...other.body } }));
  if (!them.length) return null;
  let worst: Breach<T> | null = null;
  let changed = !change;
  for (let s = 0, dt = 4; s <= horizonS; s += dt) {
    dt = 4;
    if (!changed && s >= change!.afterS) {
      change!.apply(me);
      changed = true;
    }
    for (const { other, b } of them) {
      if (worst && worst.other !== other) continue;
      const dv = Math.abs(me.altFt - b.altFt);
      if (dv >= LOST_FT + 450 || !separationApplies(me, b)) continue;
      const nm = kwikdist(me.lat, me.lon, b.lat, b.lon);
      const limit = minimumNm(me, b) + marginNm;
      // Near the minima, step by the second as the simulation does, so that a brief corner is not stepped over.
      if (nm < limit + 1.5) dt = 1;
      if (dv >= LOST_FT || nm >= limit) continue;
      if (!worst) worst = { other, inS: s, nm, atS: s };
      else if (nm < worst.nm) Object.assign(worst, { nm, atS: s });
      // Validation only needs to know that there is a breach.
      if (change) return worst;
    }
    step(me, dt);
    for (const { b } of them) step(b, dt);
  }
  return worst;
}

export function closest<T extends { id: string; body: Body }>(own: T, others: T[]) {
  let best: { otherFlightId: string; lateralNm: number; verticalFt: number; requiredNm: number; requiredFt: number } | null = null;
  let bestMargin = Infinity;
  for (const o of others) {
    if (o === own || Math.abs(o.body.lat - own.body.lat) > 1) continue;
    const verticalFt = Math.round(Math.abs(o.body.altFt - own.body.altFt));
    if (verticalFt > 6000 || !separationApplies(own.body, o.body)) continue;
    const d = kwikdist(own.body.lat, own.body.lon, o.body.lat, o.body.lon);
    if (d > 50) continue;
    const requiredNm = minimumNm(own.body, o.body);
    const margin = Math.max(d / requiredNm, verticalFt / VERTICAL_FT);
    if (margin < bestMargin) {
      bestMargin = margin;
      best = { otherFlightId: o.id, lateralNm: Math.round(d * 100) / 100, verticalFt, requiredNm, requiredFt: VERTICAL_FT };
    }
  }
  return best;
}
