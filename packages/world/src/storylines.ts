import { arrivalRoute, toGo, type Body } from "./body";
import { PORTS, runwayAxes, runwayPoint, type Port, type PortCode, type Runway } from "./airports";
import { mod, qdr } from "./bluesky/geo";
import { becomeInbound, changeRunway, free, milesToRun, runwayKey, setLevel } from "./clearances";
import { bearing, level, TYPE_NAME } from "./phrase";
import { arrival } from "./procedures";
import type { Flight, Option, Proc, Sim } from "./sim";
import { forecast, landingEta } from "./traffic";

const STAND_IN = "Supervisor (scripted stand-in)";

function* responders(sim: Sim, f: Flight, unit: string, detail: string): Proc {
  const order = yield* sim.transmit(f, {
    urgent: true, kind: "emergency", speaker: `${f.facility} to ${unit}`,
    text: `${unit}, ${f.port.name} full emergency: ${f.spoken}, ${TYPE_NAME[f.type]}, runway ${f.runway.id}, ${detail}.`,
    decision: {
      action: "alert_responders", reason: "An emergency landing needs responders in position before touchdown.",
      context: sim.facts(f), verdict: "accepted",
    },
  });
  yield* sim.transmit(f, {
    urgent: true, kind: "info", speaker: `${unit} (simulated)`, replyTo: order,
    text: `${unit} copies, ${f.spoken}, runway ${f.runway.id}, units responding to standby positions.`,
  });
  sim.mark(f, "emergency", `${unit} alerted and responding`);
}

export function* engineFailure(sim: Sim, f: Flight, code: PortCode): Proc {
  yield () => f.body.mode === "air" && f.body.altFt > f.port.elevFt + 2400 && f.position === "departure";
  yield 15;
  const b = f.body;
  f.priority = true;
  // On one engine it climbs at a fraction of the rate.
  b.perf = { ...b.perf, climbFpm: [700, 600, 500, 400] };
  f.flags.set("mayday", { score: 92, reason: "MAYDAY: engine failure", attention: "intervene", need: "Immediate return to land", status: "MAYDAY engine failure" });
  sim.mark(f, "emergency", "MAYDAY: engine failure after departure");
  const p = PORTS[code];
  const alt = Math.ceil((p.elevFt + 3300) / 1000) * 1000;
  yield* sim.exchange(f, {
    urgent: true, story: true,
    request: { text: `Mayday, mayday, mayday, ${f.facility}, ${f.spoken}, left engine failure, request immediate return to land.`, kind: "emergency", need: "Immediate return to land" },
    options: [
      {
        id: "return_landing", action: "emergency_return",
        say: `roger mayday, cleared direct downwind runway ${p.landing.id}, maintain ${level(alt, p.transitionFt)}, all traffic will give way`,
        readback: `direct downwind runway ${p.landing.id}, maintain ${level(alt, p.transitionFt)}`,
        reason: "The landing runway is open and into wind, and the circuit gives the crew time for the checklist.",
        effect: () => {
          becomeInbound(f, code, p.landing, 7);
          shortReturn(f, p.landing);
          b.clearedAlt = alt;
        },
      },
      {
        id: "return_parallel", action: "emergency_return",
        say: `roger mayday, cleared direct downwind runway ${p.alternate.id}, maintain ${level(alt, p.transitionFt)}, all traffic will give way`,
        readback: `direct downwind runway ${p.alternate.id}, maintain ${level(alt, p.transitionFt)}`,
        reason: "The parallel runway keeps the emergency out of the arrival stream.",
        effect: () => {
          becomeInbound(f, code, p.alternate, 7);
          shortReturn(f, p.alternate);
          b.clearedAlt = alt;
        },
      },
    ],
    context: () => ["One engine inoperative", `${p.icao} landing ${p.landing.id}, parallel ${p.alternate.id}`],
  });
  sim.spawn(arrival(sim, f, { checkedIn: true }));
  f.flags.set("mayday", { score: 92, reason: "MAYDAY: engine failure", attention: "intervene", need: "Immediate return to land", status: `MAYDAY, returning ${code}` });
  const landsIn = landingEta(f);
  for (const other of sim.airborne()) {
    if (other === f || other.priority || other.port !== p || other.runway !== f.runway || other.body.kind !== "arr" || other.landingClearance) continue;
    if (landingEta(other) < landsIn + 120) sim.spawn(giveWay(sim, other, f));
  }
  yield* sim.exchange(f, {
    urgent: true, kind: "emergency", readbackKind: "info", story: true,
    options: [{
      id: "souls", action: "request_emergency_details", say: "when able, say souls on board, fuel and dangerous goods",
      readback: "187 souls, 2 hours 40 of fuel, no dangerous goods", reason: "Responders need persons, fuel and cargo hazards.",
    }],
  });
  yield* responders(sim, f, "Airport Fire Rescue", "engine failure, 187 souls, 2 hours 40 of fuel");
  f.flags.set("mayday", { score: 82, reason: "MAYDAY: engine failure, returning with priority", attention: "intervene", need: "Priority landing", status: `MAYDAY, returning ${code}, number one` });
}

