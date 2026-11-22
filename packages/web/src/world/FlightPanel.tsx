import type { ControlPosition, FlightRecord, Message, Timing } from "@towerai/contracts";
import { useEffect, useMemo, useRef } from "react";
import {
  ATTENTION_WORD,
  activeAt,
  altText,
  clockText,
  decideOf,
  median,
  msText,
  needsPerson,
  poseAt,
  nearestAt,
  stateAt,
  upTo,
  type WorldIndex,
} from "./data";
import { facts, isBlocked, isRefusal, minimumWords, replyDelay, tooClose } from "../shared/replay";

const CHAIN: ControlPosition[] = ["ground", "tower", "departure", "enroute", "approach"];

const brainWord = { llm: "llm", rules: "rules", human: "human" };
/** Response is one thing in both acts: from the end of the call to being on air. */
const gapText = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const DIVERSION = /\b(returning|diverting) ([A-Z]{4})\b/;

interface Props {
  f: FlightRecord;
  epochMs: number;
  t: number;
  index: WorldIndex;
  onSeek(t: number): void;
  position: string;
  onClose(): void;
  onStep(by: number): void;
  onPlay(m: Message): void;
}

export function FlightPanel({ f, index, epochMs, t, onSeek, position, onClose, onStep, onPlay }: Props) {
  const s = f.summary;
  const at = Math.min(f.endT, Math.max(f.startT, t));
  const pose = poseAt(f, at);
  const state = stateAt(f, at);
  const active = activeAt(f, t);
  const red = active && needsPerson(state);
  const sep = active ? nearestAt(index, f, t) : undefined;
  const nameOf = (id: string) => index.byId.get(id)?.summary.callsign ?? id;
  let turned: RegExpExecArray | null = null;
  for (const step of f.riskSeries) if (step.t <= at) turned = DIVERSION.exec(step.status) ?? turned;
  const breach = sep && tooClose(sep);
  const now = upTo(f.messages, t, (m) => m.t);

  return (
    <section className="wv-flight" aria-label={`Flight ${s.callsign}`}>
      <header className="wv-flight-top">
        <div className="who">
          <h2>{s.callsign}</h2>
          <p>
            <b>
              {s.origin} <span>→</span> {s.destination}
              {turned && <em>, {turned[1]} {turned[2]}</em>}
            </b>
            <small>
              {s.airline}, {s.type}
            </small>
          </p>
        </div>
        <span className={`wv-state ${red ? "red" : ""} ${state.attention}`}>
          {active ? ATTENTION_WORD[state.attention] : t < f.startT ? "not started" : "complete"}
        </span>
        <div className="nav">
          <button className="wv-key" onClick={() => onStep(-1)} aria-label="Previous flight">
            ←
          </button>
          <small>{position}</small>
          <button className="wv-key" onClick={() => onStep(1)} aria-label="Next flight">
            →
          </button>
          <button className="wv-key dark" onClick={onClose}>
            all flights
          </button>
        </div>
      </header>

      <div className="wv-now">
        <div className="words">
          <b>{state.status}</b>
          <small>{state.facility}</small>
        </div>
        <ol className="chain" aria-label="Control position">
          {CHAIN.map((p) => (
            <li key={p} className={p === state.position ? "on" : ""}>
              {p === "enroute" ? "en-route" : p}
            </li>
          ))}
        </ol>
      </div>

      <dl className="wv-telemetry">
        <div>
          <dt>altitude</dt>
          <dd>{altText(pose.altFt)}</dd>
        </div>
        <div>
          <dt>ground speed</dt>
          <dd>
            {Math.round(pose.gsKt)}
            <u>kt</u>
          </dd>
        </div>
        <div>
          <dt>heading</dt>
          <dd>
            {String(Math.round(pose.hdg) % 360).padStart(3, "0")}
            <u>°</u>
          </dd>
        </div>
        <div>
          <dt>vertical</dt>
          <dd>
            {pose.vsFpm > 50 ? "+" : ""}
            {Math.abs(pose.vsFpm) > 50 ? Math.round(pose.vsFpm / 50) * 50 : 0}
            <u>fpm</u>
          </dd>
        </div>
        <div className={breach ? "red" : ""}>
          <dt>{sep ? `to ${nameOf(sep.otherFlightId)}, ${minimumWords(sep)}` : "nearest traffic"}</dt>
          <dd>
            {sep ? (
              <>
                {sep.lateralNm.toFixed(1)}
                <u>nm</u> {Math.round(Math.abs(sep.verticalFt))}
                <u>ft</u>
              </>
            ) : (
              "none close"
            )}
          </dd>
        </div>
      </dl>

      {active && state.need && (
        <div className={`wv-need ${red ? "red" : ""}`}>
          <small>pilot needs</small>
          <b>{state.need}</b>
        </div>
      )}

      <div className="wv-detail">
        <Conversation f={f} epochMs={epochMs} t={t} now={now} onSeek={onSeek} onPlay={onPlay} />
        <div className="wv-why">
          <Decision f={f} now={now} t={at} score={state.risk.score} reasons={state.risk.reasons} />
          <Latency f={f} now={now} />
        </div>
      </div>
    </section>
  );
}

