import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { FlightSummary, OpsState, SeparationSample, TrackPoint } from "@towerai/contracts";
import type { AirportData, SimSnapshot, Vec2 } from "@towerai/core";
import { clock, mix, mixHeading, needsHuman, separationMargin, tooClose } from "../shared/replay";

// The same projection the airport importer uses.
const EARTH_M = 6371008.8;
const NM = 1852;
const RAD = Math.PI / 180;
const ARROW = "M0,-9 L6.5,7 L0,3.5 L-6.5,7 Z";
const LEGEND = [["air", "airborne"], ["ground", "on the ground"], ["red", "needs you"]] as const;
const FONT = "ui-monospace, SF Mono, Menlo, monospace";
/** The approach picture never opens wider than this. */
const WIDEST_NM = 15;

interface Props {
  airport: AirportData;
  flights: FlightSummary[];
  runways: OpsState["runways"];
  selectedId: string | null;
  track: TrackPoint[];
  separation: SeparationSample | null;
  /** Flights with responders standing by at their runway. */
  responders: string[];
  snapshot: RefObject<SimSnapshot | null>;
  /** The moment shown when replaying, or null when live. */
  replayT: number | null;
  t: number;
  onSelect(id: string | null): void;
}

type View = "field" | "approach" | "follow";
interface Box { x: number; y: number; w: number; h: number }
interface Motion { from: Vec2 & { hdg: number }; to: Vec2 & { hdg: number }; start: number; ms: number }

const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function palette(el: Element) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return { black: v("black"), g900: v("grey-900"), g800: v("grey-800"), g600: v("grey-600"), g400: v("grey-400"), g200: v("grey-200"), white: v("white"), red: v("red") };
}

/** Everything that never moves, in metres with north up. */
function shapes(airport: AirportData) {
  const path = (lines: { points: Vec2[]; close?: boolean }[]) => {
    const p = new Path2D();
    for (const { points, close } of lines) {
      points.forEach((q, i) => (i ? p.lineTo(q.x, -q.y) : p.moveTo(q.x, -q.y)));
      if (close) p.closePath();
    }
    return p;
  };
  const d = airport.drawing;
  const ends = airport.runways.map((r) => ({ runway: r, ends: r.paved ?? [r.ends[0].threshold, r.ends[1].threshold] }));
  const all = [...ends.flatMap((r) => r.ends), ...airport.terminals.flatMap((t) => t.polygon)];
  const x0 = Math.min(...all.map((p) => p.x));
  const x1 = Math.max(...all.map((p) => p.x));
  const y0 = Math.min(...all.map((p) => p.y));
  const y1 = Math.max(...all.map((p) => p.y));
  const near = (p: Vec2) => p.x > x0 - 600 && p.x < x1 + 600 && p.y > y0 - 600 && p.y < y1 + 600;

  return {
    ends,
    bounds: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 },
    nodes: new Map(airport.nodes.map((n) => [n.id, n])),
    aprons: path((d?.aprons ?? []).map((a) => ({ points: a.polygon, close: true }))),
    buildings: path((d?.buildings ?? []).filter((b) => b.polygon[0] && near(b.polygon[0])).map((b) => ({ points: b.polygon, close: true }))),
    terminals: path(airport.terminals.map((t) => ({ points: t.polygon, close: true }))),
    taxiways: path((d?.taxiways ?? []).filter((t) => t.kind === "taxiway").map((t) => ({ points: t.points }))),
    taxilanes: path([...(d?.taxiways ?? []).filter((t) => t.kind === "taxilane"), ...(d?.stands ?? [])].map((t) => ({ points: t.points }))),
    thresholds: new Map(airport.runways.flatMap((r) => r.ends.map((e) => [e.designator, e.threshold] as const))),
    names: (d?.taxiways ?? []).filter((t) => t.name).map((t) => ({ name: t.name!, at: t.points[t.points.length >> 1]! })),
  };
}

