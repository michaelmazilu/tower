// The separation and flow services: predict, offer validated options, let the controller choose.
import { toGo, step, indicatedSpeed, trueSpeed, type Body, type Fix } from "./body";
import { detect } from "./bluesky/detect";
import { kwikdist, kwikqdrdist, mod, qdr, qdrpos, turn } from "./bluesky/geo";
import { mvp } from "./bluesky/mvp";
import { bearing, direction, level, shortLevel, trafficCall } from "./phrase";
import { minimumNm, probe, separationApplies, LOST_FT, VERTICAL_FT } from "./separation";
import type { Flight, Option, Proc, Sim } from "./sim";

/** A clearance can take effect after a short exchange or a long one, so validate across that range. */
const ACT_AFTER_S = [16, 4, 30];
const ARRIVAL_SPACING_S = 115;
const top = (b: Body) => Math.max(b.altFt, b.clearedAlt);
const bottom = (b: Body) => Math.min(b.altFt, b.clearedAlt);
/** Either may climb out of terminal airspace before they pass. */
const staysLow = (a: Body, b: Body) => top(a) < 15000 && top(b) < 15000;

interface Episode {
  a: Flight;
  b: Flight;
  predictedNm: number;
  dueT: number;
  closestNm: number;
  acted: boolean;
  solving: boolean;
  retryT: number;
}

export function forecast(sim: Sim, f: Flight, apply: (b: Body) => void, horizonS = 180, marginNm = 0.5) {
  const traffic = sim.airborne();
  for (const afterS of ACT_AFTER_S) {
    const hit = probe(f.body, traffic, horizonS, marginNm, { apply, afterS });
    if (hit) return hit;
  }
  return null;
}

function movers(a: Flight, b: Flight): Flight[] {
  const weight = (f: Flight, o: Flight) => {
    if (f.priority) return -10;
    let w = f.body.ils ? -3 : 0;
    const along = turn(f.body.hdg, kwikqdrdist(f.body.lat, f.body.lon, o.body.lat, o.body.lon)[0]);
    // In trail, the one behind gives way; otherwise the one changing level does.
    if (Math.abs(turn(f.body.hdg, o.body.hdg)) < 25 && Math.abs(along) < 60) w += 3;
    if (Math.abs(f.body.vsFpm) > 100 || Math.abs(f.body.clearedAlt - f.body.altFt) > 100) w += 2;
    return w;
  };
  return weight(b, a) > weight(a, b) ? [b, a] : [a, b];
}

