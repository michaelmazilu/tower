import type { Plugins } from "../ops/plugins";
import { audioFile, cachedLine, cachedSeconds } from "../voice/voice";
import { attachPilots, type PilotOptions, type PilotTurn } from "./pilots";

/**
 * Everything the host's plugin seam needs: cached voice, and AI pilots when
 * `pilots.enabled` is true. With no arguments it costs nothing and works offline.
 */
export function agentPlugins(options: { pilots?: Omit<PilotOptions, "onTurn"> } = {}): Plugins {
  let turns = new Map<string, PilotTurn>();
  return {
    voice: {
      label: "ElevenLabs Flash, recorded lines",
      line: ({ role, speaker, text, spoken }) => cachedLine({ role, speaker, text, spoken }),
      file: audioFile,
      seconds: ({ role, speaker, text, spoken }) => cachedSeconds({ role, speaker, text, spoken }),
    },
    pilots: ({ sim }) => {
      const thisRun = new Map<string, PilotTurn>();
      turns = thisRun;
      const driver = attachPilots(sim, {
        ...options.pilots,
        onTurn: (turn) => {
          if (turn.transmissionId) thisRun.set(turn.transmissionId, turn);
        },
      });
      return { update: () => void driver.update(), detach: () => driver.detach() };
    },
    describe: (tx) => {
      const turn = turns.get(tx.id);
      // Transmission ids restart with each run, so the speaker has to match too.
      return turn && turn.aircraftId === tx.from ? { brain: turn.brain, timings: turn.timings } : undefined;
    },
  };
}