export function AirportMap(props: Props) {
  const { airport, flights, selectedId, replayT, t } = props;
  const geo = useMemo(() => shapes(airport), [airport]);
  const project = useMemo(() => {
    const { lat, lon } = airport.reference;
    const k = Math.cos(lat * RAD);
    return (p: { lat: number; lon: number }): Vec2 => ({ x: (p.lon - lon) * RAD * EARTH_M * k, y: (p.lat - lat) * RAD * EARTH_M });
  }, [airport]);

  const [chosen, setChosen] = useState<View | null>(null);
  const selected = flights.find((f) => f.id === selectedId);
  const outside = (f: FlightSummary) => {
    const p = project(f);
    return Math.abs(p.x - geo.bounds.x) > geo.bounds.w * 0.62 || Math.abs(p.y - geo.bounds.y) > geo.bounds.h * 0.62;
  };
  // Decided at selection: opens out for a flight beyond the field, and does not jump back as it comes in.
  const [wide, setWide] = useState<string | null>(null);
  const away = !!selected && outside(selected);
  useEffect(() => {
    setChosen(null);
  }, [selectedId]);
  // A replay starts again from where the flight was then.
  useEffect(() => setWide(null), [selectedId, replayT === null]);
  useEffect(() => {
    if (away) setWide(selectedId);
  }, [away, selectedId]);
  const opened = away || (!!selectedId && wide === selectedId);
  const view: View = chosen === "follow" && !selected ? "field" : (chosen ?? (opened ? "approach" : "field"));
  const strip = view === "field" ? flights.filter((f) => f.altFt >= 20 && outside(f)) : [];
  const stripIds = useMemo(() => new Set(strip.map((f) => f.id)), [strip.map((f) => f.id).join()]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ ...props, view, stripIds });
  latest.current = { ...props, view, stripIds };
  const targets = useRef<{ id: string; box: Box }[]>([]);

  useEffect(() => {
    const el = canvas.current!;
    const g = el.getContext("2d")!;
    const base = document.createElement("canvas");
    const b = base.getContext("2d")!;
    const c = palette(el);
    const arrow = new Path2D(ARROW);
    const motion = new Map<string, Motion>();
    const cam = { x: geo.bounds.x, y: geo.bounds.y, k: 0 };
    let seen: FlightSummary[] | null = null;
    let wasReplay = false;
    let baseKey = "";
    let frame = 0;
    let framed: { key: string; x: number; y: number; k: number } | null = null;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const dpr = devicePixelRatio || 1;
      const pw = Math.round(W * dpr);
      const ph = Math.round(H * dpr);
      if (base.width !== pw || base.height !== ph || el.width !== pw || el.height !== ph) {
        el.width = base.width = pw;
        el.height = base.height = ph;
        baseKey = "";
      }
      const p = latest.current;
      const now = performance.now();
      const replaying = p.replayT !== null;

      const placed = (m: Motion) => {
        const f = Math.min(1, (now - m.start) / m.ms);
        return { x: mix(m.from.x, m.to.x, f), y: mix(m.from.y, m.to.y, f), hdg: mixHeading(m.from.hdg, m.to.hdg, f) };
      };
      if (p.flights !== seen) {
        seen = p.flights;
        const jump = replaying !== wasReplay;
        wasReplay = replaying;
        for (const f of p.flights) {
          const to = { ...project(f), hdg: f.hdg };
          const old = motion.get(f.id);
          const from = old && !jump ? placed(old) : to;
          // A restart or a long seek should land, not fly across the map.
          const far = Math.hypot(to.x - from.x, to.y - from.y) > 3000;
          motion.set(f.id, { from: far ? to : from, to, start: now, ms: replaying ? 90 : old ? Math.min(1200, Math.max(200, now - old.start)) : 1 });
        }
        for (const id of motion.keys()) if (!p.flights.some((f) => f.id === id)) motion.delete(id);
      }
      const planes = p.flights.map((flight) => ({ flight, ...placed(motion.get(flight.id)!) }));
      const chosenPlane = planes.find((a) => a.flight.id === p.selectedId);

      // Camera.
      let goal = { x: geo.bounds.x, y: geo.bounds.y, k: Math.min((W - 112) / geo.bounds.w, (H - 136) / geo.bounds.h) };
      if (p.view === "approach") {
        const least = (Math.min(W, H) / 2 - 52) / (WIDEST_NM * NM);
        if (!chosenPlane) {
          framed = null;
          let reach = 5 * NM;
          for (const a of planes) reach = Math.max(reach, Math.hypot(a.x - geo.bounds.x, a.y - geo.bounds.y));
          goal.k = Math.max(least, (Math.min(W, H) / 2 - 52) / (Math.ceil(reach / (2 * NM)) * 2 * NM));
        } else {
          const key = `${p.selectedId} ${W} ${H} ${replaying}`;
          const left = framed && (Math.abs(chosenPlane.x - framed.x) * framed.k > W / 2 - 24 || Math.abs(chosenPlane.y - framed.y) * framed.k > H / 2 - 24);
          // Framed once, on the flight, the one it is close to and its runway. The scale then holds still.
          if (!framed || framed.key !== key || left) {
            const partner = p.separation && separationMargin(p.separation) < 2 && planes.find((a) => a.flight.id === p.separation!.otherFlightId);
            const runway = p.snapshot.current?.aircraft?.find((a) => a.id === p.selectedId)?.assignedRunway;
            const threshold = runway ? geo.thresholds.get(runway) : undefined;
            const points: Vec2[] = [chosenPlane, threshold ?? geo.bounds, geo.bounds];
            const flying = p.snapshot.current?.aircraft?.find((a) => a.id === p.selectedId);
            // A pattern flown close in belongs in the picture with it.
            for (const q of flying?.airRoute?.slice(flying.airIndex) ?? []) if (Math.hypot(q.x - geo.bounds.x, q.y - geo.bounds.y) < 7 * NM) points.push(q);
            if (partner) points.push(partner);
            const x0 = Math.min(...points.map((q) => q.x));
            const x1 = Math.max(...points.map((q) => q.x));
            const y0 = Math.min(...points.map((q) => q.y));
            const y1 = Math.max(...points.map((q) => q.y));
            const fit = Math.min((W - 170) / Math.max(x1 - x0, 3 * NM), (H - 150) / Math.max(y1 - y0, 3 * NM));
            const k = Math.max(fit, least);
            // Too far out to show both: keep the flight in, and as much of the way to the field as fits.
            const centre = (mid: number, at: number, room: number) => Math.min(at + room / k, Math.max(at - room / k, mid));
            framed = { key, k, x: centre((x0 + x1) / 2, chosenPlane.x, W / 2 - 70), y: centre((y0 + y1) / 2, chosenPlane.y, H / 2 - 70) };
          }
          goal = { x: framed.x, y: framed.y, k: framed.k };
        }
      } else if (p.view === "follow" && chosenPlane) {
        goal = { x: chosenPlane.x, y: chosenPlane.y, k: chosenPlane.flight.altFt < 20 ? 0.4 : 0.07 };
      }
      const ease = cam.k === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0.16;
      cam.x = mix(cam.x, goal.x, ease);
      cam.y = mix(cam.y, goal.y, ease);
      cam.k = Math.abs(goal.k - cam.k) < goal.k * 0.002 ? goal.k : mix(cam.k || goal.k, goal.k, ease);
      if (Math.abs(goal.x - cam.x) * cam.k < 0.2) cam.x = goal.x;
      if (Math.abs(goal.y - cam.y) * cam.k < 0.2) cam.y = goal.y;
      const sx = (x: number) => W / 2 + (x - cam.x) * cam.k;
      const sy = (y: number) => H / 2 - (y - cam.y) * cam.k;

      // Ground, redrawn only when the camera or a runway changes.
      const key = `${W} ${H} ${dpr} ${cam.x} ${cam.y} ${cam.k} ${replaying} ${p.runways.map((r) => r.state).join()}`;
      if (key !== baseKey) {
        baseKey = key;
        drawGround(b, { W, H, dpr, k: cam.k, sx, sy }, replaying ? [] : p.runways, c, geo, p.view === "approach");
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      const line = (points: Vec2[], colour: string, width: number, dash: number[] = []) => {
        g.strokeStyle = colour;
        g.lineWidth = width;
        g.setLineDash(dash);
        g.beginPath();
        points.forEach((q, i) => (i ? g.lineTo(sx(q.x), sy(q.y)) : g.moveTo(sx(q.x), sy(q.y))));
        g.stroke();
        g.setLineDash([]);
      };

      if (chosenPlane) {
        const until = p.replayT ?? Infinity;
        const trail = p.track.filter((q) => q[0] <= until).map((q) => project({ lat: q[1], lon: q[2] }));
        line([...trail, chosenPlane], c.g400, 1.5);
        // Where it is cleared to go next is only known live.
        const raw = replaying ? undefined : p.snapshot.current?.aircraft?.find((a) => a.id === p.selectedId);
        if (raw) {
          const ahead: Vec2[] = raw.altitudeFt > 0
            ? (raw.airRoute ?? []).slice(raw.airIndex)
            : (raw.route ?? []).slice(raw.currentWaypointIndex, raw.routeLimitIndex + 1).flatMap((id) => geo.nodes.get(id) ?? []);
          const end = ahead[ahead.length - 1];
          if (end) {
            line([chosenPlane, ...ahead], c.white, 2.5, [7, 4]);
            g.fillStyle = c.white;
            g.fillRect(sx(end.x) - 4, sy(end.y) - 4, 8, 8);
          }
        }
      }

      const labels: Box[] = [
        { x: 0, y: 0, w: replaying ? 290 : 150, h: 44 },
        { x: W - 216, y: 0, w: 216, h: 56 },
        { x: 0, y: H - 34, w: W, h: 34 },
      ];
      const boxes: { id: string; box: Box }[] = [];
      const other = p.separation && planes.find((a) => a.flight.id === p.separation!.otherFlightId);
      if (chosenPlane && other && p.separation) {
        const close = tooClose(p.separation);
        line([chosenPlane, other], close ? c.red : c.g400, close ? 2 : 1, [3, 3]);
        const mid = { x: sx((chosenPlane.x + other.x) / 2), y: sy((chosenPlane.y + other.y) / 2) };
        // No room for the figure between them when one is off the picture: the panel has it.
        const room = [chosenPlane, other].every((q) => sx(q.x) > 0 && sx(q.x) < W && sy(q.y) > 0 && sy(q.y) < H);
        const text = `${p.separation.lateralNm.toFixed(1)} nm  ${Math.round(Math.abs(p.separation.verticalFt))} ft${p.separation.requiredNm ? "" : "  independent"}`;
        g.font = `600 12px ${FONT}`;
        const w = g.measureText(text).width + 10;
        if (room) {
          const box = { x: Math.max(4, Math.min(W - w - 4, mid.x - w / 2)), y: Math.max(54, Math.min(H - 52, mid.y - 9)), w, h: 18 };
          g.fillStyle = close ? c.red : c.black;
          g.fillRect(box.x, box.y, box.w, box.h);
          g.fillStyle = c.white;
          g.textAlign = "left";
          g.textBaseline = "middle";
          g.fillText(text, box.x + 5, box.y + 10);
          labels.push(box);
        }
      }

      const drawn = planes.flatMap((a) => {
        const x = sx(a.x);
        const y = sy(a.y);
        const inside = x >= 10 && x <= W - 10 && y >= 10 && y <= H - 34;
        if (p.view === "field" && p.stripIds.has(a.flight.id)) return [];
        if (inside) return { ...a, sx: x, sy: y, inside };
        // With a flight open, only what bears on it earns a place on the edge.
        if (chosenPlane && a !== chosenPlane && a.flight.id !== p.separation?.otherFlightId && a.flight.attention === "none") return [];
        // Parked and taxiing traffic earns no edge marker unless it matters.
        if (p.view !== "field" && a.flight.altFt < 20 && a.flight.id !== p.selectedId && a.flight.attention === "none") return [];
        // Off the screen: a marker on the edge, in the direction of the aircraft.
        const dx = x - W / 2;
        const dy = y - H / 2;
        const f = Math.min((W / 2 - 22) / Math.abs(dx || 1e-6), (H / 2 - 62) / Math.abs(dy || 1e-6));
        return { ...a, sx: W / 2 + dx * f, sy: H / 2 + dy * f, inside };
      });
      if (p.view !== "approach") for (const end of endLabels(geo, sx, sy)) labels.push({ x: end.x - 16, y: end.y - 9, w: 32, h: 18 });
      for (const a of drawn) labels.push({ x: a.sx - 10, y: a.sy - 10, w: 20, h: 20 });

      // Flights arrive most urgent first; the selected one gets the first choice of label position.
      // Labels go on last, over every arrow and leader.
      const tags: (() => void)[] = [];
      if (!replaying) {
        for (const id of p.responders) {
          const runway = p.snapshot.current?.aircraft?.find((a) => a.id === id)?.assignedRunway;
          const at = runway ? geo.thresholds.get(runway) : undefined;
          if (!at) continue;
          const x = sx(at.x);
          const y = sy(at.y) + 20;
          g.fillStyle = c.red;
          for (let i = 0; i < 3; i++) g.fillRect(x - 14 + i * 11, y, 8, 8);
          g.fillStyle = c.white;
          g.font = `700 12px ${FONT}`;
          g.textAlign = "left";
          g.textBaseline = "top";
          g.fillText("fire + rescue", x - 14, y + 11);
          labels.push({ x: x - 16, y: y - 2, w: 100, h: 28 });
        }
      }
      const order = [...drawn].sort((a, z) => Number(z.flight.id === p.selectedId) - Number(a.flight.id === p.selectedId));
      for (const a of order) {
        const f = a.flight;
        const human = needsHuman(f.attention);
        const held = f.attention === "human_control";
        const sel = f.id === p.selectedId;
        const air = f.altFt >= 20;
        const top = human ? `${f.callsign} !` : held ? `${f.callsign} human` : f.callsign;
        const low = !a.inside
          ? `${toRun(a, f, p.snapshot.current, geo).toFixed(1)} nm  ${String(Math.round(f.altFt / 100)).padStart(3, "0")}`
          : air ? `${String(Math.round(f.altFt / 100)).padStart(3, "0")}  ${Math.round(f.gsKt)}` : null;
        g.font = `700 13px ${FONT}`;
        let w = g.measureText(top).width;
        if (low) {
          g.font = `12px ${FONT}`;
          w = Math.max(w, g.measureText(low).width);
        }
        w += 10;
        const h = low ? 33 : 20;
        const { sx: x, sy: y } = a;
        // From this far out the field is a cluster: ground traffic is a square, named only if it matters.
        const speck = p.view === "approach" && !air && !sel && !human && !held && a.flight.id !== p.separation?.otherFlightId;
        if (speck) {
          g.fillStyle = c.white;
          g.fillRect(x - 2, y - 2, 4, 4);
          continue;
        }

        let label: Box | null = null;
        search: for (const d of [14, 32, 52, 76, 104, 136, 170]) {
          for (const [ox, oy] of [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]] as const) {
            const box = {
              x: ox > 0 ? x + d : ox < 0 ? x - d - w : x - w / 2,
              y: oy > 0 ? y + d * 0.7 : oy < 0 ? y - d * 0.7 - h : y - h / 2,
              w, h,
            };
            if (box.x < 4 || box.y < 4 || box.x + w > W - 4 || box.y + h > H - 30) continue;
            if (labels.some((o) => hit(o, box))) continue;
            label = box;
            break search;
          }
        }
        if (label) {
          labels.push(label);
          boxes.push({ id: f.id, box: label });
          g.strokeStyle = human ? c.red : c.g400;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(Math.min(label.x + w, Math.max(label.x, x)), Math.min(label.y + h, Math.max(label.y, y)));
          g.stroke();
          const tag = label;
          tags.push(() => {
            g.fillStyle = human ? c.red : sel || held ? c.white : c.black;
            g.fillRect(tag.x, tag.y, w, h);
            if (sel && human) {
              g.strokeStyle = c.white;
              g.strokeRect(tag.x + 0.5, tag.y + 0.5, w - 1, h - 1);
            }
            g.fillStyle = !human && (sel || held) ? c.black : c.white;
            g.textAlign = "left";
            g.textBaseline = "top";
            g.font = `700 13px ${FONT}`;
            g.fillText(top, tag.x + 5, tag.y + 4);
            if (low) {
              g.font = `12px ${FONT}`;
              g.fillText(low, tag.x + 5, tag.y + 18);
            }
          });
        }
        boxes.push({ id: f.id, box: { x: x - 14, y: y - 14, w: 28, h: 28 } });

        if (sel) {
          g.strokeStyle = human ? c.red : c.white;
          g.lineWidth = 1.5;
          g.strokeRect(x - 14, y - 14, 28, 28);
        }
        g.save();
        g.translate(x, y);
        g.rotate(a.inside ? a.hdg * RAD : Math.atan2(sx(a.x) - x, y - sy(a.y)));
        g.fillStyle = human ? c.red : air ? c.white : c.black;
        g.fill(arrow);
        g.strokeStyle = human ? c.red : c.white;
        g.lineWidth = 1.5;
        g.stroke(arrow);
        g.restore();
      }
      for (let i = tags.length - 1; i >= 0; i--) tags[i]!();
      targets.current = boxes;
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [geo, project]);

  const click = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top, w: 1, h: 1 };
    props.onSelect(targets.current.find((x) => hit(x.box, p))?.id ?? null);
  };

  return (
    <>
    {strip.length > 0 && <EdgeStrip flights={strip} selectedId={selectedId} snapshot={props.snapshot.current} project={project} geo={geo} onSelect={props.onSelect} />}
    <div className="map">
      <canvas ref={canvas} onClick={click} role="img" aria-label="Map of Toronto Pearson and its traffic" />
      <p className={`map-when ${replayT !== null ? "map-replay" : ""}`}>
        {replayT !== null ? `replay ${clock(t)}, live operations continue` : "cyyz, north up"}
      </p>
      <div className="map-views">
        {(["field", "approach", "follow"] as const).map((v) => (
          <button key={v} aria-pressed={view === v} disabled={v === "follow" && !selected} onClick={() => setChosen(v)}>{v}</button>
        ))}
      </div>
      <p className="map-legend">
        {LEGEND.map(([kind, words]) => (
          <span key={kind} className={`map-key-${kind}`}>
            <svg width="12" height="15" viewBox="-7.5 -10.5 15 19" aria-hidden><path d={ARROW} /></svg>
            {words}
          </span>
        ))}
      </p>
      <p className="map-credit" title={airport.disclaimer}>{airport.attribution}</p>
    </div>
    </>
  );
}

