import type { FlightSummary } from "@towerai/contracts";
import { ATTENTION_WORDS, needsHuman } from "../shared/replay";
import { useSteadyOrder } from "../shared/useSteadyOrder";

const MIN_BOXES = 9;
/** Past this many the boxes go four across, so the whole airport stays on one screen. */
const DENSE_PAST = 12;
/** Four rows of four. The quietest of any more fold into one row of callsigns. */
const MOST_BOXES = 16;
const STEPS = { normal: 1, watch: 2, high: 3, critical: 4 };

/** Nothing to say beyond "the agent has it". */
const quiet = (f: FlightSummary) => f.attention === "none" && f.risk.level === "normal" && !f.need;

function boxClass(f: FlightSummary) {
  if (needsHuman(f.attention)) return "box box-human";
  if (f.attention === "human_control") return "box box-held";
  if (f.risk.level === "high" || f.risk.level === "critical") return "box box-risk";
  return f.attention === "monitor" || f.risk.level === "watch" ? "box box-watch" : "box";
}

export function FlightGrid({ flights, onSelect }: { flights: FlightSummary[]; onSelect(id: string): void }) {
  const { shown, hold } = useSteadyOrder(flights, (f) => f.id);
  const boxed = new Set(flights.slice(0, MOST_BOXES).map((f) => f.id));
  const boxes = shown.filter((f) => boxed.has(f.id));
  const folded = shown.filter((f) => !boxed.has(f.id));
  const dense = boxes.length > DENSE_PAST;
  const columns = dense ? 4 : 3;
  const empty = Math.max(MIN_BOXES - boxes.length, (columns - (boxes.length % columns)) % columns);
  const rows = Math.ceil((boxes.length + empty) / columns);
  return (
    <div className="fleet" {...hold}>
    <div className={`grid ${dense ? "grid-dense" : boxes.length <= MIN_BOXES ? "grid-roomy" : ""}`} style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {boxes.map((f) => (
        <button key={f.id} className={boxClass(f)} onClick={() => onSelect(f.id)}>
          <span className="box-top">
            <b>{f.callsign}</b>
            <span className="box-risk-value" title={f.risk.reasons.join(", ")}>
              <span>{Math.round(f.risk.score)}</span>
              <i className="meter">
                {[1, 2, 3, 4].map((n) => <i key={n} className={n <= STEPS[f.risk.level] ? "meter-on" : ""} />)}
              </i>
            </span>
          </span>
          <strong className="box-status">{f.status}</strong>
          <span className={`box-who ${f.need ? "box-who-second" : ""}`}>{f.attention === "human_control" ? "human operator" : f.facility}</span>
          {f.need && <span className="box-need">{f.need}</span>}
          <span className={`box-said ${f.need ? "box-said-short" : quiet(f) ? "box-said-quiet" : ""}`}>{f.lastMessage ? `“${f.lastMessage}”` : "no radio contact yet"}</span>
          <span className={`box-foot ${quiet(f) ? "box-foot-quiet" : ""}`}>
            {f.attention === "none" && f.risk.level !== "normal" ? `${f.risk.level} risk` : ATTENTION_WORDS[f.attention]}
          </span>
        </button>
      ))}
      {Array.from({ length: empty }, (_, i) => <div key={`empty-${i}`} className="box-empty" />)}
    </div>
    {folded.length > 0 && (
      <div className="folded">
        <span>also</span>
        {folded.map((f) => (
          <button key={f.id} onClick={() => onSelect(f.id)} title={f.status}>
            <b>{f.callsign}</b>
            {f.status}
          </button>
        ))}
      </div>
    )}
    </div>
  );
}
