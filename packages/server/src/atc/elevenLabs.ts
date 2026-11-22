import type { ToolResult } from "@towerai/core";
import { ElevenLabs } from "../agents/client";
import { agentIds } from "../agents/data";
import type { TowerAgent, TurnContext } from "./controller";

/** Tools in the account carry the project's name. The gateway's names do not. */
export const TOOL_PREFIX = "TowerAI_";
/** A turn is billed 30 for its message. Tool rounds add only model tokens. Both are over-estimates. */
const TURN_CREDITS = 45;
const TOOL_ROUND_CREDITS = 8;

interface Action {
  tool_call_id: string;
  tool_name: string;
  parameters: Record<string, unknown>;
}

interface Turn {
  status: string;
  required_actions?: Action[];
  output?: { text: string }[];
}

/** One text conversation per attached tower. All tool execution stays on the simulation host. */
export class ElevenLabsTower implements TowerAgent {
  private conversationId?: string;

  constructor(
    private readonly agentId: string,
    private readonly apiKey: string,
    private readonly request = fetch,
    /** Real calls are always metered. A stubbed transport spends nothing. */
    private readonly account = request === fetch ? new ElevenLabs(apiKey) : undefined,
  ) {}

  private async post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await this.request("https://api.elevenlabs.io/v1/convai/conversations" + path, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}.`);
    return await response.json() as T;
  }

  async review(context: TurnContext): Promise<string> {
    const { signal } = context;
    try {
      await this.account?.prepare();
      if (!this.conversationId) {
        const created = await this.post<{ conversation_id: string }>("", {
          agent: { type: "persisted", agent_id: this.agentId },
        }, signal);
        if (!created.conversation_id) throw new Error("ElevenLabs omitted the conversation ID.");
        this.conversationId = created.conversation_id;
      }
      const path = "/" + encodeURIComponent(this.conversationId) + "/messages";
      let input: unknown[] = [{
        type: "user_message",
        content: [{ type: "text", text: JSON.stringify(context.briefing) }],
      }];
      const calls = new Map<string, ToolResult>();
      for (let round = 0; ; round++) {
        this.account?.guard.reserve(round ? TOOL_ROUND_CREDITS : TURN_CREDITS);
        const post = () => this.post<Turn>(path, { input }, signal);
        const turn = await (this.account ? this.account.run(post) : post());
        signal.throwIfAborted();
        if (turn.status === "completed") return (turn.output ?? []).map((o) => o.text).join("\n");
        if (turn.status !== "requires_action" || !turn.required_actions?.length) {
          throw new Error(`ElevenLabs turn ended with status ${turn.status}.`);
        }
        if (round >= 24) throw new Error("Tower exceeded the round limit for one review.");
        input = turn.required_actions.map((action) => {
          const { tool_call_id: id, tool_name: tool, parameters } = action;
          if (!id || typeof tool !== "string" || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
            throw new Error("Malformed ElevenLabs tool call.");
          }
          let result = calls.get(id);
          if (!result) {
            if (calls.size >= 48) throw new Error("Tower exceeded the tool budget for one review.");
            result = context.call(tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool, parameters);
            calls.set(id, result);
          }
          return { type: "client_tool_result", tool_call_id: id, is_error: !result.ok, result: JSON.stringify(result) };
        });
      }
    } catch (error) {
      // A lost response may have left pending actions remotely. Start with fresh world state.
      this.conversationId = undefined;
      throw error;
    }
  }
}

/** The TowerAI tower from data/agents.json, or undefined without a key or setup. An env id wins. */
export function towerFromEnv(): (() => TowerAgent) | undefined {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const id = process.env.ELEVENLABS_AGENT_ID?.trim() || agentIds()?.tower;
  return key && id ? () => new ElevenLabsTower(id, key) : undefined;
}