type Geo = ReturnType<typeof shapes>;

/** The card reads distance to threshold, so the map does too. */
function runwayOf(f: FlightSummary, snapshot: SimSnapshot | null): string | undefined {
  if (f.position === "departure" || f.position === "enroute") return undefined;
  return /\b(\d\d[LRC]?)(?=,|$| \()/.exec(f.status)?.[1] ?? snapshot?.aircraft?.find((a) => a.id === f.id)?.assignedRunway;
}

function toRun(at: Vec2, f: FlightSummary, snapshot: SimSnapshot | null, geo: Geo): number {
  const runway = runwayOf(f, snapshot);
  const end = (runway && geo.thresholds.get(runway)) || geo.bounds;
  return Math.hypot(at.x - end.x, at.y - end.y) / NM;
}

/** Traffic beyond the field: a row for each runway, nearest first, marker and label as one key. */
function EdgeStrip({ flights, selectedId, snapshot, project, geo, onSelect }: {
  flights: FlightSummary[]; selectedId: string | null; snapshot: SimSnapshot | null; project(f: FlightSummary): Vec2; geo: Geo; onSelect(id: string): void;
}) {
  const rows = new Map<string, { f: FlightSummary; nm: number }[]>();
  for (const f of flights) {
    const runway = runwayOf(f, snapshot);
    const name = !runway ? "outbound" : /around|returning/.test(f.status) ? "circuit" : `inbound ${runway}`;
    rows.set(name, [...(rows.get(name) ?? []), { f, nm: toRun(project(f), f, snapshot, geo) }]);
  }
  return (
    <div className="offmap" aria-label="traffic beyond the map">
      {[...rows].sort(([a], [b]) => Number(!a.startsWith("inbound")) - Number(!b.startsWith("inbound")) || a.localeCompare(b)).map(([name, list]) => (
        <div key={name}>
          <small>{name}</small>
          <span className="offmap-flights">
            {list.sort((a, b) => a.nm - b.nm).map(({ f, nm }) => (
              <button key={f.id} className={needsHuman(f.attention) ? "offmap-red" : f.id === selectedId ? "offmap-selected" : ""} onClick={() => onSelect(f.id)}>
                <svg width="10" height="12" viewBox="-7.5 -10.5 15 19" aria-hidden><path d={ARROW} transform={`rotate(${f.hdg})`} /></svg>
                <b>{f.callsign}</b>
                <span>{nm.toFixed(1)} nm {String(Math.round(f.altFt / 100)).padStart(3, "0")}</span>
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function drawGround(
  b: CanvasRenderingContext2D,
  v: { W: number; H: number; dpr: number; k: number; sx(x: number): number; sy(y: number): number },
  runways: OpsState["runways"],
  c: ReturnType<typeof palette>,
  geo: ReturnType<typeof shapes>,
  wide: boolean,
) {
  const { W, H, dpr, k, sx, sy } = v;
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.fillStyle = c.black;
  b.fillRect(0, 0, W, H);

  if (wide) {
    b.strokeStyle = c.g800;
    b.lineWidth = 1;
    b.font = `12px ${FONT}`;
    b.fillStyle = c.g400;
    b.textAlign = "center";
    b.textBaseline = "middle";
    const [cx, cy] = [sx(geo.bounds.x), sy(geo.bounds.y)];
    const reach = Math.hypot(Math.max(Math.abs(cx), Math.abs(W - cx)), Math.max(Math.abs(cy), Math.abs(H - cy))) / k / NM;
    const step = reach > 11 ? 5 : 2;
    for (let nm = step; nm < reach; nm += step) {
      const r = nm * NM * k;
      b.beginPath();
      b.arc(sx(geo.bounds.x), sy(geo.bounds.y), r, 0, Math.PI * 2);
      b.stroke();
      // The label goes on whichever side of the ring is in the picture.
      const y = cy + r - 8 < H - 36 ? cy + r - 8 : cy - r + 8;
      if (y > 60) b.fillText(`${nm} nm`, cx, y);
    }
  }

  b.setTransform(dpr * k, 0, 0, dpr * k, dpr * sx(0), dpr * sy(0));
  b.fillStyle = c.g900;
  b.fill(geo.aprons);
  if (k > 0.03) {
    b.fillStyle = c.g800;
    b.fill(geo.buildings);
    b.strokeStyle = c.g800;
    b.lineWidth = Math.max(0.8 / k, 8);
    b.stroke(geo.taxilanes);
  }
  b.fillStyle = c.g600;
  b.fill(geo.terminals);
  b.strokeStyle = c.g600;
  b.lineWidth = Math.max(0.7 / k, 14);
  if (k > 0.015) b.stroke(geo.taxiways);

  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.textAlign = "center";
  b.textBaseline = "middle";
  if (k > 0.3) {
    b.font = `12px ${FONT}`;
    b.fillStyle = c.g400;
    const used: Box[] = [];
    for (const { name, at } of geo.names) {
      const box = { x: sx(at.x) - 20, y: sy(at.y) - 20, w: 40, h: 40 };
      if (used.some((o) => hit(o, box))) continue;
      used.push(box);
      b.fillText(name, sx(at.x), sy(at.y));
    }
  }

  for (const { runway, ends } of geo.ends) {
    const state = runways.find((r) => r.id === runway.id)?.state ?? "clear";
    const [from, to] = ends;
    const width = Math.max(wide ? 3 : 7, runway.widthM * k);
    const stroke = (colour: string, w: number, dash: number[] = []) => {
      b.strokeStyle = colour;
      b.lineWidth = w;
      b.setLineDash(dash);
      b.beginPath();
      b.moveTo(sx(from.x), sy(from.y));
      b.lineTo(sx(to.x), sy(to.y));
      b.stroke();
      b.setLineDash([]);
    };
    stroke(state === "closed" ? c.red : state === "occupied" ? c.white : state === "inactive" ? c.g600 : c.g400, width);
    if (state === "closed") stroke(c.black, width, [3, 7]);
    else if (!wide) stroke(c.black, 1, state === "reserved" ? [2, 2] : [8, 7]);
    if (wide) continue;

    b.font = `700 13px ${FONT}`;
    b.fillStyle = state === "closed" ? c.red : c.white;
    for (const label of endLabels({ ends: [{ runway, ends }] }, sx, sy)) b.fillText(label.text, label.x, label.y);
  }
}

/** Where each designator is written: just beyond its end of the pavement. */
function endLabels(geo: Pick<ReturnType<typeof shapes>, "ends">, sx: (x: number) => number, sy: (y: number) => number) {
  return geo.ends.flatMap(({ runway, ends }) =>
    ends.map((end, i) => {
      const other = ends[1 - i]!;
      const d = Math.hypot(end.x - other.x, end.y - other.y) || 1;
      return { text: runway.ends[i]!.designator, x: sx(end.x) + ((end.x - other.x) / d) * 17, y: sy(end.y) - ((end.y - other.y) / d) * 17 };
    }),
  );
}
