import type { AskAgent, WorldRecording } from "@towerai/contracts";
import { PORTS } from "./airports";
import { backgroundTraffic } from "./background";
import { buildWorld } from "./scenario";
import { Sim, type Effect } from "./sim";
import { advisoryMonitor, conflictMonitor, flowManager } from "./traffic";
import type { ModelTiming } from "./timing";

export type { ModelTiming } from "./timing";
export { Sim, type Effect } from "./sim";

const DURATION_S = 2400;
const EPOCH = "2026-11-22T13:00:00.000Z";

export interface RecordOptions {
  seed: number;
  /** Consulted at storyline moments only. Null, an error or an invalid choice falls back to rules. */
  ask?: AskAgent;
  modelTiming?: ModelTiming;
  /** Default 40, which covers every storyline moment in the standard recording. */
  maxAgentCalls?: number;
  /** Defaults to the recording epoch, so that the output is deterministic. */
  generatedAt?: string;
}

/** Starts the separation and flow services that every simulation needs. */
export function startServices(sim: Sim): void {
  sim.spawn(conflictMonitor(sim));
  sim.spawn(advisoryMonitor(sim));
  sim.spawn(flowManager(sim));
}

export async function simulateWorld(options: RecordOptions): Promise<{ recording: WorldRecording; effects: Effect[] }> {
  const { seed, ask, modelTiming, maxAgentCalls, generatedAt = EPOCH } = options;
  const sim = new Sim({ seed, durationS: DURATION_S, ask, modelTiming, maxAgentCalls });
  startServices(sim);
  buildWorld(sim);
  await sim.run();

  const flights = sim.records();
  const recording: WorldRecording = {
    version: 1,
    generatedAt,
    seed,
    durationS: DURATION_S,
    epoch: EPOCH,
    provenance: {
      traffic:
        `Entirely synthetic. ${flights.length} simulated, controlled flights and 1000 background flights drawn on great circles. ` +
        "Real airline and airport names; fictional flights, flight numbers, fixes, frequencies and weather. Responders and supervisor lines are scripted stand-ins. Headings are true; no wind drift.",
      separation:
        "State-based detection and MVP resolution ported from BlueSky, confirmed by projecting cleared intent. Minima 3 NM below 15000 ft and 5 NM above, or 1000 ft. Below 1000 ft above the field, runway occupancy applies instead.",
      performance:
        "Climb, cruise and descent segments and airspeed conversions ported from OpenAP code. Aircraft figures are our own approximate, typical values, not OpenAP data.",
      latency: modelTiming
        ? `Decide times are only on LLM lines, each measured on its recorded call. Rules lines decide at once and carry none. The pause before a rules line, and any voice time without a recording, is modelled from measured samples (${modelTiming.source}); human stand-in timing is an assumption.`
        : "Modelled, not measured: log-normal with assumed medians of 1100 ms controller decision, 900 ms pilot decision, 380 ms first audio and 4200 ms human stand-in. Any individually measured line says so.",
      attribution: [
        "BlueSky ATC Simulator, (c) 2025 TU Delft, MIT: conflict detection, MVP, geodesy",
        "OpenAP, Junzi Sun and contributors, LGPL-3.0: atmosphere, airspeed, trajectory segments (code only, no data)",
      ],
    },
    airports: Object.values(PORTS).map(({ icao, name, lat, lon }) => ({ icao, name, lat, lon })),
    flights,
    background: backgroundTraffic(seed, DURATION_S),
    stats: {
      ...sim.stats,
      handoffs: flights.reduce((n, f) => n + f.markers.filter((m) => m.kind === "handoff").length, 0),
      messages: flights.reduce((n, f) => n + f.messages.length, 0),
    },
  };
  return { recording, effects: sim.effects };
}

export async function recordWorld(options: RecordOptions): Promise<WorldRecording> {
  return (await simulateWorld(options)).recording;
}
