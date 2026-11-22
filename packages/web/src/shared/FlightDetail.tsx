import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FlightRecord, Marker, Message } from "@towerai/contracts";
import {
  ATTENTION_WORDS, altitude, clock, facts, flightAt, indexAt, isBlocked, isRefusal, millis, minimumWords, needsHuman, replyDelay,
  respondersAt, separationAt, separationMargin, tooClose,
} from "./replay";
import "./FlightDetail.css";

export interface FlightDetailProps {
  record: FlightRecord;
  /** The moment being shown. */
  t: number;
  /** The newest moment that can be shown. */
  endT: number;
  /** True while t follows the newest moment. */
  live: boolean;
  playing: boolean;
  onSeek(t: number): void;
  onPlay(playing: boolean): void;
  onLive?(): void;
  onClose(): void;
  closeLabel?: string;
  formatTime?(t: number): string;
  nameOf?(flightId: string): string;
  /** The action beside what the flight needs, for example take over. */
  action?: ReactNode;
  /** A band under that, for example the operator's controls. */
  controls?: ReactNode;
  /** When a person is needed: replaces the status band and the numbers with what to do. */
  briefing?: ReactNode;
}

/** CLEAR_TO_LAND reads "clear to land". */
const plain = (code?: string) => code?.replaceAll("_", " ").toLowerCase();
/** The validator leads with a code; the sentence after it is what people read. */
const withoutCode = (text?: string) => text?.replace(/^[A-Z]+(?:_[A-Z]+)+: /, "");
/** Radio time is simulated. A long gap is the flight waiting for a runway or a gap, not a slow reply. */
const afterWait = (s: number) => `response ${s > 15 ? Math.round(s) : s.toFixed(1)} s sim`;
/** Rules decide at once; a recording's figure is when it was made, not now. */
const timingWords = (m: Message, x: Message["timings"][number]) =>
  x.stage === "decide"
    ? `${m.from === "pilot" ? "reaction" : `${m.brain} decide`} ${millis(x.ms)} ${x.kind}`
    : `voice first byte ${millis(x.ms)} ${x.kind}${x.source.includes("cache") ? ", replay" : ""}`;
const safeAudio = (url?: string) => (url?.startsWith("/") && !url.startsWith("//") ? url : undefined);

export function FlightDetail({
  record, t, endT, live, playing, onSeek, onPlay, onLive, onClose,
  closeLabel = "all flights", formatTime = clock, nameOf = (id) => id, action, controls, briefing,
}: FlightDetailProps) {
  const now = flightAt(record, t);
  // While live the server's summary is newer than the last recorded step.
  const flight = live ? record.summary : now;
  const human = needsHuman(flight.attention);
  const held = flight.attention === "human_control";
  const sep = separationAt(record, t);
  const heard = record.messages.filter((m) => m.t <= t);
  const lastReply = (from: Message["from"]) => [...heard].reverse().find((m) => m.from === from && replyDelay(m, record.messages) !== null);
  const responders = respondersAt(record, t);

  return (
    <article className={`fd ${human ? "fd-human" : ""} ${held ? "fd-held" : ""}`}>
      <header className="fd-head">
        <button className="btn fd-back" onClick={onClose} aria-label={closeLabel}>
          <b aria-hidden>←</b>
          <span>{closeLabel}</span>
        </button>
        <div className="fd-id">
          <h2>{flight.callsign}</h2>
          <p>{[flight.airline, flight.type, `${flight.origin} → ${flight.destination}`].filter(Boolean).join("  /  ")}</p>
        </div>
        <div className="fd-who">
          <b>{flight.status}</b>
          <p>{held ? "human operator" : flight.facility}</p>
        </div>
      </header>

      {briefing ?? <section className="fd-need">
        <div>
          <small>{live ? "" : "then / "}{ATTENTION_WORDS[flight.attention]}</small>
          <strong>{flight.need ?? (held ? "The agent will not act on this flight." : "Nothing needed right now")}</strong>
          <p>
            risk {Math.round(flight.risk.score)} {flight.risk.level}
            {flight.risk.reasons.length > 0 && `: ${flight.risk.reasons.join(", ")}`}
          </p>
        </div>
        {action}
      </section>}
      {responders && (
        <p className="fd-responders">
          <i /><i /><i />
          <b>responders</b>
          <span>{responders}</span>
        </p>
      )}
      {controls}

      {!briefing && <dl className="fd-stats">
        <Stat label="altitude" value={altitude(flight.altFt)} note={Math.abs(flight.vsFpm) >= 100 ? `${flight.vsFpm > 0 ? "up" : "down"} ${Math.abs(Math.round(flight.vsFpm / 50) * 50)} fpm` : "level"} />
        <Stat label="speed" value={`${Math.round(flight.gsKt)} kt`} note={`heading ${String(Math.round(flight.hdg) % 360).padStart(3, "0")}`} />
        <Stat
          label={sep ? `to ${nameOf(sep.otherFlightId)}` : "separation"}
          value={sep ? `${sep.lateralNm.toFixed(1)} nm ${Math.round(Math.abs(sep.verticalFt))} ft` : "–"}
          note={sep ? minimumWords(sep) : "no close traffic"}
          margin={sep?.requiredNm ? separationMargin(sep) : undefined}
          alarm={!!sep && tooClose(sep)}
          title={sep ? `Required: ${sep.requiredNm} nm or ${sep.requiredFt} ft` : undefined}
        />
        <Response label="controller response" message={lastReply("controller")} all={record.messages} />
        <Response label="pilot response" message={lastReply("pilot")} all={record.messages} />
      </dl>}

      {!briefing && <Conversation record={record} t={t} onSeek={onSeek} formatTime={formatTime} />}
      <Scrubber {...{ record, t, endT, live, playing, onSeek, onPlay, onLive, formatTime }} />
    </article>
  );
}