/** Every option returned has been flown forward against all nearby traffic. */
export function resolutions(sim: Sim, f: Flight, other: Flight, horizonS: number): Option[] {
  const b = f.body;
  const o = other.body;
  const ta = f.port.transitionFt;
  const safe = (apply: (x: Body) => void) => !forecast(sim, f, apply, horizonS);

  const speeds = (): Option | null => {
    if (b.kind === "arr" && b.altFt < 24000) {
      const now = indicatedSpeed(b);
      for (const kt of [250, 230, 210, 190, 180, 170, 160]) {
        if (kt > now - 10 || kt < b.perf.approachCasKt + 10) continue;
        const apply = (x: Body) => void (x.speed = kt);
        if (safe(apply)) return { id: "speed", action: "change_speed", say: `reduce speed ${kt} knots`, reason: `Reducing to ${kt} knots keeps the spacing with no change of track or level.`, effect: () => apply(b) };
      }
      return null;
    }
    const now = b.mach ?? b.perf.mach;
    for (let cut = 1; cut <= 8; cut++) {
      const m = Math.round((now - cut / 100) * 100) / 100;
      const apply = (x: Body) => void (x.mach = m);
      const inTrail = Math.abs(turn(b.hdg, o.hdg)) < 25;
      if (b.altFt < 28000 || (inTrail && trueSpeed({ ...b, mach: m }) > o.gsKt + 0.5)) continue;
      if (safe(apply)) {
        const text = `.${Math.round(m * 100)}`;
        return { id: "speed", action: "change_speed", say: `for spacing, reduce speed to Mach ${text}`, readback: `reducing speed Mach ${text}`, reason: `Mach ${text} removes the closure on ${other.id} without a change of track or level.`, effect: () => apply(b) };
      }
    }
    return null;
  };

  const headings = (): Option[] => {
    if (b.kind === "arr" && b.ils && toGo(b) < 18) return [];
    const req = minimumNm(b, o);
    const c = detect(b, o, req, LOST_FT, horizonS);
    const res = c ? mvp(b, o, c, req + 0.8, VERTICAL_FT, horizonS) : null;
    const wanted = res ? turn(b.hdg, res.hdg) : -turn(b.hdg, kwikqdrdist(b.lat, b.lon, o.lat, o.lon)[0]);
    const first = wanted < 0 ? -1 : 1;
    const found: Option[] = [];
    for (const side of [first, -first]) {
      const from = side === first && res ? Math.min(Math.max(10, Math.ceil(Math.abs(wanted) / 5) * 5), 60) : 10;
      for (let delta = from; delta <= 60; delta += 5) {
        const hdg = mod(Math.round((b.hdg + side * delta) / 5) * 5, 360);
        const apply = (x: Body) => void (x.heading = hdg);
        if (!safe(apply)) continue;
        const way = direction(b.hdg, hdg);
        found.push({
          id: `heading_${way}`, action: "turn_heading",
          say: `turn ${way} heading ${bearing(hdg)}, vectors for traffic`,
          readback: `${way} heading ${bearing(hdg)}`,
          reason: `${side === first ? "The MVP resolution vector points this way. " : ""}A ${delta} degree ${way} turn keeps more than ${req} NM from all traffic.`,
          effect: () => {
            apply(b);
            f.avoid = other.id;
          },
        });
        break;
      }
    }
    return found;
  };

  const levels = (): Option[] => {
    if (b.ils) return [];
    const climbing = b.clearedAlt > b.altFt + 100;
    const descending = b.clearedAlt < b.altFt - 100;
    const floor = Math.ceil((b.elevFt + 2500) / 1000) * 1000;
    const here = Math.round(b.altFt / 1000) * 1000;
    const below = Math.floor(o.altFt / 1000) * 1000 - 1000;
    const above = Math.ceil(o.altFt / 1000) * 1000 + 1000;
    const candidates = climbing ? [below, Math.ceil(b.altFt / 1000) * 1000] : descending ? [above, Math.floor(b.altFt / 1000) * 1000] : [here - 1000, here + 1000, here - 2000, here + 2000];
    const found: Option[] = [];
    for (const alt of new Set(candidates)) {
      if (alt < floor || alt > b.perf.ceilingFt || found.length === 2) continue;
      if (climbing && (alt < b.altFt || alt >= b.clearedAlt)) continue;
      if (descending && (alt > b.altFt || alt <= b.clearedAlt)) continue;
      const apply = (x: Body) => void (x.clearedAlt = alt);
      if (!safe(apply)) continue;
      const to = level(alt, ta);
      const verb = climbing ? "stop climb at" : descending ? "stop descent at" : alt > b.altFt ? "climb to" : "descend to";
      found.push({
        id: `level_${alt}`, action: "change_altitude", say: `${verb} ${to} due traffic`, readback: `${verb} ${to}`,
        reason: `${shortLevel(alt, ta)} guarantees ${VERTICAL_FT} ft from ${other.id} without a change of track.`,
        effect: () => {
          apply(b);
          f.avoid = other.id;
        },
      });
    }
    return found;
  };

  const angle = Math.abs(turn(b.hdg, o.hdg));
  if (angle < 25 && Math.abs(b.clearedAlt - o.clearedAlt) < LOST_FT) {
    const spd = speeds();
    const rest = [...headings(), ...levels()];
    return spd ? [spd, ...rest] : rest;
  }
  const vertical = angle > 150 || Math.abs(b.clearedAlt - b.altFt) > 100;
  return vertical ? [...levels(), ...headings()] : [...headings(), ...levels()];
}