/** Downwind and a five mile final: no tour of the arrival stream. */
function shortReturn(f: Flight, r: Runway): void {
  const b = f.body;
  const p = f.port;
  const [x, y] = runwayAxes(p, r, b.lat, b.lon);
  if (x < 0) return;
  const side = y < 0 ? -1 : 1;
  const at = (name: string, along: number, across = 0) => {
    const [lat, lon] = runwayPoint(p, r, along, across);
    return { name, lat, lon };
  };
  b.route = [at("DOWNW", x, side * 4), at("BASIX", -5.5, side * 4), at("INTOL", -5.5), at("FINAX", -3), at(`RW${r.id}`, 0)];
  b.leg = 0;
}

/** Everyone ahead of an emergency is moved off its runway, or held out of the way, on a validated clearance. */
function* giveWay(sim: Sim, f: Flight, emergency: Flight): Proc {
  const from = f.runway;
  const to = f.port.alternate;
  const done = yield* sim.exchange(f, {
    urgent: true,
    options: () => {
      const b = f.body;
      if (b.mode !== "air" || f.runway !== from || f.landingClearance) return [];
      const options: Option[] = [];
      const sidestep = (x: Body) => {
        x.route = arrivalRoute(f.port, to, x.lat, x.lon);
        x.leg = 0;
      };
      if (toGo(b) > 9 && !forecast(sim, f, sidestep, 480)) {
        options.push({
          id: "sidestep", action: "change_runway",
          say: `emergency traffic is number one, break off ${from.id}, change to ILS runway ${to.id}`,
          readback: `break off, ILS runway ${to.id}`,
          reason: `${emergency.id} has an engine failure and is number one for ${from.id}; ${to.id} is clear of it.`,
          effect: () => changeRunway(f, to),
        });
      }
      const orbit = (x: Body) => {
        x.orbit = true;
      };
      if (!forecast(sim, f, orbit, 300)) {
        options.push({
          id: "orbit", action: "hold",
          say: `emergency traffic is number one, orbit right present position, maintain ${level(Math.max(b.clearedAlt, Math.round(b.altFt / 1000) * 1000), f.port.transitionFt)}`,
          readback: "orbit right present position for the emergency",
          reason: `${emergency.id} has an engine failure and is number one; this flight waits out of its way.`,
          effect: () => {
            orbit(b);
            b.clearedAlt = Math.max(b.clearedAlt, Math.round(b.altFt / 1000) * 1000);
          },
        });
      }
      return options;
    },
    context: () => [`${emergency.id}: mayday, number one for ${from.id}`, "Checked against all nearby traffic"],
  });
  if (!done) return;
  f.flags.set("giveway", { score: 30, reason: `Making way for ${emergency.id}`, ...(done.id === "orbit" && { status: `holding for ${emergency.id}` }) });
  sim.mark(f, "resolved", `Making way for ${emergency.id}`, emergency);
  yield () => emergency.body.mode !== "air" || toGo(emergency.body) < 8;
  const b = f.body;
  while (b.orbit) {
    const resume = (x: Body) => {
      x.orbit = false;
    };
    const released = yield* sim.exchange(f, {
      options: () => (forecast(sim, f, resume, 240) ? [] : [{
        id: "release", action: "resume_approach", say: `emergency traffic is ahead, leave the orbit, continue approach runway ${f.runway.id}`,
        readback: `leaving the orbit, runway ${f.runway.id}`, reason: `${emergency.id} is ahead and the way back in is clear.`,
        effect: () => resume(b),
      }]),
    });
    if (released) break;
    yield 15;
  }
  f.flags.delete("giveway");
}

