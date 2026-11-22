import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { post } from "./useOps";

/** The questions a controller taking a flight actually asks, one tap each. */
const SUGGESTIONS = ["Why?", "What should I do?", "What if we wait?", "What's around it?", "What if I hand it back?"];

/**
 * "Ask the agent", built on assistant-ui: a chat about one flight. Every answer
 * comes from the server's rule-built briefing for that flight, the same facts
 * the card shows, so it works offline and cannot contradict the card.
 */
export function AskAgent({ flightId, callsign }: { flightId: string; callsign: string }) {
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async run({ messages }) {
        const last = messages[messages.length - 1];
        const question = (last?.content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(" ")
          .trim();
        const reply = await post(`/api/ops/flights/${encodeURIComponent(flightId)}/ask`, { question });
        return { content: [{ type: "text", text: reply.message ?? "I could not answer that just now." }] };
      },
    }),
    [flightId],
  );
  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="askai">
        <ThreadPrimitive.Viewport className="askai-view">
          <ThreadPrimitive.Empty>
            <p className="askai-empty">
              Ask me anything about {callsign}. I answer from the same live picture as this card, and I never send anything to the
              plane.
            </p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === "user" ? (
                <MessagePrimitive.Root className="askai-msg askai-you">
                  <b>You</b>
                  <MessagePrimitive.Parts />
                </MessagePrimitive.Root>
              ) : (
                <MessagePrimitive.Root className="askai-msg askai-agent">
                  <b>Agent</b>
                  <MessagePrimitive.Parts />
                </MessagePrimitive.Root>
              )
            }
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <div className="askai-suggest">
          {SUGGESTIONS.map((s) => (
            <ThreadPrimitive.Suggestion key={s} prompt={s} send className="askai-chip">
              {s}
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
        <ComposerPrimitive.Root className="askai-composer">
          <ComposerPrimitive.Input className="askai-input" placeholder={`Ask about ${callsign}: why, what to do, how long…`} />
          <ComposerPrimitive.Send className="askai-send">Ask</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
