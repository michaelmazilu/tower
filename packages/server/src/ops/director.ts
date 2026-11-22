import {
  AIRBORNE_PHASES,
  NM,
  Rng,
  angleDiff,
  bearing,
  controlPosition,
  dist,
  distanceToThreshold,
  flyingSec,
  touchdownIn,
  type Aircraft,
  type Command,
  type SimEvent,
  type Position,
  type Simulation,
} from "@towerai/core";
import { radioSpeech } from "../voice/speech";

/**
 * Runs the judge demo: keeps traffic coming, injects the disruptions and says
 * the procedural lines (handoffs, traffic, weather, responders). Rules, not a
 * model. It acts only through simulation commands, so a run replays from its log.
 */

const CLOSED = "06L/24R";
const NORMAL = { arrivals: ["23", "24R"], departures: ["23", "24L"] };
const WHILE_CLOSED = { arrivals: ["23", "24L"], departures: ["23", "24L"] };

// One box each, all on one screen.
const TRAFFIC_POPULATION = 15;
const MOST_LIVE = 16;
const FIRE = "fire and rescue";
const ARRIVAL_EVERY_SEC = 130;
const DEPARTURE_EVERY_SEC = 135;
const ARRIVAL_SPAWN_NM = 24;
/** Seconds between touchdowns on one runway: a rollout, or a departure in the gap. */
const ARRIVAL_SPACING_SEC = 220;
const PARKED_FOR_SEC = 75;

const FLEET: [airline: string, types: string[]][] = [
  ["ACA", ["A320", "A321", "B38M", "B789"]],
  ["WJA", ["B38M", "B789"]],
  ["POE", ["E175", "DH8D"]],
  ["JZA", ["CRJ9", "E175", "DH8D"]],
  ["ROU", ["A319", "A321"]],
  ["TSC", ["A321", "A333"]],
  ["FLE", ["B38M"]],
  ["DAL", ["B739", "A319"]],
  ["UAL", ["A319", "B739"]],
  ["AAL", ["E175", "A319"]],
  ["SWG", ["B38M"]],
  ["KLM", ["B789"]],
];

const TYPE_NAMES: Record<string, string> = { B38M: "737 MAX", B739: "737", B77W: "777", B789: "787", A333: "A330", DH8D: "Dash 8", E175: "Embraer 175", CRJ9: "CRJ" };
const spell = (type: string) => TYPE_NAMES[type] ?? type;

interface Beat {
  at: number;
  /** Gives up after this, so a beat whose aircraft has gone does not fire minutes late. */
  until: number;
  /** True once it has happened. */
  run: () => boolean;
}

export class Director {
  private readonly rng: Rng;
  private beats: Beat[];
  private readonly positions = new Map<string, Position>();
  private readonly toldCentre = new Set<string>();
  private readonly toldTraffic = new Set<string>();
  private readonly used = new Set<string>();
  private readonly wentAround = new Set<string>();
  /** Tower transmission -> what the crew answers once it has heard it. */
  private readonly replies = new Map<string, { aircraftId: string; kind: "traffic" | "handoff" | "details" | "responders_ack"; text: string }>();
  private lastTraffic = -Infinity;
  private nextArrival = 220;
  private lastReady = 650;
  private readonly unsubscribe: () => void;

  constructor(private readonly sim: Simulation) {
    this.rng = new Rng(sim.config.seed ^ 0x7051ac);
    for (const ac of sim.aircraft.values()) {
      this.used.add(ac.id);
      this.positions.set(ac.id, controlPosition(sim, ac));
    }
    this.beats = this.script();
    this.unsubscribe = sim.on((e) => this.react(e));
  }

  detach(): void {
    this.unsubscribe();
  }

  update(): void {
    const { sim } = this;
    if (sim.tick % Math.round(1 / sim.config.dt) !== 0) return;
    this.beats = this.beats.filter((b) => {
      if (sim.time < b.at) return true;
      if (sim.time > b.until) return false;
      return !b.run();
    });
    this.handoffs();
    this.trafficAdvisory();
    this.flow();
  }

  private ok(command: Command): boolean {
    return this.sim.dispatch(command).ok;
  }

