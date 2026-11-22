import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FlightSummary, Message, OperatorInstruction } from "@towerai/contracts";
import { clock, needsHuman } from "../shared/replay";
import { get, post } from "./useOps";

type Action = { clearanceType: string; label: string };

export function useOperator(id: string | null, held: boolean, refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [actions, setActions] = useState<Action[]>([]);

  useEffect(() => {
    setResult(null);
    setActions([]);
  }, [id]);

  useEffect(() => {
    if (!id || !held) return;
    let stopped = false;
    const load = () =>
      get<{ actions: Action[] }>(`/api/ops/flights/${encodeURIComponent(id)}/actions`)
        .then((r) => !stopped && setActions(r.actions))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, held]);

  useEffect(() => {
    if (!result?.ok) return;
    const timer = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(timer);
  }, [result]);

  const send = async (verb: "takeover" | "handback" | "instruct" | "accept", body?: OperatorInstruction | { steps: string[] }, done = "") => {
    if (!id || busy) return;
    setBusy(true);
    const res = await post(`/api/ops/flights/${encodeURIComponent(id)}/${verb}`, body);
    setBusy(false);
    setResult({ ok: res.ok, text: res.ok ? (res.message ?? done) : (res.message ?? "The validator refused this.") });
    refresh();
  };

  return { busy, result, actions, send };
}

type Operator = ReturnType<typeof useOperator>;

