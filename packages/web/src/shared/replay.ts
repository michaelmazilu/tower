import type { Attention, FlightRecord, FlightSummary, Message, RiskLevel, SeparationSample } from "@towerai/contracts";

/** Index of the last sample at or before t, or -1. */
export function indexAt<T>(items: readonly T[], t: number, time: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid]!) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export const mix = (a: number, b: number, f: number) => a + (b - a) * f;
export const mixHeading = (a: number, b: number, f: number) => (a + ((((b - a) % 360) + 540) % 360 - 180) * f + 360) % 360;

/** The flight as it was at t: position interpolated, everything else the value that held then. */
export function flightAt(record: FlightRecord, t: number): FlightSummary {
  const { summary, track, riskSeries, messages } = record;
  const at = { ...summary };
  if (track.length > 0) {
    const i = Math.max(0, indexAt(track, t, (p) => p[0]));
    const a = track[i]!;
    const b = track[Math.min(i + 1, track.length - 1)]!;
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    at.lat = mix(a[1], b[1], f);
    at.lon = mix(a[2], b[2], f);
    at.altFt = mix(a[3], b[3], f);
    at.gsKt = mix(a[4], b[4], f);
    at.hdg = mixHeading(a[5], b[5], f);
    at.vsFpm = mix(a[6], b[6], f);
  }
  if (riskSeries.length > 0) {
    const { t: _, ...state } = riskSeries[Math.max(0, indexAt(riskSeries, t, (s) => s.t))]!;
    Object.assign(at, state);
  }
  const heard = messages.filter((m) => m.t <= t && !isBlocked(m));
  at.lastMessage = heard[heard.length - 1]?.text ?? null;
  return at;
}

/** Never said. A refusal that was spoken and read back is a transmission like any other. */
export const isBlocked = (m: Message) => m.decision?.verdict === "rejected" && m.durationS === 0;
export const isRefusal = (m: Message) => m.decision?.verdict === "rejected" && m.durationS > 0;

/** The decision's facts without the one said twice over. */
export function facts(context: readonly string[], most = 3): string[] {
  const seen = new Set<string>();
  const kept = context.filter((line) => {
    const key = line.startsWith("Predicted") ? "Predicted" : line;
    return !seen.has(key) && !!seen.add(key);
  });
  return kept.slice(0, most);
}

/** Who is out there for this flight, at t. */
export function respondersAt(record: FlightRecord, t: number): string | null {
  let found: string | null = null;
  for (const m of record.markers) {
    if (m.t <= t && m.kind === "emergency" && /^(fire \+ rescue|paramedics)/.test(m.label)) found = m.label;
  }
  return found;
}

/** Seconds between the end of the message being answered and the start of this one. */
export function replyDelay(message: Message, messages: readonly Message[]): number | null {
  const asked = message.replyTo ? messages.find((m) => m.id === message.replyTo) : undefined;
  return asked ? Math.max(0, message.t - asked.t - asked.durationS) : null;
}

/** The tightest pair in the latest few seconds before t. */
export function separationAt(record: FlightRecord, t: number): SeparationSample | null {
  let worst: SeparationSample | null = null;
  const margin = separationMargin;
  const latest = new Map<string, SeparationSample>();
  for (const s of record.separation) if (s.t <= t && s.t >= t - 15) latest.set(s.otherFlightId, s);
  for (const s of latest.values()) if (!worst || margin(s) < margin(worst)) worst = s;
  return worst;
}

/** 1 is the minimum. No minimum, for an independent parallel, is never short. */
export const separationMargin = (s: SeparationSample) =>
  s.requiredNm ? Math.max(s.lateralNm / s.requiredNm, s.requiredFt ? Math.abs(s.verticalFt) / s.requiredFt : 0) : Infinity;

export function minimumWords(s: SeparationSample): string {
  if (!s.requiredNm) return "independent parallel";
  return s.requiredNm === 2.5 ? "in trail, min 2.5 nm" : `min ${s.requiredNm} nm / ${s.requiredFt} ft`;
}

/** Either axis is enough to be separated. */
export const tooClose = (s: SeparationSample) => s.lateralNm < s.requiredNm && Math.abs(s.verticalFt) < s.requiredFt;

const ATTENTION_RANK: Record<Attention, number> = { human_requested: 4, intervene: 3, human_control: 2, monitor: 1, none: 0 };
const LEVEL_RANK: Record<RiskLevel, number> = { critical: 3, high: 2, watch: 1, normal: 0 };

export const needsHuman = (attention: Attention) => attention === "human_requested" || attention === "intervene";

export function byUrgency(a: FlightSummary, b: FlightSummary): number {
  return (
    ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
    LEVEL_RANK[b.risk.level] - LEVEL_RANK[a.risk.level] ||
    b.risk.score - a.risk.score ||
    a.callsign.localeCompare(b.callsign)
  );
}

export const ATTENTION_WORDS: Record<Attention, string> = {
  none: "autonomous",
  monitor: "agent handling",
  intervene: "intervene",
  human_requested: "human requested",
  human_control: "you have control",
};

export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

export const millis = (ms: number) => (ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

export function altitude(ft: number): string {
  if (ft < 20) return "ground";
  return ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : `${(Math.round(ft / 10) * 10).toLocaleString("en-CA")} ft`;
}