  private say(
    kind: Extract<Command, { type: "advisory.issue" }>["kind"],
    text: string,
    options: { aircraftId?: string; by?: "pilot"; replyTo?: string; reason?: string } = {},
  ): string | undefined {
    const result = this.sim.dispatch({ type: "advisory.issue", kind, text, spoken: radioSpeech(text), ...options });
    return result.ok ? String(result.transmissionId) : undefined;
  }

  private script(): Beat[] {
    const { sim } = this;
    const pick = (match: (ac: Aircraft) => boolean, preferred?: string) => {
      const first = preferred ? sim.get(preferred) : undefined;
      return first && match(first) ? first : [...sim.aircraft.values()].find(match);
    };
    return [
      {
        at: 5,
        until: 45,
        // Once the arrival owns the runway, the departure rolls through the hold line.
        run: () =>
          (sim.get("ACA214")?.landingCleared === true || sim.time >= 16) &&
          this.ok({ type: "emergency.trigger", emergencyType: "runway_incursion", aircraftId: "WJA302" }),
      },
      {
        at: 25,
        until: 120,
        run: () => {
          const ac = pick((a) => a.phase === "approach" && !a.emergencyId && !a.humanControl, "DLH471");
          if (!ac) return false;
          this.ok({ type: "priority.set", aircraftId: ac.id, priority: "urgent", reason: "Passenger medical emergency on board." });
          return this.ok({
            type: "pilot.request",
            aircraftId: ac.id,
            requestType: "OTHER",
            text: `${controlPosition(sim, ac) === "tower" ? "Tower" : "Approach"}, ${ac.callsign}, passenger medical emergency, request a human controller.`,
          });
        },
      },
      {
        at: 48,
        until: 200,
        run: () =>
          this.say("weather", "All stations, Toronto weather, wind 230 at 18 gusting 27, snow, braking action poor runway 24R.", {
            reason: "Scenario weather update. Advisory: the flight model has no wind.",
          }) !== undefined,
      },
      {
        at: 75,
        until: 600,
        run: () => {
          const reason = "Poor braking action in snow; closed for clearing.";
          if (!this.ok({ type: "runways.set_active", ...WHILE_CLOSED, closed: [CLOSED], reason })) return false;
          this.say("closure", "All stations, runway 24R is closed for snow clearing, arrivals use runway 24L.", { reason });
          return true;
        },
      },
      {
        at: 60,
        until: 175,
        run: () => {
          const ac = pick((a) => a.phase === "departure", sim.time < 130 ? "UAL119" : undefined);
          return !!ac && this.ok({ type: "emergency.trigger", emergencyType: "engine_failure", aircraftId: ac.id });
        },
      },
      {
        at: 480,
        until: 900,
        run: () => {
          // 24L stays open to those already lined up on it.
          const arrivals = [...NORMAL.arrivals, "24L"];
          if (!this.ok({ type: "runways.set_active", arrivals, departures: NORMAL.departures, closed: [], reason: "Snow clearing complete." })) return false;
          this.say("closure", "All stations, runway 24R is open.", { reason: "Snow clearing complete." });
          return true;
        },
      },
      {
        at: 610,
        until: 700,
        run: () => this.ok({ type: "emergency.trigger", emergencyType: "taxiway_blocked" }),
      },
      {
        at: 760,
        until: 900,
        run: () => {
          const ac = pick(
            (a) => a.phase === "approach" && a.priority === "normal" && !a.humanControl && !this.wentAround.has(a.id) && distanceToThreshold(sim, a) < 4 * NM,
          );
          return !!ac && this.ok({ type: "emergency.trigger", emergencyType: "go_around", aircraftId: ac.id });
        },
      },
    ];
  }

