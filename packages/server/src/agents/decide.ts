import type { AgentPrompt, Timing } from "@towerai/contracts";
import type { ElevenLabs } from "./client";
import type { AgentIds } from "./data";

/** A text message is billed 30, its LLM tokens about 1. One more is headroom. */
export const DECISION_CREDITS = 32;

export interface Decision {
  optionId: string;
  reason: string;
  timing: Timing;
  conversationId: string;
}

export function parseChoice(output: string, options: AgentPrompt["options"]): { optionId: string; reason: string } {
  const json = /\{[\s\S]*\}/.exec(output)?.[0];
  if (!json) throw new Error("Agent reply was not JSON.");
  const { id, reason } = JSON.parse(json) as { id?: unknown; reason?: unknown };
  if (typeof id !== "string" || !options.some((o) => o.id === id)) throw new Error("Agent chose something that was not offered.");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("Agent gave no reason.");
  return { optionId: id, reason: reason.trim().slice(0, 240) };
}

/** One fresh conversation per decision, so no pilot inherits another pilot's frequency or identity. */
export async function decide(api: ElevenLabs, ids: AgentIds, prompt: AgentPrompt, timeoutMs: number): Promise<Decision> {
  if (!prompt.options.length) throw new Error("Nothing to choose from.");
  api.guard.reserve(DECISION_CREDITS);
  const started = performance.now();
  return api.run(async () => {
    const signal = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs - (performance.now() - started))));
    const { conversation_id } = await api.json<{ conversation_id: string }>(
      "POST",
      "/v1/convai/conversations",
      { agent: { type: "persisted", agent_id: prompt.role === "controller" ? ids.controller : ids.pilot } },
      signal,
    );
    const turn = await api.json<{ status: string; output?: { text: string }[] }>(
      "POST",
      `/v1/convai/conversations/${encodeURIComponent(conversation_id)}/messages`,
      {
        input: [{
          type: "user_message",
          content: [{
            type: "text",
            text: JSON.stringify({
              you: prompt.speaker,
              flight: prompt.flightId,
              position: prompt.position,
              context: prompt.context.slice(0, 10),
              frequency: prompt.history.slice(-5),
              options: prompt.options,
            }),
          }],
        }],
      },
      signal,
    );
    if (turn.status !== "completed") throw new Error(`Agent turn ended ${turn.status}.`);
    const choice = parseChoice((turn.output ?? []).map((o) => o.text).join(""), prompt.options);
    const ms = Math.round(performance.now() - started);
    const day = new Date().toISOString().slice(0, 10);
    return {
      ...choice,
      conversationId: conversation_id,
      timing: { stage: "decide", ms, kind: "measured", source: `ElevenLabs agent (${ids.llm}), recorded ${day}` },
    };
  });
}