export function TakeOverKey({ flight, operator }: { flight: FlightSummary; operator: Operator }) {
  if (flight.attention === "human_control") {
    return (
      <button className="btn btn-invert btn-wide" disabled={operator.busy} onClick={() => void operator.send("handback", undefined, "The agent has control again.")}>
        <b>hand back</b>
        <span>to agent</span>
      </button>
    );
  }
  return (
    <button
      className={`btn btn-wide ${needsHuman(flight.attention) ? "btn-invert" : "btn-red"}`}
      disabled={operator.busy}
      onClick={() => void operator.send("takeover", undefined, "You have control.")}
    >
      <b>take over</b>
      <span>choose yourself</span>
    </button>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * When a flight needs a person: what is wrong, where it is, how long there is,
 * what to do, what is true right now, and the radio between the agent and the
 * plane. Accepting sends exactly the steps shown; reasons are on hover.
 */
export function NeedsYou({ flight, operator, heldAlerts, messages }: {
  flight: FlightSummary; operator: Operator; heldAlerts: number; messages: Message[];
}) {
  const b = flight.brief;
  if (!b) return null;
  const held = flight.attention === "human_control";
  const { busy, send, result } = operator;
  const urgent = b.deadline !== null && b.deadline.inS < 45;
  const n = b.recommend.length;
  return (
    <section className={`ask ${held ? "ask-held" : ""}`} aria-label={`${flight.callsign} needs you`}>
      <div className="ask-top">
        <div className="ask-what">
          <small>{held ? `You are handling ${flight.callsign}` : `${flight.callsign} needs you`}</small>
          <h3>{b.problem}</h3>
          <p>{b.context}</p>
        </div>
        {b.deadline && (
          <div className={`ask-clock ${urgent ? "ask-urgent" : ""}`}>
            <b>{mmss(b.deadline.inS)}</b>
            <span>to decide, or {b.deadline.then}</span>
          </div>
        )}
      </div>

      <div className="ask-now">
        <small>Happening now</small>
        <ul>{b.now.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>

      {(n > 0 || !held) && (
        <div className="ask-do">
          <small>{held ? "Still to do" : "What the agent suggests"}</small>
          {n > 0 ? (
            <ol>{b.recommend.map((r) => <li key={r.clearanceType} title={`Why: ${r.why}`}>{r.label}</li>)}</ol>
          ) : b.agentDoing ? (
            <p className="ask-wait">Nothing right now. The agent is already {b.agentDoing.text}. Watch, or take over if you disagree.</p>
          ) : (
            <p>There is no single answer. Take over and choose.</p>
          )}
          <div className="ask-keys">
            {n > 0 && (
              <button className="ask-yes" disabled={busy} onClick={() => void send("accept", { steps: b.recommend.map((r) => r.clearanceType) }, "Done.")}>
                <b>{held ? (n > 1 ? "Send both" : "Send it") : n > 1 ? "Take over and send both" : "Take over and send it"}</b>
                <span>{n > 1 ? "Both calls" : "This call"} go out now, in your name</span>
              </button>
            )}
            {!held && (
              <button className={n || b.agentDoing ? "ask-no" : "ask-yes"} disabled={busy} onClick={() => void send("takeover", undefined, `You have ${flight.callsign}.`)}>
                <b>{n ? "Take over, send nothing" : "Take over"}</b>
                <span>{b.agentDoing?.cancelledByTakeover ? "Cancels the agent's call. You choose" : "You choose what to say"}</span>
              </button>
            )}
          </div>
          {!held && (
            <p className="ask-note">
              {n ? "Either button gives you" : "Taking over gives you"} control of {flight.callsign}. The agent stops talking to it until you hand it back.
            </p>
          )}
        </div>
      )}

      {result && !result.ok && <p className="ask-refused" role="status">Not sent: {result.text}</p>}

      {held && (
        <div className="ask-back">
          <p>{b.onHandback}</p>
          <button disabled={busy} onClick={() => void send("handback", undefined, "The agent has it.")}>Hand back to agent</button>
        </div>
      )}
      {held && heldAlerts > 0 && <p className="ask-quiet">{heldAlerts} routine alert{heldAlerts > 1 ? "s" : ""} paused until you hand back.</p>}

      <RadioLog callsign={flight.callsign} messages={messages} />
    </section>
  );
}

/** Everything said between the agent, the plane and you, newest at the bottom. */
function RadioLog({ callsign, messages }: { callsign: string; messages: Message[] }) {
  const box = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (box.current && pinned.current) box.current.scrollTop = box.current.scrollHeight;
  }, [messages.length]);
  const said = messages.filter((m) => m.decision?.verdict !== "rejected" || m.from === "pilot");
  return (
    <div className="ask-radio">
      <small>Radio log, agent and {callsign} <span>{said.length} message{said.length === 1 ? "" : "s"}, scroll for earlier</span></small>
      <ol
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
        }}
      >
        {said.length === 0 && <li className="ask-radio-empty">Nothing said yet.</li>}
        {said.map((m) => {
          const who = m.from === "pilot" ? "pilot" : m.from === "operator" ? "you" : "agent";
          const name = who === "pilot" ? callsign : who === "you" ? "You" : `Agent (${m.speaker})`;
          const audio = m.audioUrl?.startsWith("/") && !m.audioUrl.startsWith("//") ? m.audioUrl : undefined;
          return (
            <li key={m.id} className={`ask-msg ask-msg-${who}`}>
              <div>
                <time>{clock(m.t)}</time>
                <b>{name}</b>
                {audio && <button onClick={() => void new Audio(audio).play().catch(() => undefined)}>play</button>}
              </div>
              <p title={m.decision?.reason ? `Why: ${m.decision.reason}` : undefined}>{m.text}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function OperatorPanel({ flight, operator }: { flight: FlightSummary; operator: Operator }) {
  const [reason, setReason] = useState("");
  const { result, actions, busy, send } = operator;
  const held = flight.attention === "human_control";
  if (!held && !result) return null;
  return (
    <div className="instruct">
      {result && !flight.brief && <p className={`instruct-result ${result.ok ? "" : "instruct-refused"}`} role="status">{result.ok ? "" : "not sent: "}{result.text}</p>}
      {held && (
        <details className="instruct-more">
          <summary>Other instructions</summary>
          <label className="instruct-reason">
            <span>reason</span>
            <input value={reason} maxLength={160} placeholder="optional: say why" onChange={(e) => setReason(e.currentTarget.value)} />
          </label>
          <div className="instruct-actions">
            {actions.length === 0 && <span className="instruct-none">No valid instruction for this flight right now.</span>}
            {actions.map((a) => (
              <button
                key={a.clearanceType + a.label}
                disabled={busy}
                onClick={() => void send("instruct", { clearanceType: a.clearanceType, reason: reason.trim() || "operator decision" }, `Sent: ${a.label}`)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