  private react(e: SimEvent): void {
    const { sim } = this;
    const ac = e.aircraftId ? sim.get(e.aircraftId) : undefined;

    if (e.type === "radio.tx_requeued") {
      const waiting = this.replies.get(String(e.data.replaces));
      if (waiting) this.replies.set(String(e.data.transmissionId), waiting);
      return;
    }
    if (e.type === "radio.tx_completed") {
      const id = String(e.data.transmissionId);
      const reply = this.replies.get(id);
      if (!reply) return;
      this.replies.delete(id);
      const crew = sim.get(reply.aircraftId);
      if (!crew) return;
      if (reply.kind === "responders_ack") this.say(reply.kind, reply.text, { aircraftId: crew.id, replyTo: id });
      else if (!crew.externallyControlled) this.say(reply.kind, reply.text, { aircraftId: crew.id, by: "pilot", replyTo: id });
      return;
    }
    if (e.type === "advisory.issued" && e.data.kind === "responders" && ac) {
      const text = String(e.data.text);
      const unit = text.startsWith("Fire") ? FIRE : "paramedics";
      this.replies.set(String(e.data.transmissionId), {
        aircraftId: ac.id,
        kind: "responders_ack",
        text: unit === FIRE ? `Fire and rescue, standing by runway ${ac.assignedRunway} for ${ac.callsign}.` : `Paramedics copy, meeting ${ac.callsign} at gate ${ac.gate}.`,
      });
      return;
    }
    if (!ac) return;
    if (e.type === "go_around.initiated") this.wentAround.add(ac.id);

    if (e.type === "emergency.declared" && e.data.emergencyType === "engine_failure") {
      this.say(
        "responders",
        `Fire and rescue, Toronto Tower, emergency ${ac.callsign}, engine failure, runway ${ac.assignedRunway}, take standby positions.`,
        { aircraftId: ac.id, reason: "An aircraft declared an emergency, so airport fire and rescue are alerted (simulated)." },
      );
    } else if (e.type === "clearance.acknowledged" && e.data.clearanceType === "RETURN_TO_LAND" && !ac.humanControl) {
      const id = this.say("details", `${ac.callsign}, when able, say souls on board and fuel.`, {
        aircraftId: ac.id,
        reason: "Responders need the number on board and the fuel before touchdown.",
      });
      if (id) this.replies.set(id, { aircraftId: ac.id, kind: "details", text: `132 souls, 3 hours of fuel, ${ac.callsign}.` });
    } else if (e.type === "request.pending" && e.data.requestType === "OTHER" && !e.data.reminder && !ac.humanControl) {
      const asked = [...sim.transmissions.values()].reverse().find((t) => t.requestId === e.data.requestId);
      this.say("escalation", `${ac.callsign}, roger, calling the supervisor now, stand by.`, {
        aircraftId: ac.id,
        replyTo: asked?.id,
        reason: "The pilot asked for a person, so the flight is flagged for the operator.",
      });
    } else if (e.type === "aircraft.phase_changed" && e.data.to === "departure") {
      this.handoff(ac, `${ac.callsign}, contact Toronto Departure, 128.8.`, `128.8, ${ac.callsign}.`);
    }
  }

  private handoff(ac: Aircraft, text: string, reply: string): void {
    if (ac.humanControl) return;
    const id = this.say("handoff", text, { aircraftId: ac.id, reason: "The flight is leaving this position's airspace." });
    if (id) this.replies.set(id, { aircraftId: ac.id, kind: "handoff", text: reply });
  }

  private handoffs(): void {
    const { sim } = this;
    for (const ac of sim.aircraft.values()) {
      const position = controlPosition(sim, ac);
      const before = this.positions.get(ac.id);
      this.positions.set(ac.id, position);
      if (before === "approach" && position === "tower" && ac.phase === "approach" && !ac.emergencyId) {
        this.handoff(ac, `${ac.callsign}, contact Toronto Tower, 118.7.`, `118.7, ${ac.callsign}.`);
      }
      const exit = ac.airRoute[ac.airIndex];
      if (exit?.tag === "departure_exit" && !this.toldCentre.has(ac.id) && dist(ac.position, exit) < 2.5 * NM) {
        this.toldCentre.add(ac.id);
        this.handoff(ac, `${ac.callsign}, contact Toronto Centre, good day.`, `Over to Centre, ${ac.callsign}.`);
      }
    }
  }