export function* depressurisation(sim: Sim, f: Flight, code: PortCode, atS: number): Proc {
  yield atS;
  const b = f.body;
  const p = PORTS[code];
  f.priority = true;
  f.flags.set("mayday", { score: 96, reason: "MAYDAY: cabin depressurisation", attention: "intervene", need: "Immediate descent", status: "MAYDAY depressurisation" });
  sim.mark(f, "emergency", "MAYDAY: depressurisation");
  yield* sim.exchange(f, {
    urgent: true, story: true,
    request: { text: `Mayday, mayday, mayday, ${f.facility}, ${f.spoken}, depressurisation, request emergency descent.`, kind: "emergency", need: "Immediate descent" },
    options: () => {
      const apply = (x: Body) => {
        x.clearedAlt = 10000;
        x.emergencyDescent = true;
      };
      const hit = forecast(sim, f, apply, 300);
      return [{
        id: "descend", action: "emergency_descent", say: `roger mayday, descend to 10000 feet now, ${hit ? "traffic is being moved" : "no traffic below you"}, ${p.qnh}`,
        readback: `emergency descent 10000 feet, ${p.qnh}`,
        reason: hit ? "The emergency has priority; conflicting traffic will be moved." : "The descent corridor was checked clear down to 10000 ft.",
        effect: () => apply(b),
      }];
    },
  });
  yield 35;
  yield* sim.exchange(f, {
    urgent: true, story: true,
    request: { text: `${f.facility}, ${f.spoken}, crew on oxygen, request diversion ${p.name}.`, kind: "emergency", need: "Diversion" },
    options: [{
      id: "divert", action: "divert", say: `cleared direct ${p.name}, expect runway ${p.landing.id}, squawk 7700`,
      readback: `direct ${p.name}, runway ${p.landing.id}, 7700`, reason: `${p.name} is the nearest suitable runway with full emergency cover.`,
      effect: () => becomeInbound(f, code),
    }],
  });
  sim.spawn(arrival(sim, f, { checkedIn: true }));
  yield* sim.exchange(f, {
    urgent: true, kind: "emergency", readbackKind: "info",
    options: [{
      id: "souls", action: "request_emergency_details", say: "say souls on board and any injuries",
      readback: "242 souls, 3 passengers need medical attention", reason: "Responders need the number aboard and casualties.",
    }],
  });
  yield* responders(sim, f, "Fire and Ambulance Control", "depressurisation, 242 souls, 3 needing medical attention");
  f.flags.set("mayday", { score: 81, reason: "MAYDAY: diverting after depressurisation", attention: "intervene", need: "Priority landing", status: `MAYDAY, diverting ${code}` });
}

export function* medical(sim: Sim, f: Flight, atS: number): Proc {
  yield atS;
  yield () => !f.control;
  f.priority = true;
  f.flags.set("pan", { score: 62, attention: "intervene", reason: "PAN-PAN: medical emergency on board", need: "Priority landing and paramedics", status: "PAN-PAN medical" });
  sim.mark(f, "emergency", "PAN-PAN: medical emergency");
  yield* sim.exchange(f, {
    urgent: true, story: true,
    request: { text: `Pan-pan, pan-pan, pan-pan, ${f.facility}, ${f.spoken}, passenger with suspected cardiac arrest, request priority and paramedics.`, kind: "emergency", need: "Priority landing and paramedics" },
    options: () => [
      {
        id: "priority", action: "priority_approach", say: `roger pan-pan, you are number one, expect short final runway ${f.runway.id}, ${milesToRun(f)} miles to run`,
        readback: `number one, short final runway ${f.runway.id}`, reason: "A medical urgency goes to the front of the landing sequence.",
      },
      {
        id: "priority_speed", action: "priority_approach", say: `roger pan-pan, you are number one, no speed restrictions, runway ${f.runway.id}`,
        readback: `number one, no speed restrictions, runway ${f.runway.id}`, reason: "Priority with no speed restriction shortens the time to medical care.",
        effect: () => {
          f.body.speed = null;
        },
      },
    ],
  });
  yield* responders(sim, f, "Airport Paramedics", "medical emergency, one passenger");
  f.flags.set("pan", { score: 53, attention: "intervene", reason: "PAN-PAN: medical, paramedics meeting aircraft", need: "Priority landing", status: "PAN-PAN priority" });
}

