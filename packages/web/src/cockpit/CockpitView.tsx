import { useEffect, useRef, useState } from "react";
import type { CockpitState, Exchange, Fault } from "@towerai/contracts";
import type { AirportData } from "@towerai/core";
import { get } from "../ops/useOps";
import { Windscreen } from "./Windscreen";
import { useCockpit } from "./useCockpit";
import "./cockpit.css";

const FAULTS: [Fault, string][] = [["engine_failure", "engine failure"], ["smoke", "smoke"], ["low_fuel", "low fuel"]];
const VERDICT = { confirmed: "The data confirms it", contradicted: "The data says otherwise", unverified: "The data can't verify it" };
const LOW_FUEL_MIN = 30;
const WEAK_ENGINE_PCT = 15;

const red = (on: boolean) => (on ? "ck-red" : undefined);
const seconds = (ms: number) => (ms < 10 ? "<0.01" : (ms / 1000).toFixed(2));

export default function CockpitView() {
  const pilot = useCockpit();
  const { state, exchanges, phase } = pilot;
  const [airport, setAirport] = useState<AirportData | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const load = () => {
      get<AirportData>("/api/airport")
        .then((data) => !stopped && setAirport(data))
        .catch(() => !stopped && (retry = setTimeout(load, 1500)));
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, []);

  if (!state) return <p className="wait">{pilot.lost ? "The pilot's seat is not answering. Trying again." : "loading"}</p>;
  const last = exchanges.at(-1);

  return (
    <div className="ck">
      <section className="ck-seat">
        <header className={state.humanCalled ? "ck-who ck-alarm" : "ck-who"}>
          <div className="ck-you">
            <small>you are the pilot of</small>
            <b>{state.callsign}</b>
            <span>{state.spokenCallsign}, {state.type}</span>
          </div>
          <div className="ck-now">
            <small>
              {state.humanCalled && <strong>responders alerted</strong>}
              {state.status}
            </small>
            <p>{state.coach.now}</p>
          </div>
        </header>

        <div className="ck-window">
          {airport && <Windscreen airport={airport} state={state} />}
          {pilot.lost && <p className="ck-lost">Link to the tower lost. Reconnecting.</p>}
          {airport?.attribution && <small className="ck-credit">schematic view {airport.attribution}</small>}
          {state.readBack && phase !== "thinking" && (
            <div className="ck-readback" data-long={state.readBack.length > 70 || undefined}>
              <small>your turn: {pilot.canTalk ? "hold space and read this back" : "type this back"}</small>
              <p>{state.readBack}</p>
            </div>
          )}
        </div>

        <Instruments state={state} />
        <Radio pilot={pilot} state={state} />
      </section>

      <section className="ck-tower">
        <Latency last={last} thinking={phase === "thinking"} />
        <Check last={last} thinking={phase === "thinking"} />
        <Conversation canTalk={pilot.canTalk} exchanges={exchanges} thinking={phase === "thinking"} sent={pilot.sent} />
        <footer className="ck-presenter">
          <small>presenter</small>
          {FAULTS.map(([fault, label]) => {
            const on = state.faults.includes(fault);
            return (
              <button key={fault} aria-pressed={on} onClick={() => void pilot.command("/api/cockpit/fault", { fault, on: !on })}>
                {label}
              </button>
            );
          })}
          <button className="ck-reset" onClick={() => void pilot.command("/api/cockpit/reset")}>reset</button>
        </footer>
      </section>
    </div>
  );
}

