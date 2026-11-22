import { useEffect, useRef, useState } from "react";
import type { CockpitState, Exchange, Fault } from "@towerai/contracts";
import type { AirportData } from "@towerai/core";
import { get } from "../ops/useOps";
import { Windscreen } from "./Windscreen";
import { useCockpit } from "./useCockpit";
import "./cockpit.css";

const FAULTS: [Fault, string][] = [["engine_failure", "engine failure"], ["smoke", "smoke"], ["low_fuel", "low fuel"]];
const VERDICT = { confirmed: "confirmed by the data", contradicted: "the data says otherwise", unverified: "cannot be verified" };
const LOW_FUEL_MIN = 30;
const WEAK_ENGINE_PCT = 15;

const red = (on: boolean) => (on ? "ck-red" : undefined);
const seconds = (ms: number) => (ms / 1000).toFixed(2);

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
        <header className={state.humanCalled ? "ck-who ck-red" : "ck-who"}>
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
      <div><dt>{v.onGround ? "on the ground" : "altitude ft"}</dt><dd>{Math.max(0, Math.round(v.altFt)).toLocaleString("en")}</dd></div>
      <div><dt>speed kt</dt><dd>{Math.round(v.gsKt)}</dd></div>
      <div><dt>climb ft/min</dt><dd>{v.vsFpm > 0 ? "+" : ""}{Math.round(v.vsFpm)}</dd></div>
      <div className={red(failed(left, right))}><dt>left engine</dt><dd>{Math.round(left)}%</dd></div>
      <div className={red(failed(right, left))}><dt>right engine</dt><dd>{Math.round(right)}%</dd></div>
      <div className={red(v.fuelMin < LOW_FUEL_MIN)}><dt>fuel min</dt><dd>{Math.round(v.fuelMin)}</dd></div>
      <div className={red(v.smoke)}><dt>smoke</dt><dd>{v.smoke ? "YES" : "none"}</dd></div>
      <div><dt>gear</dt><dd>{v.gearDown ? "down" : "up"}</dd></div>
    </dl>
  );
}

function Radio({ pilot, state }: { pilot: ReturnType<typeof useCockpit>; state: CockpitState }) {
  const { mic, phase, note, canTalk, press, release, say } = pilot;
  const [text, setText] = useState("");
  const typeOnly = !canTalk || mic === "blocked";

  const [title, line] =
    phase === "listening" ? ["listening", "let go when done"]
    : phase === "thinking" ? ["thinking", "reading your aircraft"]
    : phase === "speaking" ? ["tower speaking", canTalk ? "press to interrupt" : "type to interrupt"]
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
        <b>{title}</b>
        <span aria-live="polite">{line}</span>
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
      {parts.map(([name, ms, kind]) => (
        <div key={name.split(",")[0]}>
          <dt>{name}{kind === "modelled" && ", modelled"}</dt>
          <dd>{ms === undefined ? "-" : Math.round(ms)}{ms !== undefined && <i>ms</i>}</dd>
        </div>
      ))}
      <div className="ck-total">
        <dt>{t ? "answered in" : thinking ? "answering" : "time to answer"}</dt>
        <dd>{t ? seconds(t.totalMs) : thinking ? "..." : "-"}{t && <i>s</i>}</dd>
      </div>
    </dl>
  );
}

function Check({ last, thinking }: { last?: Exchange; thinking: boolean }) {
  const check = thinking ? null : last?.check;
  if (!check) {
    const looked = thinking ? [] : (last?.looked ?? []);
    return (
      <div className="ck-check ck-check-idle">
        <h2>{thinking ? "checking what you said against the aircraft" : "the tower checks what you say against the aircraft"}</h2>
        {looked.length ? (
          <ul>{looked.slice(0, 6).map((fact, i) => <li key={i}>{fact}</li>)}</ul>
        ) : (
          !thinking && <p>Say &ldquo;we&rsquo;re crashing!&rdquo; and see what it finds.</p>
        )}
      </div>
    );
  }
  return (
    <div className={`ck-check ck-check-${check.verdict}`} key={last!.id}>
      <div className="ck-claim">
        <small>you claimed</small>
        <p>{check.claim}</p>
      </div>
      <table>
        <thead>
          <tr><th>the tower checked</th><th>aircraft data</th><th>matches you</th></tr>
        </thead>
        <tbody>
          {check.evidence.map((row, i) => (
            <tr key={i} className={row.agrees ? undefined : "ck-differs"}>
              <td>{row.label}</td>
              <td>{row.value}</td>
              <td>{row.agrees ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ck-verdict">
        {VERDICT[check.verdict]}
        {last!.callsHuman && <span>responders alerted</span>}
      </p>
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