  private trafficAdvisory(): void {
    const { sim } = this;
    if (sim.time < 55 || sim.time - this.lastTraffic < 130) return;
    const flying = [...sim.aircraft.values()].filter(
      (a) => AIRBORNE_PHASES.has(a.phase) && a.altitudeFt > 600 && !a.humanControl,
    );
    for (const a of flying) {
      for (const b of flying) {
        const key = [a.id, b.id].sort().join(":");
        const away = dist(a.position, b.position) / NM;
        if (a === b || away > 4 || Math.abs(a.altitudeFt - b.altitudeFt) > 1200 || this.toldTraffic.has(key)) continue;
        const clock = ((Math.round(angleDiff(a.headingDeg, bearing(a.position, b.position)) / 30) + 11) % 12) + 1;
        const altitude = Math.max(1, Math.round(b.altitudeFt / 1000));
        const text = `${a.callsign}, traffic, ${clock} o'clock, ${Math.max(1, Math.round(away))} miles, ${spell(b.type)}, ${altitude},000 feet.`;
        const id = this.say("traffic", text, {
          aircraftId: a.id,
          reason: `${b.callsign} is ${away.toFixed(1)} NM and ${Math.round(Math.abs(a.altitudeFt - b.altitudeFt))} ft away.`,
        });
        if (!id) return;
        this.replies.set(id, { aircraftId: a.id, kind: "traffic", text: `Looking for traffic, ${a.callsign}.` });
        this.toldTraffic.add(key);
        this.lastTraffic = sim.time;
        return;
      }
    }
  }

  private flow(): void {
    const { sim } = this;
    for (const ac of [...sim.aircraft.values()]) {
      if (ac.flightComplete && !ac.humanControl && sim.time - ac.phaseSince > PARKED_FOR_SEC) {
        this.ok({ type: "aircraft.remove", aircraftId: ac.id });
      }
    }

    let live = sim.aircraft.size;
    if (sim.time >= this.nextArrival && live < MOST_LIVE && this.spawnArrival()) {
      this.nextArrival = sim.time + ARRIVAL_EVERY_SEC;
      live++;
    }
    if (live < TRAFFIC_POPULATION) {
      const ready = Math.max(sim.time + 40, this.lastReady + DEPARTURE_EVERY_SEC);
      if (this.spawnDeparture(ready - sim.time)) this.lastReady = ready;
    }
  }

  private spawnArrival(): boolean {
    const { sim } = this;
    const due = (runway: string) =>
      [...sim.aircraft.values()]
        .filter((a) => a.assignedRunway === runway && ["approach", "holding", "go_around", "landing"].includes(a.phase))
        .map((a) => touchdownIn(sim, a));
    const lands = flyingSec(ARRIVAL_SPAWN_NM * NM);
    const active = sim.activeRunways.arrivals;
    const runway = active
      .filter((r) => r !== "24L" || !active.includes("24R"))
      // A gap for whoever is already inbound, including anyone coming round from a go-around.
      .filter((r) => due(r).every((sec) => Math.abs(sec - lands) >= ARRIVAL_SPACING_SEC))
      .sort((a, b) => due(a).length - due(b).length)[0];
    if (!runway) return false;
    return this.spawn("arrival", runway, { kind: "approach", distanceNm: ARRIVAL_SPAWN_NM });
  }

  private spawnDeparture(readyInSec: number): boolean {
    const runway = this.rng.pick(this.sim.activeRunways.departures);
    return !!runway && this.spawn("departure", runway, { kind: "gate" }, readyInSec);
  }

  private spawn(
    flight: "arrival" | "departure",
    runway: string,
    start: Extract<Command, { type: "aircraft.spawn" }>["spec"]["start"],
    readyInSec?: number,
  ): boolean {
    const { sim, rng } = this;
    const taken = new Set<string>();
    for (const a of sim.aircraft.values()) {
      if (a.gate && (a.flight === "arrival" || a.phase === "at_gate" || a.phase === "pushback")) taken.add(a.gate);
    }
    const gate = rng.pick([...sim.graph.gates.keys()].filter((g) => !taken.has(g)));
    const [airline, types] = rng.pick(FLEET)!;
    const callsign = `${airline}${Math.floor(rng.range(100, 999))}`;
    if (!gate || this.used.has(callsign)) return false;
    const spec = { callsign, type: rng.pick(types), pilotType: "ai" as const, flight, runway, gate, start, readyInSec };
    if (!this.ok({ type: "aircraft.spawn", spec })) return false;
    this.used.add(callsign);
    return true;
  }
}
