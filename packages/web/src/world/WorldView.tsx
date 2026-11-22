import type { Marker, Message, WorldRecording } from "@towerai/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../shared/tokens.css";
import "./world.css";
import {
  ATTENTION_WORD,
  activeAt,
  clockText,
  indexWorld,
  msText,
  needsPerson,
  stateAt,
  statsAt,
  upTo,
  urgency,
  type WorldIndex,
} from "./data";
import { useSound } from "../shared/sound";
import { useSteadyOrder } from "../shared/useSteadyOrder";
import { Conversation, lineAt, openingLine, type OnAirNow } from "./conversation";
import { VoiceBar } from "./VoiceBar";
import { FlightPanel } from "./FlightPanel";
import { Profiles } from "./Profiles";
import { Track } from "./Track";
import { useClock, type Clock } from "./useClock";
import { WorldMap } from "./WorldMap";

const SPEEDS = [1, 5, 15, 60];
const STEP_MS = 300;
const SCRUB_MS = 400;
/** A moment picked just after a call began still opens on that call. */
const LEAD_S = 1;
const RED_EVENTS: Marker["kind"][] = ["conflict", "emergency", "escalation"];

export default function WorldView({ sound, onSound }: { sound: boolean; onSound?: () => void }) {
  // Without the app's switch, this screen keeps one of its own.
  const own = useSound();
  const audible = onSound ? sound : own.on && own.ready;
  const [index, setIndex] = useState<WorldIndex | null>(null);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let mounted = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch("/api/world");
        if (!res.ok) throw new Error(`/api/world answered ${res.status}`);
        const next = indexWorld((await res.json()) as WorldRecording);
        if (mounted) setIndex(next);
      } catch (e) {
        if (!mounted) return;
        setFailed(e instanceof Error ? e.message : String(e));
        retry = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      mounted = false;
      clearTimeout(retry);
    };
  }, []);

  if (index) return <World index={index} sound={audible} onSound={onSound ?? own.press} />;
  return (
    <div className="wv wv-wait" role="status">
      <b>{failed ? "waiting for the world recording" : "loading the world"}</b>
      {failed && <small>{failed}. Trying again every 3 seconds.</small>}
    </div>
  );
}

/** Opens shortly before something happens, with traffic already talking. */
function openingT({ incidents, world }: WorldIndex) {
  const early = world.durationS * 0.08;
  const first = incidents.find((m) => RED_EVENTS.includes(m.kind) && m.t >= early);
  return Math.max(0, first ? first.t - 90 : early);
}

