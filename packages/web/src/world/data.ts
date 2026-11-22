// Everything the screen shows is derived here from the recording and a playhead.
import type { FlightRecord, Message, SeparationSample, TrackPoint, WorldRecording } from "@towerai/contracts";
import { geoDistance } from "d3-geo";
import { indexAt as upTo, isBlocked, millis, mix, mixHeading } from "../shared/replay";

export { upTo };

const byT = <T extends { t: number }>(a: T, b: T) => a.t - b.t;
const timeOf = (x: { t: number }) => x.t;
const trackTime = (p: TrackPoint) => p[0];
const turn = (from: number, to: number) => ((to - from + 540) % 360) - 180;

export interface Pose {
  lat: number;
  lon: number;
  altFt: number;
  gsKt: number;
  hdg: number;
  vsFpm: number;
}

export function poseAt(f: FlightRecord, t: number): Pose {
  const i = upTo(f.track, t, trackTime);
  const a = f.track[Math.max(0, i)];
  if (!a) return f.summary;
  const b = i < 0 ? a : (f.track[i + 1] ?? a);
  const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  const lerp = (j: 1 | 3 | 4 | 6) => mix(a[j], b[j], k);
  return {
    lat: lerp(1),
    lon: ((a[2] + turn(a[2], b[2]) * k + 540) % 360) - 180,
    altFt: lerp(3),
    gsKt: lerp(4),
    hdg: mixHeading(a[5], b[5], k),
    vsFpm: lerp(6),
  };
}

export type State = FlightRecord["riskSeries"][number];

export function stateAt(f: FlightRecord, t: number): State {
  return f.riskSeries[Math.max(0, upTo(f.riskSeries, t, timeOf))] ?? { t: f.startT, ...f.summary };
}

export const activeAt = (f: { startT: number; endT: number }, t: number) => t >= f.startT && t <= f.endT;

/** Red is reserved for these. */
export const needsPerson = (s: Pick<State, "attention" | "risk">) =>
  s.attention === "human_requested" ||
  s.attention === "intervene" ||
  (s.risk.level === "critical" && s.attention !== "human_control");

const ATTENTION_RANK = { human_requested: 4, intervene: 3, human_control: 2, monitor: 1, none: 0 };
export const urgency = (s: State) => (needsPerson(s) ? 1000 : 0) + ATTENTION_RANK[s.attention] * 100 + s.risk.score;

/** Time to decide, on the lines where a model really decided. */
export const decideOf = (m: Message) => (m.brain === "llm" ? m.timings.find((x) => x.stage === "decide" && x.kind === "measured")?.ms : undefined);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A value of 1 is the minimum: an aircraft is separated if either axis meets it. */
export const margin = (s: SeparationSample) =>
  Math.max(
    s.requiredNm ? s.lateralNm / s.requiredNm : Infinity,
    s.requiredFt ? Math.abs(s.verticalFt) / s.requiredFt : 0,
  );

/** The closest pairing at each sampled second. */
export function closest(f: FlightRecord): SeparationSample[] {
  const worst = new Map<number, SeparationSample>();
  for (const s of f.separation) {
    const held = worst.get(s.t);
    if (!held || margin(s) < margin(held)) worst.set(s.t, s);
  }
  return [...worst.values()].sort(byT);
}

/** Samples further apart than this are different encounters. */
export const GAP_S = 120;

export function sampleAt(samples: readonly SeparationSample[], t: number) {
  const s = samples[upTo(samples, t, timeOf)];
  return s && t - s.t <= GAP_S ? s : undefined;
}

export interface Conflict {
  a: string;
  b: string;
  start: number;
  end: number;
  /** When it was resolved; null means it was still open when tracking ended. */
  resolvedAt: number | null;
}

const pairKey = (a: string, b: string) => [a, b].sort().join("|");

