import { useEffect, useState } from "react";
import type { CockpitState, Exchange, Fault, Stage } from "@towerai/contracts";
import type { AirportData } from "@towerai/core";
import { get } from "../ops/useOps";
import { Flight3D } from "./Flight3D";
import { useCockpit } from "./useCockpit";
import "./cockpit.css";

type Pilot = ReturnType<typeof useCockpit>;

const FAULTS: [Fault, string][] = [["engine_failure", "engine failure"], ["smoke", "smoke"], ["low_fuel", "low fuel"]];
const VERDICT = { confirmed: "The data confirms it", contradicted: "The data says otherwise", unverified: "The data can't verify it" };
const STAGES: [Stage, string][] = [["check_in", "check in"], ["pushback", "push back"], ["taxi", "taxi"], ["cross", "cross"], ["takeoff", "take off"], ["climb", "climb"]];
const LOW_FUEL_MIN = 30;
const WEAK_ENGINE_PCT = 15;

const red = (on: boolean) => (on ? "ck-red" : undefined);
const seconds = (ms: number) => (ms < 10 ? "<0.01" : (ms / 1000).toFixed(2));

/** The aircraft fills the screen. Over it: where you are, what the tower said, and the one thing to say next. */
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

  return (
    <div className="ck">
      <div className="ck-world">{airport && <Flight3D airport={airport} state={state} />}</div>
      <Progress state={state} />
      <div className="ck-over">
        <Situation state={state} />
        <Tower last={exchanges.at(-1)} thinking={phase === "thinking"} sent={pilot.sent} />
      </div>
      {pilot.lost && <p className="ck-lost">Link to the tower lost. Reconnecting.</p>}
      <Dock pilot={pilot} state={state} />
      <Foot pilot={pilot} state={state} attribution={airport?.attribution} />
    </div>
  );
}

function Progress({ state }: { state: CockpitState }) {
  const at = STAGES.findIndex(([stage]) => stage === state.stage);
  return (
    <header className="ck-top">
      <p className={state.humanCalled ? "ck-id ck-red" : "ck-id"}>
        <b>{state.callsign}</b>
        <span>you are the pilot</span>
      </p>
      <ol className="ck-steps">
        {STAGES.map(([stage, name], i) => (
          <li key={stage} data-step={i < at ? "done" : i === at ? "now" : "next"} aria-current={i === at ? "step" : undefined}>
            <i>{i + 1}</i>
            {name}
          </li>
        ))}
      </ol>
      <p className="ck-time" data-fast={state.speed > 1 || undefined}>
        <b>{state.speed}&times;</b>
        {state.speed > 1 ? "sped up" : "real time"}
      </p>
    </header>
  );
}

function Situation({ state }: { state: CockpitState }) {
  const v = state.vitals;
  const [left, right] = v.engines;
  // Both off at the stand is normal. One down, or any down in the air, is not.
  const failed = (pct: number, other: number) => pct < WEAK_ENGINE_PCT && (!v.onGround || other >= WEAK_ENGINE_PCT);
  return (
    <section className="ck-where">
      <small>
        {state.humanCalled && <strong>responders alerted</strong>}
        {state.status}
      </small>
      <p>{state.coach.now}</p>
      <dl>
        <Reading label="altitude" value={Math.max(0, Math.round(v.altFt)).toLocaleString("en")} unit="ft" />
        <Reading label="speed" value={String(Math.round(v.gsKt))} unit="kt" />
        <Reading label="engines" value={`${Math.round(left)} / ${Math.round(right)}`} unit="%" alert={failed(left, right) || failed(right, left)} />
        {v.smoke ? <Reading label="smoke" value="YES" alert /> : <Reading label="fuel" value={String(Math.round(v.fuelMin))} unit="min" alert={v.fuelMin < LOW_FUEL_MIN} />}
      </dl>
    </section>
  );
}

function Reading({ label, value, unit, alert = false }: { label: string; value: string; unit?: string; alert?: boolean }) {
  return (
    <div className={red(alert)}>
      <dt>{label}</dt>
      <dd>
        {value}
        {unit && <i>{unit}</i>}
      </dd>
    </div>
  );
}

