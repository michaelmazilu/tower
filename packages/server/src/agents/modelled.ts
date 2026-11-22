import type { Timing } from "@towerai/contracts";
import { dataPath, readData } from "./data";

interface Samples {
  decide: number[];
  voice: number[];
}

/** The measured samples behind every modelled agent timing. Null before a measurement exists. */
export function latencySamples(): { recorded: string; llm: string; tts: string; controller: Samples; pilot: Samples } | null {
  return readData(dataPath("latency", "timings.json"), null);
}

/** Draws a measured value for a line that was never timed, labelled as modelled. The same key gives the same value. */
export function modelledTiming(role: "controller" | "pilot", stage: Timing["stage"], key: string): Timing | null {
  const samples = latencySamples();
  const values = samples?.[role][stage];
  if (!samples || !values?.length) return null;
  let hash = 2166136261;
  for (const c of `${role}:${stage}:${key}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return {
    stage,
    ms: values[hash % values.length],
    kind: "modelled",
    source: `modelled from ${values.length} measured samples, recorded ${samples.recorded}`,
  };
}