function Conversation({
  f,
  epochMs,
  t,
  now,
  onSeek,
  onPlay,
}: {
  f: FlightRecord;
  epochMs: number;
  t: number;
  now: number;
  onSeek(t: number): void;
  onPlay(m: Message): void;
}) {
  const list = useRef<HTMLOListElement>(null);
  // Radio and events are one story, in the order it happened.
  const entries = useMemo(
    () =>
      [
        ...f.markers.map((marker) => ({ t: marker.t, marker, message: undefined })),
        ...f.messages.map((message, i) => ({ t: message.t, message: { ...message, i }, marker: undefined })),
      ].sort((a, b) => a.t - b.t),
    [f],
  );
  const reached = upTo(entries, t, (e) => e.t);
  useEffect(() => {
    const box = list.current;
    if (!box) return;
    const line = box.children[Math.max(0, reached)] as HTMLElement | undefined;
    if (!line) return;
    // Moves this list only; scrollIntoView would drag the page with it.
    box.scrollTop = line.offsetTop - Math.max(0, (box.clientHeight - line.offsetHeight) * 0.6);
  }, [reached]);

  return (
    <div className="wv-talk">
      <h3>
        radio <span>{f.messages.length ? `${now + 1} of ${f.messages.length}` : "silent"}</span>
      </h3>
      <ol ref={list}>
        {entries.map(({ message: m, marker }, n) => {
          if (!m)
            return (
              <li key={`event${n}`} className={`event ${marker!.kind} ${n > reached ? "later" : ""}`}>
                <button onClick={() => onSeek(marker!.t + 0.01)}>
                  <b>{marker!.kind}</b>
                  <span>{marker!.label}</span>
                  <time>{clockText(epochMs, marker!.t)}</time>
                </button>
              </li>
            );
          const { i } = m;
          const ms = decideOf(m);
          const gap = replyDelay(m, f.messages);
          const blocked = isBlocked(m);
          const refusal = isRefusal(m);
          return (
            <li key={m.id} className={`${i === now ? "now" : i > now ? "later" : ""} ${blocked ? "blocked" : ""}`}>
              <button
                onClick={() => {
                  onSeek(m.t + 0.01);
                  onPlay(m);
                }}
              >
                <span className="meta">
                  <i className={`voice ${m.from}`} />
                  <em>{m.speaker}</em>
                  {blocked && <strong>not transmitted</strong>}
                  {refusal && <strong>request blocked</strong>}
                  {!blocked && !refusal && (m.kind === "emergency" || m.kind === "escalation") && <strong>{m.kind}</strong>}
                  <time>{clockText(epochMs, m.t)}</time>
                </span>
                <span className="text">{m.text || m.decision?.action.replaceAll("_", " ")}</span>
                {refusal && <span className="refused">requested action blocked: {m.decision?.blockedBy}</span>}
                <span className="prov">
                  <span>{brainWord[m.brain]}</span>
                  {ms !== undefined && <span>decide {msText(ms)} measured</span>}
                  {gap !== null && <span>response {gapText(gap)} sim</span>}
                  {m.audioUrl && <span>voice recorded</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Decision({ f, now, t, score, reasons }: { f: FlightRecord; now: number; t: number; score: number; reasons: string[] }) {
  let m: Message | undefined;
  for (let i = now; i >= 0 && !m; i--) if (f.messages[i]?.decision) m = f.messages[i];
  const d = m?.decision;
  const last = f.markers.filter((x) => x.t <= t && x.kind !== "handoff" && x.kind !== "weather").at(-1);
  return (
    <div className="wv-decision">
      <h3>
        decision {m && <span>by {brainWord[m.brain]}</span>}
        {d && (
          <b className={`verdict ${d.verdict}`}>{d.verdict === "accepted" ? "validated" : isBlocked(m!) ? "not transmitted" : "request blocked"}</b>
        )}
      </h3>
      <dl className="now">
        {last?.kind === "resolved" && (
          <div>
            <dt>outcome</dt>
            <dd>{last.label}</dd>
          </div>
        )}
        <div>
          <dt>risk now</dt>
          <dd>
            <b>{Math.round(score)}</b> {reasons[0] ?? "nothing flagged"}
          </dd>
        </div>
      </dl>
      <div className="body">
        {d ? (
          <>
            <p className="action">{d.action.replaceAll("_", " ")}</p>
            <p className="reason">{d.verdict === "rejected" && d.blockedBy ? `Blocked: ${d.blockedBy}. ${d.reason}` : d.reason}</p>
            {d.context.length > 0 && (
              <>
                <small>it looked at</small>
                <ul>
                  {facts(d.context).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="empty">No decision yet at this point of the flight.</p>
        )}
      </div>
    </div>
  );
}

function Latency({ f, now }: { f: FlightRecord; now: number }) {
  const past = f.messages.slice(0, now + 1);
  const roles = (["controller", "pilot"] as const).map((role) => {
    const answers = past.filter((m) => m.from === role && replyDelay(m, f.messages) !== null);
    // A model's own decision counts even where it was not answering a call.
    const m = past.filter((x) => x.from === role && (answers.includes(x) || decideOf(x) !== undefined)).at(-1);
    return { role, m, gap: m ? replyDelay(m, f.messages) : null, mid: median(answers.map((x) => replyDelay(x, f.messages)!)) };
  });
  const top = Math.max(2, ...roles.map((r) => r.gap ?? 0)) * 1000;

  return (
    <div className="wv-latency">
      <h3>
        response time <span>call to on air</span>
        <span className="key">
          <i className="decide" />
          decide
          <i className="voice" />
          voice
        </span>
      </h3>
      {roles.map(({ role, m, gap, mid }) => {
        const decide = m ? decideOf(m) : undefined;
        const voice: Timing | undefined = m?.timings.find((x) => x.stage === "voice");
        const rules = m?.brain === "rules";
        const width = (ms = 0) => ({ width: `${Math.min(100, (ms / top) * 100)}%` });
        return (
          <div className="lat" key={role} title={m?.timings.map((x) => `${x.stage}: ${x.source}`).join("\n")}>
            <div className="line">
              <em>
                {role}
                {mid !== null && <span>median so far {gapText(mid)}</span>}
              </em>
              <b>{gap !== null ? `${gapText(gap)} sim` : decide !== undefined ? msText(decide) : "–"}</b>
            </div>
            <div className="bar">
              {m && <i className="wait" style={width((gap ?? 0) * 1000)} />}
              <span>
                {decide !== undefined && <i className="decide" style={width(decide)} />}
                {voice && <i className="voice" style={width(voice.ms)} />}
              </span>
            </div>
            <div className="sub">
              {!m && <span>has not had to answer yet</span>}
              {decide !== undefined && <span><b>llm decide {msText(decide)}</b> measured</span>}
              {rules && <span>rules, no model wait</span>}
              {voice && <span className="gap">voice {msText(voice.ms)} {voice.kind}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