function* resolve(sim: Sim, e: Episode): Proc {
  const { a, b } = e;
  const left = e.dueT - sim.t;
  for (const f of movers(a, b)) {
    if (f.control) continue;
    const other = f === a ? b : a;
    const heading = f.body.heading;
    const cleared = f.body.clearedAlt;
    const horizon = Math.max(Math.round(left + 200), 180);
    let predicted = true;
    const done = yield* sim.exchange(f, {
      urgent: left < 120,
      story: true,
      options: () => {
        predicted = !!probe(f.body, [other], Math.max(e.dueT - sim.t + 90, 90));
        return predicted ? resolutions(sim, f, other, horizon) : [];
      },
      context: () => [
        `Predicted ${e.predictedNm.toFixed(1)} NM from ${other.id} in ${Math.max(0, Math.round(e.dueT - sim.t))} s`,
        `Minimum ${minimumNm(f.body, other.body)} NM or ${VERTICAL_FT} ft`,
        ...sim.facts(other).slice(0, 1),
      ],
    });
    if (!predicted) break;
    if (!done) continue;
    e.acted = true;
    for (const x of [a, b]) {
      x.flags.delete("unresolved");
      x.flags.set(`cd:${(x === a ? b : a).id}`, {
        score: 34, reason: `Resolving predicted ${e.predictedNm.toFixed(1)} NM with ${(x === a ? b : a).id}`, status: x === f ? undefined : "traffic being separated",
      });
    }
    if (f.body.heading !== heading || f.body.clearedAlt !== cleared) sim.spawn(resumeOwn(sim, f, other, heading, cleared));
    if (!other.busy && !other.flags.has("told")) {
      sim.spawn(sim.exchange(other, {
        kind: "advisory",
        options: () => other.body.mode === "air" ? [{
          id: "traffic", action: "traffic_information", say: `${trafficCall(other.body, f.body, f.type)}, being separated`, readback: "copied the traffic",
          reason: `${other.id} keeps its clearance and needs to know why traffic nearby is manoeuvring.`,
        }] : [],
      }));
    }
    e.solving = false;
    e.retryT = sim.t + 30;
    return;
  }
  if (!e.acted && probe(a.body, [b], Math.max(e.dueT - sim.t + 30, 30))) {
    const f = a;
    if (!f.flags.has("unresolved")) {
      f.flags.set("unresolved", { score: 85, reason: `No validated option against ${b.id}`, attention: "human_requested", need: "Controller to separate traffic" });
      sim.stats.escalations++;
      sim.mark(f, "escalation", "No validated option: supervisor requested", b);
    }
  }
  e.solving = false;
  e.retryT = sim.t + 10;
}

function* resumeOwn(sim: Sim, f: Flight, other: Flight, heading: number | null, cleared: number): Proc {
  yield 60;
  const b = f.body;
  const setHeading = b.heading;
  const setAlt = b.clearedAlt;
  const apply = (x: Body) => {
    if (x.heading === setHeading && setHeading !== heading) {
      x.heading = heading;
      while (x.kind !== "arr" && x.leg < x.route.length - 1) {
        const next = x.route[x.leg]!;
        if (Math.abs(turn(x.hdg, qdr(x.lat, x.lon, next.lat, next.lon))) < 80) break;
        x.leg++;
      }
    }
    if (x.clearedAlt === setAlt) x.clearedAlt = cleared;
  };
  for (;;) {
    if (b.mode !== "air" || f.endT !== null) break;
    if (b.heading !== setHeading || (setHeading === heading && b.clearedAlt !== setAlt)) break;
    const horizon = b.altFt < 15000 ? 180 : 420;
    const tight = () => !!forecast(sim, f, apply, horizon, 0.3);
    // "Clear of traffic" is only true after the closest point.
    if (!f.control && !stillConverging(b, other.body) && !tight()) {
      const turning = setHeading !== heading;
      const next = b.route[b.leg];
      const alt = cleared !== setAlt;
      const parts = [
        turning && `resume own navigation direct ${next?.name ?? f.destination}`,
        alt && `${cleared > setAlt ? "climb" : "descend"} to ${level(cleared, f.port.transitionFt)}`,
      ].filter(Boolean).join(", ");
      const done = yield* sim.exchange(f, {
        options: () => (tight() ? [] : [{
          id: "resume", action: turning ? "direct_to" : "change_altitude", say: `clear of traffic, ${parts}`, readback: parts,
          reason: `The original clearance is free of conflict again, so ${other.id} is no longer a constraint.`,
          effect: () => apply(b),
        }]),
      });
      if (done) {
        break;
      }
    }
    yield 15;
  }
  if (f.avoid === other.id) f.avoid = null;
}

