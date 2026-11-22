import { useEffect, useRef } from "react";
import type { CockpitState } from "@towerai/contracts";
import type { AirportData, Vec2 } from "@towerai/core";

/*
 * A forward schematic of the real field at night: one pinhole camera, flat shapes, greys and white lights.
 * The eye sits higher than a real cockpit so that the pavement ahead can be read from across a room.
 */

const RAD = Math.PI / 180;
const FT = 0.3048;
const EYE_M = 17;
const NEAR_M = 2;
const FONT = "ui-monospace, SF Mono, Menlo, monospace";
const COMPASS: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };

type P3 = [x: number, y: number, up: number];
interface Shape { points: Vec2[]; at: Vec2; heightM: number }
interface Mark { points: Vec2[]; at: Vec2 }

/** Where the glass starts below the heading tape. */
const TAPE_H = 38;
/** The same every frame and every visit: far-off lights, by compass bearing. */
const SKYLINE = Array.from({ length: 540 }, (_, i) => {
  const r = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  return { bearing: (i * 137.508) % 360, up: r * r * 5, bright: r > 0.8 };
});

const middle = (points: Vec2[]): Vec2 => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
});

/** A rectangle along a line: from a to b metres along it, centred `side` metres off it. */
function strip(from: Vec2, to: Vec2, width: number, a?: number, b?: number, side = 0): Vec2[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const at = (along: number, off: number) => ({ x: from.x + ux * along + uy * off, y: from.y + uy * along - ux * off });
  const l = side - width / 2;
  const r = side + width / 2;
  return [at(a ?? 0, l), at(b ?? len, l), at(b ?? len, r), at(a ?? 0, r)];
}

function build(airport: AirportData) {
  const d = airport.drawing;
  const mark = (points: Vec2[]): Mark => ({ points, at: middle(points) });
  const taxiways: Mark[] = [];
  const centres: Mark[] = [];
  for (const way of d?.taxiways ?? []) {
    way.points.slice(1).forEach((to, i) => {
      const from = way.points[i]!;
      taxiways.push(mark(strip(from, to, way.kind === "taxiway" ? 23 : 14)));
      centres.push(mark([from, to]));
    });
  }
  const runways = airport.runways.map((runway) => {
    const [from, to] = runway.paved ?? [runway.ends[0].threshold, runway.ends[1].threshold];
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const w = runway.widthM;
    const paint: Mark[] = [];
    for (let a = 80; a < len - 80; a += 60) paint.push(mark(strip(from, to, 1.6, a, a + 32)));
    for (const side of [-1, 1]) {
      for (let a = 0; a < len; a += 120) paint.push(mark(strip(from, to, 1.4, a, Math.min(len, a + 120), (side * (w - 3)) / 2)));
      for (let i = 0; i < 4; i++) {
        for (const a of [10, len - 45]) paint.push(mark(strip(from, to, 2.6, a, a + 35, side * (5 + i * 6.2))));
      }
    }
    const ux = (to.x - from.x) / len;
    const uy = (to.y - from.y) / len;
    const lights: Vec2[] = [];
    const light = (along: number, off: number) => lights.push({ x: from.x + ux * along + uy * off, y: from.y + uy * along - ux * off });
    for (let a = 0; a <= len; a += 30) for (const side of [-1, 1]) light(a, side * (w / 2 + 3));
    for (let off = -w / 2; off <= w / 2; off += 5) for (const a of [-3, len + 3]) light(a, off);
    return { from, to, ends: runway.ends, surface: strip(from, to, w), paint, lights };
  });
  const solids: Shape[] = [
    ...(d?.buildings ?? []).map((b) => ({ points: b.polygon, heightM: b.heightM })),
    ...(d?.buildings?.length ? [] : airport.terminals.map((t) => ({ points: t.polygon, heightM: 16 }))),
  ].filter((s) => s.points.length > 2).map((s) => ({ ...s, heightM: Math.min(s.heightM, 40), at: middle(s.points) }));
  return { taxiways, centres, runways, solids, aprons: (d?.aprons ?? []).map((a) => a.polygon) };
}