export function* minimumFuel(sim: Sim, f: Flight, atS: number): Proc {
  yield atS;
  f.priority = true;
  f.flags.set("fuel", { score: 58, attention: "intervene", reason: "Minimum fuel declared", need: "No further delay", status: "minimum fuel" });
  sim.mark(f, "emergency", "Minimum fuel declared");
  yield* sim.exchange(f, {
    urgent: true, story: true,
    request: { text: `${f.facility}, ${f.spoken}, minimum fuel.`, kind: "emergency", need: "No further delay" },
    options: () => [{
      id: "no_delay", action: "protect_sequence", say: `roger minimum fuel, no delay expected, ${milesToRun(f)} miles to run`,
      readback: "no delay, will advise if it becomes a mayday", reason: "The flight is protected from any further speed or path delay.",
    }],
  });
}

export function* closure(sim: Sim, flights: Flight[], trigger: Flight, why: string): Proc {
  yield () => trigger.position === "tower" && toGo(trigger.body) < 6.5;
  const p: Port = trigger.port;
  const shut = trigger.runway;
  sim.closed.add(runwayKey(trigger));
  for (const f of flights) {
    if (f.port !== p || f.endT !== null || f.body.kind !== "arr" || f.body.mode !== "air" || f.runway.id !== shut.id) continue;
    f.flags.set("closure", { score: 56, reason: `Runway ${shut.id} closed: ${why}`, need: "Another runway", status: `runway ${shut.id} closed` });
    sim.mark(f, "closure", `Runway ${shut.id} closed: ${why}`);
    // An aircraft on short final goes around; the landing procedure issues that.
    if (f !== trigger) sim.spawn(reassign(sim, f, why));
  }
}

function* reassign(sim: Sim, f: Flight, why: string): Proc {
  const from = f.runway;
  const to = f.port.alternate;
  yield* sim.exchange(f, {
    urgent: true, story: true,
    options: () => f.body.mode === "air" && f.runway === from ? [{
      id: "alternate", action: "change_runway", say: `runway ${from.id} is closed due ${why}, runway change, expect ILS runway ${to.id}`,
      readback: `copy ${from.id} closed, expect ILS runway ${to.id}`, reason: `${to.id} is open and has the same orientation into wind.`,
      effect: () => changeRunway(f, to),
    }] : [],
    context: () => [`${from.id} closed: ${why}`, `${to.id} open`],
  });
  f.flags.set("closure", { score: 28, reason: `Moved to ${to.id} after closure of ${from.id}` });
  sim.mark(f, "resolved", `Now landing ${to.id}`);
  yield 180;
  f.flags.delete("closure");
}

export function* windshear(sim: Sim, flights: Flight[], escaping: Flight, atS: number): Proc {
  yield atS;
  for (const f of flights) {
    if (f.port !== escaping.port || f.body.mode !== "air" || f.body.kind !== "arr") continue;
    f.flags.set("weather", { score: 42, reason: "Windshear alert on final", need: "Current wind", status: "windshear alert" });
    sim.mark(f, "weather", "Windshear alert on final");
    sim.spawn(sim.exchange(f, {
      kind: "advisory", story: true,
      options: [{
        id: "windshear", action: "weather_alert", say: `windshear alert runway ${f.runway.id}, minus 20 knots at 3 miles final`,
        readback: "copy windshear, minus 20 at 3 miles", reason: "A windshear alert is critical for every aircraft on that approach.",
      }],
    }));
  }
  yield () => escaping.position === "tower" && toGo(escaping.body) < 3.4;
  if (escaping.body.mode === "air") escaping.goAround = "windshear";
  yield 320;
  for (const f of flights) f.flags.delete("weather");
}

