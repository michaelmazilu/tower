// The ordinary life of each flight, position by position.
import { runwayPoint } from "./airports";
import { indicatedSpeed, toGo } from "./body";
import { kwikdist, qdrpos } from "./bluesky/geo";
import { free, handoff, missedApproach, runwayKey, setLevel } from "./clearances";
import { forecast } from "./traffic";
import { REGION, destinationWeather, vary } from "./regions";
import { city, level, shortLevel } from "./phrase";
import type { Flight, Option, Proc, Sim } from "./sim";

const heavy = (f: Flight) => (f.body.perf.heavy ? `${f.spoken} heavy` : f.spoken);
const round = (ft: number) => Math.ceil(ft / 1000) * 1000;

function landingBlocked(sim: Sim, f: Flight): Flight | undefined {
  return sim.flights.find((o) =>
    o !== f && sim.live(o) && o.port === f.port && o.runway.id === f.runway.id &&
    ((o.body.mode === "rollout" && !o.vacated) || o.body.mode === "lineup" || o.body.mode === "roll" || (o.body.mode === "air" && o.landingClearance)));
}

export function* arrival(sim: Sim, f: Flight, opts: { checkedIn?: boolean; wait?: number } = {}): Proc {
  yield Math.max(0, f.startT - sim.t) + (opts.wait ?? 0);
  const b = f.body;
  const p = f.port;
  const ta = p.transitionFt;
  const low = round(p.elevFt + 8500);
  const final = round(p.elevFt + 3300);

  if (!opts.checkedIn) {
    const approach = f.position === "approach";
    const target = approach ? final : toGo(b) > 90 ? Math.max(20000, low) : low;
    const call = `${f.facility}, ${heavy(f)}, ${level(b.altFt, ta)}, inbound ${p.name}`;
    if (target < b.clearedAlt && free(f)) {
      yield* setLevel(sim, f, target, { request: `${call}, request descent.`, first: "identified", tail: `expect runway ${f.runway.id}` });
    } else {
      yield* sim.exchange(f, {
        request: { text: `${call}.`, kind: "info" },
        options: () => [{
          id: "identify", action: "radar_identify", say: `identified, maintain ${level(b.clearedAlt, ta)}, expect runway ${f.runway.id}`,
          readback: `maintain ${level(b.clearedAlt, ta)}, runway ${f.runway.id}`, reason: "Radar identification and the landing runway come first.",
        }],
      });
    }
  }

  let briefed = false;
  let number = false;
  let established = false;
  while (b.mode === "air") {
    yield 4;
    if (b.mode !== "air") break;
    const d = toGo(b);
    const closed = sim.closed.has(runwayKey(f));
    if (f.goAround || (closed && d < 8 && b.ils) || (f.position === "tower" && !f.landingClearance && d < 1.8) || (f.position !== "tower" && d < 4)) {
      if (f.control || f.busy) continue;
      const pilotCall = f.goAround === "windshear";
      const holder = landingBlocked(sim, f);
      const why = closed ? "runway closed" : pilotCall ? "windshear reported" : holder ? "runway occupied" : "not stabilised for landing";
      const runway = closed ? p.alternate : f.runway;
      f.flags.set("go_around", { score: 55, reason: `Go-around: ${why}`, need: "Vectors for another approach", status: "going around" });
      const gone = yield* sim.exchange(f, {
        urgent: true, story: true,
        ...(pilotCall && { request: { text: `${f.facility}, ${f.spoken}, windshear warning on final, requesting missed approach.`, kind: "emergency" as const, need: "Missed approach" } }),
        options: () => {
          if (b.mode !== "air") return [];
          // The runway can clear while the call waits for the frequency.
          if (holder && !closed && !f.goAround && !landingBlocked(sim, f) && toGo(b) > 0.7) return [];
          return [missedApproach(f, why, `Landing is no longer safe (${why}), so the approach is discontinued.`, runway)];
        },
        context: () => [`${toGo(b).toFixed(1)} NM from threshold`, holder ? `${holder.id} occupies ${f.runway.id}` : `${runway.id} is available`],
      });
      if (!gone || b.ils) {
        f.flags.delete("go_around");
        number = false;
        continue;
      }
      sim.mark(f, closed ? "closure" : pilotCall ? "weather" : "conflict", `Go-around: ${why}`);
      established = number = false;
      yield* handoff(sim, f, "approach");
      yield* sim.exchange(f, {
        request: { text: `${f.facility}, ${f.spoken}, going around, climbing ${level(b.clearedAlt, ta)}.`, kind: "info" },
        options: () => [{
          id: "recover", action: "sequence", say: `identified, continue for downwind, expect ILS runway ${f.runway.id}, ${Math.round(toGo(b))} miles to run`,
          readback: `continue downwind, ILS runway ${f.runway.id}`, reason: "A wide circuit puts the flight safely back into the landing sequence.",
        }],
      });
      f.flags.delete("go_around");
      sim.mark(f, "resolved", "Back in the landing sequence");
      continue;
    }
    if (f.control || b.orbit) continue;

    if (f.position === "enroute" || f.position === "departure") {
      if (d < 48) {
        yield* handoff(sim, f, "approach");
        yield* sim.exchange(f, {
          request: { text: `${f.facility}, ${heavy(f)}, passing ${level(b.altFt, ta)}, information Kilo.`, kind: "info" },
          options: [{
            id: "approach", action: "approach_information", say: `identified, expect ILS runway ${f.runway.id}, wind ${p.wind}, ${p.qnh}`,
            readback: `ILS runway ${f.runway.id}, ${p.qnh}`, reason: "Approach confirms the runway and current weather before vectoring.",
          }],
        });
      } else if (free(f) && d < 75 && b.clearedAlt > low) {
        if (!(yield* setLevel(sim, f, low))) yield 20;
      }
      continue;
    }

    if (f.position === "approach") {
      if (!free(f)) continue;
      if (d < 42 && b.clearedAlt > final) {
        if (!(yield* setLevel(sim, f, final))) yield 16;
      } else if (!briefed && d < 34 && d > 22) {
        briefed = true;
        const ahead = sim.airborne()
          .filter((o) => o !== f && o.port === p && o.body.kind === "arr" && o.runway === f.runway && !o.body.orbit && (o.priority || !f.priority) && (o.priority && !f.priority || toGo(o.body) < d))
          .sort((x, y) => toGo(y.body) - toGo(x.body));
        const lead = ahead[0];
        const number = `number ${ahead.length + 1}`;
        const reason = lead ? `Behind ${lead.id} in the landing sequence.` : "First in the landing sequence.";
        const kt = lead ? 180 : 210;
        const slow = (x: typeof b) => void (x.speed = kt);
        const slows = !f.priority && b.speed === null && indicatedSpeed(b) > kt + 10 && kt > b.perf.approachCasKt && !forecast(sim, f, slow, 180);
        yield* sim.exchange(f, slows ? {
          options: [{
            id: "sequence_speed", action: "sequence_speed",
            say: lead
              ? `reduce speed ${kt} knots, ${number} behind ${lead.spoken}, runway ${f.runway.id}`
              : `reduce speed ${kt} knots, ${number} for runway ${f.runway.id}, ${Math.round(d)} miles to run`,
            readback: `speed ${kt} knots, ${number}`,
            reason: `${reason} ${kt} knots sets the spacing and passed the separation check.`,
            effect: () => slow(b),
          }],
          context: () => [...ahead.slice(0, 2).map((o) => `Ahead: ${o.id}, ${toGo(o.body).toFixed(0)} NM to run`), `Speed now ${Math.round(indicatedSpeed(b))} kt`],
        } : {
          kind: "advisory",
          options: [{
            id: "sequence", action: "sequence_information", say: `you are ${number} for runway ${f.runway.id}, ${Math.round(d)} miles to run`,
            readback: `${number}, runway ${f.runway.id}`, reason,
          }],
          context: () => ahead.slice(0, 3).map((o) => `Ahead: ${o.id}, ${toGo(o.body).toFixed(0)} NM to run`),
        });
      } else if (!b.ils && d < 22 && !closed) {
        yield* sim.exchange(f, {
          options: () => free(f) ? [{
            id: "ils", action: "clear_approach", say: `${Math.round(toGo(b))} miles to run, cleared ILS approach runway ${f.runway.id}, report established`,
            readback: `cleared ILS runway ${f.runway.id}, wilco`, reason: "The track intercepts the localiser and the glide path is free.",
            effect: () => {
              b.ils = true;
            },
          }] : [],
        });
      } else if (b.ils && d < 11) {
        yield* handoff(sim, f, "tower");
      }
      continue;
    }

    if (f.position !== "tower" || f.landingClearance || closed || f.busy) continue;
    const holder = landingBlocked(sim, f);
    if (established && number && holder) continue;
    const contact = established ? undefined : { text: `${f.facility}, ${heavy(f)}, established ILS runway ${f.runway.id}, ${d.toFixed(0)} miles.`, kind: "info" as const };
    established = true;
    if (holder) {
      number = true;
      yield* sim.exchange(f, {
        ...(contact && { request: contact }),
        options: [{
          id: "continue", action: "continue_approach", say: `continue approach runway ${f.runway.id}, number two, traffic ahead has the runway`,
          readback: `continue approach, number two`, blockedBy: `${holder.id} has runway ${f.runway.id}`, reason: "Landing clearance is withheld until the runway is clear.",
        }],
      });
    } else {
      yield* sim.exchange(f, {
        ...(contact && { request: contact }),
        options: (): Option[] => b.mode !== "air" || sim.closed.has(runwayKey(f)) || landingBlocked(sim, f) || f.goAround ? [] : [{
          id: "land", action: "clear_landing", say: `wind ${p.wind}, runway ${f.runway.id}, cleared to land`, readback: `cleared to land runway ${f.runway.id}`,
          reason: "The runway is open, clear, and nobody ahead holds a landing clearance.",
          effect: () => {
            f.landingClearance = true;
          },
        }],
        context: () => [`Runway ${f.runway.id} clear`],
      });
    }
  }

  for (const key of [...f.flags.keys()]) if (!["mayday", "pan"].includes(key)) f.flags.delete(key);
  f.phase = `landed ${f.runway.id}`;
  yield () => b.gsKt <= 50;
  if (f.vacateDelayS) {
    f.flags.set("stopped", { score: 52, reason: "Landed aircraft cannot vacate the runway", need: "Time to vacate", status: "stopped on runway" });
    yield* sim.exchange(f, {
      kind: "advisory",
      request: { text: `${f.facility}, ${f.spoken}, steering caution, we need a moment on the runway.`, need: "Time to vacate" },
      options: [{
        id: "hold", action: "protect_runway", say: "roger, runway is protected, report able to vacate", readback: "will report able to vacate",
        reason: "An occupied runway cannot be used, so following landings are withheld.",
      }],
    });
    yield f.vacateDelayS;
    f.flags.delete("stopped");
  }
  const side = f.runway.offset < 0 ? "left" : "right";
  const [ground, freq] = p.units.ground;
  yield* sim.exchange(f, {
    options: [{
      id: "vacate", action: "vacate_runway", say: `welcome, vacate ${side}, when clear contact ${ground} on ${freq}`, readback: `vacate ${side}, ${ground} ${freq}`,
      reason: "The runway is needed for the next movement.",
      effect: () => {
        const [lat, lon] = qdrpos(b.lat, b.lon, f.runway.hdg + (side === "left" ? -70 : 70), 0.12);
        b.route = [{ name: "EXIT", lat, lon }];
        b.leg = 0;
        b.mode = "taxi";
        f.vacated = true;
        f.phase = "vacating runway";
        sim.mark(f, "handoff", `${f.facility} to ${ground}`);
        f.position = "ground";
        f.facility = ground;
      },
    }],
  });
  f.flags.delete("pan");
  if (f.flags.has("mayday")) {
    f.flags.set("mayday", { score: 55, reason: "Emergency landing complete, responders in attendance", status: "stopped, responders attending" });
    sim.mark(f, "resolved", "Emergency landed safely");
  }
  const gate = `${"ABCDE"[f.id.length % 5]}${(Number(f.id.slice(3)) % 38) + 1}`;
  yield* sim.exchange(f, {
    request: { text: `${f.facility}, ${f.spoken}, runway ${f.runway.id} vacated, for gate ${gate}.`, need: "Taxi to gate" },
    options: [{
      id: "taxi", action: "clear_taxi", say: `taxi to gate ${gate} via Alpha and Kilo, hold short of any runway`, readback: `gate ${gate} via Alpha, Kilo, hold short of any runway`,
      reason: "The route keeps clear of both active runways.",
      effect: () => {
        const [lat, lon] = qdrpos(p.lat, p.lon, f.runway.hdg + 90, 0.15);
        b.route = [{ name: gate, lat, lon }];
        b.leg = 0;
        b.mode = "taxi";
        f.phase = `taxi to ${gate}`;
      },
    }],
  });
  yield () => b.leg >= b.route.length;
  b.mode = "parked";
  f.phase = `parked ${gate}`;
  f.flags.clear();
  yield 150;
  f.endT = sim.t;
}