export function Windscreen({ airport, state }: { airport: AirportData; state: CockpitState }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ state, at: performance.now() });
  if (latest.current.state !== state) latest.current = { state, at: performance.now() };

  useEffect(() => {
    const el = canvas.current!;
    const g = el.getContext("2d")!;
    const css = getComputedStyle(el);
    const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
    const c = { black: v("black"), g900: v("grey-900"), g800: v("grey-800"), g600: v("grey-600"), g400: v("grey-400"), g200: v("grey-200"), white: v("white"), red: v("red") };
    const field = build(airport);
    let cam: { run: string; x: number; y: number; alt: number; hdg: number; vs: number } | null = null;
    let before = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
        el.width = Math.round(W * dpr);
        el.height = Math.round(H * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      const { state: s, at } = latest.current;
      const age = Math.max(0, Math.min(0.6, (now - at) / 1000));
      const run = s.vitals.gsKt * 0.5144 * age;
      const goal = {
        run: s.runId,
        x: s.x + Math.sin(s.vitals.hdg * RAD) * run,
        y: s.y + Math.cos(s.vitals.hdg * RAD) * run,
        alt: Math.max(0, s.vitals.onGround ? 0 : (s.vitals.altFt + (s.vitals.vsFpm / 60) * age) * FT),
        hdg: s.vitals.hdg,
        vs: s.vitals.onGround ? 0 : s.vitals.vsFpm,
      };
      if (!cam || cam.run !== goal.run || Math.hypot(goal.x - cam.x, goal.y - cam.y) > 600) cam = goal;
      else {
        const k = 1 - Math.exp(-Math.max(0, now - before) / 250);
        cam = {
          run: goal.run,
          x: cam.x + (goal.x - cam.x) * k,
          y: cam.y + (goal.y - cam.y) * k,
          alt: cam.alt + (goal.alt - cam.alt) * k,
          hdg: cam.hdg + (((goal.hdg - cam.hdg + 540) % 360) - 180) * k,
          vs: cam.vs + (goal.vs - cam.vs) * k,
        };
      }
      before = now;

      const me = cam;
      const sin = Math.sin(me.hdg * RAD);
      const cos = Math.cos(me.hdg * RAD);
      const eye = me.alt + EYE_M;
      const focal = Math.max(W * 0.62, H);
      const horizon = H * (0.4 + Math.max(-0.12, Math.min(0.14, me.vs / 22_000)));
      const reach = 2600 + eye * 8;
      const ahead = (p: Vec2) => (p.x - me.x) * sin + (p.y - me.y) * cos;
      const seen = (p: Vec2, within = reach) => {
        const f = ahead(p);
        return f > -150 && f < within && Math.abs((p.x - me.x) * cos - (p.y - me.y) * sin) < f + 350;
      };
      const screen = ([r, f, up]: P3): [number, number] => [W / 2 + (r / f) * focal, horizon - (up / f) * focal];

      /** Adds one shape to the path, cut where it passes behind the eye. */
      const trace = (points: P3[], closed = true) => {
        const local = points.map(([x, y, up]): P3 => [(x - me.x) * cos - (y - me.y) * sin, (x - me.x) * sin + (y - me.y) * cos, up - eye]);
        let open = false;
        const to = (p: P3) => {
          const [x, y] = screen(p);
          if (open) g.lineTo(x, y);
          else g.moveTo(x, y);
          open = true;
        };
        for (let i = 0; i < local.length; i++) {
          const a = local[i]!;
          if (a[1] >= NEAR_M) to(a);
          if (!closed && i === local.length - 1) break;
          const b = local[(i + 1) % local.length]!;
          if (a[1] >= NEAR_M === b[1] >= NEAR_M) continue;
          const t = (NEAR_M - a[1]) / (b[1] - a[1]);
          to([a[0] + (b[0] - a[0]) * t, NEAR_M, a[2] + (b[2] - a[2]) * t]);
        }
        if (open && closed) g.closePath();
      };
      const flat = (points: Vec2[], closed = true) => trace(points.map((p): P3 => [p.x, p.y, 0]), closed);
      const fill = (color: string, shapes: Vec2[][]) => {
        g.fillStyle = color;
        // One at a time: overlapping shapes wound in opposite directions would cut holes in each other.
        for (const points of shapes) {
          g.beginPath();
          flat(points);
          g.fill();
        }
      };

      g.fillStyle = c.g800;
      g.fillRect(0, 0, W, H);
      g.fillStyle = c.g900;
      g.fillRect(0, horizon, W, H - horizon);

      // Once airborne, a grid on the ground, or there is no sense of speed when the field is behind.
      if (me.alt > 20) {
        const step = eye > 400 ? 1000 : 250;
        g.beginPath();
        for (let i = -16; i <= 16; i++) {
          const gx = (Math.round(me.x / step) + i) * step;
          const gy = (Math.round(me.y / step) + i) * step;
          flat([{ x: gx, y: me.y - 16 * step }, { x: gx, y: me.y + 16 * step }], false);
          flat([{ x: me.x - 16 * step, y: gy }, { x: me.x + 16 * step, y: gy }], false);
        }
        g.strokeStyle = c.g800;
        g.lineWidth = 1;
        g.stroke();
      }

      g.fillStyle = c.g600;
      g.fillRect(0, horizon, W, 1);
      for (const l of SKYLINE) {
        const off = ((l.bearing - me.hdg + 540) % 360) - 180;
        if (Math.abs(off) > 65) continue;
        g.fillStyle = l.bright ? c.g200 : c.g600;
        g.fillRect(W / 2 + Math.tan(off * RAD) * focal, horizon - l.up, l.bright ? 2 : 1.5, l.bright ? 2 : 1.5);
      }

      fill(c.g900, field.aprons);
      fill(c.g800, field.taxiways.filter((m) => seen(m.at)).map((m) => m.points));
      g.beginPath();
      for (const m of field.centres) if (seen(m.at, 900 + eye * 2)) flat(m.points, false);
      g.strokeStyle = c.g600;
      g.lineWidth = 1;
      g.setLineDash([2, 7]);
      g.stroke();
      g.setLineDash([]);

      fill(c.g600, field.runways.map((r) => r.surface));
      fill(c.white, field.runways.flatMap((r) => r.paint.filter((m) => seen(m.at)).map((m) => m.points)));
      for (const r of field.runways) {
        g.fillStyle = r.ends.some((e) => e.designator === s.runway) ? c.white : c.g400;
        for (const p of r.lights) {
          const f = ahead(p);
          if (f < NEAR_M || !seen(p)) continue;
          const [x, y] = screen([(p.x - me.x) * cos - (p.y - me.y) * sin, f, 0.5 - eye]);
          const size = Math.max(1.2, Math.min(3.5, (0.7 / f) * focal));
          g.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }

      const solids = field.solids.filter((b) => seen(b.at)).sort((a, b) => ahead(b.at) - ahead(a.at));
      g.lineWidth = 1;
      for (const b of solids) {
        const walls = b.points
          .map((from, i) => ({ from, to: b.points[(i + 1) % b.points.length]! }))
          .sort((a, z) => ahead(z.from) + ahead(z.to) - ahead(a.from) - ahead(a.to));
        // Far to near, so the windows of a back wall are covered by the front one.
        for (const { from, to } of walls) {
          g.fillStyle = c.black;
          g.beginPath();
          trace([[from.x, from.y, 0], [to.x, to.y, 0], [to.x, to.y, b.heightM], [from.x, from.y, b.heightM]]);
          g.fill();
          const n = Math.min(24, Math.floor(Math.hypot(to.x - from.x, to.y - from.y) / 16));
          g.fillStyle = c.g400;
          for (let up = 5; up < b.heightM; up += 8) {
            for (let i = 1; i <= n; i++) {
              if ((i * 7 + up * 3 + Math.round(Math.abs(from.x))) % 5 < 2) continue;
              const x = from.x + ((to.x - from.x) * i) / (n + 1);
              const y = from.y + ((to.y - from.y) * i) / (n + 1);
              const f = (x - me.x) * sin + (y - me.y) * cos;
              if (f < 30) continue;
              const [sx, sy] = screen([(x - me.x) * cos - (y - me.y) * sin, f, up - eye]);
              const size = Math.max(1, Math.min(3, (1.5 / f) * focal));
              g.fillRect(sx, sy, size, size);
            }
          }
        }
        g.fillStyle = c.black;
        g.beginPath();
        trace(b.points.map((p): P3 => [p.x, p.y, b.heightM]));
        g.fill();
        g.strokeStyle = c.g600;
        g.stroke();
      }

      g.textAlign = "center";
      g.textBaseline = "middle";
      const local = (p: Vec2, up: number): P3 => [(p.x - me.x) * cos - (p.y - me.y) * sin, ahead(p), up - eye];
      const tag = (text: string, x: number, y: number, bg: string, ink: string, size = 12) => {
        g.font = `700 ${size}px ${FONT}`;
        const w = g.measureText(text).width + 10;
        g.fillStyle = bg;
        g.fillRect(x - w / 2, y - size / 2 - 4, w, size + 8);
        g.fillStyle = ink;
        g.fillText(text, x, y);
      };

      for (const t of s.traffic) {
        const p = local(t, t.altFt * FT + 5);
        if (p[1] < 12 || p[1] > reach * 2) continue;
        const [x, y] = screen(p);
        const span = Math.max(14, Math.min(150, (36 / p[1]) * focal));
        g.fillStyle = c.white;
        g.beginPath();
        // Seen from behind or ahead: wings, body and fin.
        ([[-0.5, 0], [-0.07, -0.03], [-0.025, -0.07], [0, -0.28], [0.025, -0.07], [0.07, -0.03], [0.5, 0], [0.07, 0.06], [-0.07, 0.06]] as const)
          .forEach(([a, b], i) => (i ? g.lineTo(x + a * span, y + b * span) : g.moveTo(x + a * span, y + b * span)));
        g.fill();
        if (p[1] < 2200 && x > 30 && x < W - 30) tag(t.callsign, x, y - span * 0.28 - 14, c.white, c.black);
      }

      for (const r of field.runways) {
        const end = r.ends.find((e) => e.designator === s.runway);
        if (!end) continue;
        const p = local(end.threshold, 0);
        if (p[1] < 30) continue;
        const [x, y] = screen(p);
        if (x < 30 || x > W - 30) continue;
        const top = Math.max(TAPE_H + 30, Math.min(y, horizon) - 44);
        g.fillStyle = c.red;
        g.fillRect(x - 0.5, top, 1, y - top);
        g.fillRect(x - 4, y - 4, 8, 8);
        tag(`runway ${end.designator}`, x, top, c.red, c.white, 14);
      }

      // The aircraft around the glass: posts either side, the glareshield below.
      const post = Math.round(W * 0.045);
      const shield = Math.max(22, Math.round(H * 0.07));
      const shape = (...points: [number, number][]) => {
        g.beginPath();
        points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fill();
      };
      g.fillStyle = c.black;
      g.fillRect(0, 0, W, TAPE_H);
      shape([0, TAPE_H], [post * 0.3, TAPE_H], [post, H], [0, H]);
      shape([W, TAPE_H], [W - post * 0.3, TAPE_H], [W - post, H], [W, H]);
      const sill = H - shield;
      shape([0, H], [0, sill + 10], [W * 0.2, sill + 10], [W * 0.26, sill], [W * 0.74, sill], [W * 0.8, sill + 10], [W, sill + 10], [W, H]);

      // The horizon reference.
      g.fillStyle = c.g200;
      for (const side of [-1, 1]) {
        g.fillRect(W / 2 + side * 34 - 14, horizon, 28, 2);
        g.fillRect(W / 2 + side * 20 - 1, horizon, 2, 7);
      }

      // Heading tape.
      const px = W / 70;
      for (let d = Math.ceil((me.hdg - 36) / 5) * 5; d <= me.hdg + 36; d += 5) {
        const x = W / 2 + (d - me.hdg) * px;
        const major = d % 15 === 0;
        g.fillStyle = major ? c.g200 : c.g600;
        g.fillRect(x, TAPE_H - (major ? 9 : 5), 1, major ? 9 : 5);
        if (!major || Math.abs(x - W / 2) < 36) continue;
        const deg = ((d % 360) + 360) % 360;
        g.font = `700 12px ${FONT}`;
        g.fillStyle = c.g400;
        g.fillText(COMPASS[deg] ?? String(deg).padStart(3, "0"), x, 15);
      }
      tag(String(Math.round(((me.hdg % 360) + 360) % 360) % 360).padStart(3, "0"), W / 2, 19, c.white, c.black, 18);

      // Where that is on the field, heading up.
      const size = Math.min(150, Math.round(Math.min(W * 0.24, H * 0.36)));
      if (size < 90) return;
      const left = W - post - size - 8;
      const top = TAPE_H + 12;
      const range = Math.max(1500, Math.min(12_000, Math.hypot(me.x, me.y) * 0.75));
      const k = size / 2 / range;
      g.save();
      g.beginPath();
      g.rect(left, top, size, size);
      g.fillStyle = c.black;
      g.fill();
      g.strokeStyle = c.g600;
      g.stroke();
      g.clip();
      g.translate(left + size / 2, top + size * 0.6);
      const map = (p: Vec2): [number, number] => [((p.x - me.x) * cos - (p.y - me.y) * sin) * k, -ahead(p) * k];
      const line = (from: Vec2, to: Vec2) => {
        g.moveTo(...map(from));
        g.lineTo(...map(to));
      };
      g.beginPath();
      for (const m of field.centres) line(m.points[0]!, m.points[1]!);
      g.strokeStyle = c.g600;
      g.lineWidth = 0.75;
      g.stroke();
      for (const r of field.runways) {
        g.beginPath();
        line(r.from, r.to);
        g.strokeStyle = r.ends.some((e) => e.designator === s.runway) ? c.red : c.g400;
        g.lineWidth = 3;
        g.stroke();
      }
      g.fillStyle = c.g200;
      for (const t of s.traffic) {
        const [x, y] = map(t);
        g.fillRect(x - 2, y - 2, 4, 4);
      }
      g.fillStyle = c.white;
      g.beginPath();
      g.moveTo(0, -11);
      g.lineTo(7, 8);
      g.lineTo(0, 4);
      g.lineTo(-7, 8);
      g.fill();
      g.restore();
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [airport]);

  return <canvas ref={canvas} aria-label="The airport ahead, from the pilot's seat" />;
}