export function* weatherDeviation(sim: Sim, f: Flight, atS: number, lastsS: number): Proc {
  yield atS;
  yield () => free(f);
  const b = f.body;
  const base = b.hdg;
  const to = (deg: number) => Math.round(mod(base + deg, 360) / 5) * 5;
  f.flags.set("weather", { score: 46, reason: "Thunderstorm cell on track", need: "Deviation around weather", status: "weather ahead" });
  sim.mark(f, "weather", "Thunderstorm cell on track");
  const turnTo = (side: "left" | "right"): Option | null => {
    const hdg = to(side === "right" ? 20 : -20);
    const apply = (x: Body) => void (x.heading = hdg);
    if (forecast(sim, f, apply, 480)) return null;
    return {
      id: side, action: "weather_deviation", say: `deviation approved, turn ${side} heading ${bearing(hdg)}, report clear of weather`,
      readback: `${side} heading ${bearing(hdg)}, will report clear of weather`,
      reason: `Twenty degrees ${side} avoids the cell and passed the eight-minute separation check.`,
      effect: () => {
        apply(b);
        f.avoid = "weather";
      },
    };
  };
  let blocked = false;
  yield* sim.exchange(f, {
    story: true,
    request: { text: `${f.facility}, ${f.spoken}, request 20 degrees right due weather.`, need: "Deviation around weather" },
    options: () => {
      const right = turnTo("right");
      if (right) return [right];
      blocked = true;
      const hit = forecast(sim, f, (x) => void (x.heading = to(20)), 480)!;
      return [{
        id: "unable", action: "refuse_deviation", say: `unable right due traffic, ${hit.other.spoken} is on that side, standby for left`,
        readback: "standing by for left", blockedBy: `${hit.other.id} would be ${hit.nm.toFixed(1)} NM away`,
        reason: "The requested side failed the separation check.",
      }];
    },
  });
  while (blocked && b.heading === null) {
    const done = yield* sim.exchange(f, {
      story: true,
      options: () => [turnTo("left")].filter((o) => o !== null),
      context: () => ["Right side blocked by traffic", "Left side checked for eight minutes"],
    });
    if (!done) yield 15;
  }
  f.flags.set("weather", { score: 30, reason: "Deviating around a thunderstorm", status: "weather deviation" });
  yield lastsS;
  f.flags.delete("weather");
  const back = (x: Body) => {
    x.heading = null;
  };
  let asked = false;
  for (;;) {
    const request = asked ? {} : { request: { text: `${f.facility}, ${f.spoken}, clear of weather, request direct.`, need: "Direct routing" } };
    asked = true;
    const done = yield* sim.exchange(f, {
      ...request,
      options: () => forecast(sim, f, back, 300) ? [] : [{
        id: "direct", action: "direct_to", say: `roger, proceed direct ${b.route[b.leg]!.name}`, readback: `direct ${b.route[b.leg]!.name}`,
        reason: "The route back was checked clear of traffic.", effect: () => back(b),
      }],
    });
    if (done) break;
    yield 20;
  }
  if (f.avoid === "weather") f.avoid = null;
  sim.mark(f, "resolved", "Clear of weather, back on route");
}

export function* blockedClimb(sim: Sim, f: Flight, atS: number, wanted: number): Proc {
  yield atS;
  const b = f.body;
  const ta = f.port.transitionFt;
  f.flags.set("climb", { score: 28, reason: "Requested level is occupied", need: level(wanted, ta) });
  yield* sim.exchange(f, {
    story: true,
    request: { text: `${f.facility}, ${f.spoken}, request climb ${level(wanted, ta)}.`, need: level(wanted, ta) },
    options: () => {
      const hit = forecast(sim, f, (x) => void (x.clearedAlt = wanted), 420);
      if (!hit) return [{ id: "climb", action: "change_altitude", say: `climb to ${level(wanted, ta)}`, effect: () => void (b.clearedAlt = wanted), reason: "The level is free." }];
      return [{
        id: "unable", action: "refuse_altitude", say: `unable ${level(wanted, ta)} due traffic, can you accept ${level(wanted - 1000, ta)}`,
        readback: `affirm, we can accept ${level(wanted - 1000, ta)}`, blockedBy: `${hit.other.id} would be ${hit.nm.toFixed(1)} NM away at that level`,
        reason: "The requested level failed the separation check; the level below may work.",
      }];
    },
  });
  if (b.clearedAlt !== wanted) yield* setLevel(sim, f, wanted - 1000);
  f.flags.delete("climb");
}