export function* conflictMonitor(sim: Sim): Proc {
  const episodes = new Map<string, Episode>();
  for (;;) {
    const flying = sim.airborne();
    for (let i = 0; i < flying.length; i++) {
      for (let j = i + 1; j < flying.length; j++) {
        const a = flying[i]!;
        const b = flying[j]!;
        if (Math.abs(a.body.lat - b.body.lat) > 3) continue;
        const d = kwikdist(a.body.lat, a.body.lon, b.body.lat, b.body.lon);
        const key = `${a.id}/${b.id}`;
        const open = episodes.get(key);
        if (d > 160 && !open) continue;
        const dv = Math.abs(a.body.altFt - b.body.altFt);
        if (open && dv < LOST_FT && separationApplies(a.body, b.body)) open.closestNm = Math.min(open.closestNm, d);
        if (open && (open.solving || sim.t < open.retryT)) continue;

        const req = minimumNm(a.body, b.body);
        const low = staysLow(a.body, b.body);
        const look = low ? 150 : 480;
        // State-based detection finds the pair; the cleared intent then confirms it or dismisses it.
        const state = detect(a.body, b.body, low ? 3 : 5, LOST_FT, look);
        const turningOrLevelling = d < (low ? 25 : 48) && sim.t % 10 === 0 &&
          bottom(a.body) < top(b.body) + LOST_FT && bottom(b.body) < top(a.body) + LOST_FT;
        const within = state ? look : Math.min(look, 150);
        const breach = state || turningOrLevelling ? probe(a.body, [b], within, 0.1) : null;

        if (breach) {
          // The figure shown is the closest point if nobody acts, which can lie beyond the look-ahead.
          const predictedNm = open?.predictedNm ?? probe(a.body, [b], within + 600, 0.1)?.nm ?? breach.nm;
          const e = open ?? { a, b, predictedNm, dueT: 0, closestNm: Infinity, acted: false, solving: false, retryT: 0 };
          e.dueT = sim.t + breach.inS;
          if (!open) {
            episodes.set(key, e);
            sim.stats.conflictsPredicted++;
            for (const [f, o] of [[a, b], [b, a]] as const) {
              f.flags.set(`cd:${o.id}`, {
                score: breach.inS < 120 ? 82 : breach.inS < 240 ? 64 : 52,
                reason: `Predicted ${predictedNm.toFixed(1)} NM with ${o.id}, minima lost in ${breach.inS} s`,
                need: "Separation from traffic", status: "conflict predicted",
              });
              sim.mark(f, "conflict", `Predicted ${predictedNm.toFixed(1)} NM with ${o.id}, minima lost in ${breach.inS} s`, o);
            }
          }
          e.solving = true;
          sim.spawn(resolve(sim, e));
        } else if (open) {
          const closing = kwikdist(...ahead(a.body), ...ahead(b.body)) < d;
          if (open.acted && dv < LOST_FT && ((closing && sim.t < open.dueT) || stillConverging(a.body, b.body))) continue;
          episodes.delete(key);
          if (open.acted && open.closestNm >= req) sim.stats.conflictsResolved++;
          const outcome = dv >= LOST_FT || !Number.isFinite(open.closestNm) ? `${Math.round(dv / 100) * 100} ft vertical` : `closest ${open.closestNm.toFixed(1)} NM`;
          for (const [f, o] of [[a, b], [b, a]] as const) {
            f.flags.delete(`cd:${o.id}`);
            f.flags.delete("unresolved");
            sim.mark(f, "resolved", `Clear of ${o.id}: ${outcome}, was predicted ${open.predictedNm.toFixed(1)}`, o);
          }
        }
      }
    }
    for (const [key, e] of episodes) {
      if (e.a.body.mode === "air" && e.b.body.mode === "air") continue;
      episodes.delete(key);
      if (e.acted && e.closestNm >= 3) sim.stats.conflictsResolved++;
      e.a.flags.delete(`cd:${e.b.id}`);
      e.b.flags.delete(`cd:${e.a.id}`);
    }
    yield 5;
  }
}