export function* departure(sim: Sim, f: Flight, readyAfterS: number, cruiseFt: number): Proc {
  yield f.startT - sim.t + readyAfterS;
  const b = f.body;
  const p = f.port;
  const ta = p.transitionFt;
  const r = f.runway;
  const initial = round(p.elevFt + 4500);
  const squawk = `${2000 + (Number(f.id.slice(3)) % 8) * 100 + 41}`;

  yield* sim.exchange(f, {
    request: { text: `${f.facility}, ${heavy(f)}, at the gate, request IFR clearance to ${city(f.destination)}.`, need: "IFR clearance" },
    options: [{
      id: "ifr", action: "clear_ifr", say: `cleared to ${city(f.destination)} as filed, runway ${r.id}, initial climb ${level(initial, ta)}, squawk ${squawk}`,
      reason: "The filed route is available and the squawk is unique.",
    }],
  });
  yield 25;
  yield* sim.exchange(f, {
    request: { text: `${f.facility}, ${f.spoken}, request push and start.`, need: "Pushback" },
    options: [{
      id: "push", action: "clear_pushback", say: `push and start approved, face west, ${p.qnh}`, readback: `push and start approved, facing west, ${p.qnh}`,
      reason: "The apron behind the stand is clear.",
      effect: () => {
        f.phase = "pushback and start";
      },
    }],
  });
  yield 70;
  yield* sim.exchange(f, {
    request: { text: `${f.facility}, ${f.spoken}, ready to taxi.`, need: "Taxi" },
    options: [{
      id: "taxi", action: "clear_taxi", say: `taxi to holding point runway ${r.id} via Bravo and Echo, hold short`, readback: `holding point runway ${r.id} via Bravo, Echo, hold short`,
      reason: "The route to the departure runway has no opposing traffic.",
      effect: () => {
        const [lat, lon] = runwayPoint(p, r, 0, 0.08);
        b.route = [{ name: "HOLD", lat, lon }, ...b.route];
        b.leg = 0;
        b.mode = "taxi";
        f.phase = `taxi to ${r.id}`;
      },
    }],
  });
  yield () => kwikdist(b.lat, b.lon, b.route[0]!.lat, b.route[0]!.lon) < 0.01;
  b.route = b.route.slice(1);
  b.leg = 0;
  b.mode = "parked";
  f.phase = `holding short ${r.id}`;
  yield* handoff(sim, f, "tower");

  const runwayFree = () => !sim.flights.some((o) =>
    o !== f && sim.live(o) && o.port === p && o.runway.id === r.id &&
    (o.body.mode === "lineup" || o.body.mode === "roll" || (o.body.mode === "rollout" && !o.vacated) ||
      (o.body.mode === "air" && o.body.kind === "arr" && toGo(o.body) < 8) ||
      (o.airborneT !== null && sim.t - o.airborneT < 100)));
  const clearNow = runwayFree();
  yield* sim.exchange(f, {
    request: { text: `${f.facility}, ${heavy(f)}, holding short runway ${r.id}, ready.`, need: "Line-up clearance" },
    options: [clearNow ? {
      id: "lineup", action: "line_up", say: `runway ${r.id}, line up and wait`, readback: `line up and wait runway ${r.id}`,
      reason: "The runway is clear; take-off follows once the departure path is checked.",
      effect: () => lineUp(f),
    } : {
      id: "hold", action: "hold_short", say: `hold short runway ${r.id}, traffic`, blockedBy: "runway or departure spacing in use",
      reason: "Runway separation does not yet exist.",
    }],
  });
  if (!clearNow) {
    yield runwayFree;
    yield* sim.exchange(f, {
      options: [{ id: "lineup", action: "line_up", say: `runway ${r.id}, line up and wait`, reason: "The runway is now clear.", effect: () => lineUp(f) }],
    });
  }
  yield 20;
  yield* sim.exchange(f, {
    options: [{
      id: "takeoff", action: "clear_takeoff", say: `wind ${p.wind}, runway ${r.id}, cleared for take-off`, readback: `cleared for take-off runway ${r.id}`,
      reason: "Runway clear and departure spacing met.",
      effect: () => {
        b.mode = "roll";
        b.clearedAlt = initial;
      },
    }],
  });
  yield () => b.mode === "air";
  f.airborneT = sim.t;
  yield () => b.altFt > p.elevFt + 1000;
  yield* handoff(sim, f, "departure");
  yield* sim.exchange(f, {
    request: { text: `${f.facility}, ${heavy(f)}, airborne runway ${r.id}, passing ${level(b.altFt, ta)} for ${level(initial, ta)}.`, kind: "info" },
    options: [{
      id: "identify", action: "radar_identify", say: "identified, resume own navigation, report any weather", readback: "own navigation, wilco",
      reason: "Radar contact is confirmed on the departure track.",
    }],
  });

  const steps = [Math.min(14000, cruiseFt), Math.min(24000, cruiseFt), cruiseFt];
  let i = 0;
  while (b.kind === "dep" && i < steps.length) {
    yield 8;
    if (b.kind !== "dep" || !free(f) || f.flags.has("mayday")) continue;
    if (i > 0 && b.altFt < steps[i - 1]! - 2500) continue;
    if (i === 2 && f.position === "departure") {
      yield* handoff(sim, f, "enroute");
      continue;
    }
    if (yield* setLevel(sim, f, steps[i]!, i === 2 ? { request: `${f.facility}, ${f.spoken}, climbing ${level(b.clearedAlt, ta)}, requesting ${level(cruiseFt, ta)}.`, first: "identified" } : {})) i++;
    else yield 20;
  }
  if (b.kind !== "dep") return;
  yield () => b.kind !== "dep" || b.altFt > cruiseFt - 3000;
  if (b.kind !== "dep") return;
  yield* sim.exchange(f, {
    kind: "advisory",
    options: [{
      id: "ride", action: "weather_update", say: `ride reports smooth at ${level(cruiseFt, ta)}, light chop above`, readback: "copied, thanks",
      reason: "Recent pilot reports on the route are relayed before top of climb.",
    }],
  });
}