function Instruments({ state: { vitals: v } }: { state: CockpitState }) {
  const [left, right] = v.engines;
  // Both off at the stand is normal. One down, or any down in the air, is not.
  const failed = (pct: number, other: number) => pct < WEAK_ENGINE_PCT && (!v.onGround || other >= WEAK_ENGINE_PCT);
  return (
    <dl className="ck-dials">
      <Dial label="altitude" value={Math.max(0, Math.round(v.altFt)).toLocaleString("en")} unit="ft" />
      <Dial label="speed" value={String(Math.round(v.gsKt))} unit="kt" />
      <Dial label="climb" value={`${v.vsFpm > 0 ? "+" : ""}${Math.round(v.vsFpm)}`} unit="fpm" />
      <Dial label="left engine" value={String(Math.round(left))} unit="%" fill={left} alert={failed(left, right)} />
      <Dial label="right engine" value={String(Math.round(right))} unit="%" fill={right} alert={failed(right, left)} />
      <Dial label="fuel" value={String(Math.round(v.fuelMin))} unit="min" alert={v.fuelMin < LOW_FUEL_MIN} />
      <Dial label="smoke" value={v.smoke ? "YES" : "none"} alert={v.smoke} />
      <Dial label="gear" value={v.gearDown ? "down" : "up"} />
    </dl>
  );
}

/** `fill` is a percentage, for the readings that have one. */
function Dial({ label, value, unit, fill, alert = false }: { label: string; value: string; unit?: string; fill?: number; alert?: boolean }) {
  return (
    <div className={red(alert)}>
      <dt>{label}</dt>
      <dd>
        {value}
        {unit && <i>{unit}</i>}
      </dd>
      {fill !== undefined && <dd className="ck-gauge" aria-hidden="true"><s style={{ width: `${Math.min(100, Math.max(0, fill))}%` }} /></dd>}
    </div>
  );
}