/** Only the latest exchange. Nothing is here until someone has spoken. */
function Tower({ last, thinking, sent }: { last?: Exchange; thinking: boolean; sent: string | null }) {
  if (thinking) {
    return (
      <section className="ck-tower" aria-live="polite">
        {sent && <p className="ck-heard"><small>you said</small>{sent}</p>}
        <p className="ck-said"><small>tower</small>Checking your aircraft...</p>
      </section>
    );
  }
  if (!last) return null;
  const t = last.timings;
  const parts = [
    ["hear", t.transcribeMs],
    ["think", t.decide.ms],
    // A phrase said before comes from the cache. That is not how fast the voice is made.
    [t.voice?.source.startsWith("cached") ? "speak, cached" : "speak", t.voice?.ms],
  ] as const;
  const { check, action } = last;
  return (
    <section className="ck-tower" aria-live="polite" data-check={!!check || undefined} key={last.id}>
      {last.heard && <p className="ck-heard"><small>you said</small>{last.heard}</p>}
      <p className="ck-said" data-long={!!check || last.said.length > 130 || undefined}><small>tower</small>{last.said}</p>
      {check && (
        <div className="ck-check" data-verdict={check.verdict}>
          <p>
            <b>{VERDICT[check.verdict]}</b>
            <small>{check.evidence.filter((row) => row.agrees).length} of {check.evidence.length} readings match &ldquo;{check.claim}&rdquo;</small>
          </p>
          <ul>
            {check.evidence.map((row, i) => (
              <li key={i} data-agrees={row.agrees}>
                <span>{row.label}</span>
                <b>{row.value}</b>
                <em>{row.agrees ? "matches" : "differs"}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ck-proof">
        <p>
          <em>{last.brain}</em>
          {action && <em className={red(action.verdict === "rejected")}>{action.type.replaceAll("_", " ").toLowerCase()} {action.verdict}</em>}
          <span>{last.reason}</span>
        </p>
        <dl>
          <div className="ck-total">
            <dt>answered in</dt>
            <dd>{seconds(t.totalMs)}<i>s</i></dd>
          </div>
          {parts.map(([name, ms]) => ms !== undefined && (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{Math.round(ms)}<i>ms</i></dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** The talk key and the one thing to say next, big enough to read aloud from. */
function Dock({ pilot, state }: { pilot: Pilot; state: CockpitState }) {
  const { mic, phase, canTalk, press, release } = pilot;
  const [title, hint] =
    !canTalk ? ["voice is off", "start with npm run judge:talk"]
    : phase === "listening" ? ["listening", "let go when done"]
    : phase === "thinking" ? ["thinking", "checking your aircraft"]
    : phase === "speaking" ? ["speaking", "hold space to interrupt"]
    : mic === "asking" ? ["allow mic", "in the browser prompt"]
    : mic === "blocked" ? ["mic blocked", "allow it in the address bar"]
    : ["hold space", "and speak"];
  const [first, ...more] = state.coach.trySaying;
  const words = state.waiting ? (state.readBack ?? first) : undefined;
  const label =
    phase === "listening" ? "listening: say it, then let go of space"
    : state.readBack ? "hold space and read it back out loud"
    : "hold space and say it out loud";
  const also = words ? more.slice(0, 1) : state.coach.trySaying.slice(0, 2);

  return (
    <div className="ck-dock">
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
        <span className="ck-wave" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>
        <b>{title}</b>
        <span className="ck-hint" aria-live="polite">{hint}</span>
      </button>
      {/* Words to read aloud. Pressing them does nothing: the tower answers to a voice. */}
      {words && phase !== "thinking" ? (
        <p className="ck-cue" data-listening={phase === "listening" || undefined} data-long={words.length > 40 || undefined}>
          <small>{label}</small>
          <b>&ldquo;{words}&rdquo;</b>
        </p>
      ) : (
        <p className="ck-helps">
          <small>what TowerAI is doing</small>
          {phase === "thinking" ? "Checking what you said against your aircraft." : state.helps}
        </p>
      )}
      {also.length > 0 && (
        <div className="ck-alts">
          {also.map((line, i) => (
            <p className="ck-also" key={line}>
              {i === 0 && <small>or say</small>}
              <span>&ldquo;{line}&rdquo;</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function TypeLine({ pilot, placeholder }: { pilot: Pilot; placeholder: string }) {
  const { canTalk, mic, say } = pilot;
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        say(text);
        setText("");
        // Give space back to the talk key.
        if (canTalk && mic !== "blocked") (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      <input
        value={text}
        maxLength={300}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        placeholder={placeholder}
        aria-label="Type to the tower"
        autoFocus
      />
    </form>
  );
}

function Foot({ pilot, state, attribution }: { pilot: Pilot; state: CockpitState; attribution?: string }) {
  const { canTalk, note, command } = pilot;
  const [typing, setTyping] = useState(false);
  return (
    <footer className="ck-foot">
      {typing && <TypeLine pilot={pilot} placeholder="type to the tower, then return" />}
      <p className={note ? "ck-note ck-red" : "ck-note"}>
        {note || `${canTalk ? "Voice is transcribed by ElevenLabs, not stored by TowerAI." : "Voice is off in this copy. Nothing is sent to ElevenLabs."}${attribution ? ` Map ${attribution}` : ""}`}
      </p>
      <button aria-pressed={typing} onClick={() => setTyping(!typing)}>keyboard backup</button>
      {FAULTS.map(([fault, label]) => {
        const on = state.faults.includes(fault);
        return (
          <button key={fault} aria-pressed={on} onClick={() => void command("/api/cockpit/fault", { fault, on: !on })}>
            {label}
          </button>
        );
      })}
      <button className="ck-reset" onClick={() => void command("/api/cockpit/reset")}>reset</button>
    </footer>
  );
}