function lineUp(f: Flight): void {
  const b = f.body;
  [b.lat, b.lon] = runwayPoint(f.port, f.runway, 0);
  b.hdg = f.runway.hdg;
  b.mode = "lineup";
  f.phase = `lined up ${f.runway.id}`;
}

const startsClimbing = (f: Flight) => f.body.clearedAlt > f.body.altFt;

export function* cruise(sim: Sim, f: Flight, opts: { next?: [string, string]; quiet?: boolean } = {}): Proc {
  yield f.startT - sim.t + (opts.quiet || startsClimbing(f) ? 1 : 6 + sim.rand() * 50);
  const b = f.body;
  const ta = f.port.transitionFt;
  const inCruise = () => b.kind === "cruise" && !f.control && ![...f.flags.values()].some((x) => x.score >= 50);
  yield* sim.exchange(f, {
    request: {
      text: `${f.facility}, ${heavy(f)}, ${b.clearedAlt > b.altFt ? `passing ${level(b.altFt, ta)} for ` : ""}${level(b.clearedAlt, ta)}, direct ${b.route[0]!.name}.`,
      kind: "info",
    },
    options: () => [{
      id: "identify", action: "radar_identify", say: `radar contact, continue to ${level(b.clearedAlt, ta)}, direct ${b.route[b.leg]!.name}`,
      readback: `${level(b.clearedAlt, ta)}, direct ${b.route[b.leg]!.name}`, reason: "Identity, level and route match the flight plan.",
    }],
    context: () => [`Route ${f.origin} to ${f.destination}`, `Mode C reads ${shortLevel(b.altFt, ta)}`],
  });
  if (opts.quiet) return;

  const squawk = `${4000 + Math.floor(sim.rand() * 7) * 100 + Math.floor(sim.rand() * 7) * 10 + 2}`;
  const region = REGION[f.port.icao as keyof typeof REGION];
  const miles = [40, 60, 80, 110][Math.floor(f.body.perf.ceilingFt / 1000 + f.id.charCodeAt(f.id.length - 1)) % 4]!;
  const chatter: (() => Proc<Option | null>)[] = [
    () => sim.exchange(f, {
      request: {
        text: `${f.facility}, ${f.spoken}, ${vary(`chop${f.id}`, [`occasional light chop at ${level(b.altFt, ta)}, any ride reports?`, `how is the ride ahead at ${level(b.altFt, ta)}?`, `any reports of turbulence further along?`])}`,
        need: "Ride report",
      },
      kind: "advisory",
      options: () => [{
        id: "ride", action: "weather_update",
        say: vary(`ride${f.id}`, [
          `moderate turbulence reported ${miles} miles ahead near ${b.route[b.leg]!.name}, smoother after that`,
          `smooth reports at ${level(b.altFt, ta)} as far as ${b.route[b.leg]!.name}`,
          `light chop reported for the next ${miles} miles, nothing significant beyond`,
        ]),
        readback: vary(`rb${f.id}`, ["copied, we will secure the cabin", "thanks for that", "copied the ride report"]),
        reason: "The latest pilot report on this route is relevant weather.",
      }],
    }),
    () => sim.exchange(f, {
      options: [{ id: "squawk", action: "assign_squawk", say: `squawk ${squawk}`, readback: `squawk ${squawk}`, reason: "A unique code is needed for the next sector." }],
    }),
    () => sim.exchange(f, {
      kind: "info",
      options: () => {
        const mach = `Mach .${Math.round((b.mach ?? b.perf.mach) * 100)}`;
        const heading = String(Math.round(b.hdg) % 360 || 360).padStart(3, "0");
        return [vary(`check${f.id}`, [
          { id: "report_speed", action: "request_speed", say: "say your Mach number", readback: mach, reason: "The actual Mach number is needed to keep spacing in trail." },
          { id: "report_heading", action: "request_heading", say: "say your present heading", readback: `heading ${heading}`, reason: "The heading is co-ordinated with the next sector for traffic crossing its route." },
          { id: "report_level", action: "confirm_altitude", say: `confirm maintaining ${level(b.clearedAlt, ta)}`, readback: `affirm, ${level(b.clearedAlt, ta)}`, reason: "The cleared level is cross-checked against Mode C." },
        ])];
      },
    }),
    () => sim.exchange(f, {
      kind: "info",
      options: () => {
        const next = b.route[b.leg]!;
        const miles = kwikdist(b.lat, b.lon, next.lat, next.lon);
        const minutes = Math.max(1, Math.round((miles / b.gsKt) * 60));
        return [vary(`estimate${f.id}`, [
          {
            id: "estimate", action: "request_estimate", say: `say your estimate for ${next.name}`,
            readback: `${next.name} in ${minutes} minutes`, reason: "The next sector is co-ordinated on the boundary estimate.",
          },
          {
            id: "distance", action: "request_position", say: `say distance to ${next.name}`,
            readback: `${Math.round(miles)} miles to ${next.name}`, reason: "The crew's navigation is cross-checked against radar before the sector boundary.",
          },
        ])];
      },
    }),
    () => sim.exchange(f, {
      kind: "advisory",
      options: [{
        id: "sigmet", action: "weather_update", say: `SIGMET in force, ${vary(`sigmet${f.id}`, region.hazards)}`,
        readback: vary(`sig${f.id}`, ["copy the SIGMET, we will watch the radar", "SIGMET copied", "copied, will call if we need to deviate"]),
        reason: "Significant weather near the route is a critical update.",
      }],
    }),
    () => sim.exchange(f, {
      request: {
        text: `${f.facility}, ${f.spoken}, ${vary(`wx${f.id}`, [`can you pass ${f.destination} landing runway and weather?`, `do you have the latest ${f.destination} weather?`])}`,
        need: "Destination weather",
      },
      kind: "advisory",
      options: [{
        id: "destination", action: "weather_update", say: destinationWeather(f.destination),
        readback: "copied the weather, thanks", reason: "The crew plans the arrival on current destination weather.",
      }],
    }),
  ];
  const start = Math.floor(sim.rand() * chatter.length);
  let said = 0;
  for (let i = 0; i <= chatter.length; i++) {
    yield 210 + sim.rand() * 130;
    if (b.kind !== "cruise" || f.endT !== null) return;
    if (!inCruise()) continue;
    if (i === 2) {
      const next = opts.next ?? [`${f.port.units.enroute[0]} East`, "132.85"];
      yield* handoff(sim, f, "enroute", next);
      yield* sim.exchange(f, {
        request: { text: `${f.facility}, ${heavy(f)}, ${level(b.altFt, ta)}.`, kind: "info" },
        options: () => [{
          id: "identify", action: "radar_identify", say: `identified, maintain ${level(b.clearedAlt, ta)}`, readback: `maintain ${level(b.clearedAlt, ta)}`,
          reason: "The receiving sector confirms identity and cleared level.",
        }],
      });
    } else yield* chatter[(start + said++) % chatter.length]!();
  }
}