export function* radioFailure(sim: Sim, f: Flight, atS: number): Proc {
  yield atS;
  f.flags.set("comms", { score: 52, reason: "No reply to a controller call", status: "no radio contact" });
  yield* sim.transmit(f, {
    kind: "advisory", text: `${f.spoken}, ${f.facility}, how do you read?`,
    decision: { action: "radio_check", reason: "An expected reply is missing.", context: sim.facts(f), verdict: "accepted" },
  });
  yield 28;
  f.flags.set("comms", { score: 72, reason: "Two calls unanswered", attention: "intervene", need: "Radio contact", status: "radio failure suspected" });
  sim.mark(f, "escalation", "Radio contact lost: supervisor alerted");
  sim.stats.escalations++;
  yield* sim.transmit(f, {
    kind: "escalation", text: `${f.spoken}, ${f.facility}, radio check. If you read, squawk ident. Supervisor is being alerted.`,
    decision: { action: "escalate", reason: "Two unanswered calls meet the lost-communication rule.", context: sim.facts(f), verdict: "accepted" },
  });
  yield 45;
  yield* sim.transmit(f, {
    kind: "advisory", text: `${f.spoken}, ${f.facility} on guard, 121.5, contact ${f.port.units.enroute[1]}.`,
    decision: { action: "call_on_guard", reason: "The emergency frequency is the next means of contact.", context: sim.facts(f), verdict: "accepted" },
  });
  yield 100;
  yield* sim.exchange(f, {
    story: true,
    request: { text: `${f.facility}, ${f.spoken} on guard, we had the wrong frequency, reading you now.`, kind: "info" },
    options: () => [{
      id: "restore", action: "restore_communications", say: `loud and clear, return to ${f.port.units.enroute[1]}, confirm maintaining ${level(f.body.clearedAlt)}`,
      readback: `${f.port.units.enroute[1]}, maintaining ${level(f.body.clearedAlt)}`, reason: "Contact is restored; the cleared level must be reconfirmed.",
    }],
  });
  f.flags.delete("comms");
  sim.mark(f, "resolved", "Radio contact restored");
}

function* askHuman(sim: Sim, f: Flight, ask: string, need: string, why: string): Proc {
  f.flags.set("human", { score: 74, reason: why, attention: "human_requested", need, status: "human requested" });
  sim.stats.escalations++;
  sim.mark(f, "escalation", `Human requested: ${need}`);
  yield* sim.exchange(f, {
    kind: "escalation", readbackKind: "info", urgent: true, story: true,
    request: { text: ask, kind: "escalation", need },
    options: () => [{
      id: "escalate", action: "request_human", say: `understood, I am calling the supervisor, maintain ${level(f.body.clearedAlt, f.port.transitionFt)} and stand by`,
      readback: `maintain ${level(f.body.clearedAlt, f.port.transitionFt)}, standing by for the supervisor`,
      reason: `${why}. The agent has no authority to decide this.`,
    }],
  });
}

function* standIn(sim: Sim, f: Flight, waitS: number, order: () => Option): Proc {
  yield waitS;
  yield () => !f.busy;
  f.control = true;
  f.flags.delete("human");
  f.flags.set("takeover", { score: 55, reason: "Supervisor is deciding", need: "Supervisor instruction", status: "under human control" });
  sim.mark(f, "takeover", "Supervisor took control (scripted stand-in)");
  yield* sim.transmit(f, { from: "operator", speaker: STAND_IN, kind: "info", urgent: true, text: `${f.spoken}, supervisor on frequency, I have you, stand by.` });
  yield 20;
  yield* sim.exchange(f, { operator: true, urgent: true, options: [order()] });
  f.control = false;
  f.flags.delete("takeover");
  sim.mark(f, "handback", "Handed back to the agent");
  yield* sim.exchange(f, {
    kind: "advisory",
    options: [{
      id: "resume", action: "resume_control", say: "supervisor decision copied, I will continue with you from here", readback: "roger, thanks",
      reason: "The human decision is in effect, so routine control returns to the agent.",
    }],
  });
}

