import type { Vec2 } from "./types";

/** Metres per second in one knot. */
export const KT = 0.514444;
/** Metres in one nautical mile. */
export const NM = 1852;
/** Metres in one foot. */
export const FT = 0.3048;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function unit(a: Vec2): Vec2 {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function normDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Unit vector for a compass heading (0 = north, 90 = east). */
export function headingVec(deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), y: Math.cos(r) };
}

/** Compass bearing from one point to another. */
export function bearing(from: Vec2, to: Vec2): number {
  return normDeg((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI);
}

/** Signed shortest turn from `from` to `to`, in (-180, 180]. Positive = right. */
export function angleDiff(from: number, to: number): number {
  let d = normDeg(to - from);
  if (d > 180) d -= 360;
  return d;
}

/** Turn `current` toward `target` by at most `maxDelta` degrees. */
export function turnToward(current: number, target: number, maxDelta: number): number {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxDelta) return normDeg(target);
  return normDeg(current + Math.sign(d) * maxDelta);
}

/**
 * Project point `p` onto segment a→b. `t` is the distance along the segment
 * from `a` (unclamped), `lateral` the perpendicular offset.
 */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; lateral: number; length: number } {
  const ab = sub(b, a);
  const length = len(ab);
  if (length === 0) return { t: 0, lateral: dist(p, a), length: 0 };
  const u = scale(ab, 1 / length);
  const ap = sub(p, a);
  const t = dot(ap, u);
  const lateral = Math.abs(ap.x * u.y - ap.y * u.x);
  return { t, lateral, length };
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;