export function indexWorld(world: WorldRecording) {
  // The engine's order is not assumed, and nothing here mutates the recording.
  const flights = world.flights.map((f) => ({
    ...f,
    track: [...f.track].sort((a, b) => a[0] - b[0]),
    messages: [...f.messages].sort(byT),
    markers: [...f.markers].sort(byT),
    riskSeries: [...f.riskSeries].sort(byT),
  }));
  const byId = new Map(flights.map((f) => [f.summary.id, f]));
  const marks = flights.flatMap((f) => f.markers.map((m) => ({ ...m, flightId: f.summary.id }))).sort(byT);

  const conflicts: Conflict[] = [];
  // A clearance inside an open conflict, or a place in a landing sequence, is not a new incident.
  const turningPoints = new Set<(typeof marks)[number]>();
  const open = new Map<string, Conflict>();
  for (const m of marks) {
    if (!m.otherFlightId || (m.kind !== "conflict" && m.kind !== "resolved")) continue;
    const key = pairKey(m.flightId, m.otherFlightId);
    const held = open.get(key);
    if (m.kind === "conflict" && !held) {
      const end = Math.min(byId.get(m.flightId)!.endT, byId.get(m.otherFlightId)?.endT ?? Infinity);
      const c = { a: m.flightId, b: m.otherFlightId, start: m.t, end, resolvedAt: null };
      open.set(key, c);
      conflicts.push(c);
      turningPoints.add(m);
    } else if (m.kind === "resolved" && held) {
      held.resolvedAt = m.t;
      held.end = m.t;
      open.delete(key);
      turningPoints.add(m);
    }
  }

  // One loss is one unbroken run below both minima, counted once per pair.
  const pairs = new Map<string, SeparationSample[]>();
  for (const f of flights)
    for (const s of f.separation) {
      const key = pairKey(f.summary.id, s.otherFlightId);
      const held = pairs.get(key);
      if (held) held.push(s);
      else pairs.set(key, [s]);
    }
  const losses: number[] = [];
  for (const samples of pairs.values()) {
    let inside = false;
    for (const s of samples.sort(byT)) {
      const below = margin(s) < 1;
      if (below && !inside) losses.push(s.t);
      inside = below;
    }
  }

  const said = new Map<string, { flightId: string; m: Message }>();
  for (const f of flights) for (const m of f.messages) said.set(m.id, { flightId: f.summary.id, m });
  const onAir = [...said.values()].filter((e) => !isBlocked(e.m)).sort((a, b) => a.m.t - b.m.t);

  const seen = new Set<string>();
  const incidents = marks.filter((m) => {
    if (m.kind === "handoff") return false;
    if ((m.kind === "conflict" || m.kind === "resolved") && m.otherFlightId && !turningPoints.has(m)) return false;
    const who = m.otherFlightId ? pairKey(m.flightId, m.otherFlightId) : m.flightId;
    const key =
      m.kind === "weather" || m.kind === "closure" ? `${m.kind}${m.label}${m.t}` : `${m.kind}${who}${Math.round(m.t)}`;
    return !seen.has(key) && !!seen.add(key);
  });

  const nearest = new Map(flights.map((f) => [f.summary.id, closest(f)]));
  return { world, flights, byId, nearest, marks, incidents, conflicts, losses, onAir };
}

export type WorldIndex = ReturnType<typeof indexWorld>;

export const liveConflicts = (x: WorldIndex, t: number) => x.conflicts.filter((c) => t >= c.start && t < c.end);

const EARTH_NM = 3440.065;

/**
 * The recorded closest pairing. A conflict is predicted minutes before that
 * starts, so until then the pair is measured from both tracks.
 */
export function nearestAt(x: WorldIndex, f: FlightRecord, t: number): SeparationSample | undefined {
  const id = f.summary.id;
  const held = sampleAt(x.nearest.get(id)!, t);
  if (held) return held;
  const pair = liveConflicts(x, t).find((c) => c.a === id || c.b === id);
  const other = pair && x.byId.get(pair.a === id ? pair.b : pair.a);
  const minima = other && f.separation.find((s) => s.otherFlightId === other.summary.id);
  if (!other || !minima) return undefined;
  const a = poseAt(f, t);
  const b = poseAt(other, t);
  return {
    ...minima,
    t,
    lateralNm: geoDistance([a.lon, a.lat], [b.lon, b.lat]) * EARTH_NM,
    verticalFt: b.altFt - a.altFt,
  };
}

export function statsAt(x: WorldIndex, t: number) {
  const past = x.onAir.slice(0, upTo(x.onAir, t, (e) => e.m.t) + 1);
  const decided = past.flatMap((e) => (e.m.from === "controller" ? (decideOf(e.m) ?? []) : []));
  const talking = new Set(
    past.filter((e) => t - e.m.t <= 120 && activeAt(x.byId.get(e.flightId)!, t)).map((e) => e.flightId),
  );
  return {
    handled: new Set(past.map((e) => e.flightId)).size,
    airborne:
      x.flights.filter((f) => activeAt(f, t) && poseAt(f, t).gsKt > 60).length +
      x.world.background.filter((b) => t >= b.departT && t <= b.departT + b.durationS).length,
    talking: talking.size,
    transmissions: past.length,
    conflicts: x.conflicts.filter((c) => c.start <= t).length,
    resolved: x.conflicts.filter((c) => c.resolvedAt !== null && c.resolvedAt <= t).length,
    losses: x.losses.filter((s) => s <= t).length,
    escalations: x.incidents.filter((m) => m.kind === "escalation" && m.t <= t).length,
    decideMs: median(decided),
    decisions: decided.length,
  };
}

// ----------------------------------------------------------------- formatting

export const clockText = (epochMs: number, t: number) => new Date(epochMs + t * 1000).toISOString().slice(11, 19) + "z";

export function spanText(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export const msText = (ms: number | null) => (ms === null ? "–" : millis(ms));

export const altText = (ft: number) =>
  ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : `${(Math.round(ft / 100) * 100).toLocaleString("en")} ft`;

export const ATTENTION_WORD: Record<State["attention"], string> = {
  none: "autonomous",
  monitor: "monitor",
  intervene: "intervene",
  human_requested: "human needed",
  human_control: "human control",
};