function World({ index, sound, onSound }: { index: WorldIndex; sound: boolean; onSound(): void }) {
  const { world, flights, byId } = index;
  const start = useMemo(() => openingT(index), [index]);
  const clock = useClock(world.durationS, start);
  const t = clock.now();
  const epochMs = useMemo(() => Date.parse(world.epoch) || 0, [world]);
  const [selected, setSelected] = useState<string | null>(null);
  const [onAir, setOnAir] = useState<OnAirNow | null>(null);
  const talk = useMemo(() => new Conversation(clock, setOnAir), [clock]);
  const speedBefore = useRef(clock.speed);

  const order = flights
    .map((f) => {
      const state = stateAt(f, t);
      const when = activeAt(f, t) ? 0 : t < f.startT ? 1 : 2;
      return { f, state, when, rank: when ? 0 : urgency(state) };
    })
    .sort((a, b) => a.when - b.when || b.rank - a.rank || a.f.summary.callsign.localeCompare(b.f.summary.callsign));

  useEffect(() => talk.setSound(sound), [talk, sound]);
  useEffect(() => talk.setPaused(!clock.playing), [talk, clock.playing]);
  useEffect(() => () => talk.stop(), [talk]);

  const select = useCallback(
    (id: string | null, seekT?: number, delayMs = 0) => {
      const f = id ? byId.get(id) : undefined;
      setSelected(f ? id : null);
      if (!f) {
        talk.stop();
        if (selected) clock.setSpeed(speedBefore.current);
        return;
      }
      if (!selected) speedBefore.current = clock.speed;
      const m = seekT === undefined ? openingLine(f, clock.now()) : lineAt(f, seekT - LEAD_S);
      clock.seek(seekT ?? m?.t ?? f.startT);
      clock.setSpeed(1);
      clock.setPlaying(true);
      talk.setPaused(false);
      talk.play(f, m, delayMs);
    },
    [byId, clock, selected, talk],
  );

  const flight = selected ? byId.get(selected) : undefined;

  const seek = useCallback(
    (to: number) => {
      clock.seek(to);
      if (!flight) return;
      clock.setSpeed(1);
      talk.play(flight, lineAt(flight, to), SCRUB_MS);
    },
    [clock, flight, talk],
  );

  const playVoice = useCallback(
    (m: Message) => {
      if (!flight) return;
      clock.setPlaying(true);
      talk.setPaused(false);
      talk.play(flight, m);
    },
    [clock, flight, talk],
  );

  // Faster than speech is watched, not heard.
  const setSpeed = (speed: number) => {
    if (flight && speed === 1) talk.play(flight, lineAt(flight, clock.now()));
    else talk.stop();
    clock.setSpeed(speed);
  };

  // Unattended, the world keeps running.
  useEffect(() => {
    if (clock.playing && t >= world.durationS) {
      if (selected) clock.setPlaying(false);
      else clock.seek(start);
    }
  }, [t, clock, world.durationS, selected, start]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, select")) return;
      if (e.key === "Escape" && selected) select(null);
      else if (e.key === " " && !(e.target as Element).closest?.("button")) {
        e.preventDefault();
        clock.setPlaying(!clock.playing);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [clock, selected, select]);

  // Recording order, because urgency order moves under the playhead.
  const place = flights.findIndex((f) => f.summary.id === selected);
  const step = (by: number) => select(flights[(place + by + flights.length) % flights.length]!.summary.id, undefined, STEP_MS);

  return (
    <div className={`wv ${flight ? "open" : ""}`}>
      <Stats index={index} t={t} />
      <main className="wv-body">
        <div className="wv-stage">
          <WorldMap
            index={index}
            clock={clock}
            selected={selected}
            speaking={clock.playing && onAir?.phase === "speaking" ? onAir.message.from : null}
            onSelect={select}
          />
          {flight ? (
            <VoiceBar now={onAir} sound={sound} playing={clock.playing} onSound={onSound} />
          ) : (
            !sound && (
              <button className="wv-hear over" onClick={onSound}>
                <b>sound is off</b>
                press, then click any plane to hear it
              </button>
            )
          )}
          {flight ? (
            <Profiles f={flight} index={index} t={t} onSeek={seek} />
          ) : (
            <OnAir index={index} t={t} onSelect={select} />
          )}
        </div>
        {flight ? (
          <FlightPanel
            key={flight.summary.id}
            f={flight}
            epochMs={epochMs}
            t={t}
            index={index}
            onSeek={seek}
            position={`${place + 1} / ${flights.length}`}
            onClose={() => select(null)}
            onStep={step}
            onPlay={playVoice}
            speakingId={onAir && onAir.phase !== "ended" ? onAir.message.id : undefined}
          />
        ) : (
          <Roster order={order} epochMs={epochMs} onSelect={select} />
        )}
      </main>
      <Transport index={index} clock={clock} t={t} epochMs={epochMs} selected={selected} onSeek={seek} onSpeed={setSpeed} onSelect={select} />
    </div>
  );
}

function Stats({ index, t }: { index: WorldIndex; t: number }) {
  const s = statsAt(index, t);
  const cells = [
    { name: "aircraft in the air", value: s.airborne.toLocaleString("en"), sub: "worldwide, synthetic" },
    { name: "flights handled", value: s.handled, sub: `of ${index.flights.length}, by agents` },
    { name: "active conversations", value: s.talking, sub: `${s.transmissions.toLocaleString("en")} transmissions` },
    { name: "conflicts resolved", value: s.resolved, sub: `of ${s.conflicts} predicted` },
    { name: "losses of separation", value: s.losses, sub: "below both minima", red: s.losses > 0 },
    { name: "escalated to a person", value: s.escalations, sub: "agent or pilot asked" },
    { name: "llm decide time", value: msText(s.decideMs), sub: s.decisions ? `median, n=${s.decisions}, measured` : "none yet" },
  ];
  return (
    <dl className="wv-stats" aria-label="Totals at the playhead">
      {cells.map((c) => (
        <div key={c.name} className={c.red ? "red" : ""}>
          <dt>{c.name}</dt>
          <dd>{c.value}</dd>
          <small>{c.sub}</small>
        </div>
      ))}
    </dl>
  );
}

function OnAir({ index, t, onSelect }: { index: WorldIndex; t: number; onSelect(id: string, seekT: number): void }) {
  const i = upTo(index.onAir, t, (e) => e.m.t);
  const recent = index.onAir.slice(Math.max(0, i - 2), i + 1);
  return (
    <div className="wv-air">
      <h3>on air worldwide</h3>
      <ol>
        {recent.map(({ flightId, m }, n) => (
          <li key={m.id} className={n === recent.length - 1 ? "now" : ""}>
            <button onClick={() => onSelect(flightId, m.t)}>
              <em>
                <i className={`voice ${m.from}`} />
                {m.speaker}
              </em>
              <span>{m.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

interface Listed {
  f: WorldIndex["flights"][number];
  state: ReturnType<typeof stateAt>;
  when: number;
}

function Roster({ order, epochMs, onSelect }: { order: Listed[]; epochMs: number; onSelect(id: string): void }) {
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const { shown: steady, hold } = useSteadyOrder(order, (o) => o.f.summary.id);
  const flagged = steady.filter((o) => !o.when && o.state.attention !== "none");
  const calling = flagged.filter((o) => needsPerson(o.state)).length;
  const q = query.trim().toLowerCase();
  const shown = (attentionOnly && !q ? flagged : steady).filter(
    ({ f: { summary: s }, state }) =>
      !q ||
      [s.callsign, s.airline, s.origin, s.destination, s.type, state.facility, state.status]
        .join(" ")
        .toLowerCase()
        .includes(q),
  );

  return (
    <aside className="wv-roster" aria-label="Flights">
      <div className="wv-find">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="find flight, airport"
          aria-label="Find a flight"
        />
        <div className="filter">
          <button className={`wv-key ${attentionOnly ? "" : "dark"}`} onClick={() => setAttentionOnly(false)}>
            all <b>{order.length}</b>
          </button>
          <button className={`wv-key ${attentionOnly ? "dark" : ""}`} onClick={() => setAttentionOnly(true)}>
            attention <b className={calling ? "count red" : "count"}>{flagged.length}</b>
          </button>
        </div>
      </div>
      <ul {...hold}>
        {shown.map(({ f, state, when }) => {
          const s = f.summary;
          const red = !when && needsPerson(state);
          return (
            <li key={s.id}>
              <button
                className={`row ${red ? "red" : ""} ${when ? "off" : state.attention}`}
                title={`${s.origin} to ${s.destination}${when ? "" : `, ${ATTENTION_WORD[state.attention]}`}`}
                onClick={() => onSelect(s.id)}
              >
                <b>{s.callsign}</b>
                <span className={`score ${state.risk.level}`}>
                  {when ? (
                    <i className="route">{s.destination}</i>
                  ) : (
                    <>
                      {Math.round(state.risk.score)}
                      <i className="meter">
                        {[1, 2, 3, 4].map((n) => <i key={n} className={n <= STEPS[state.risk.level] ? "lit" : ""} />)}
                      </i>
                    </>
                  )}
                </span>
                <span className="status">
                  {when === 1
                    ? `starts ${clockText(epochMs, f.startT)}`
                    : when === 2
                      ? "complete"
                      : state.need && red
                        ? state.need
                        : state.status}
                </span>
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="empty">{q ? "no flight matches" : "nothing needs attention right now"}</li>}
      </ul>
    </aside>
  );
}

const BINS = 180;
const STEPS = { normal: 1, watch: 2, high: 3, critical: 4 };

function Transport({
  index,
  clock,
  t,
  epochMs,
  selected,
  onSeek,
  onSpeed,
  onSelect,
}: {
  index: WorldIndex;
  clock: Clock;
  t: number;
  epochMs: number;
  selected: string | null;
  onSeek(t: number): void;
  onSpeed(speed: number): void;
  onSelect(id: string, seekT: number): void;
}) {
  const { world, incidents, onAir, byId } = index;
  const [sources, setSources] = useState(false);
  const activity = useMemo(() => {
    const bins = new Array<number>(BINS).fill(0);
    for (const { m } of onAir) {
      const i = Math.min(BINS - 1, Math.max(0, Math.floor((m.t / world.durationS) * BINS)));
      bins[i]!++;
    }
    const top = Math.max(1, ...bins);
    return bins.map((n, i) => (n ? `M${i},24h.7v${-Math.max(1.5, (n / top) * 22)}h-.7z` : "")).join("");
  }, [onAir, world.durationS]);
  const pct = (at: number) => `${(at / world.durationS) * 100}%`;
  const named = (id: string) => byId.get(id)!.summary.callsign;
  const recent = incidents[upTo(incidents, t, (m) => m.t)];
  const life = selected ? byId.get(selected) : undefined;
  const p = world.provenance;

  return (
    <footer className="wv-transport">
      <button
        className="wv-key play"
        onClick={() => clock.setPlaying(!clock.playing)}
        aria-label={clock.playing ? "Pause" : "Play"}
      >
        <i className={clock.playing ? "pause" : "go"} />
        <small>{clock.playing ? "pause" : "play"}</small>
      </button>
      <div className="when">
        <b>{clockText(epochMs, t)}</b>
        <small>replay, utc</small>
      </div>
      <div className="line">
        <div className="caption">
          {recent ? (
            <button onClick={() => onSelect(recent.flightId, recent.t)}>
              <i className={`mark ${recent.kind} ${RED_EVENTS.includes(recent.kind) ? "red" : ""}`} />
              <time>{clockText(epochMs, recent.t)}</time> <b>{named(recent.flightId)}</b> {recent.label}
            </button>
          ) : (
            <span>no incidents yet</span>
          )}
          <p className="key" aria-hidden>
            <i className="mark red" />
            incident
            <i className="mark resolved" />
            resolved
            <i className="mark weather" />
            weather
            <i className="mark closure" />
            closure
          </p>
        </div>
        <Track from={0} to={world.durationS} t={t} label="World playback" onSeek={onSeek} className="wv-global">
          <svg viewBox={`0 0 ${BINS} 24`} preserveAspectRatio="none" aria-hidden>
            <path d={activity} className="future" />
            <path d={activity} className="past" style={{ clipPath: `inset(0 ${100 - (t / world.durationS) * 100}% 0 0)` }} />
          </svg>
          {life && <i className="life" style={{ left: pct(life.startT), width: pct(life.endT - life.startT) }} />}
          {incidents.map((m, i) => (
            <button
              key={i}
              className={`mark ${m.kind} ${RED_EVENTS.includes(m.kind) ? "red" : ""}`}
              style={{ left: pct(m.t) }}
              title={`${clockText(epochMs, m.t)} ${named(m.flightId)} ${m.label}`}
              aria-label={`${named(m.flightId)} ${m.label}`}
              onClick={() => onSelect(m.flightId, m.t)}
            />
          ))}
        </Track>
      </div>
      <div className="speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`wv-key ${clock.speed === s ? "dark" : ""}`}
            aria-pressed={clock.speed === s}
            onClick={() => onSpeed(s)}
          >
            {s}×
          </button>
        ))}
        <button className="wv-sources-key" aria-expanded={sources} onClick={() => setSources(!sources)}>
          simulated world, sources
        </button>
      </div>
      {sources && (
        <div className="wv-sources">
          <h3>
            what is real here
            <button className="wv-key" onClick={() => setSources(false)}>
              close
            </button>
          </h3>
          <dl>
            {(
              [
                ["traffic", p.traffic],
                ["separation", p.separation],
                ["performance", p.performance],
                ["latency", p.latency],
              ] as const
            ).map(([name, text]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{text}</dd>
              </div>
            ))}
            <div>
              <dt>credits</dt>
              <dd>{[...p.attribution, "Map: Natural Earth via world-atlas"].join(". ")}</dd>
            </div>
            <div>
              <dt>recording</dt>
              <dd>
                seed {world.seed}, generated {world.generatedAt}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </footer>
  );
}
