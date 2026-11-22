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

/** "fire + rescue: standing by 01:45 (simulated)" reads "Fire and rescue are standing by, since 01:45 (simulated)." */
const respondersWords = (label: string) => {
  const m = /^(fire \+ rescue|paramedics):\s*(alerted|standing by)\D*(\d\d:\d\d)/.exec(label);
  if (!m) return label;
  const who = m[1] === "paramedics" ? "Paramedics" : "Fire and rescue";
  return m[2] === "alerted" ? `${who} alerted at ${m[3]} (simulated).` : `${who} are standing by, since ${m[3]} (simulated).`;
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * When a flight needs a person: what is wrong, where it is, how long there is,
 * what to do, what is true right now, and the radio between the agent and the
 * plane. Accepting sends exactly the steps shown; reasons are on hover.
 */
export function NeedsYou({ flight, operator, heldAlerts, messages, responders }: {
  flight: FlightSummary; operator: Operator; heldAlerts: number; messages: Message[]; responders: string | null;
}) {
  const [view, setView] = useState<"brief" | "radio">("brief");
  const b = flight.brief;
  if (!b) return null;
  const held = flight.attention === "human_control";
  const { busy, send, result } = operator;
  const urgent = b.deadline !== null && b.deadline.inS < 45;
  const n = b.recommend.length;
  const said = heard(messages);
  return (
    <section className={`ask ${held ? "ask-held" : ""} ${view === "radio" ? "ask-radio-mode" : ""}`} aria-label={`${flight.callsign} needs you`}>
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

      <div className="ask-tabs" role="tablist">
        <button role="tab" aria-selected={view === "brief"} onClick={() => setView("brief")}>{held ? "Your flight" : "What to do"}</button>
        <button role="tab" aria-selected={view === "radio"} onClick={() => setView("radio")}>Radio log <span>{said.length}</span></button>
      </div>

      {view === "brief" && <>
      {(b.approach || b.around) && (
        <div className="ask-around">
          {b.approach && <ApproachLine callsign={flight.callsign} approach={b.approach} />}
          {b.around && <p><small>Around it</small>{b.around}</p>}
        </div>
      )}

      <div className="ask-now">
        <small>Happening now</small>
        <ul>
          {b.now.map((line) => <li key={line}>{line}</li>)}
          {responders && <li className="ask-responders">{respondersWords(responders)}</li>}
        </ul>
      </div>

      {(n > 0 || !held) && (
        <div className="ask-do">
          <small>{held ? "Still to do" : "What the agent suggests"}</small>
          {n > 0 ? (
            <ol>{b.recommend.map((r) => <li key={r.clearanceType} title={`Why: ${r.why}`}>{r.label}</li>)}</ol>
          ) : b.agentDoing ? (
            <p className="ask-wait">Nothing right now. {b.agentDoing.text} Watch, or take over if you disagree.</p>
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

      {result && <p className={result.ok ? "ask-sofar" : "ask-refused"} role="status">{result.ok ? "" : "Not sent: "}{result.text}</p>}

      {held && (
        <div className="ask-back">
          <p>{b.onHandback}</p>
          <button disabled={busy} onClick={() => void send("handback", undefined, "The agent has it.")}>Hand back to agent</button>
        </div>
      )}
      {held && heldAlerts > 0 && <p className="ask-quiet">{heldAlerts} routine alert{heldAlerts > 1 ? "s" : ""} paused until you hand back.</p>}

      {b.story.length > 0 && (
        <div className="ask-story">
          <small>How we got here</small>
          <ol>
            {b.story.map((x) => (
              <li key={`${x.t}${x.text}`}><time>{clock(x.t)}</time><span>{x.text}</span></li>
            ))}
          </ol>
        </div>
      )}

      <RadioLog callsign={flight.callsign} said={said} preview onOpen={() => setView("radio")} />
      </>}

      {view === "radio" && <RadioLog callsign={flight.callsign} said={said} />}
    </section>
  );
}

/** The way in, drawn to scale: the plane, the others landing on that runway, the abort point and the runway. */
function ApproachLine({ callsign, approach }: { callsign: string; approach: NonNullable<NonNullable<FlightSummary["brief"]>["approach"]> }) {
  const W = 400, L = 14, R = 352;
  const span = Math.max(4, Math.ceil(Math.max(approach.miles, ...approach.others.map((o) => o.miles)) * 1.08));
  const x = (miles: number) => R - (Math.min(miles, span) / span) * (R - L);
  const abort = x(approach.decisionNm);
  return (
    <svg className="ask-line" viewBox={`0 0 ${W} 58`} role="img"
      aria-label={`${callsign} is ${approach.miles} miles from runway ${approach.runway}. It aborts the landing at ${approach.decisionNm} mile without a clearance.`}>
      <line x1={L} x2={R} y1={30} y2={30} className="ask-line-path" />
      <rect x={R} y={25} width={W - R - 6} height={10} className="ask-line-runway" />
      <text x={W - 6} y={50} textAnchor="end" className="ask-line-note">runway {approach.runway}</text>
      <line x1={abort} x2={abort} y1={20} y2={40} className="ask-line-abort" />
      <text x={abort - 4} y={16} textAnchor="end" className="ask-line-note ask-line-red">abort point</text>
      {approach.others.map((o) => (
        <g key={o.callsign}>
          <circle cx={x(o.miles)} cy={30} r={4} className="ask-line-other" />
          <text x={x(o.miles)} y={16} textAnchor="middle" className="ask-line-note">{o.callsign}</text>
        </g>
      ))}
      <path d={`M ${x(approach.miles) + 7} 30 L ${x(approach.miles) - 6} 23 L ${x(approach.miles) - 6} 37 Z`} className="ask-line-me" />
      <text x={x(approach.miles)} y={14} textAnchor="middle" className="ask-line-label">{callsign}</text>
      <text x={x(approach.miles)} y={52} textAnchor="middle" className="ask-line-note">{approach.miles.toFixed(1)} mi</text>
    </svg>
  );
}

/** What actually went out on the radio: refused proposals were never said. */
const heard = (messages: Message[]) => messages.filter((m) => m.decision?.verdict !== "rejected" || m.from === "pilot");

/**
 * Everything said between the agent, the plane and you, newest at the bottom.
 * As a preview it shows the last two lines and a way to the full log; in full
 * it takes the whole panel, follows new lines, and offers a jump back down.
 */
function RadioLog({ callsign, said, preview, onOpen }: { callsign: string; said: Message[]; preview?: boolean; onOpen?(): void }) {
  const box = useRef<HTMLOListElement>(null);
  const [pinned, setPinned] = useState(true);
  useLayoutEffect(() => {
    if (box.current && pinned) box.current.scrollTop = box.current.scrollHeight;
  }, [said.length, pinned]);
  const shown = preview ? said.slice(-2) : said;
  return (
    <div className={`ask-radio ${preview ? "ask-radio-preview" : "ask-radio-full"}`}>
      <div className="ask-radio-head">
        <small>{preview ? "Latest on the radio" : `Radio log, agent and ${callsign}`}</small>
        {preview && said.length > 0 && <button onClick={onOpen}>See all {said.length} messages</button>}
      </div>
      <ol
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
        }}
      >
        {shown.length === 0 && <li className="ask-radio-empty">Nothing said yet.</li>}
        {shown.map((m) => {
          const who = m.from === "pilot" ? "pilot" : m.from === "operator" ? "you" : "agent";
          const name = who === "pilot" ? `${callsign} (pilot)` : who === "you" ? "You" : `Agent, ${m.speaker}`;
          const audio = m.audioUrl?.startsWith("/") && !m.audioUrl.startsWith("//") ? m.audioUrl : undefined;
          return (
            <li key={m.id} className={`ask-msg ask-msg-${who}`}>
              <div>
                <time>{clock(m.t)}</time>
                <b>{name}</b>
                {audio && <button onClick={() => void new Audio(audio).play().catch(() => undefined)}>play</button>}
              </div>
              <p>{m.text}</p>
              {!preview && m.decision?.reason && who !== "pilot" && <p className="ask-msg-why">Why: {m.decision.reason}</p>}
            </li>
          );
        })}
      </ol>
      {!preview && !pinned && (
        <button className="ask-radio-jump" onClick={() => setPinned(true)}>Jump to newest</button>
      )}
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
