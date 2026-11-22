import { runwayAxes, runwayPoint, type Port, type Runway } from "./airports";
import type { State } from "./bluesky/detect";
import { kwikdist, qdr, qdrpos, rad, turn } from "./bluesky/geo";
import { climb, descent, trueAirspeedKt } from "./openap/gen";
import type { Perf } from "./perf";

export interface Fix {
  name: string;
  lat: number;
  lon: number;
}

/**
 * The flyable state of one aircraft. Only step() moves it; only a clearance effect changes
 * clearedAlt, heading, speeds, route or ils. A shallow copy is enough to fly a what-if.
 */
export interface Body extends State {
  mode: "parked" | "taxi" | "lineup" | "roll" | "air" | "rollout";
  kind: "arr" | "dep" | "cruise";
  perf: Perf;
  elevFt: number;
  route: Fix[];
  leg: number;
  clearedAlt: number;
  heading: number | null;
  speed: number | null;
  mach: number | null;
  orbit: boolean;
  ils: boolean;
  emergencyDescent: boolean;
  runwayHdg: number;
}

export function toGo(b: Body): number {
  let d = 0;
  let { lat, lon } = b;
  for (let i = b.leg; i < b.route.length; i++) {
    const f = b.route[i]!;
    d += kwikdist(lat, lon, f.lat, f.lon);
    ({ lat, lon } = f);
  }
  return d;
}

export function indicatedSpeed(b: Body, dtg = b.kind === "arr" ? toGo(b) : Infinity): number {
  const agl = b.altFt - b.elevFt;
  if (b.kind === "dep") return climb(b.perf, b.altFt, agl).casKt;
  if (b.kind === "cruise") return b.altFt < 10500 ? 250 : b.perf.climbCasKt;
  if (dtg < 5) return b.perf.approachCasKt;
  const profile = dtg < 14 ? 180 : dtg < 22 ? 210 : dtg < 40 ? 250 : b.perf.descentCasKt;
  return Math.min(profile, b.speed ?? Infinity, b.altFt < 10500 ? 250 : Infinity);
}

export function trueSpeed(b: Body, dtg?: number): number {
  return trueAirspeedKt(indicatedSpeed(b, dtg), b.mach ?? b.perf.mach, b.altFt);
}

const towards = (value: number, target: number, by: number) => (value < target ? Math.min(target, value + by) : Math.max(target, value - by));

function move(b: Body, dt: number) {
  if (b.gsKt > 0) [b.lat, b.lon] = qdrpos(b.lat, b.lon, b.hdg, (b.gsKt * dt) / 3600);
}

export function step(b: Body, dt: number): void {
  switch (b.mode) {
    case "parked":
    case "lineup":
      b.gsKt = 0;
      b.vsFpm = 0;
      return;
    case "taxi": {
      const f = b.route[b.leg];
      if (!f) {
        b.gsKt = 0;
        return;
      }
      b.gsKt = 20;
      b.hdg = qdr(b.lat, b.lon, f.lat, f.lon);
      if (kwikdist(b.lat, b.lon, f.lat, f.lon) <= (b.gsKt * dt) / 3600) {
        b.lat = f.lat;
        b.lon = f.lon;
        b.leg++;
      } else move(b, dt);
      return;
    }
    case "roll":
      b.hdg = b.runwayHdg;
      b.gsKt += 4 * dt;
      move(b, dt);
      if (b.gsKt >= b.perf.approachCasKt + 15) {
        b.mode = "air";
        b.leg = 0;
      }
      return;
    case "rollout":
      b.hdg = b.runwayHdg;
      b.vsFpm = 0;
      b.gsKt = Math.max(0, b.gsKt - 4 * dt);
      move(b, dt);
      return;
  }

  const dtg = b.kind === "arr" ? toGo(b) : Infinity;
  b.gsKt = towards(b.gsKt, trueSpeed(b, dtg), 2 * dt);
  const maxTurn = Math.min(3, 590 / Math.max(b.gsKt, 100)) * dt;

  let target = b.heading ?? b.hdg;
  if (b.orbit) target = b.hdg + maxTurn;
  else if (b.heading === null) {
    while (b.leg < b.route.length) {
      const f = b.route[b.leg]!;
      const d = kwikdist(b.lat, b.lon, f.lat, f.lon);
      target = qdr(b.lat, b.lon, f.lat, f.lon);
      const next = b.route[b.leg + 1];
      const hop = (b.gsKt * dt) / 3600;
      const off = Math.abs(turn(b.hdg, target));
      if (!next) {
        if (b.kind === "arr" && b.ils && (d <= Math.max(hop, 0.08) || (d < 0.7 && off > 80))) {
          b.lat = f.lat;
          b.lon = f.lon;
          b.altFt = b.elevFt;
          b.hdg = b.runwayHdg;
          b.vsFpm = 0;
          b.mode = "rollout";
          return;
        }
        break;
      }
      const bend = Math.min(120, Math.abs(turn(target, qdr(f.lat, f.lon, next.lat, next.lon))));
      const radius = b.gsKt / (3600 * Math.min(3, 590 / Math.max(b.gsKt, 100)) * rad);
      const lead = Math.min(radius * Math.tan((bend / 2) * rad), 6);
      if (d > Math.max(lead, hop * 1.2) && !(d < 3 && off > 100)) break;
      b.leg++;
    }
  }
  const change = turn(b.hdg, target);
  b.hdg = (b.hdg + (b.orbit ? maxTurn : Math.max(-maxTurn, Math.min(maxTurn, change))) + 360) % 360;

  const agl = b.altFt - b.elevFt;
  let aim = b.clearedAlt;
  let gliding = false;
  if (b.ils && b.heading === null && !b.orbit) {
    const glide = b.elevFt + dtg * 318;
    if (glide < aim) {
      aim = glide;
      gliding = true;
    }
  }
  if (Math.abs(aim - b.altFt) < 0.5) {
    b.altFt = aim;
    b.vsFpm = 0;
  } else {
    const up = aim > b.altFt;
    const fpm = b.emergencyDescent && !up ? 5000 : up ? climb(b.perf, b.altFt, agl).fpm : gliding ? 1800 : descent(b.perf, b.altFt, agl).fpm;
    const before = b.altFt;
    b.altFt = towards(before, aim, (fpm * dt) / 60);
    b.vsFpm = ((b.altFt - before) / dt) * 60;
  }
  move(b, dt);
}

const fix = (name: string, [lat, lon]: [number, number]): Fix => ({ name, lat, lon });

/** Straight in from behind, otherwise downwind, base and final. Fix names are fictional. */
export function arrivalRoute(p: Port, r: Runway, lat: number, lon: number, finalNm = 12): Fix[] {
  const [x, y] = runwayAxes(p, r, lat, lon);
  const turnIn = -(finalNm + 4);
  const at = (name: string, along: number, across = 0) => fix(name, runwayPoint(p, r, along, across));
  const route: Fix[] = [];
  if (x > turnIn && x < -7 && Math.abs(y) < 2) return [at("FINAX", -6), at(`RW${r.id}`, 0)];
  if (x > turnIn || (x > turnIn - 10 && Math.abs(y) > 4)) {
    // A missed approach turns away from the parallel runway.
    const side = (Math.abs(y) < 1 ? r.offset : y) < 0 ? -1 : 1;
    if (Math.abs(y) < 4 && x > -3) route.push(at("MISAP", x + 5), at("CROSS", x + 6, side * 8));
    route.push(at("BASIX", turnIn, side * 8));
  }
  route.push(at("INTOL", turnIn), at("FINAX", -6), at(`RW${r.id}`, 0));
  return route;
}
