import type { BackgroundFlight, ControlPosition, Message } from "@towerai/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { activeAt, clockText, liveConflicts, needsPerson, nearestAt, poseAt, stateAt, urgency, type WorldIndex } from "./data";
import {
  bound,
  ease,
  greatCircle,
  loadLand,
  nearX,
  overview,
  pathOf,
  project,
  type Camera,
  type Land,
  type XY,
} from "./geo";
import { routeOf } from "./routes";
import type { Clock } from "./useClock";

/** Map units across the frame when following a flight. */
const SPAN: Record<ControlPosition, number> = { ground: 6, tower: 6, departure: 10, approach: 10, enroute: 44 };
const HIT_PX = 44;
/** Zoomed in, a controlled flight this near beats any background dot. */
const NEAR_PX = 24;
/** Background dots are 2 px and packed tighter, so they need a closer click. */
const BACKGROUND_HIT_PX = 12;
/** On a cluster's label, only a press right on an aircraft is for that aircraft. */
const ON_PLANE_PX = 8;
/** Zoomed out, a press on a background dot opens the controlled flight nearest to it. */
const DOT_PX = 10;
/** At world zoom, flights this close become one count. */
const CLUSTER_PX = 42;
const CLUSTER_BELOW = 2.2;

function regionName(lat: number, lon: number): string {
  if (lat < -10) return lon > 100 ? "australia" : lon < -30 ? "south america" : "southern africa";
  if (lon < -100) return "us west";
  if (lon < -55) return "north america";
  if (lon < -30) return "atlantic";
  if (lon < 35) return "europe";
  if (lon < 70) return "gulf";
  if (lon < 120) return "south-east asia";
  return "japan";
}