function Stat({ label, value, note, alarm, title, margin }: {
  label: string; value: string; note: string; alarm?: boolean; title?: string; margin?: number;
}) {
  return (
    <div className={alarm ? "fd-alarm" : ""} title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <dd className="fd-note">{note}</dd>
      {margin !== undefined && (
        <i className="fd-margin" aria-label={`${margin.toFixed(1)} times the minimum`}>
          <i style={{ width: `${Math.min(1, margin / 3) * 100}%` }} />
        </i>
      )}
    </div>
  );
}

/** Response is one thing in both acts: from the end of the call to being on air. */
function Response({ label, message: m, all }: { label: string; message?: Message; all: Message[] }) {
  if (!m) return <Stat label={label} value="–" note="none yet" />;
  const s = replyDelay(m, all)!;
  const decide = m.timings.find((x) => x.stage === "decide");
  const note = decide && m.from !== "pilot" ? `${m.brain} decide ${millis(decide.ms)}` : "to on air, sim";
  const title = ["From the end of the call to being on air, in simulated time.", ...m.timings.map((x) => `${timingWords(m, x)}: ${x.source}`)].join("\n");
  return <Stat label={label} value={`${s > 15 ? Math.round(s) : s.toFixed(1)} s`} note={note} title={title} />;
}

type Entry = { t: number; message: Message } | { t: number; marker: Marker };

function Conversation({ record, t, onSeek, formatTime }: Pick<FlightDetailProps, "record" | "t" | "onSeek"> & { formatTime(t: number): string }) {
  const [opened, setOpened] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Follow the newest entry, but never push the start of it out of sight.
  const newestTop = (el: HTMLDivElement) => {
    const last = el.firstElementChild?.lastElementChild as HTMLElement | null;
    return Math.min(el.scrollHeight - el.clientHeight, last?.offsetTop ?? Infinity);
  };

  const entries: Entry[] = [
    ...record.markers.map((marker) => ({ t: marker.t, marker })),
    ...record.messages.map((message) => ({ t: message.t, message })),
  ].sort((a, b) => a.t - b.t);
  const shown = entries.slice(0, indexAt(entries, t, (e) => e.t) + 1);
  const newest = [...shown].reverse().find((e) => "message" in e && e.message.decision?.verdict === "accepted" && e.message.kind !== "advisory");
  const newestDecision = newest && "message" in newest ? newest.message.id : null;

  useLayoutEffect(() => {
    if (box.current && atBottom.current) box.current.scrollTop = newestTop(box.current);
  });

  return (
    <div
      className="fd-talk"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollTop >= newestTop(el) - 24;
      }}
    >
      <div className="fd-talk-in">
        {shown.length === 0 && <p className="fd-empty">No radio contact {record.messages.length ? "yet at this point" : "yet"}.</p>}
        {shown.map((entry) =>
          "marker" in entry ? (
            <button
              key={`${entry.marker.kind}${entry.t}${entry.marker.label}${entry.marker.otherFlightId ?? ""}`}
              className={`fd-event fd-event-${entry.marker.kind}`}
              onClick={() => onSeek(entry.t)}
            >
              <time>{formatTime(entry.t)}</time>
              <b>{entry.marker.kind}</b>
              <span>{entry.marker.label}</span>
            </button>
          ) : (
            <Line
              key={entry.message.id}
              message={entry.message}
              all={record.messages}
              onAir={!isBlocked(entry.message) && t < entry.t + entry.message.durationS}
              open={opened === entry.message.id || newestDecision === entry.message.id}
              onOpen={() => {
                atBottom.current = false;
                setOpened(opened === entry.message.id ? null : entry.message.id);
              }}
              onSeek={() => {
                atBottom.current = true;
                onSeek(entry.t);
              }}
              time={formatTime(entry.t)}
            />
          ),
        )}
      </div>
    </div>
  );
}