const ahead = (b: Body) => qdrpos(b.lat, b.lon, b.hdg, b.gsKt / 360);

/** Crossing traffic that has not reached its closest point yet. */
function stillConverging(a: Body, b: Body): boolean {
  if (a.mode !== "air" || b.mode !== "air" || Math.abs(turn(a.hdg, b.hdg)) < 25) return false;
  const d = kwikdist(a.lat, a.lon, b.lat, b.lon);
  return d < 120 && kwikdist(...ahead(a), ...ahead(b)) < d;
}

/** Traffic information for crossing or passing traffic that is separated vertically. */
export function* advisoryMonitor(sim: Sim): Proc {
  const told = new Set<string>();
  for (;;) {
    const flying = sim.airborne();
    for (let i = 0; i < flying.length; i++) {
      for (let j = i + 1; j < flying.length; j++) {
        const a = flying[i]!;
        const b = flying[j]!;
        const dv = Math.abs(a.body.altFt - b.body.altFt);
        const key = `${a.id}/${b.id}`;
        if (dv < LOST_FT || dv > 2200 || told.has(key) || a.busy || !a.messages.length || a.flags.has(`cd:${b.id}`) || !separationApplies(a.body, b.body)) continue;
        const d = kwikdist(a.body.lat, a.body.lon, b.body.lat, b.body.lon);
        if (d > (a.body.altFt < 15000 ? 6 : 16)) continue;
        if (kwikdist(...ahead(a.body), ...ahead(b.body)) >= d + 0.02) continue;
        told.add(key);
        for (const [f, o] of [[a, b], [b, a]] as const) f.flags.set(`near:${o.id}`, { score: 27, reason: `${o.id} passing ${Math.round(dv / 100) * 100} ft away vertically` });
        sim.spawn(inform(sim, a, b));
      }
    }
    yield 8;
  }
}

function* inform(sim: Sim, a: Flight, b: Flight): Proc {
  yield* sim.exchange(a, {
    kind: "advisory",
    options: () => [{
      id: "traffic", action: "traffic_information", say: trafficCall(a.body, b.body, b.type), readback: "looking for the traffic",
      reason: "Close traffic with vertical separation only, so the crew is told before TCAS shows it.",
    }],
    context: () => [...sim.facts(b).slice(0, 1), "Vertical separation is valid; no clearance change needed"],
  });
  yield 50;
  a.flags.delete(`near:${b.id}`);
  b.flags.delete(`near:${a.id}`);
}

export function landingEta(f: Flight, apply?: (b: Body) => void): number {
  const b = { ...f.body };
  apply?.(b);
  b.heading = null;
  b.orbit = false;
  b.ils = true;
  b.clearedAlt = Math.min(b.clearedAlt, f.port.elevFt + 4000);
  let s = 0;
  while (b.mode === "air" && s < 3600) {
    step(b, 6);
    s += 6;
  }
  return s;
}

