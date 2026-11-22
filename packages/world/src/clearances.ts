import { arrivalRoute, toGo, type Body } from "./body";
import { PORTS, type PortCode, type Runway } from "./airports";
import type { ControlPosition } from "@towerai/contracts";
import { level } from "./phrase";
import type { Flight, Option, Proc, Sim } from "./sim";
import { forecast } from "./traffic";

export const runwayKey = (f: Flight, r: Runway = f.runway) => `${f.port.icao}${r.id}`;
/** Routine clearances wait for conflicts, holds and people. */
export const free = (f: Flight) => !f.avoid && !f.control && !f.body.orbit && f.body.heading === null && f.endT === null;

export function* handoff(sim: Sim, f: Flight, to: ControlPosition, unit: [string, string] = f.port.units[to]): Proc {
  const [name, freq] = unit;
  yield* sim.exchange(f, {
    kind: "handoff",
    options: [{
      id: "handoff", action: "handoff", say: `contact ${name} on ${freq}, good day`, readback: `${name} ${freq}, good day`,
      reason: `The flight is leaving this position's airspace; ${name} is responsible next.`,
      effect: () => {
        sim.mark(f, "handoff", `${f.facility} to ${name}`);
        f.position = to;
        f.facility = name;
      },
    }],
  });
}

export function* setLevel(sim: Sim, f: Flight, target: number, opts: { request?: string; first?: string; tail?: string } = {}): Proc<boolean> {
  const b = f.body;
  const verb = target > b.clearedAlt ? "climb to" : "descend to";
  const to = level(target, f.port.transitionFt);
  const qnh = target < f.port.transitionFt && b.altFt >= f.port.transitionFt ? `, ${f.port.qnh}` : "";
  const tail = `${qnh}${opts.tail ? `, ${opts.tail}` : ""}`;
  const apply = (x: Body) => void (x.clearedAlt = target);
  const wrong = level(target + (target > b.clearedAlt ? 2000 : -1000), f.port.transitionFt);
  const misheard = f.misreads ? `${verb} ${wrong}${qnh}` : undefined;
  f.misreads = false;
  const done = yield* sim.exchange(f, {
    ...(opts.request && { request: { text: opts.request, need: target > b.clearedAlt ? "Climb clearance" : "Descent clearance" } }),
    ...(misheard && { misheard }),
    context: () => [`${to} checked against traffic for 180 s`],
    options: (): Option[] => {
      if (!free(f)) return [];
      const hit = forecast(sim, f, apply, 180, 0.2);
      const lead = opts.first ? `${opts.first}, ` : "";
      if (hit) {
        return opts.request || opts.first ? [{
          id: "wait", action: "maintain_altitude", say: `${lead}maintain ${level(b.clearedAlt, f.port.transitionFt)}, expect ${verb.split(" ")[0]} shortly due traffic`,
          readback: `maintain ${level(b.clearedAlt, f.port.transitionFt)}`, blockedBy: `${hit.other.id} would be ${hit.nm.toFixed(1)} NM away`,
          reason: "The requested level failed the separation check, so it is withheld.",
        }] : [];
      }
      return [{
        id: "level", action: "change_altitude", say: `${lead}${verb} ${to}${tail}`, readback: `${verb} ${to}${tail}`,
        reason: `${to} follows the profile and passed the separation check.`, effect: () => apply(b),
      }];
    },
  });
  return done?.id === "level";
}

export function missedApproach(f: Flight, why: string, reason: string, runway: Runway): Option {
  const p = f.port;
  const alt = Math.ceil((p.elevFt + 2500) / 1000) * 1000;
  return {
    id: "go_around", action: "go_around",
    say: `go around, I say again, go around, ${why}, climb to ${level(alt, p.transitionFt)}, expect vectors runway ${runway.id}`,
    readback: `going around, climb to ${level(alt, p.transitionFt)}`,
    reason,
    effect: () => {
      const b = f.body;
      if (b.mode !== "air") return;
      f.runway = runway;
      b.route = arrivalRoute(p, runway, b.lat, b.lon, 8);
      b.leg = 0;
      b.ils = false;
      b.speed = null;
      b.clearedAlt = alt;
      f.landingClearance = false;
      f.goAround = null;
    },
  };
}

export function changeRunway(f: Flight, runway: Runway, finalNm?: number): void {
  const b = f.body;
  f.runway = runway;
  b.route = arrivalRoute(f.port, runway, b.lat, b.lon, finalNm);
  b.leg = 0;
  b.runwayHdg = runway.hdg;
}

/** The effect of a clearance that turns any flight into an inbound for `code`. */
export function becomeInbound(f: Flight, code: PortCode, runway?: Runway, finalNm?: number): void {
  const p = PORTS[code];
  f.port = p;
  f.destination = p.icao;
  f.body.kind = "arr";
  f.body.elevFt = p.elevFt;
  f.body.mach = null;
  f.body.heading = null;
  changeRunway(f, runway ?? p.landing, finalNm);
}

export const milesToRun = (f: Flight) => Math.round(toGo(f.body));