function Line({ message: m, all, onAir, open, onOpen, onSeek, time }: {
  message: Message; all: Message[]; onAir: boolean; open: boolean; onOpen(): void; onSeek(): void; time: string;
}) {
  const blocked = isBlocked(m);
  const decision = m.decision;
  const refused = isRefusal(m);
  const audio = blocked ? undefined : safeAudio(m.audioUrl);
  const reply = blocked ? null : replyDelay(m, all);
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => player.current?.pause(), []);

  return (
    <div className={`fd-line fd-${m.from} ${blocked ? "fd-blocked" : refused ? "fd-refused" : ""} ${onAir ? "fd-onair" : ""}`}>
      <button className="fd-time" onClick={onSeek} title="Replay from here">
        <time>{time}</time>
        <span>{onAir ? "on air" : ""}</span>
      </button>
      <div className="fd-body">
        <div className="fd-meta">
          <b>{blocked ? "blocked by validator" : m.speaker}</b>
          <span>{m.brain}</span>
          {blocked ? <span>not transmitted</span> : m.kind !== "info" && <span>{m.kind}</span>}
          {audio && (
            <button
              className="fd-link"
              onClick={() => {
                player.current ??= new Audio(audio);
                player.current.currentTime = 0;
                void player.current.play().catch(() => undefined);
              }}
            >
              play audio
            </button>
          )}
          {decision && !blocked && (
            <button className="fd-link" onClick={onOpen} aria-expanded={open}>why</button>
          )}
        </div>
        {blocked && <strong className="fd-reason">{withoutCode(decision?.blockedBy) ?? "The validator refused this action."}</strong>}
        {refused && <strong className="fd-reason">requested action blocked: {withoutCode(decision?.blockedBy) ?? "refused by the validator"}</strong>}
        <p className="fd-words">{blocked ? `Proposed: ${plain(decision?.action) || m.text}` : m.text}</p>
        {decision && (open || blocked) && (
          <dl className="fd-why">
            <dt>why</dt>
            <dd>{blocked ? withoutCode(decision.blockedBy) : decision.reason}</dd>
            {blocked && (
              <>
                <dt>proposed</dt>
                <dd>{decision.reason}</dd>
              </>
            )}
            {decision.context.length > 0 && (
              <>
                <dt>looked at</dt>
                <dd>{facts(decision.context, 4).join(", ")}</dd>
              </>
            )}
            {!blocked && !refused && m.kind === "clearance" && (
              <>
                <dt>validator</dt>
                <dd>accepted {plain(decision.action)}</dd>
              </>
            )}
          </dl>
        )}
        {(m.timings.length > 0 || reply !== null) && (
          <p className="fd-times">
            {m.timings.map((x, i) => (
              <span key={i} title={x.source}>
                <i className={`fd-mark ${x.kind === "measured" ? "fd-measured" : ""}`} />
                {timingWords(m, x)}
              </span>
            ))}
            {reply !== null && <span>{afterWait(reply)}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

const ALARM_MARKERS = new Set(["conflict", "emergency", "escalation"]);

function Scrubber({ record, t, endT, live, playing, onSeek, onPlay, onLive, formatTime }:
  Pick<FlightDetailProps, "record" | "t" | "endT" | "live" | "playing" | "onSeek" | "onPlay" | "onLive"> & { formatTime(t: number): string }) {
  const start = record.startT;
  const span = Math.max(1, endT - start);
  const at = (x: number): CSSProperties => ({ left: `${Math.min(100, Math.max(0, ((x - start) / span) * 100))}%` });

  return (
    <footer className={`fd-scrub ${live ? "" : "fd-replaying"}`}>
      <button
        className="btn"
        onClick={() => {
          if (!playing && t >= endT - 0.5) onSeek(start);
          onPlay(!playing);
        }}
      >
        <i className={playing ? "fd-pause" : "fd-play"} />
        <span>{playing ? "hold" : "replay"}</span>
      </button>
      <div className="fd-track">
        <div className="fd-track-words">
          <span>{formatTime(start)}</span>
          <b>{live ? "now" : "replay"} {formatTime(t)}</b>
          <span>{formatTime(endT)}</span>
        </div>
        <div className="fd-rail">
          <em style={{ width: at(t).left }} />
          {record.messages.map((m) => (
            <i key={m.id} className={`fd-tick ${isBlocked(m) ? "fd-tick-alarm" : ""}`} style={at(m.t)} />
          ))}
          {record.markers.map((m, i) => (
            <i key={i} className={`fd-tick fd-tick-event ${ALARM_MARKERS.has(m.kind) ? "fd-tick-alarm" : ""}`} style={at(m.t)} title={`${formatTime(m.t)} ${m.kind}: ${m.label}`} />
          ))}
          <input
            type="range"
            aria-label="Replay position"
            min={start}
            max={Math.max(start + 1, endT)}
            step={0.1}
            value={Math.min(t, endT)}
            onChange={(e) => onSeek(Number(e.currentTarget.value))}
          />
        </div>
      </div>
      {onLive && (
        <button className={`btn ${live ? "btn-on" : "btn-red"}`} onClick={onLive} disabled={live}>
          <b>{live ? "live" : "go live"}</b>
          <span>{live ? "following" : "return"}</span>
        </button>
      )}
    </footer>
  );
}
