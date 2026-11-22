import type { Timing } from "@towerai/contracts";

/** Measured samples a caller collected from real calls. Draws from them are still labelled modelled. */
export interface ModelTiming {
  /** Where and when the samples were measured. */
  source: string;
  controllerDecideMs: number[];
  pilotDecideMs: number[];
  voiceMs: number[];
}

export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Median milliseconds and log-normal spread. An assumption, not a measurement.
const ASSUMED = { controller: [1100, 0.3], pilot: [900, 0.32], operator: [4200, 0.25], voice: [380, 0.22] } as const;

export function timingModel(rand: () => number, measured?: ModelTiming) {
  return (who: "controller" | "pilot" | "operator", stage: Timing["stage"]): Timing => {
    const key = stage === "voice" ? "voice" : who;
    const samples =
      key === "voice" ? measured?.voiceMs : key === "controller" ? measured?.controllerDecideMs : key === "pilot" ? measured?.pilotDecideMs : undefined;
    if (measured && samples?.length) {
      return {
        stage, kind: "modelled", ms: Math.round(samples[Math.floor(rand() * samples.length)]!),
        source: `modelled from ${samples.length} measured samples (${measured.source})`,
      };
    }
    const [median, spread] = ASSUMED[key];
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return {
      stage, kind: "modelled", ms: Math.round(median * Math.exp(spread * Math.max(-2, Math.min(2.5, z)))),
      source: `modelled assumption, not timed: log-normal, median ${median} ms`,
    };
  };
}

export function speechSeconds(text: string): number {
  const words = text.split(/\s+/).length;
  const digits = text.match(/\d/g)?.length ?? 0;
  return Math.round((0.5 + words * 0.3 + digits * 0.12) * 10) / 10;
}
