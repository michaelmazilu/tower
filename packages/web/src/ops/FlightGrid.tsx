import type { FlightSummary } from "@towerai/contracts";
import { needsHuman } from "../shared/replay";
import { useSteadyOrder } from "../shared/useSteadyOrder";

const MIN_BOXES = 9;
/** Past this many the boxes go four across, so the whole airport stays on one screen. */
const DENSE_PAST = 12;
/** Four rows of four. The quietest of any more fold into one row of callsigns. */
const MOST_BOXES = 16;
/** One word at the foot, only when it asks something of the person. The agent's own flights say nothing. */
const FOOT: Record<FlightSummary["attention"], string | null> = {
  human_requested: "pilot asked for you",
  intervene: "needs you",
  human_control: "you have it",
  monitor: null,
  none: null,
};

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
        <button key={f.id} className={boxClass(f)} onClick={() => onSelect(f.id)} title={f.risk.reasons.join(", ") || undefined}>
          <span className="box-top"><b>{f.callsign}</b></span>
          <strong className="box-status">{f.status}</strong>
          {f.brief ? (
            <span className="box-need box-need-plain">{f.brief.problem}</span>
          ) : (
            f.need && <span className="box-need">{f.need}</span>
          )}
          {f.lastMessage && !f.brief && <span className={`box-said ${f.need ? "box-said-short" : ""}`}>“{f.lastMessage}”</span>}
          {FOOT[f.attention] && <span className="box-foot">{FOOT[f.attention]}</span>}
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