interface Props {
  index: WorldIndex;
  clock: Clock;
  selected: string | null;
  speaking: Message["from"] | null;
  onSelect(id: string): void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function WorldMap({ index, clock, selected, speaking, onSelect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [land, setLand] = useState<Land | null>(null);
  const [free, setFree] = useState(false);
  /** A background flight opened by clicking it. They have no story, so they get a small card, not the flight panel. */
  const [picked, setPicked] = useState<BackgroundFlight | null>(null);
  const live = useRef({ clock, selected, speaking, free, onSelect, picked: null as string | null, setPicked });
  live.current = { clock, selected, speaking, free, onSelect, picked: picked?.id ?? null, setPicked };
  useEffect(() => {
    if (selected) setPicked(null);
  }, [selected]);
  useEffect(() => {
    if (!picked) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicked(null);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [picked]);

  useEffect(() => {
    let mounted = true;
    void loadLand().then((l) => mounted && setLand(l));
    return () => {
      mounted = false;
    };
  }, []);
  const hub = useRef<Camera | null>(null);
  const toHub = useRef(false);
  useEffect(() => {
    // Closing a flight steps back to the hub it was opened from, not all the way out.
    const back = !selected && !!hub.current;
    toHub.current = back;
    setFree(back);
  }, [selected]);
  const wholeWorld = () => {
    if (!live.current.selected) hub.current = null;
    live.current.free = false;
    setFree(false);
  };
  useEffect(() => {
    if (selected || picked || !free) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as Element).closest?.("input")) wholeWorld();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [selected, picked, free]);

  const shapes = useMemo(() => {
    const arcs = new Path2D();
    const background = index.world.background.map((b) => {
      const at = greatCircle(b.from, b.to);
      pathOf(Array.from({ length: 25 }, (_, i) => at(i / 24)), arcs);
      return { ...b, at };
    });
    const deep = index.flights.map((f) => {
      return { f, route: routeOf(index.world, f) };
    });
    const airports = index.world.airports.map((a) => ({ icao: a.icao, lat: a.lat, at: project(a.lat, a.lon) }));
    return { arcs, background, deep, airports };
  }, [index]);

  useEffect(() => {
    const el = canvas.current!;
    const g = el.getContext("2d", { alpha: false })!;
    const base = document.createElement("canvas");
    const b = base.getContext("2d", { alpha: false })!;
    const css = getComputedStyle(el);
    const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
    const c = {
      black: token("black"),
      g900: token("grey-900"),
      g800: token("grey-800"),
      g600: token("grey-600"),
      g400: token("grey-400"),
      g200: token("grey-200"),
      white: token("white"),
      red: token("red"),
    };
    const mono = token("mono");

    let w = 0;
    let h = 0;
    let dpr = 1;
    let cam: Camera | null = null;
    let wanted: Camera | null = null;
    let painted = "";
    let last = performance.now();
    let frame = 0;
    let hover: string | null = null;
    let hits: { id: string; x: number; y: number; rank: number }[] = [];
    /** Background flights on screen this frame, only once zoomed in past the clusters. */
    let backgroundHits: { i: number; x: number; y: number }[] = [];
    let hubs: (Box & { at: XY })[] = [];
    let dots: XY[] = [];
    let zoomedIn = false;

    const resize = new ResizeObserver(([entry]) => {
      w = entry!.contentRect.width;
      h = entry!.contentRect.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = base.width = Math.round(w * dpr);
      el.height = base.height = Math.round(h * dpr);
      painted = "";
      if (!live.current.free) wanted = null;
    });
    resize.observe(el);

    const copies = (view: Camera, draw: (shift: number) => void) => {
      for (const shift of [-360, 0, 360]) if (Math.abs(view.x - shift) < 180 + w / 2 / view.k) draw(shift);
    };
    const place = (ctx: CanvasRenderingContext2D, view: Camera, shift: number) => {
      const s = dpr * view.k;
      ctx.setTransform(s, 0, 0, s, dpr * (w / 2 + (shift - view.x) * view.k), dpr * (h / 2 - view.y * view.k));
    };
    const toScreen = (view: Camera, [x, y]: XY): XY => [
      w / 2 + (nearX(x, view.x) - view.x) * view.k,
      h / 2 + (y - view.y) * view.k,
    ];

    function paintBase(view: Camera) {
      // Following a flight moves a fraction of a pixel a frame; repaint on half pixels.
      const key = `${Math.round(view.x * view.k * 2)},${Math.round(view.y * view.k * 2)},${view.k.toFixed(3)}`;
      if (key === painted) return;
      painted = key;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.fillStyle = c.black;
      b.fillRect(0, 0, base.width, base.height);
      // Far out the world is a grid of squares; close in it becomes a chart.
      const chart = Math.min(1, Math.max(0, (view.k / overview(w, h).k - 1.3) / 1.4));
      copies(view, (shift) => {
        place(b, view, shift);
        if (chart > 0) {
          b.globalAlpha = chart;
          b.fillStyle = c.g900;
          b.fill(land!.land, "evenodd");
          b.strokeStyle = c.g600;
          b.lineWidth = 0.8 / view.k;
          b.stroke(land!.land);
          b.strokeStyle = c.g800;
          b.stroke(land!.borders);
        }
        if (chart < 1) {
          b.globalAlpha = 1 - chart;
          b.fillStyle = c.g600;
          b.globalAlpha = (1 - chart) * 0.72;
          b.fill(land!.dots);
          b.globalAlpha = (1 - chart) * 0.035;
          b.strokeStyle = c.g200;
          b.lineWidth = 0.8 / view.k;
          b.stroke(shapes.arcs);
        }
        b.globalAlpha = 1;
      });
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      const close = view.k / overview(w, h).k > 3;
      b.strokeStyle = c.g400;
      b.fillStyle = c.g400;
      b.font = `12px ${mono}`;
      b.lineWidth = 1;
      for (const a of shapes.airports) {
        const [x, y] = toScreen(view, a.at);
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
        const r = close ? 4 : 2;
        b.strokeRect(x - r, y - r, r * 2, r * 2);
        if (close) {
          // Range rings at 10 and 20 nm, once the terminal area is in frame.
          b.strokeStyle = c.g800;
          for (const nm of [10, 20]) {
            const ring = ((nm / 60) * view.k) / Math.cos((a.lat * Math.PI) / 180);
            if (ring < 14) continue;
            b.beginPath();
            b.arc(x, y, ring, 0, 2 * Math.PI);
            b.stroke();
          }
          b.strokeStyle = c.g400;
        }
      }
    }

    function draw(now: number) {
      frame = requestAnimationFrame(draw);
      const dt = now - last;
      last = now;
      if (!w || !h || !land) return;
      const { clock, selected, speaking, free } = live.current;
      const t = clock.now();
      const conflicts = liveConflicts(index, t);
      const sel = selected ? index.byId.get(selected) : undefined;

      if (!free) {
        if (sel) {
          const p = poseAt(sel, t);
          const [x, y] = project(p.lat, p.lon);
          let span = SPAN[stateAt(sel, t).position];
          const pair = conflicts.find((k) => k.a === selected || k.b === selected);
          const other = pair && index.byId.get(pair.a === selected ? pair.b : pair.a);
          if (other) {
            const o = poseAt(other, t);
            const [ox, oy] = project(o.lat, o.lon);
            span = Math.max(3, Math.abs(nearX(ox, x) - x) * 4, Math.abs(oy - y) * 5);
          }
          wanted = bound({ x, y, k: w / span }, w, h);
        } else wanted = overview(w, h);
      }
      if (free && !sel) {
        if (toHub.current && hub.current) wanted = hub.current;
        toHub.current = false;
        if (wanted) hub.current = wanted;
      }
      if (!wanted) wanted = cam ?? overview(w, h);
      cam = cam ? ease(cam, wanted, Math.min(250, dt)) : wanted;
      const view = cam;
      paintBase(view);

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      g.fillStyle = c.g400;
      g.strokeStyle = c.g600;
      g.lineWidth = 1;
      const tails = new Path2D();
      // Background flights get their own card only once zoomed in past the clusters, and
      // only those already on screen: the loop below culls them anyway, so this costs
      // one push per visible dot and nothing is loaded.
      zoomedIn = !selected && view.k / overview(w, h).k >= CLUSTER_BELOW;
      const pickedId = live.current.picked;
      backgroundHits = [];
      dots = [];
      let pickedAt: XY | null = null;
      let pickedRoute: { at: (k: number) => XY; k: number } | null = null;
      for (let i = 0; i < shapes.background.length; i++) {
        const f = shapes.background[i]!;
        const k = (t - f.departT) / f.durationS;
        if (k < 0 || k > 1) continue;
        const [x, y] = toScreen(view, f.at(k));
        // Before the culling: the line stays when its aircraft is dragged out of frame.
        if (f.id === pickedId || (zoomedIn && f.id === hover)) pickedRoute = { at: f.at, k };
        if (x < -8 || y < -8 || x > w + 8 || y > h + 8) continue;
        g.fillRect(x - 1, y - 1, 2, 2);
        if (zoomedIn) backgroundHits.push({ i, x, y });
        else dots.push([x, y]);
        if (f.id === pickedId || (zoomedIn && f.id === hover)) pickedAt = [x, y];
        const [px, py] = toScreen(view, f.at(Math.max(0, k - 0.025)));
        if (Math.abs(px - x) > w / 2) continue;
        tails.moveTo(px, py);
        tails.lineTo(x, y);
      }
      g.globalAlpha = 0.8;
      g.stroke(tails);
      g.globalAlpha = 1;
      if (pickedAt) {
        g.strokeStyle = c.white;
        g.lineWidth = 1;
        g.strokeRect(pickedAt[0] - 7, pickedAt[1] - 7, 14, 14);
      }

      const planes = shapes.deep
        .filter(({ f }) => f.summary.id === selected || activeAt(f, t))
        .map((d) => {
          const state = stateAt(d.f, t);
          const pose = poseAt(d.f, t);
          const id = d.f.summary.id;
          const at = project(pose.lat, pose.lon);
          const [x, y] = toScreen(view, at);
          const inConflict = conflicts.some((k) => k.a === id || k.b === id);
          const red = inConflict || (activeAt(d.f, t) && needsPerson(state));
          const rank = (id === selected ? 10_000 : 0) + (id === hover ? 8000 : 0) + (inConflict ? 4000 : 0) + urgency(state);
          return { ...d, id, state, pose, at, x, y, red, rank };
        })
        .sort((a, z) => a.rank - z.rank);

      // A to B for every flight: solid where it has been, dashed where it is going.
      const zoom = view.k / overview(w, h).k;
      const chosen = planes.find((p) => p.id === selected);
      const pointed = planes.find((p) => p.id === hover);
      const legs = planes.map((p) => {
        const now: [number, number] = [p.pose.lat, p.pose.lon];
        const behind = p.route.behind(t, now, p === chosen);
        const ahead = p.route.ahead(t, now);
        return { p, behind, ahead, flown: pathOf(behind), togo: pathOf(ahead) };
      });
      // All three turns of the world: a route over the date line runs off the one it started on.
      for (const shift of [-360, 0, 360]) {
        place(g, view, shift);
        for (const { p, flown, togo } of legs) {
          const main = p === chosen || p === pointed;
          const quiet = (!!chosen || !!pointed) && !main;
          // Faded and close in, they are unreadable, and they are most of the frame's cost.
          if (quiet && chosen && zoom >= 3) continue;
          g.strokeStyle = p.red ? c.red : main ? c.white : c.g200;
          g.lineWidth = (main ? 2 : 1.25) / view.k;
          g.globalAlpha = main ? 1 : quiet ? 0.08 : p.red ? 0.9 : zoom < 3 ? 0.65 : 0.4;
          g.stroke(flown);
          // Dashing sixty long lines costs frames that close in, and undashed they would read as flown.
          if (!main && zoom >= 12) continue;
          g.setLineDash([4 / view.k, 4 / view.k]);
          g.globalAlpha = main ? 0.85 : quiet ? 0.06 : p.red ? 0.8 : zoom < 3 ? 0.5 : 0.3;
          g.stroke(togo);
          g.setLineDash([]);
        }
        if (pickedRoute) {
          const { at, k } = pickedRoute;
          const part = (a: number, b: number) => pathOf(Array.from({ length: 49 }, (_, i) => at(a + ((b - a) * i) / 48)));
          g.globalAlpha = 1;
          g.strokeStyle = c.white;
          g.lineWidth = 1.5 / view.k;
          g.stroke(part(0, k));
          g.setLineDash([4 / view.k, 4 / view.k]);
          g.stroke(part(k, 1));
          g.setLineDash([]);
        }
      }
      g.globalAlpha = 1;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ends: { text: string; x: number; y: number }[] = [];
      if (zoom < 3 || chosen || pointed) {
        for (const { p, behind, ahead } of legs) {
          const main = p === (pointed ?? chosen);
          if ((chosen || pointed) && !main) continue;
          g.fillStyle = p.red ? c.red : c.white;
          const side = main ? 8 : 4;
          for (const at of [behind[0], ahead[ahead.length - 1]]) {
            if (!at) continue;
            const [x, y] = toScreen(view, at);
            g.fillRect(x - side / 2, y - side / 2, side, side);
          }
          if (!main) continue;
          // Where an end is out of frame, its name sits where the line leaves the frame.
          const mark = (points: XY[], text: string) => {
            const onScreen = points.map((at) => toScreen(view, at));
            for (let i = 0; i < onScreen.length; i++) {
              let [x, y] = onScreen[i]!;
              const inside = ([a, b]: XY) => a >= 0 && b >= 0 && a <= w && b <= h;
              if (!inside([x, y])) {
                const next = onScreen[i + 1];
                if (!next || !inside(next)) continue;
                // Walk back along the segment from the point that is in frame to the edge.
                let k = 1;
                if (x < 0) k = Math.min(k, next[0] / (next[0] - x));
                if (x > w) k = Math.min(k, (w - next[0]) / (x - next[0]));
                if (y < 0) k = Math.min(k, next[1] / (next[1] - y));
                if (y > h) k = Math.min(k, (h - next[1]) / (y - next[1]));
                [x, y] = [next[0] + (x - next[0]) * k, next[1] + (y - next[1]) * k];
              }
              ends.push({ text, x, y });
              return;
            }
          };
          mark(behind, `from ${p.route.from}`);
          mark([...ahead].reverse(), `to ${p.route.to(t)}`);
        }
      }

      const near = chosen && activeAt(chosen.f, t) && nearestAt(index, chosen.f, t);
      if (chosen && near) {
        // Half the minimum around each aircraft: the rings touch exactly at the limit.
        const r = ((near.requiredNm / 2 / 60) * view.k) / Math.cos((chosen.pose.lat * Math.PI) / 180);
        const pair = [chosen, planes.find((p) => p.id === near.otherFlightId)];
        g.setLineDash([3, 4]);
        g.strokeStyle = chosen.red ? c.red : c.g400;
        g.lineWidth = 1;
        for (const p of pair) {
          if (!p || r < 6) continue;
          g.beginPath();
          g.arc(p.x, p.y, r, 0, 2 * Math.PI);
          g.stroke();
        }
        g.setLineDash([]);
      }

      g.strokeStyle = c.red;
      g.lineWidth = 2;
      for (const k of conflicts) {
        const a = planes.find((p) => p.id === k.a);
        const z = planes.find((p) => p.id === k.b);
        if (!a || !z) continue;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(a.x + (nearX(z.at[0], a.at[0]) - a.at[0]) * view.k, z.y);
        g.stroke();
      }

      const size = Math.min(1, Math.max(0.75, zoom / 2.5));
      const folded = new Set<string>();
      hubs = [];
      const groups: (typeof planes)[] = [];
      if (!selected && zoom < CLUSTER_BELOW) {
        for (const p of [...planes].sort((a, z) => a.id.localeCompare(z.id))) {
          const group = groups.find((g) => Math.hypot(g[0]!.x - p.x, g[0]!.y - p.y) < CLUSTER_PX);
          if (group) group.push(p);
          else groups.push([p]);
        }
      }
      const badges = groups
        .filter((group) => group.length > 2)
        .map((group) => {
          for (const p of group) if (!p.red && p.id !== hover) folded.add(p.id);
          const mean = (of: (p: (typeof group)[number]) => number) => group.reduce((sum, p) => sum + of(p), 0) / group.length;
          const calls = group.filter((p) => activeAt(p.f, t) && needsPerson(p.state)).length;
          return { group, x: mean((p) => p.x), y: mean((p) => p.y), calls, conflict: !calls && group.some((p) => p.red) };
        });
      for (const p of planes) {
        if (folded.has(p.id)) continue;
        if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
        g.save();
        g.translate(p.x, p.y);
        if (p.id === selected || p.id === hover || p.red) {
          const r = p.id === selected ? 17 : 13;
          g.strokeStyle = p.red ? c.red : c.white;
          g.lineWidth = p.id === selected ? 2 : 1;
          g.strokeRect(-r, -r, r * 2, r * 2);
        }
        g.fillStyle = p.red ? c.red : c.white;
        g.strokeStyle = p.red ? c.red : c.white;
        g.lineWidth = 1.5;
        if (p.pose.gsKt < 40) {
          const r = p.id === selected || p.red ? 4 : 4 * size;
          g.fillRect(-r, -r, r * 2, r * 2);
        } else {
          g.rotate((p.pose.hdg * Math.PI) / 180);
          if (!p.red && p.id !== selected && p.id !== hover) g.scale(size, size);
          g.beginPath();
          g.moveTo(0, -9);
          g.lineTo(6, 6);
          g.lineTo(0, 3);
          g.lineTo(-6, 6);
          g.closePath();
          if (p.state.attention === "human_control") {
            g.fillStyle = c.black;
            g.fill();
            g.stroke();
          } else g.fill();
        }
        g.restore();
      }

      if (chosen && speaking) {
        // Out from the aircraft while the pilot talks, in towards it while the tower does.
        g.strokeStyle = chosen.red ? c.red : c.white;
        g.lineWidth = 2;
        for (const offset of [0, 0.5]) {
          const k = (now / 1100 + offset) % 1;
          const r = 20 + (speaking === "pilot" ? k : 1 - k) * 30;
          g.globalAlpha = 1 - (r - 20) / 36;
          g.strokeRect(chosen.x - r, chosen.y - r, r * 2, r * 2);
        }
        g.globalAlpha = 1;
      }

      // Folded ones too: a press in a pile is for the aircraft nearest to it.
      hits = planes.filter((p) => p.x >= -HIT_PX && p.y >= -HIT_PX && p.x <= w + HIT_PX && p.y <= h + HIT_PX).map((p) => ({ id: p.id, x: p.x, y: p.y, rank: p.rank }));

      // Most urgent first; a label that finds no room is left out.
      const boxes: Box[] = [];
      g.textBaseline = "middle";
      // At world zoom each pile is one square count: how many, where, and whether it needs someone.
      for (const badge of badges.sort((a, z) => z.calls - a.calls || z.group.length - a.group.length)) {
        const { group, calls, conflict } = badge;
        const count = String(group.length);
        const lead = group[0]!;
        const words = [regionName(lead.pose.lat, lead.pose.lon), calls ? `${calls} ${calls === 1 ? "needs" : "need"} you` : conflict ? "conflict" : ""].filter(Boolean).join(", ");
        g.font = `12px ${mono}`;
        const cw = Math.max(26, count.length * 9 + 10);
        const bw = cw + g.measureText(words).width + 12;
        // Beside the pile and off any red aircraft in it, stacked clear of the next pile.
        const spots = [0, -32, 32, -64, 64].flatMap((dy) => [
          { x: badge.x + 14, y: badge.y - 13 + dy, w: bw, h: 26 },
          { x: badge.x - 14 - bw, y: badge.y - 13 + dy, w: bw, h: 26 },
        ]);
        const box = spots.find((s) => s.x >= 0 && s.y >= 0 && s.x + s.w <= w && s.y + s.h <= h - 22 && !boxes.some((o) => overlaps(o, s)));
        if (!box) {
          for (const p of group) folded.delete(p.id);
          continue;
        }
        boxes.push(box);
        hubs.push({ ...box, at: [badge.x, badge.y] });
        g.fillStyle = calls ? c.red : c.white;
        g.fillRect(box.x, box.y, cw, box.h);
        g.fillRect(badge.x - 3, badge.y - 3, 6, 6);
        g.fillStyle = c.black;
        g.fillRect(box.x + cw, box.y, box.w - cw, box.h);
        g.strokeStyle = calls ? c.red : c.white;
        g.lineWidth = 1;
        g.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
        g.beginPath();
        g.moveTo(badge.x, badge.y);
        g.lineTo(Math.min(box.x + box.w, Math.max(box.x, badge.x)), Math.min(box.y + box.h, Math.max(box.y, badge.y)));
        g.stroke();
        g.fillStyle = calls ? c.white : c.black;
        g.font = `700 14px ${mono}`;
        g.fillText(count, box.x + (cw - g.measureText(count).width) / 2, box.y + 14);
        g.fillStyle = c.g200;
        g.font = `12px ${mono}`;
        g.fillText(words, box.x + cw + 6, box.y + 13.5);
      }
      g.font = `12px ${mono}`;
      for (const { text, x, y } of ends) {
        const bw = g.measureText(text).width + 10;
        const plane = pointed ?? chosen!;
        const body = { x: plane.x - 38, y: plane.y - 36, w: 76, h: 60 };
        const spot = [0, -22, 22, -44, 44, -66, 66]
          .map((dy) => ({ x: Math.max(6, Math.min(w - bw - 6, x - bw / 2)), y: Math.max(6, Math.min(h - 44, y - 24 + dy)), w: bw, h: 18 }))
          .find((s) => !overlaps(body, s) && !boxes.some((o) => overlaps(o, s)));
        if (!spot) continue;
        boxes.push(spot);
        g.fillStyle = c.white;
        g.fillRect(spot.x, spot.y, spot.w, spot.h);
        g.fillStyle = c.black;
        g.fillText(text, spot.x + 5, spot.y + 9.5);
      }
      for (let i = planes.length - 1; i >= 0; i--) {
        const p = planes[i]!;
        if (folded.has(p.id)) continue;
        // Far out, only a flight that needs attention is named.
        if (!selected && zoom < CLUSTER_BELOW && !p.red && p.id !== hover && p.state.attention !== "human_control" && p.state.attention !== "intervene") continue;
        const text = p.f.summary.callsign;
        const bw = g.measureText(text).width + 10;
        const spots: Box[] = [
          { x: p.x + 16, y: p.y - 9, w: bw, h: 18 },
          { x: p.x - 16 - bw, y: p.y - 9, w: bw, h: 18 },
          { x: p.x - bw / 2, y: p.y - 34, w: bw, h: 18 },
          { x: p.x - bw / 2, y: p.y + 17, w: bw, h: 18 },
        ];
        const box = spots.find(
          (s) =>
            s.x >= 0 &&
            s.y >= 0 &&
            s.x + s.w <= w &&
            s.y + s.h <= h - 22 &&
            !boxes.some((o) => overlaps(o, s)) &&
            !planes.some((o) => o !== p && o.x > s.x && o.x < s.x + s.w && o.y > s.y && o.y < s.y + s.h && o.rank > p.rank),
        );
        if (!box) continue;
        boxes.push(box);
        const main = p.id === selected || p.id === hover;
        if (p.red || main || selected) {
          g.fillStyle = p.red ? c.red : main ? c.white : c.black;
          g.fillRect(box.x, box.y, box.w, box.h);
        }
        g.fillStyle = p.red ? c.white : main ? c.black : c.g200;
        g.fillText(text, box.x + 5, box.y + 9.5);
      }
      if (zoom > 3) {
        // An airport is named where that covers no aircraft and no callsign.
        g.fillStyle = c.g400;
        for (const a of shapes.airports) {
          const [x, y] = toScreen(view, a.at);
          if (x < 0 || y < 0 || x > w || y > h) continue;
          const spots = [{ x: x - 18, y: y + 8, w: 36, h: 14 }, { x: x - 18, y: y - 24, w: 36, h: 14 }, { x: x + 9, y: y - 7, w: 36, h: 14 }, { x: x - 45, y: y - 7, w: 36, h: 14 }];
          const spot = spots.find(
            (s) =>
              !boxes.some((o) => overlaps(o, s)) &&
              !planes.some((p) => {
                const r = p.id === selected ? 19 : 9;
                return overlaps(s, { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 });
              }),
          );
          if (!spot) continue;
          boxes.push(spot);
          g.fillText(a.icao, spot.x + 4, spot.y + 8);
        }
      }
      g.textBaseline = "alphabetic";
    }
    frame = requestAnimationFrame(draw);

    const closestTo = (x: number, y: number, within: number) =>
      hits
        .map((p) => ({ ...p, d: Math.hypot(p.x - x, p.y - y) }))
        .filter((p) => p.d < within)
        // The pixel nearest wins, urgency breaks ties.
        .sort((a, z) => Math.round(a.d / 2) - Math.round(z.d / 2) || z.rank - a.rank)[0]?.id ?? null;
    const nearestBackground = (x: number, y: number) => {
      let best: { i: number; d: number } | null = null;
      for (const p of backgroundHits) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < BACKGROUND_HIT_PX && (!best || d < best.d)) best = { i: p.i, d };
      }
      return best ? shapes.background[best.i]! : null;
    };

    const hubAt = (x: number, y: number) => hubs.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    /** What a press here opens: a controlled flight, a background flight's card, or neither. */
    const target = (x: number, y: number): { id: string | null; background: BackgroundFlight | null } => {
      const none = { id: null, background: null };
      if (hubAt(x, y)) return { ...none, id: closestTo(x, y, ON_PLANE_PX) };
      if (zoomedIn && !closestTo(x, y, NEAR_PX)) {
        const background = nearestBackground(x, y);
        if (background) return { ...none, background };
      }
      const id = closestTo(x, y, HIT_PX);
      if (id) return { ...none, id };
      return { ...none, id: dots.some(([dx, dy]) => Math.hypot(dx - x, dy - y) < DOT_PX) ? closestTo(x, y, Infinity) : null };
    };
    let press: { x: number; y: number; moved: boolean; from: Camera } | null = null;
    const local = (e: MouseEvent): XY => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      if (!cam) return;
      const [x, y] = local(e);
      press = { x, y, moved: false, from: cam };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const [x, y] = local(e);
      if (press) {
        if (!press.moved && Math.hypot(x - press.x, y - press.y) < 6) return;
        press.moved = true;
        live.current.free = true;
        setFree(true);
        const { from } = press;
        wanted = bound({ k: from.k, x: from.x - (x - press.x) / from.k, y: from.y - (y - press.y) / from.k }, w, h);
        cam = wanted;
        return;
      }
      const found = target(x, y);
      hover = found.id ?? found.background?.id ?? null;
      el.style.cursor = hover || hubAt(x, y) ? "pointer" : "grab";
    };
    const up = (e: PointerEvent) => {
      if (press && !press.moved && cam) {
        const [x, y] = local(e);
        const found = target(x, y);
        const pressed = hubAt(x, y);
        if (found.id) live.current.onSelect(found.id);
        else if (pressed) {
          live.current.free = true;
          setFree(true);
          toHub.current = false;
          wanted = bound({ k: overview(w, h).k * 9, x: cam.x + (pressed.at[0] - w / 2) / cam.k, y: cam.y + (pressed.at[1] - h / 2) / cam.k }, w, h);
        }
        else live.current.setPicked(found.background); // straight from the recording in memory: no request, no wait
      }
      press = null;
    };
    const leave = () => {
      hover = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!cam) return;
      const [x, y] = local(e);
      const from = live.current.free && wanted ? wanted : cam;
      const k = bound({ ...from, k: from.k * Math.exp(-e.deltaY * 0.0015) }, w, h).k;
      wanted = bound(
        { k, x: from.x + (x - w / 2) * (1 / from.k - 1 / k), y: from.y + (y - h / 2) * (1 / from.k - 1 / k) },
        w,
        h,
      );
      live.current.free = true;
      setFree(true);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
    };
  }, [index, shapes, land]);

  return (
    <div className="wv-map">
      <canvas ref={canvas} aria-label="World map of flights. Use the flight list to choose one with a keyboard." />
      <div className="wv-legend">
        <span>
          <i className="arrow" />
          agent controlled
        </span>
        <span>
          <i className="route" />
          flown, then to go
        </span>
        {!selected && (
          <span>
            <i className="dot" />
            synthetic background
          </span>
        )}
        <span className="attn">
          <i />
          attention or conflict
        </span>
      </div>
      {picked && !selected && <BackgroundCard flight={picked} epochMs={Date.parse(index.world.epoch) || 0} onClose={() => setPicked(null)} />}
      {free && (
        <button className="wv-key wv-recentre" onClick={wholeWorld}>
          {selected ? "follow flight" : "whole world"}
        </button>
      )}
    </div>
  );
}

