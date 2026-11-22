import type { AskAgent, Timing } from "@towerai/contracts";
import { voiceLine } from "../voice/voice";
import { ElevenLabs } from "./client";
import { agentIds, type AgentIds } from "./data";
import { decide } from "./decide";

export interface AskOptions {
  /** Off by default: an unset switch never spends. */
  enabled?: boolean;
  maxCalls?: number;
  timeoutMs?: number;
  /** false = text only. "cached" = attach existing audio. "generate" also spends on voice. */
  voice?: false | "cached" | "generate";
  onError?: (error: unknown) => void;
  api?: ElevenLabs | null;
  ids?: AgentIds | null;
}

/**
 * The world recorder's agent. It can only pick an option id: the words on
 * frequency are always the option's text, so `text` is never returned.
 */
export function createAskAgent(options: AskOptions = {}): AskAgent {
  const { maxCalls = 12, timeoutMs = 6000, voice = "cached", onError } = options;
  const enabled = options.enabled === true && maxCalls > 0;
  const api = enabled ? (options.api === undefined ? ElevenLabs.fromEnv() : options.api) : null;
  const ids = enabled ? (options.ids === undefined ? agentIds() : options.ids) : null;
  let calls = 0;

  return async (prompt) => {
    if (!api || !ids || !prompt.options.length || calls >= maxCalls) return null;
    calls++;
    try {
      const started = performance.now();
      await api.prepare();
      const chosen = await decide(api, ids, prompt, timeoutMs);
      // The whole wait, including the meter read and any queue for a free slot.
      const timings: Timing[] = [{ ...chosen.timing, ms: Math.round(performance.now() - started) }];
      let audioUrl: string | undefined;
      if (voice) {
        const text = prompt.options.find((o) => o.id === chosen.optionId)!.text;
        try {
          const line = await voiceLine(
            { role: prompt.role, speaker: prompt.speaker, text },
            voice === "generate" ? { api } : {},
          );
          if (line) {
            timings.push(line.timing);
            audioUrl = line.audioUrl;
          }
        } catch (error) {
          onError?.(error);
        }
      }
      return { optionId: chosen.optionId, reason: chosen.reason, brain: "llm", timings, audioUrl };
    } catch (error) {
      onError?.(error);
      return null;
    }
  };
}