export function* diversionDecision(sim: Sim, f: Flight, code: PortCode, atS: number): Proc {
  yield atS;
  const p = PORTS[code];
  yield* askHuman(sim, f,
    `${f.facility}, ${f.spoken}, sick passenger, we are 30 tonnes over landing weight, request a supervisor for diversion ${p.name}.`,
    "Supervisor approval for an overweight diversion", "An overweight diversion needs human approval");
  yield* standIn(sim, f, 300, () => ({
    id: "approve", action: "approve_diversion",
    say: `diversion approved, proceed direct ${p.name}, descend to flight level 200, full length runway ${p.landing.id}`,
    readback: `direct ${p.name}, descend flight level 200, runway ${p.landing.id}`,
    reason: "Scripted stand-in: the airport accepts an overweight landing.",
    effect: () => {
      becomeInbound(f, code);
      f.body.clearedAlt = Math.min(f.body.clearedAlt, 20000);
      f.priority = true;
    },
  }));
  sim.spawn(arrival(sim, f, { checkedIn: true }));
  f.flags.set("pan", { score: 42, reason: "Approved overweight diversion", status: `diverting ${code}` });
}

export function* hydraulicFailure(sim: Sim, f: Flight, atS: number): Proc {
  yield atS;
  const b = f.body;
  f.priority = true;
  sim.mark(f, "emergency", "Hydraulic failure");
  f.flags.set("hydraulic", { score: 66, reason: "Hydraulic failure, longer landing distance", need: "Time and a longer runway", status: "hydraulic failure" });
  const orbit = (x: Body) => {
    x.orbit = true;
  };
  yield* sim.exchange(f, {
    urgent: true, story: true,
    request: { text: `Pan-pan, pan-pan, pan-pan, ${f.facility}, ${f.spoken}, hydraulic failure, request delay for checklists.`, kind: "emergency", need: "Time for checklists" },
    options: () => forecast(sim, f, orbit, 240) ? [{
      id: "continue", action: "maintain_route", say: "roger pan-pan, continue present routing, no speed restrictions",
      readback: "continue present routing", reason: "A hold here would conflict, so the present route is kept.",
    }] : [{
      id: "orbit", action: "hold", say: `roger pan-pan, orbit right present position, maintain ${level(b.clearedAlt, f.port.transitionFt)}`,
      readback: `orbit right, maintain ${level(b.clearedAlt, f.port.transitionFt)}`, reason: "An orbit in checked airspace buys time for the checklist.",
      effect: () => orbit(b),
    }],
  });
  yield 45;
  const r = f.port.alternate;
  yield* askHuman(sim, f, `${f.facility}, ${f.spoken}, we need the departure runway ${r.id} for landing, longer and no turn-off.`,
    `Supervisor approval to land on runway ${r.id}`, "Landing on the departure runway stops all departures");
  yield* standIn(sim, f, 90, () => ({
    id: "approve", action: "approve_runway",
    say: `departures are stopped, leave the orbit, proceed for runway ${r.id}, priority approach`,
    readback: `leaving the orbit for runway ${r.id}`, reason: "Scripted stand-in: departures paused, runway granted.",
    effect: () => {
      b.orbit = false;
      changeRunway(f, r);
    },
  }));
  yield* responders(sim, f, "Airport Fire Rescue", "hydraulic failure, possible stop on the runway");
  f.flags.set("hydraulic", { score: 54, reason: "Hydraulic failure, priority landing", need: "Priority landing", status: "priority landing" });
}

export function* unresolvedHuman(sim: Sim, f: Flight, atS: number): Proc {
  yield atS;
  yield* askHuman(sim, f,
    `${f.facility}, ${f.spoken}, disruptive passenger restrained, captain requests a human supervisor about police and diversion.`,
    "A supervisor for security and diversion", "A security diversion is a human decision");
  yield 150;
  yield* sim.exchange(f, {
    kind: "advisory", readbackKind: "info",
    options: () => [{
      id: "waiting", action: "await_human", say: `supervisor has been alerted and not yet answered, your route is clear on heading ${bearing(qdr(f.body.lat, f.body.lon, f.body.route[f.body.leg]!.lat, f.body.route[f.body.leg]!.lon))}, continue`,
      readback: "continuing, cabin is secure for now", reason: "The agent keeps the flight separated but leaves the decision open for a person.",
    }],
  });
}
