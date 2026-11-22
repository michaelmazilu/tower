import type { FlightRecord, Marker, SeparationSample } from "@towerai/contracts";
import { useMemo, type ReactNode } from "react";
import { GAP_S, altText, clockText, margin, nearestAt, poseAt, spanText, stateAt, type WorldIndex } from "./data";
import { Track } from "./Track";

const W = 1000;
const H = 100;
const MARGIN_TOP = 3;
const RED_MARKS: Marker["kind"][] = ["conflict", "emergency", "escalation"];

function Row({ name, value, red, children }: { name: string; value: string; red?: boolean; children: ReactNode }) {
  return (
    <div className="wv-profile">
      <div className="wv-profile-name">
        <small>{name}</small>
        <b className={red ? "red" : ""}>{value}</b>
      </div>
      {children}
    </div>
  );
}

const Plot = ({ children }: { children: ReactNode }) => (
  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
    {children}
  </svg>
);

/** Markers closer than this share of the flight sit on one another. */
const SAME_SPOT = 0.025;

function mergeMarks(markers: Marker[], within: number) {
  const out: { t: number; marks: Marker[] }[] = [];
  for (const m of markers) {
    const last = out[out.length - 1];
    if (last && m.t - last.t <= within) last.marks.push(m);
    else out.push({ t: m.t, marks: [m] });
  }
  return out;
}

/** The flight's whole life as one instrument: every lane shares the axis and the playhead. */
export function Profiles({ f, index, t, onSeek }: { f: FlightRecord; index: WorldIndex; t: number; onSeek(t: number): void }) {
  const epochMs = Date.parse(index.world.epoch) || 0;
  const samples = index.nearest.get(f.summary.id)!;
  const from = f.startT;
  const to = f.endT;
  const shape = useMemo(() => {
    const x = (at: number) => ((at - from) / (to - from || 1)) * W;
    const top = Math.max(1000, ...f.track.map((p) => p[3])) * 1.15;
    const alt = f.track.map((p) => `L${x(p[0])},${H - (p[3] / top) * H}`).join("");
    const runs: SeparationSample[][] = [];
    for (const s of samples) {
      const run = runs[runs.length - 1];
      if (run && s.t - run[run.length - 1]!.t <= GAP_S) run.push(s);
      else runs.push([s]);
    }
    const sy = (s: SeparationSample) => H - (Math.min(MARGIN_TOP, margin(s)) / MARGIN_TOP) * H;
    const separation = runs
      .map((run) => `M${x(run[0]!.t)},${sy(run[0]!)}` + run.map((s) => `L${x(s.t)},${sy(s)}`).join("") + "h2")
      .join("");
    const risk = f.riskSeries.map((s, i) => {
      const left = x(Math.max(from, s.t));
      const right = x(Math.min(to, f.riskSeries[i + 1]?.t ?? to));
      return { x: left, w: Math.max(0, right - left), h: Math.max(2, s.risk.score), level: s.risk.level };
    });
    return { alt: `M0,${H}${alt}L${W},${H}Z`, line: alt.replace("L", "M"), separation, risk };
  }, [f, samples, from, to]);

  const pct = (at: number) => `${((at - from) / (to - from || 1)) * 100}%`;
  const at = Math.min(to, Math.max(from, t));
  const pose = poseAt(f, at);
  const { risk } = stateAt(f, at);
  const sep = t >= from && t <= to ? nearestAt(index, f, t) : undefined;
  const track = { from, to, t, onSeek };

  return (
    <div className="wv-profiles">
      <Row name="flight" value={`${spanText(at - from)} / ${spanText(to - from)}`}>
        <Track {...track} label="Flight playback" className="wv-life">
          {f.messages.map((m) => (
            <i key={m.id} className={`tick ${m.from}`} style={{ left: pct(m.t) }} />
          ))}
          <i className="done" style={{ width: pct(at) }} />
          {mergeMarks(f.markers, (to - from) * SAME_SPOT).map(({ t: when, marks }, i) => {
            const label = marks.map((m) => `${clockText(epochMs, m.t)} ${m.kind}: ${m.label}`).join("; ");
            const first = marks.find((m) => RED_MARKS.includes(m.kind)) ?? marks[0]!;
            return (
              <button
                key={i}
                className={`mark ${first.kind} ${RED_MARKS.includes(first.kind) ? "red" : ""}`}
                style={{ left: pct(when) }}
                title={label}
                aria-label={label}
                onClick={() => onSeek(first.t)}
              />
            );
          })}
        </Track>
      </Row>
      <Row name="altitude" value={altText(pose.altFt)}>
        <Track {...track} label="Altitude over the flight">
          <Plot>
            <path d={shape.alt} className="area" />
            <path d={shape.line} className="line" />
          </Plot>
        </Track>
      </Row>
      <Row
        name="separation"
        red={sep && margin(sep) < 1}
        value={sep ? `${Math.min(99.9, margin(sep)).toFixed(1)}× minimum` : "no one near"}
      >
        <Track {...track} label="Separation against the minimum">
          <Plot>
            <rect x="0" y={(H * 2) / MARGIN_TOP} width={W} height={H / MARGIN_TOP} className="below" />
            <path d={`M0,${(H * 2) / MARGIN_TOP}H${W}`} className="minimum" />
            <path d={shape.separation} className="line" />
          </Plot>
          <span className="limit">minimum</span>
        </Track>
      </Row>
      <Row name="risk" value={`${Math.round(risk.score)} ${risk.level}`} red={risk.level === "critical"}>
        <Track {...track} label="Risk over the flight">
          <Plot>
            {shape.risk.map((r, i) => (
              <rect key={i} x={r.x} y={H - r.h} width={r.w} height={r.h} className={`risk ${r.level}`} />
            ))}
          </Plot>
        </Track>
      </Row>
    </div>
  );
}