function Radio({ pilot, state }: { pilot: ReturnType<typeof useCockpit>; state: CockpitState }) {
  const { mic, phase, note, canTalk, press, release, say } = pilot;
  const [text, setText] = useState("");
  const typeOnly = !canTalk || mic === "blocked";

  const [title, line] =
    phase === "listening" ? ["listening", "let go when done"]
    : phase === "thinking" ? ["thinking", "reading your aircraft"]
    : phase === "speaking" ? ["speaking", canTalk ? "press to interrupt" : "type to interrupt"]
    : mic === "asking" ? ["allow mic", "in the browser prompt"]
    : !canTalk ? ["type instead", "speech is not available"]
    : mic === "blocked" ? ["allow mic", "or type instead"]
    : ["hold to talk", mic === "ready" ? "mic ready. space, or hold here" : "space. first press asks for the mic"];

  return (
    <div className="ck-radio">
      <button
        className="ck-key"
        data-phase={phase}
        disabled={!canTalk}
        onPointerDown={(e) => {
          if (e.button) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          (document.activeElement as HTMLElement | null)?.blur();
          void press();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="ck-wave" aria-hidden="true">{Array.from({ length: 11 }, (_, i) => <i key={i} />)}</span>
        <b>{title}</b>
        <span className="ck-hint" aria-live="polite">{line}</span>
      </button>
      <div className="ck-say">
        <div className="ck-try">
          <small>{typeOnly ? "press one, or type" : "try saying"}</small>
          {state.coach.trySaying.slice(0, 3).map((words) => (
            <button key={words} title={words} onClick={() => say(words)}>&ldquo;{words}&rdquo;</button>
          ))}
        </div>
        <form
          className="ck-type"
          onSubmit={(e) => {
            e.preventDefault();
            say(text);
            setText("");
            // Give space back to the talk key.
            if (!typeOnly) (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <input
            value={text}
            maxLength={300}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
            placeholder={typeOnly ? "Type to the tower, in your own words" : "or type to the tower"}
            aria-label="Type to the tower"
          />
          <button disabled={!text.trim()}>send</button>
        </form>
        <p className={note ? "ck-note ck-red" : "ck-note"}>
          {note || (canTalk ? "Your voice is sent to ElevenLabs to transcribe and is not stored by TowerAI." : "Typed input. Nothing is sent to ElevenLabs.")}
        </p>
      </div>
    </div>
  );
}

function Latency({ last, thinking }: { last?: Exchange; thinking: boolean }) {
  const t = thinking ? undefined : last?.timings;
  const parts = [
    ["hear", t?.transcribeMs],
    ["think", t?.decide.ms, t?.decide.kind],
    // A phrase said before comes from the cache. That is not how fast the voice is made.
    [t?.voice?.source.startsWith("cached") ? "speak, cached" : "speak", t?.voice?.ms, t?.voice?.kind],
  ] as const;
  return (
    <dl className="ck-latency">
      <div className="ck-total">
        <dt>{t ? "answered in" : thinking ? "answering" : "time to answer"}</dt>
        <dd>{t ? seconds(t.totalMs) : thinking ? "..." : "-"}{t && <i>s</i>}</dd>
      </div>
      {parts.map(([name, ms, kind]) => (
        <div key={name.split(",")[0]}>
          <dt>{name}{kind === "modelled" && ", modelled"}</dt>
          <dd>{ms === undefined ? "-" : Math.round(ms)}{ms !== undefined && <i>ms</i>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Check({ last, thinking }: { last?: Exchange; thinking: boolean }) {
  const check = thinking ? null : last?.check;
  if (!check) {
    const looked = thinking ? [] : (last?.looked ?? []);
    return (
      <div className="ck-check ck-check-idle">
        <h2>{thinking ? "checking what you said against the aircraft" : looked.length ? "what the tower looked at on your last call" : "the tower checks what you say against the aircraft"}</h2>
        {looked.length ? (
          <ul>{looked.slice(0, 6).map((fact, i) => <li key={i}>{fact}</li>)}</ul>
        ) : (
          !thinking && <p>Say &ldquo;we&rsquo;re crashing!&rdquo; and see what it finds.</p>
        )}
      </div>
    );
  }
  const agree = check.evidence.filter((row) => row.agrees).length;
  return (
    <div className={`ck-check ck-check-${check.verdict}`} key={last!.id}>
      <div className="ck-finding">
        <div className="ck-claim">
          <small>you reported</small>
          <p>{check.claim}</p>
        </div>
        <div className="ck-verdict">
          <small>{agree} of {check.evidence.length} {check.evidence.length === 1 ? "reading matches" : "readings match"}</small>
          <p>{VERDICT[check.verdict]}</p>
          {last!.callsHuman && <span>responders alerted</span>}
        </div>
      </div>
      <ul className="ck-evidence">
        {check.evidence.map((row, i) => (
          <li key={i} data-agrees={row.agrees}>
            <small>{row.label}</small>
            <b>{row.value}</b>
            <em>{row.agrees ? "matches" : "differs"}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Conversation({ canTalk, exchanges, thinking, sent }: { canTalk: boolean; exchanges: Exchange[]; thinking: boolean; sent: string | null }) {
  const list = useRef<HTMLOListElement>(null);
  const newest = exchanges.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest, exchanges.length, thinking, sent]);
  useEffect(() => {
    // The newest line stays in view when the check above it grows.
    const el = list.current!;
    const keep = new ResizeObserver(() => (el.scrollTop = el.scrollHeight));
    keep.observe(el);
    return () => keep.disconnect();
  }, []);

  return (
    <ol className="ck-talk" ref={list}>
      {!exchanges.length && !thinking && <li className="ck-empty">
          <b>No experience needed.</b>
          <p><i>1</i>{canTalk ? "Hold space and talk normally." : "Type, or press a suggestion."}</p>
          <p><i>2</i>The tower tells you what to do.</p>
          <p><i>3</i>Read it back. Your plane moves.</p>
        </li>}
      {exchanges.map((x) => (
        <li key={x.id}>
          {x.heard && <p className="ck-heard"><small>you{x.input === "typed" && ", typed"}</small>{x.heard}</p>}
          <p className="ck-said"><small>tower</small>{x.said}</p>
          <p className="ck-why">
            <em>{x.brain}</em>
            {x.action && (
              <em className={red(x.action.verdict === "rejected")}>
                {x.action.type.replaceAll("_", " ")} {x.action.verdict}
                {x.action.blockedBy && `: ${x.action.blockedBy}`}
              </em>
            )}
            <span>{x.reason}</span>
          </p>
        </li>
      ))}
      {thinking && (
        <li>
          {sent && <p className="ck-heard"><small>you, typed</small>{sent}</p>}
          <p className="ck-said"><small>tower</small>...</p>
        </li>
      )}
    </ol>
  );
}