const latLon = ([lat, lon]: [number, number]) =>
  `${Math.abs(lat).toFixed(1)}°${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(1)}°${lon < 0 ? "W" : "E"}`;

function greatCircleNm([a, b]: [number, number], [c, d]: [number, number]) {
  const r = Math.PI / 180;
  const h = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * 3440 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Everything a background flight has. It is drawn for density: no radio, no decisions. */
function BackgroundCard({ flight, epochMs, onClose }: { flight: BackgroundFlight; epochMs: number; onClose(): void }) {
  const nm = greatCircleNm(flight.from, flight.to);
  return (
    <div className="wv-bgcard" role="dialog" aria-label={`Background flight ${flight.id}`}>
      <div className="wv-bgcard-head">
        <b>{flight.id}</b>
        <span>background traffic</span>
        <button className="wv-key" onClick={onClose}>
          close
        </button>
      </div>
      <dl>
        <dt>from</dt>
        <dd>{latLon(flight.from)}</dd>
        <dt>to</dt>
        <dd>{latLon(flight.to)}</dd>
        <dt>level</dt>
        <dd>FL{Math.round(flight.altFt / 100)}</dd>
        <dt>distance</dt>
        <dd>{Math.round(nm).toLocaleString()} nm</dd>
        <dt>departs</dt>
        <dd>{clockText(epochMs, flight.departT)}</dd>
        <dt>arrives</dt>
        <dd>{clockText(epochMs, flight.departT + flight.durationS)}</dd>
      </dl>
      <p>Synthetic traffic on a great circle. Not controlled by TowerAI, so there is no radio or decision to replay.</p>
    </div>
  );
}