/** Orders each landing queue and spaces it by speed, then by a longer route. */
export function* flowManager(sim: Sim): Proc {
  const lastT = new Map<string, number>();
  for (;;) {
    const queues = new Map<string, Flight[]>();
    for (const f of sim.airborne()) {
      if (f.body.kind !== "arr" || f.body.orbit || f.body.heading !== null) continue;
      const key = `${f.port.icao}${f.runway.id}`;
      queues.set(key, [...(queues.get(key) ?? []), f]);
    }
    for (const queue of queues.values()) {
      if (queue.length < 2) continue;
      const eta = new Map(queue.map((f) => [f, landingEta(f)]));
      const order = [...queue].sort((x, y) => eta.get(x)! - (x.priority ? ARRIVAL_SPACING_S * 2 : 0) - (eta.get(y)! - (y.priority ? ARRIVAL_SPACING_S * 2 : 0)));
      for (let i = 1; i < order.length; i++) {
        const lead = order[i - 1]!;
        const f = order[i]!;
        const gap = eta.get(f)! - eta.get(lead)!;
        if (gap >= ARRIVAL_SPACING_S - 8 || f.priority || f.control || f.busy || toGo(f.body) < 12 || sim.t - (lastT.get(f.id) ?? -999) < 120) continue;
        lastT.set(f.id, sim.t);
        sim.spawn(space(sim, lead, f, i + 1));
        break;
      }
    }
    yield 30;
  }
}

function* space(sim: Sim, lead: Flight, f: Flight, number: number): Proc {
  let gap = 0;
  const done = yield* sim.exchange(f, {
    story: true,
    options: () => {
      const b = f.body;
      if (b.mode !== "air" || lead.body.mode !== "air" || b.heading !== null) return [];
      const leadEta = landingEta(lead);
      gap = landingEta(f) - leadEta;
      const good = (apply: (x: Body) => void) => landingEta(f, apply) - leadEta >= ARRIVAL_SPACING_S && !forecast(sim, f, apply, 180);
      const out: Option[] = [];
      const now = indicatedSpeed(b);
      for (const kt of [250, 230, 210, 190, 180, 170, 160]) {
        if (kt > now - 10 || kt < b.perf.approachCasKt + 10 || (b.altFt > 12000 && kt < 220)) continue;
        const apply = (x: Body) => void (x.speed = kt);
        if (!good(apply)) continue;
        out.push({
          id: "speed", action: "sequence_speed", say: `number ${number} behind ${lead.spoken}, reduce speed ${kt} knots`, readback: `number ${number}, speed ${kt} knots`,
          reason: `${kt} knots opens the landing gap behind ${lead.id} to at least ${ARRIVAL_SPACING_S} s.`, effect: () => apply(b),
        });
        break;
      }
      const next = b.route[b.leg];
      if (next && b.route.length - b.leg > 2) {
        const [brg, d] = kwikqdrdist(b.lat, b.lon, next.lat, next.lon);
        if (d > 8) search: for (const off of [4, 6, 8, 11, 14, 18, 23]) {
          for (const side of [-1, 1]) {
            const [lat, lon] = qdrpos(...qdrpos(b.lat, b.lon, brg, d / 2), brg + side * 90, off);
            // A second dogleg needs a fix of its own, or the clearance names one fix twice.
            const fix: Fix = { name: next.name === "DELEX" ? "VEKTA" : "DELEX", lat, lon };
            const route = [fix, ...b.route.slice(b.leg)];
            const apply = (x: Body) => {
              x.route = route;
              x.leg = 0;
            };
            if (!good(apply)) continue;
            out.push({
              id: "path", action: "sequence_vector",
              say: `number ${number} behind ${lead.spoken}, turn ${side < 0 ? "left" : "right"} direct ${fix.name}, then ${next.name}, delay for spacing`,
              readback: `number ${number}, direct ${fix.name} then ${next.name}`,
              reason: `A ${off} NM dogleg absorbs the delay behind ${lead.id}.`, effect: () => apply(b),
            });
            break search;
          }
        }
      }
      return out;
    },
    context: () => [`Landing gap behind ${lead.id}: ${gap} s`, `Required ${ARRIVAL_SPACING_S} s`, `${f.port.icao} runway ${f.runway.id}`],
  });
  if (!done) return;
  f.flags.set("sequence", { score: 26, reason: `Being spaced behind ${lead.id}` });
  sim.mark(f, "resolved", `Sequenced number ${number} behind ${lead.id}`, lead);
  yield 120;
  f.flags.delete("sequence");
}
