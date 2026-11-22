import type { CockpitState, CrossCheck, Exchange, Fault, Stage, Timing, Vitals } from "@towerai/contracts";
import {
  DEFAULT_RULES,
  NM,
  createSimulation,
  dist,
  spokenCallsign,
  type Aircraft,
  type Clearance,
  type ClearanceType,
  type Scenario,
  type Simulation,
} from "@towerai/core";
import type { ElevenLabs } from "../agents/client";
import { latLon } from "../ops/describe";
import { voiceLine } from "../voice/voice";
import { ClipError, SpendLimitError, askAgent, cockpitAgent, creditsLeft, transcribe, within } from "./brain";
import { checkReadback, understand, type Claim, type Meaning, type Topic } from "./understand";

const ME = "ACA7";
const NAME = "Air Canada 7";
const RUNWAY = "24L";
const GATE = "178";
/** Simulated seconds per real second while there is nothing to say. */
const FAST = { pushback: 12, taxi: 12, crossing: 10, lineUp: 7, roll: 4, climbOut: 2, returning: 4 };
const HELPS: Record<Stage, string> = {
  check_in: "It finds your aircraft in live data before it says a word.",
  pushback: "It makes sure nobody is taxiing behind you before you move.",
  taxi: "It plans your route and stops you short of the live runway.",
  cross: "It checks nobody is landing or rolling before you cross.",
  takeoff: "It checks the runway, the arrivals and the gap to the last departure.",
  climb: "It keeps watching your data, and checks any report against it.",
};
const ASKS: Record<Exclude<Stage, "climb">, { now: string; say: string; topic: Topic }> = {
  check_in: { now: "You're at the gate. Check in with the tower.", say: "Tower, Air Canada 7, checking in", topic: "checkin" },
  pushback: { now: "You're on their screen. Ask to leave the gate.", say: "Air Canada 7, request pushback", topic: "pushback" },
  taxi: { now: "You're clear of the gate. Ask for a route to the runway.", say: "Air Canada 7, ready to taxi", topic: "taxi" },
  cross: { now: "A live runway is in your way. Ask before you cross.", say: "Air Canada 7, request to cross", topic: "cross" },
  takeoff: { now: "You're at your runway. Ask to take off.", say: "Air Canada 7, ready for takeoff", topic: "takeoff" },
};
const ISSUER = "cockpit-tower";
const FRAME_MS = 50;
const MAX_TEXT = 300;
const VOICE_TIMEOUT_MS = 6000;

const SCENARIO: Scenario = {
  id: "cockpit",
  name: "Pilot's seat",
  description: "The visitor is at gate 178 at Toronto Pearson, bound for runway 24L, with a little traffic.",
  airport: "cyyz",
  seed: 247,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "manual",
  aircraft: [
    { callsign: ME, type: "A320", pilotType: "human", flight: "departure", runway: RUNWAY, gate: GATE, readyInSec: 86_400, start: { kind: "gate" } },
    { callsign: "WJA302", type: "B38M", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 7, cleared: true } },
    // Nothing lands on 24R, which the visitor crosses: however long they take, it stays open to them.
    { callsign: "JZA781", type: "CRJ9", flight: "departure", runway: "23", start: { kind: "taxiing", from: "A.15" } },
    { callsign: "ROU1861", type: "A321", flight: "arrival", runway: "23", gate: "135", start: { kind: "taxiing", from: "X.204" } },
  ],
};

const OPTIONS: Record<string, string> = {
  chat: "small talk, a joke, nonsense or anything off topic",
  help: "does not know what to do or say",
  takeoff: "wants to take off now",
  checkin: "is checking in or asks for a radio check",
  pushback: "wants to push back from the gate",
  taxi: "wants to taxi to the runway",
  cross: "wants to cross a runway",
  land: "wants to land",
  hold: "wants to stop or wait",
  human: "wants help sent or a human controller",
  status: "asks where they are or what the tower sees",
  altitude: "asks how high they are",
  speed: "asks how fast they are",
  engines: "asks about the engines",
  fuel: "asks about fuel",
  weather: "asks about weather",
  traffic: "asks about other aircraft",
  runway: "asks about the runway",
  callsign: "asks who they are on the radio",
  repeat: "wants the last thing repeated",
  "claim:crash": "says they are crashing, falling or in an emergency",
  "claim:engine": "says an engine or power has failed",
  "claim:smoke": "says there is smoke or fire",
  "claim:fuel": "says fuel is low",
  "claim:other": "reports some other danger, illness or damage",
};
/** What lets the visitor's aircraft move on the ground. */
const MOVES: ReadonlySet<ClearanceType> = new Set<ClearanceType>(["PUSHBACK", "TAXI", "CROSS_RUNWAY", "CONTINUE_TAXI", "CLEARED_TAKEOFF"]);
/** Where the rules are sure, or safety is involved, nobody waits for a model. */
const ASK_MODEL: ReadonlySet<Topic> = new Set<Topic>(["unknown"]);

interface Answer {
  said: string;
  intent: string;
  reason: string;
  check?: CrossCheck;
  action?: Exchange["action"];
  callsHuman?: boolean;
}
interface Issued {
  clearance?: Clearance;
  action: NonNullable<Exchange["action"]>;
}

/** The caption and the voice give the same rounded height. */
const height = (ft: number) => Math.max(100, Math.round(ft / 100) * 100);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const spokenFeet = (said: string) =>
  said.replace(/\b(\d+) feet\b/g, (_, value: string) => {
    const n = Math.round(Number(value) / 100) * 100;
    const words = [n >= 1000 ? `${Math.floor(n / 1000)} thousand` : "", n % 1000 ? `${(n % 1000) / 100} hundred` : ""].filter(Boolean).join(" ");
    return `${words || "zero"} feet`;
  });

/** One run of the pilot's seat. A reset makes a new one, so nothing carries over. */
class Run {
  readonly id = `cockpit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  readonly sim: Simulation;
  readonly faults = new Set<Fault>();
  readonly exchanges: Exchange[] = [];
  humanCalled = false;
  private vsFpm = 0;
  private fuelUsedMin = 0;
  /** A danger the pilot reported and has not withdrawn. No takeoff while it stands. */
  private alarm: Claim | null = null;
  private doubts = 0;
  private mayday = false;
  private responders = false;
  private nextLook = 0;
  private serial = 0;
  private checkedIn = false;

  constructor(private readonly unprompted: (run: Run, exchange: Exchange) => void) {
    this.sim = createSimulation(SCENARIO, {
      // Lines are timed by the voice the visitor hears, not by the simulated frequency.
      clipSec: () => 0.05,
      rules: { ...DEFAULT_RULES, handoffDistanceNm: 500, readbackTimeoutSec: 900 },
    });
    this.sim.dispatch({ type: "pilot.claim", aircraftId: ME, by: "human" });
  }

  get me(): Aircraft {
    return this.sim.get(ME)!;
  }

  /** Moving is sped up. Whenever it is the pilot's turn, or something is wrong, time is real. */
  get speed(): number {
    const { phase, emergencyId, flags, holdPosition, altitudeFt } = this.me;
    if (this.pending() || this.alarm || (this.faults.size && !this.mayday)) return 1;
    if (phase === "rollout") return FAST.returning;
    if ((emergencyId || flags.emergencyReturn) && altitudeFt > 0) return phase === "landing" ? 2 : FAST.returning;
    if (this.alarm || this.faults.size || holdPosition) return 1;
    if (phase === "takeoff") return altitudeFt > 0 ? FAST.climbOut : FAST.roll;
    if (phase === "departure") return altitudeFt < 900 ? FAST.climbOut : 1;
    if (!this.rolling()) return 1;
    if (phase === "pushback") return FAST.pushback;
    if (phase === "taxi_out") return FAST.taxi;
    return this.crossing() ? FAST.crossing : FAST.lineUp;
  }

  /** A movement was cleared and has not finished. */
  private rolling(): boolean {
    const ac = this.me;
    if (ac.phase === "pushback") return !ac.flags.pushbackComplete;
    return ac.phase === "taxi_out" || ac.phase === "line_up" || (ac.phase === "holding_short" && Object.keys(ac.runwayAuth).length > 0);
  }

  /** Stopped on the way, so it is taxiing that has to resume, not the takeoff. */
  private stoppedShort(): boolean {
    const { holdPosition, phase } = this.me;
    if (!holdPosition) return false;
    return phase === "pushback" || phase === "taxi_out" || (phase === "holding_short" && !!this.crossing());
  }

  /** The runway still to cross on the way out, by the end that is in use. */
  private crossing(): string | undefined {
    const ac = this.me;
    if (ac.flight !== "departure" || ac.altitudeFt > 0) return undefined;
    const g = this.sim.graph;
    const own = g.runwayEnd(RUNWAY)!.runway.id;
    const route =
      ac.phase === "at_gate" || ac.phase === "pushback"
        ? (g.shortestPath(g.gates.get(GATE)!.pushbackNode!, g.departureHolds(RUNWAY), {})?.path ?? [])
        : ac.route.slice(Math.max(0, ac.currentWaypointIndex - 1));
    const id = g.crossings(route).find((r) => r !== own);
    return id?.split("/").find((end) => this.sim.activeRunways.arrivals.includes(end)) ?? id?.split("/")[0];
  }

  get stage(): Stage {
    const ac = this.me;
    if (ac.flight !== "departure" || ac.altitudeFt > 0) return "climb";
    switch (ac.phase) {
      case "at_gate": return this.checkedIn ? "pushback" : "check_in";
      case "pushback": return ac.flags.pushbackComplete ? "taxi" : "pushback";
      case "taxi_out": return this.crossing() ? "taxi" : "takeoff";
      case "holding_short": return this.crossing() ? "cross" : "takeoff";
      case "line_up": case "takeoff": return "takeoff";
      default: return "climb";
    }
  }

  get waiting(): boolean {
    if (this.pending() || this.alarm || (this.faults.size && !this.mayday) || this.me.holdPosition) return true;
    return this.stage !== "climb" && this.me.phase !== "takeoff" && !this.rolling();
  }

  get helps(): string {
    return HELPS[this.stage];
  }

  path(): { x: number; y: number }[] {
    const ac = this.me;
    if (ac.altitudeFt > 0 || ac.phase === "takeoff") return [];
    const { route, currentWaypointIndex } = ac;
    return route.slice(currentWaypointIndex).map((n) => this.sim.graph.pos(n)).map(({ x, y }) => ({ x, y }));
  }

  step(): void {
    const before = this.me.altitudeFt;
    this.sim.step();
    const { dt } = this.sim.config;
    this.vsFpm = ((this.me.altitudeFt - before) / dt) * 60;
    this.fuelUsedMin += dt / 60;
    if (this.sim.time < this.nextLook) return;
    this.nextLook = this.sim.time + 1;
    this.look();
  }

  vitals(): Vitals {
    const ac = this.me;
    const onGround = ac.altitudeFt <= 0;
    const power =
      ac.phase === "takeoff" ? 94
      : ac.phase === "departure" || ac.phase === "go_around" ? 88
      : ac.phase === "approach" || ac.phase === "landing" ? 56
      : ac.speedKts > 1 ? 28 : 22;
    return {
      onGround,
      altFt: Math.round(ac.altitudeFt),
      gsKt: Math.round(ac.speedKts),
      hdg: Math.round(ac.headingDeg + 360) % 360,
      vsFpm: onGround ? 0 : Math.round(this.vsFpm / 10) * 10,
      engines: [this.faults.has("engine_failure") ? 0 : power, power],
      fuelMin: Math.max(1, Math.round((this.faults.has("low_fuel") ? 14 : 142) - this.fuelUsedMin)),
      smoke: this.faults.has("smoke"),
      gearDown: onGround || (ac.phase === "takeoff" && ac.altitudeFt < 300) || ((ac.phase === "approach" || ac.phase === "landing") && ac.altitudeFt < 2000),
    };
  }

  status(ac = this.me): string {
    const rw = ac.assignedRunway ? `runway ${ac.assignedRunway}` : "the runway";
    switch (ac.phase) {
      case "holding_short": {
        const short = ac.id === ME ? this.crossing() : undefined;
        return `holding short of ${short ? `runway ${short}` : rw}`;
      }
      case "line_up": return `${ac.holdPosition ? "stopped on" : "lining up on"} ${rw}`;
      case "takeoff": return ac.altitudeFt > 0 ? `lifting off ${rw}` : `takeoff roll on ${rw}`;
      case "departure": return `airborne, climbing out of ${rw}`;
      case "go_around": return ac.flags.emergencyReturn ? `turning back to ${rw}` : `going around from ${rw}`;
      case "approach": return `on approach to ${rw}`;
      case "holding": return "holding in the air";
      case "landing": return `short final ${rw}`;
      case "rollout": return `landed, slowing on ${rw}`;
      case "taxi_out": return `taxiing to ${rw}`;
      case "taxi_in": return ac.speedKts > 1 ? "taxiing in after landing" : "stopped after landing";
      case "at_gate": return ac.id === ME ? `parked at gate ${GATE}` : "parked at the gate";
      case "pushback": return "pushing back";
    }
  }

  others(): Aircraft[] {
    return [...this.sim.aircraft.values()].filter((a) => a.id !== ME);
  }

  facts(): string[] {
    const v = this.vitals();
    const near = this.nearest();
    return [
      `${ME}: ${this.status()}`,
      `Altitude ${v.altFt} ft, ${v.gsKt} kt, vertical ${signed(v.vsFpm)} ft/min`,
      `Engines ${v.engines[0]}% and ${v.engines[1]}% N1, ${v.smoke ? "smoke detected" : "no smoke"}, fuel ${v.fuelMin} min`,
      `Runway ${RUNWAY}: ${this.sim.runwayState.get(this.sim.graph.runwayEnd(RUNWAY)!.runway.id)?.occupants.join(", ") || "clear"}`,
      ...(near ? [`Nearest traffic ${near.ac.callsign}, ${near.nm.toFixed(1)} NM, ${this.status(near.ac)}`] : []),
    ];
  }

  private nearest(): { ac: Aircraft; nm: number } | null {
    const moving = this.others().map((ac) => ({ ac, nm: dist(ac.position, this.me.position) / NM }));
    return moving.sort((a, b) => Number(b.ac.altitudeFt > 0) - Number(a.ac.altitudeFt > 0) || a.nm - b.nm)[0] ?? null;
  }

  pending(): Clearance | undefined {
    return [...this.sim.clearances.values()].filter((c) => c.aircraftId === ME && c.status === "transmitted" && c.type !== "HOLD_POSITION").pop();
  }

  /** What to say back, in the fewest words that still pass. */
  sayBack(c: Clearance): string {
    if (c.type === "PUSHBACK") return "Pushback approved";
    if (c.type === "CONTINUE_TAXI") return "Continue taxi";
    if (c.type === "CROSS_RUNWAY") return `Cross runway ${c.runway}`;
    if (c.type === "TAXI") {
      const short = this.crossing();
      return `Taxi to runway ${c.runway}${short ? `, hold short runway ${short}` : ""}`;
    }
    if (c.vector) return `Heading ${String(c.vector.headingDeg).padStart(3, "0")}, maintain ${c.vector.altitudeFt / 1000} thousand, runway ${c.runway}`;
    return `${c.type === "CLEARED_TAKEOFF" ? "Cleared for takeoff" : "Cleared to land"}, runway ${c.runway}`;
  }

  private instruction(c: Clearance): string {
    if (c.vector) {
      return `roger mayday, engine out confirmed. Turn ${c.vector.turn} heading ${String(c.vector.headingDeg).padStart(3, "0")}, maintain ${c.vector.altitudeFt / 1000} thousand, runway ${c.runway}, number one. Responders alerted. Read that back.`;
    }
    if (c.type === "PUSHBACK") return "pushback approved, it's clear behind you. Now say: pushback approved.";
    if (c.type === "CONTINUE_TAXI") return "you can carry on. Now say: continue taxi.";
    if (c.type === "CROSS_RUNWAY") return `nobody's on it, cross runway ${c.runway}. Now say: cross runway ${c.runway}.`;
    if (c.type === "TAXI") {
      const short = this.crossing();
      return `taxi to runway ${c.runway}${short ? `, hold short of runway ${short}` : ""}. Follow the line. Read that back.`;
    }
    const what = c.type === "CLEARED_TAKEOFF" ? "cleared for takeoff" : "cleared to land";
    return `runway ${c.runway}, ${what}. Now say: ${what}, runway ${c.runway}.`;
  }

  private cancel(which: (c: Clearance) => boolean, reason: string): boolean {
    let any = false;
    for (const c of [...this.sim.clearances.values()]) {
      if (c.aircraftId !== ME || (c.status !== "issued" && c.status !== "transmitted") || !which(c)) continue;
      any = this.sim.dispatch({ type: "clearance.cancel", clearanceId: c.id, reason }).ok || any;
    }
    return any;
  }

  /** The validator decides, and only ever about the visitor's own aircraft. */
  private issue(type: ClearanceType, reason: string, runway?: string): Issued {
    const result = this.sim.dispatch({ type: "clearance.issue", aircraftId: ME, clearanceType: type, runway, reason, issuedBy: ISSUER });
    if (!result.ok) return { action: { type, verdict: "rejected", blockedBy: result.message } };
    const clearance = this.sim.clearances.get(String(result.clearanceId))!;
    // It is transmitted in a fraction of a second here; let that happen before answering.
    for (let i = 0; i < 80 && clearance.status === "issued"; i++) this.sim.step();
    if (clearance.status === "issued" || clearance.status === "expired") {
      return { action: { type, verdict: "rejected", blockedBy: clearance.closeReason ?? "The frequency is busy." } };
    }
    return { clearance, action: { type, verdict: "accepted" } };
  }

  private stop(reason: string): Issued | null {
    this.cancel((c) => MOVES.has(c.type), reason);
    const { phase, holdPosition } = this.me;
    if (holdPosition || !["pushback", "taxi_out", "holding_short", "line_up", "taxi_in"].includes(phase)) return null;
    return this.issue("HOLD_POSITION", reason);
  }

  private callHuman(): void {
    this.humanCalled = true;
  }

  private alert(reason: string): void {
    this.callHuman();
    if (this.responders) return;
    this.responders = this.sim.dispatch({
      type: "advisory.issue",
      kind: "responders",
      aircraftId: ME,
      text: `Emergency responders, ${ME}: ${reason}, ${this.status()}.`,
      reason,
    }).ok;
  }

  setFault(fault: Fault, on: boolean): void {
    if (on) this.faults.add(fault);
    else this.faults.delete(fault);
    if (!on) {
      if (!this.faults.size && this.mayday && this.me.flight === "departure" && this.me.altitudeFt <= 0 && this.me.phase !== "takeoff") {
        // The data is normal again. The pilot still has to say so before anything moves.
        this.mayday = false;
        this.alarm ??= "other";
      }
      return;
    }
    this.cancel((c) => MOVES.has(c.type), `aircraft data shows ${fault}`);
    if (this.committed()) this.stop(`aircraft data shows ${fault}`);
    this.failEngine();
  }

  /** Cleared to move and not yet on the takeoff roll: it can still be stopped. */
  private committed(): boolean {
    return this.me.flight === "departure" && this.rolling();
  }

  private failEngine(): void {
    if (this.faults.has("engine_failure") && this.me.phase === "departure" && !this.me.emergencyId) {
      this.sim.dispatch({ type: "emergency.trigger", emergencyType: "engine_failure", aircraftId: ME });
    }
  }

  /** What the tower starts by itself: the way back, then the landing clearance. */
  private look(): void {
    this.failEngine();
    const ac = this.me;
    if (!ac.flags.emergencyReturn) return;
    if (ac.phase === "approach") this.cancel((c) => c.type === "RETURN_TO_LAND", "already on approach");
    if (this.pending()) return;
    let type: ClearanceType | null = null;
    if (ac.phase === "approach" && !ac.landingCleared) type = "CLEARED_TO_LAND";
    else if (this.mayday && ac.phase === "go_around" && !ac.flags.priorityReturn) type = "RETURN_TO_LAND";
    if (!type) return;
    const started = performance.now();
    const { clearance, action } = this.issue(type, "Emergency return: the aircraft is number one.");
    if (!clearance) {
      this.nextLook = this.sim.time + 5;
      return;
    }
    this.alert("emergency return");
    const exchange = this.record("", "typed", {
      said: `${NAME}, ${this.instruction(clearance)}`,
      intent: type.toLowerCase(),
      reason: "The tower called first: the aircraft is returning with an emergency.",
      action,
      callsHuman: true,
    }, { decide: { stage: "decide", ms: Math.round((performance.now() - started) * 10) / 10, kind: "measured", source: "rules, unprompted" }, totalMs: 0 }, "rules");
    this.unprompted(this, exchange);
  }

  record(heard: string, input: Exchange["input"], a: Answer, timings: Exchange["timings"], brain: Exchange["brain"]): Exchange {
    const exchange: Exchange = {
      id: `${this.id}-${++this.serial}`,
      t: this.sim.time,
      heard,
      input,
      said: a.said,
      brain,
      intent: a.intent,
      reason: a.reason,
      looked: this.facts(),
      check: a.check ?? null,
      action: a.action ?? null,
      callsHuman: a.callsHuman ?? false,
      timings,
    };
    this.exchanges.push(exchange);
    if (this.exchanges.length > 40) this.exchanges.shift();
    return exchange;
  }

  // ---------------------------------------------------------------- answers

  /** The readback comes first, unless a new danger is in the same breath. */
  readback(text: string, meaning: Meaning): Answer | null {
    const c = this.pending();
    if (!c) return null;
    if (meaning.kind === "claim" && !(c.vector || c.type === "CLEARED_TO_LAND")) return null;
    if (meaning.kind === "topic" && ["injection", "human", "hold"].includes(meaning.topic)) return null;
    const { attempted, missing } = checkReadback(c, text, c.type === "TAXI" ? this.crossing() : undefined);
    if (!attempted) return null;
    // "Engine failure" is not a botched readback.
    if (meaning.kind === "claim" && missing.length) return null;
    const intent = "readback";
    if (missing.length) {
      return {
        said: `${NAME}, almost. I need ${missing.filter((m) => m !== "a clear yes").join(" and ") || "a clear yes"}. Say: ${this.sayBack(c)}.`,
        intent,
        reason: `Readback missing or wrong: ${missing.join(", ")}. Nothing was activated.`,
        action: { type: c.type, verdict: "rejected", blockedBy: `readback: ${missing.join(", ")}` },
      };
    }
    if (MOVES.has(c.type) && (this.alarm || this.faults.size)) {
      this.stop("danger reported before moving");
      return { said: `${NAME}, hold position. There's an open problem on your aircraft, so that clearance is cancelled.`, intent, reason: "A danger is open.", action: { type: c.type, verdict: "rejected", blockedBy: "open emergency" } };
    }
    // The form was lenient; the simulator still gets, and re-validates, the standard words.
    const result = this.sim.dispatch({ type: "pilot.readback", aircraftId: ME, clearanceId: c.id, text: c.expectedReadback, spoken: true });
    if (!result.ok) {
      return { said: `${NAME}, hold on, that clearance is no longer valid. Stand by for a new one.`, intent, reason: result.message, action: { type: c.type, verdict: "rejected", blockedBy: result.message } };
    }
    const said =
      c.type === "PUSHBACK" ? "readback correct. Pushing you back. Ask me to taxi when you stop."
      : c.type === "TAXI" ? "readback correct. Off you go. I'm watching every turn."
      : c.type === "CROSS_RUNWAY" ? "readback correct. Cross now. Your runway is next."
      : c.type === "CONTINUE_TAXI" ? "readback correct. Rolling again."
      : c.type === "CLEARED_TAKEOFF" ? "readback correct. You're rolling. Enjoy the view, and call me if anything feels wrong."
      : c.vector ? "readback correct. You're turning home and you're number one. I'll call you to land."
      : "readback correct. The runway is yours. Responders are alerted.";
    return { said: `${NAME}, ${said}`, intent, reason: "Instruction and numbers correct, so the clearance is active in the simulator.", action: { type: c.type, verdict: "accepted" } };
  }

  answer(meaning: Meaning, heard: string): Answer {
    if (meaning.kind === "claim") return this.crossCheck(meaning.claim, meaning.feet);
    return this.topic(meaning.topic, heard);
  }

  private crossCheck(claim: Claim, feet?: number): Answer {
    const v = this.vitals();
    const air = !v.onGround;
    const left = v.engines[0] === 0;
    const falling = air && v.vsFpm < -2000;
    const row = (label: string, value: string, agrees: boolean) => ({ label, value, agrees });
    const ground = row("On ground", v.onGround ? "yes" : "no", claim === "ground" ? v.onGround : air);
    const speed = row("Groundspeed", `${v.gsKt} kt`, claim === "ground" ? v.gsKt < 30 : v.gsKt > 60);
    const alt = row("Altitude", `${v.altFt} ft`, claim === "ground" ? v.onGround : claim === "altitude" ? Math.abs(v.altFt - (feet ?? 0)) <= 400 : air);
    const vertical = row("Vertical speed", `${signed(v.vsFpm)} ft/min`, falling);
    const engines = row("Engines", `${v.engines[0]}% / ${v.engines[1]}% N1${left ? ", left failed" : ""}`, left);
    const smoke = row("Smoke sensor", v.smoke ? "smoke detected" : "clear", v.smoke);
    const fuel = row("Fuel", `${v.fuelMin} min`, v.fuelMin <= 30);
    const state = claim === "airborne" || claim === "ground" || claim === "altitude";

    let holds = false;
    let evidence: CrossCheck["evidence"];
    switch (claim) {
      case "engine": holds = left; evidence = [engines, ground, speed]; break;
      case "smoke": holds = v.smoke; evidence = [smoke, engines, ground, speed]; break;
      case "fuel": holds = fuel.agrees; evidence = [fuel, ground, engines]; break;
      case "crash": holds = falling || this.faults.size > 0; evidence = [ground, alt, speed, vertical, engines, smoke, fuel]; break;
      case "other": evidence = [ground, speed, engines, smoke].map((r) => ({ ...r, agrees: false })); break;
      case "airborne": holds = air; evidence = [ground, alt, speed]; break;
      case "ground": holds = v.onGround; evidence = [ground, alt, speed]; break;
      case "altitude": holds = alt.agrees; evidence = [alt, ground, speed]; break;
    }
    const words: Record<Claim, string> = {
      engine: "engine failure", smoke: "smoke or fire", fuel: "low fuel", crash: "crashing or in an emergency", other: "a danger on board",
      airborne: "airborne", ground: "on the ground", altitude: `at ${feet} ft`,
    };
    const check: CrossCheck = {
      claim: words[claim],
      verdict: holds ? "confirmed" : claim === "other" ? "unverified" : "contradicted",
      evidence,
    };
    const intent = `claim:${claim}`;
    const where = v.onGround
      ? v.gsKt < 1 ? "stationary on the ground, zero knots" : `on the ground at ${v.gsKt} knots`
      : `${height(v.altFt)} feet, ${v.gsKt} knots`;

    if (state) {
      const next = air ? "How can I help?" : `${this.prompt().trim() || "What do you need?"}`;
      return {
        said: holds ? `${NAME}, confirmed, I show you ${where}. ${next}` : `${NAME}, I show you ${where}, so that doesn't match. What are you seeing?`,
        intent, check,
        reason: holds ? "The aircraft's data agrees." : "The aircraft's data says otherwise.",
      };
    }
    if (holds || this.faults.size) return this.confirmed(intent, check, where, v);

    const again = this.alarm !== null;
    this.alarm = claim;
    this.doubts++;
    const stopped = this.committed() ? this.stop(`pilot reported ${words[claim]}`) : null;
    const cancelled = this.cancel((c) => MOVES.has(c.type), `pilot reported ${words[claim]}`);
    if (claim === "other" || (again && this.doubts > 1)) return this.escalate(intent, check, claim === "other");

    const engineWords = "both engines normal";
    const data =
      claim === "smoke" ? `${where}, no smoke detected`
      : claim === "fuel" ? `${where}, ${v.fuelMin} minutes of fuel`
      : claim === "crash" && air ? `${where}, ${v.vsFpm < -100 ? "descending normally" : v.vsFpm > 100 ? "climbing" : "level"}, ${engineWords}`
      : `${where}, ${engineWords}`;
    // The plainest proof that it has read the aircraft, not just the words.
    const unflown = claim === "crash" && v.onGround && this.me.flight === "departure" && this.me.phase !== "takeoff" ? " You haven't taken off." : "";
    const offer = stopped || cancelled ? (this.stage === "takeoff" ? "I've cancelled takeoff. Want help sent?" : "I've stopped you. Want help sent?") : air ? "Need help?" : "Say everything is fine, or send help.";
    return {
      said: `${NAME}, I hear you. I show you ${data}.${unflown} What do you see? ${offer}`,
      intent, check,
      action: stopped?.action,
      reason: "The data contradicts the report, so no emergency yet. The pilot is asked, and help is offered.",
    };
  }

  private confirmed(intent: string, check: CrossCheck | undefined, where: string, v: Vitals): Answer {
    this.alert("confirmed emergency");
    this.mayday = true;
    this.sim.dispatch({ type: "priority.set", aircraftId: ME, priority: "emergency", reason: "Emergency confirmed by aircraft data." });
    this.failEngine();
    const seen = v.engines[0] === 0 ? "left engine at zero" : v.smoke ? "smoke on board" : v.fuelMin <= 30 ? `${v.fuelMin} minutes of fuel` : "a rapid descent";
    const base = { intent, check, callsHuman: true, reason: `The data shows ${seen}, ${where}: mayday, priority, responders and a human.` };
    if (v.onGround && this.me.phase !== "takeoff") {
      const held = this.stop("emergency on the ground");
      return { ...base, action: held?.action, said: `${NAME}, roger mayday, I see ${seen}. Hold position. Responders and a human controller are alerted. Is everyone okay?` };
    }
    const ac = this.me;
    if (ac.phase === "go_around" && ac.flags.emergencyReturn && !ac.flags.priorityReturn) {
      const waiting = this.pending();
      if (waiting) return { ...base, said: `${NAME}, ${this.instruction(waiting)}` };
      const { clearance, action } = this.issue("RETURN_TO_LAND", `Confirmed: ${seen}.`);
      if (clearance) return { ...base, action, said: `${NAME}, ${this.instruction(clearance)}` };
      return { ...base, action, said: `${NAME}, roger mayday, I see ${seen}. You have priority. A human controller and responders are alerted.` };
    }
    const next = ac.phase === "takeoff" && this.faults.has("engine_failure") ? "I'll give you the turn back once you're climbing." : "You have priority. What do you need?";
    return { ...base, said: `${NAME}, roger mayday, I see ${seen}. Responders and a human controller alerted. ${next}` };
  }

  private escalate(intent: string, check?: CrossCheck, unseen = false): Answer {
    this.alert("pilot reports a danger the data cannot confirm");
    const held = this.vitals().onGround ? this.stop("pilot reports danger") : null;
    const why = unseen ? "I can't see that from here, so I'm believing you." : "my data looks normal, but I'm taking your word.";
    return {
      said: `${NAME}, ${why} ${this.vitals().onGround ? "Hold position. " : "You have priority. "}Help and a human controller are alerted. Tell me what you see.`,
      intent, check,
      action: held?.action,
      callsHuman: true,
      reason: unseen ? "The aircraft's data cannot verify this, so a person decides." : "The pilot insisted or asked for help, so a person decides.",
    };
  }

  /** The next thing to say, for the end of an answer. */
  private prompt(): string {
    const waiting = this.pending();
    if (waiting) return ` Say: ${this.sayBack(waiting)}.`;
    const stage = this.stage;
    if (this.alarm || stage === "climb" || !this.waiting) return "";
    if (this.stoppedShort()) return " When you're ready, say: ready to move.";
    return ` When you're ready, say: ${ASKS[stage].say.replace(`${NAME}, `, "").replace(/^Tower, /, "")}.`;
  }

  /** The steps before takeoff. Asked out of order, the tower says which one comes first. */
  private ground(asked: Topic, heard: string): Answer {
    const stage = this.stage;
    const intent = asked;
    const reply = (said: string, reason: string, more: Partial<Answer> = {}): Answer => ({ said: `${NAME}, ${said}`, intent, reason, ...more });
    const waiting = this.pending();
    if (waiting) return reply(this.instruction(waiting), "A clearance is already waiting for its readback.");
    if (this.faults.size || this.alarm) return this.takeoff(heard);
    if (stage === "climb") return this.takeoff(heard);
    if (this.stoppedShort()) {
      // A stop acts when it is spoken, so being ready again stands in for its readback.
      this.cancel((c) => c.type === "HOLD_POSITION", "pilot is ready again");
      if (!this.me.holdPosition) return reply("carry on, you're free to move.", "The stop was withdrawn.");
      const { clearance, action } = this.issue("CONTINUE_TAXI", "The pilot is ready again and nothing is wrong.");
      if (clearance) return reply(this.instruction(clearance), "The validator allows it to move again.", { action });
      return reply("stay where you are a moment, then ask me again.", action.blockedBy!, { action });
    }
    if (stage === "check_in") {
      this.checkedIn = true;
      if (asked !== "pushback") {
        return reply(`Toronto Tower, I have you at gate ${GATE}, both engines normal. Next, say: request pushback.`, "Checked in: the aircraft was found in live data.", { action: { type: "CHECK_IN", verdict: "accepted" } });
      }
    } else if (asked === "checkin") {
      return reply(`loud and clear.${this.prompt()}`, "Already checked in.");
    } else if (this.rolling()) {
      return reply(`you're already cleared and moving. I'll have your next step when you stop.`, `Already ${this.status()}.`);
    } else if (asked !== ASKS[stage].topic && !(asked === "takeoff" && /^\W*(?:(?:ok|okay|we re|i m|we're|i'm) )?ready\W*$/i.test(heard))) {
      return reply(`one step first.${this.prompt()}`, `The next step is ${stage.replace("_", " ")}.`);
    }
    const next = this.stage;
    if (next === "takeoff") return this.takeoff(heard);
    const type: ClearanceType = next === "pushback" ? "PUSHBACK" : next === "taxi" ? "TAXI" : "CROSS_RUNWAY";
    const runway = type === "TAXI" ? RUNWAY : type === "CROSS_RUNWAY" ? this.crossing() : undefined;
    const { clearance, action } = this.issue(type, `The pilot asked to ${next === "pushback" ? "push back" : next}.`, runway);
    if (!clearance) return reply("not this second, it isn't clear yet. Stay put and ask me again shortly.", action.blockedBy!, { action });
    return reply(this.instruction(clearance), "The validator checked the traffic and found it clear.", { action });
  }

  private takeoff(heard: string): Answer {
    const intent = "takeoff";
    const rules = "The pilot asked to take off.";
    const waiting = this.pending();
    if (waiting) return { said: `${NAME}, ${this.instruction(waiting)}`, intent, reason: "A clearance is already waiting for its readback." };
    const ac = this.me;
    if (ac.altitudeFt > 0 || ac.phase === "takeoff") return { said: `${NAME}, you're already on your way. Ask me anything, or tell me if something's wrong.`, intent, reason: `Already ${this.status()}.` };
    if (ac.flight !== "departure") return { said: `${NAME}, you've flown and landed. Press reset for another flight.`, intent, reason: "The flight is over." };
    if (this.faults.size) {
      const held = this.stop("fault before takeoff");
      this.alert("fault before takeoff");
      return { said: `${NAME}, I can't clear you. Your data shows a fault. Hold position, a human controller and responders are alerted.`, intent, reason: "A fault is active.", action: held?.action ?? { type: "CLEARED_TAKEOFF", verdict: "rejected", blockedBy: "active fault" }, callsHuman: true };
    }
    if (this.alarm) {
      return { said: `${NAME}, you reported trouble, so nothing moves yet. If you're truly okay, say: everything is fine.`, intent, reason: "A reported danger has not been withdrawn.", action: { type: "CLEARED_TAKEOFF", verdict: "rejected", blockedBy: "reported danger not withdrawn" } };
    }
    this.cancel((c) => c.type === "HOLD_POSITION", "pilot is ready again");
    this.sim.dispatch({ type: "pilot.request", aircraftId: ME, requestType: "TAKEOFF", runway: RUNWAY, text: heard || "Ready for departure.", spoken: true });
    const { clearance, action } = this.issue("CLEARED_TAKEOFF", "Pilot ready and the runway is clear.", RUNWAY);
    if (!clearance) return { said: `${NAME}, not just yet, it isn't safe this second. Stay where you are and ask me again shortly.`, intent, reason: action.blockedBy!, action };
    return { said: `${NAME}, easy, I've got you. ${this.instruction(clearance).replace("runway", "Runway")}`, intent, reason: `${rules} The validator found the runway clear.`, action };
  }

  private topic(topic: Topic, heard: string): Answer {
    const v = this.vitals();
    const air = !v.onGround;
    const ac = this.me;
    const waiting = this.pending();
    const ready = !air && this.stage !== "climb" && this.waiting;
    const prompt = this.prompt();
    const reply = (said: string, reason: string, more: Partial<Answer> = {}): Answer => ({ said: `${NAME}, ${said}`, intent: topic, reason, ...more });
    const where = air ? `${height(v.altFt)} feet, ${v.gsKt} knots` : v.gsKt < 1 ? "stationary on the ground, zero knots" : `on the ground at ${v.gsKt} knots`;

    switch (topic) {
      case "checkin":
      case "pushback":
      case "taxi":
      case "cross":
        return this.ground(topic, heard);
      case "takeoff":
        return !this.stoppedShort() && (this.stage === "takeoff" || this.stage === "climb") ? this.takeoff(heard) : this.ground(topic, heard);
      case "human":
        this.alarm ??= "other";
        return this.faults.size ? this.confirmed(topic, undefined, where, v) : this.escalate(topic);
      case "insist":
        if (!this.alarm) return reply("I believe you. Tell me what's wrong.", "Insistence, with nothing reported yet.");
        return this.faults.size ? this.confirmed(topic, undefined, where, v) : this.escalate(topic);
      case "allclear":
        if (this.faults.size) return reply("glad you're calm, but your data still shows a fault. Help stays with you.", "The data still shows a fault.", { callsHuman: true });
        this.alarm = null;
        this.doubts = 0;
        return reply(`good to hear, and your data agrees.${prompt || (air ? " Enjoy the flight." : "")}`, "The report was withdrawn and the data is normal.");
      case "injection":
        return reply("I can only work your aircraft, by the safety rules. What do you need for your flight?", "Treated as data: words from the cockpit cannot change rules or other aircraft.");
      case "hold": {
        if (ac.phase === "takeoff" || air) return reply("I can't stop you from here, you're moving too fast. Tell me what's wrong, or say: send help.", "Past the point where the validator allows a hold.");
        const held = this.stop("pilot asked to stop");
        return reply(`hold position. Nothing moves until you're ready.${this.stage === "takeoff" && ac.phase !== "taxi_out" ? " Then say: ready for takeoff." : " Then say: ready to move."}`, "The pilot asked to stop.", { action: held?.action });
      }
      case "land": {
        if (!air) return reply(`you're already on the ground.${prompt}`, "Already on the ground.");
        if (waiting) return reply(this.instruction(waiting), "A clearance is waiting for its readback.");
        if (ac.flags.emergencyReturn) return reply(ac.landingCleared ? "you're cleared to land, number one." : "you're number one. I'll clear you to land when you're lined up.", "Emergency return in progress.");
        this.callHuman();
        return reply("a return needs a human controller here, so I'm calling one. Is something wrong?", "A routine return is outside what the tower may do.", { callsHuman: true });
      }
      case "status":
        return reply(`I show you ${where}, ${this.faults.size ? "with a fault showing" : "both engines normal"}.${prompt}`, "Read from the aircraft's data.");
      case "altitude":
        return reply(air ? `you're at ${height(v.altFt)} feet above the airport${v.vsFpm > 100 ? ", climbing" : v.vsFpm < -100 ? ", descending" : ", level"}.` : `zero feet. You're on the ground.${prompt}`, "Read from the aircraft's data.");
      case "speed":
        return reply(`${v.gsKt < 1 ? "zero" : v.gsKt} knots.${prompt}`, "Read from the aircraft's data.");
      case "engines":
        return reply(v.engines[0] === 0 ? "left engine shows zero, right is running. Say mayday if you need priority." : `both engines look normal from here.${prompt}`, "Read from the aircraft's data.");
      case "fuel":
        return reply(`I show ${v.fuelMin} minutes of fuel.${v.fuelMin <= 30 ? " That's low. Say mayday for priority." : prompt}`, "Read from the aircraft's data.");
      case "weather":
        return reply(`I don't have live weather in this simulator, so I won't guess.${prompt}`, "No weather is modelled.");
      case "traffic": {
        const near = this.nearest();
        if (!near) return reply("nobody near you.", "No other aircraft.");
        return reply(`nearest to watch is ${spokenCallsign(near.ac.callsign)}, ${Math.max(1, Math.round(near.nm))} miles, ${this.status(near.ac)}.`, "Read from the simulator's traffic.");
      }
      case "runway":
        return reply(`your runway is ${ac.assignedRunway}. You're ${this.status().replace(` of runway ${RUNWAY}`, "")}.${prompt}`, "Read from the simulator.");
      case "callsign":
        return reply(`that's you: ${NAME}. I'm Toronto Tower.${prompt}`, "The visitor's callsign.");
      case "repeat": {
        if (waiting) return reply(this.instruction(waiting), "Repeated the waiting clearance.");
        const last = this.exchanges.at(-1);
        return last ? { said: last.said, intent: topic, reason: "Repeated the last call." } : reply(`Toronto Tower here.${prompt}`, "Nothing to repeat yet.");
      }
      case "help":
        // "Help!" after reporting danger is not a request for a lesson.
        if (this.alarm && !waiting) return this.faults.size ? this.confirmed(topic, undefined, where, v) : this.escalate(topic);
        if (waiting) return reply(`you're doing great. Just repeat the clearance.${prompt}`, "A readback is due.");
        if (ready) return reply(`no experience needed. I'll walk you through it.${prompt}`, "Guidance for a beginner.");
        return reply(air ? "you're flying nicely. Ask me your height or traffic, or tell me if something's wrong." : `you're ${this.status()}. Ask me anything.`, "Guidance for where they are.");
      case "hello":
        if (this.stage === "check_in" && !this.alarm) return this.ground("checkin", heard);
        return reply(`Toronto Tower, loud and clear. I'll talk you through it.${prompt}`, "Greeting.");
      case "thanks":
        return reply(`any time.${prompt}`, "Thanks.");
      case "unknown":
        if (this.alarm && /^\W*(?:yes|yeah|yep|yup|please|do it|send (?:them|it))\b/i.test(heard)) return this.faults.size ? this.confirmed("human", undefined, where, v) : this.escalate("human");
        return reply(`I didn't follow that.${prompt || " Tell me what you need, or if something's wrong."}`, "No intent matched.");
    }
  }

  /** While a danger is open a model may still understand, but never choose the words. */
  get troubled(): boolean {
    return this.alarm !== null;
  }

  coach(): CockpitState["coach"] {
    const c = this.pending();
    const ac = this.me;
    const v = this.vitals();
    if (c) return { now: this.faults.size || this.mayday ? "Emergency. Read back your way home." : "Read it back, and your plane acts on it.", trySaying: [this.sayBack(c), "Say again?"] };
    if (v.onGround && ac.flight === "arrival") return { now: "You're back on the ground. Reset to fly again.", trySaying: ["Thanks, tower", "Where am I?"] };
    if (this.faults.size && !this.mayday) {
      const line = v.engines[0] === 0 ? "Mayday, our engine failed!" : v.smoke ? "Mayday, there's smoke!" : "Mayday, we're low on fuel!";
      return { now: "Something is wrong with your aircraft. Tell the tower.", trySaying: [line, "What do you see on my aircraft?"] };
    }
    if (this.faults.size || this.mayday) return { now: `Emergency: you have priority, ${this.status()}.`, trySaying: ["What do you see?", "Send help", "How high am I?"] };
    if (this.alarm) return { now: "Your aircraft's data shows no emergency. Stand down, or ask for help.", trySaying: ["Everything is fine", "I'm serious, send help"] };
    const stage = this.stage;
    if (ac.holdPosition && stage !== "climb") return { now: "You're stopped. Tell the tower when you're ready to move.", trySaying: [this.stoppedShort() ? "Air Canada 7, ready to move" : ASKS.takeoff.say, "Is there other traffic?"] };
    if (stage !== "climb" && this.waiting) return { now: ASKS[stage].now, trySaying: [ASKS[stage].say, stage === "check_in" ? "Oh no, we're crashing!" : "What do I need to do?"] };
    if (ac.phase === "pushback") return { now: "The tug is pushing you back from the gate.", trySaying: ["Stop!", "Is there other traffic?"] };
    if (ac.phase === "taxi_out") return { now: "You're taxiing along the route the tower planned.", trySaying: ["Where am I?", "Stop!"] };
    if (stage === "cross") return { now: "You're crossing a live runway, with the tower's permission.", trySaying: ["Where am I?", "Is there other traffic?"] };
    if (v.onGround && ac.phase === "takeoff") return { now: "You're rolling. Look ahead and enjoy it.", trySaying: ["How fast am I going?", "Our engine failed!"] };
    if (v.onGround) return { now: ac.phase === "line_up" ? "You're moving onto the runway." : `You are ${this.status()}.`, trySaying: ["How fast am I going?", "Stop!"] };
    return { now: "You're flying. Ask anything, or report a problem.", trySaying: ["How high am I?", "We're crashing!", "Any traffic near me?"] };
  }
}

export type TalkResult = { ok: boolean; exchange?: Exchange; message?: string };

const FAULTS: readonly Fault[] = ["engine_failure", "smoke", "low_fuel"];

export function createCockpit({ api = null }: { api?: ElevenLabs | null } = {}) {
  let run = new Run(announce);
  let busy: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let credits: { at: number; left: number | null } = { at: -Infinity, left: null };

  /** A recorded line needs no key. Only a new one needs `api`. */
  async function addVoice(exchange: Exchange): Promise<void> {
    const started = performance.now();
    try {
      const line = { role: "controller" as const, speaker: "Toronto Tower", text: exchange.said, spoken: spokenFeet(exchange.said) };
      const voiced = await within(voiceLine(line, { api, timeoutMs: VOICE_TIMEOUT_MS }), VOICE_TIMEOUT_MS);
      if (!voiced) return;
      exchange.audioUrl = voiced.audioUrl;
      // A cached line's own timing belongs to the day it was recorded, not to this press.
      exchange.timings.voice = {
        stage: "voice",
        ms: voiced.fromCache ? Math.round(performance.now() - started) : voiced.timing.ms,
        kind: "measured",
        source: voiced.fromCache ? "cached ElevenLabs audio, lookup" : voiced.timing.source,
      };
    } catch (error) {
      console.warn("Cockpit voice unavailable:", error instanceof Error ? error.message : error);
    }
  }

  function announce(from: Run, exchange: Exchange): void {
    const started = performance.now();
    void addVoice(exchange).then(() => {
      if (from === run) exchange.timings.totalMs = Math.round(performance.now() - started);
    });
  }

  async function answer(here: Run, heard: string, input: Exchange["input"], started: number, transcribeMs?: number): Promise<TalkResult> {
    const deciding = performance.now();
    let meaning = understand(heard);
    let brain: Exchange["brain"] = "rules";
    let note = "";
    let timing: Timing | null = null;
    let result = here.readback(heard, meaning);
    if (!result) {
      const agent = api && meaning.kind === "topic" && ASK_MODEL.has(meaning.topic) ? cockpitAgent() : null;
      if (api && agent) {
        try {
          const reply = await askAgent(api, agent, {
            heard,
            facts: here.facts(),
            recent: here.exchanges.slice(-4).map((e) => `pilot: ${e.heard} | tower: ${e.said}`),
            options: Object.entries(OPTIONS).map(([id, means]) => ({ id, means })),
          });
          if (here !== run) return { ok: false, message: "The cockpit was reset." };
          if (reply.id.startsWith("claim:")) meaning = { kind: "claim", claim: reply.id.slice(6) as Claim };
          else meaning = { kind: "topic", topic: reply.id === "chat" ? "unknown" : (reply.id as Topic) };
          timing = reply.timing;
          brain = "llm";
          note = "Understood by the model. ";
        } catch (error) {
          if (here !== run) return { ok: false, message: "The cockpit was reset." };
          console.warn("Cockpit agent unavailable:", error instanceof Error ? error.message : error);
          note = "The model did not answer, so rules did. ";
        }
      }
      result = here.answer(meaning, heard);
    }
    result.reason = note + result.reason;
    timing ??= {
      stage: "decide",
      ms: Math.round((performance.now() - deciding) * 10) / 10,
      kind: "measured",
      source: note ? "rules, after the model failed" : "rules",
    };
    const timings: Exchange["timings"] = { ...(transcribeMs === undefined ? {} : { transcribeMs }), decide: timing, totalMs: 0 };
    const exchange = here.record(heard, input, result, timings, brain);
    if (result.callsHuman) here.humanCalled = true;
    await addVoice(exchange);
    timings.totalMs = Math.round(performance.now() - started);
    if (here !== run) return { ok: false, message: "The cockpit was reset." };
    return { ok: true, exchange };
  }

  async function press(work: (here: Run) => Promise<TalkResult>): Promise<TalkResult> {
    const here = run;
    if (busy === here.id) return { ok: false, message: "The tower is still answering." };
    busy = here.id;
    try {
      return await work(here);
    } finally {
      if (busy === here.id) busy = null;
    }
  }

  const cockpit = {
    state(): CockpitState {
      const ac = run.me;
      const [lat, lon] = latLon(run.sim, ac.position);
      const waiting = run.pending();
      if (api && Date.now() - credits.at > 2000) credits = { at: Date.now(), left: creditsLeft(api) };
      return {
        runId: run.id,
        t: run.sim.time,
        callsign: ME,
        spokenCallsign: spokenCallsign(ME),
        type: ac.type,
        runway: ac.assignedRunway ?? RUNWAY,
        phase: ac.phase,
        status: run.status(),
        lat,
        lon,
        x: ac.position.x,
        y: ac.position.y,
        vitals: run.vitals(),
        faults: [...run.faults],
        traffic: run.others().map((o) => ({ callsign: o.callsign, x: o.position.x, y: o.position.y, altFt: Math.round(o.altitudeFt), hdg: Math.round(o.headingDeg + 360) % 360, status: run.status(o) })),
        coach: run.coach(),
        stage: run.stage,
        waiting: run.waiting,
        helps: run.helps,
        speed: run.speed,
        path: run.path(),
        readBack: waiting ? run.sayBack(waiting) : null,
        humanCalled: run.humanCalled,
        exchanges: [...run.exchanges],
        speech: api
          ? { available: true, label: "ElevenLabs Scribe and Flash", creditsLeft: credits.left }
          : { available: false, label: "Typed input, rules, no live voice", creditsLeft: null },
      };
    },

    say(text: string): Promise<TalkResult> {
      const heard = typeof text === "string" ? text.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, MAX_TEXT) : "";
      if (!heard) return Promise.resolve({ ok: false, message: "Type what you want to say." });
      return press((here) => answer(here, heard, "typed", performance.now()));
    },

    talk(audio: Buffer, contentType: string): Promise<TalkResult> {
      if (!api) return Promise.resolve({ ok: false, message: "Speech needs ElevenLabs. Type what you want to say." });
      const started = performance.now();
      return press(async (here) => {
        let heard: { text: string; ms: number };
        try {
          heard = await transcribe(api, audio, contentType);
        } catch (error) {
          if (error instanceof ClipError) return { ok: false, message: error.message };
          if (error instanceof SpendLimitError) return { ok: false, message: "The speech budget is used up. Type instead." };
          console.warn("Cockpit speech to text failed:", error instanceof Error ? error.message : error);
          return { ok: false, message: "I couldn't hear that. Try again, or type it." };
        }
        if (here !== run) return { ok: false, message: "The cockpit was reset." };
        if (!heard.text) return { ok: false, message: "I didn't catch any words. Hold the key while you talk." };
        return answer(here, heard.text.slice(0, MAX_TEXT), "speech", started, heard.ms);
      });
    },

    fault(fault: Fault, on: boolean): { ok: boolean; message?: string } {
      if (!FAULTS.includes(fault) || typeof on !== "boolean") return { ok: false, message: "Unknown fault." };
      run.setFault(fault, on);
      return { ok: true };
    },

    reset(): { ok: true } {
      run = new Run(announce);
      return { ok: true };
    },

    /** For tests and rehearsals: simulated seconds, at once. */
    advance(seconds: number): void {
      for (let i = Math.round(seconds / run.sim.config.dt); i > 0; i--) run.step();
    },

    start(): void {
      if (timer) return;
      let last = Date.now();
      let budget = 0;
      timer = setInterval(() => {
        const now = Date.now();
        // After a sleep the backlog is dropped, not fast-forwarded.
        budget += (Math.min(1000, now - last) / 1000) * run.speed;
        last = now;
        const { dt } = run.sim.config;
        for (; budget >= dt; budget -= dt) {
          try {
            run.step();
          } catch (error) {
            console.error("Cockpit step failed:", error);
            budget = 0;
            break;
          }
        }
      }, FRAME_MS);
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return cockpit;
}

export type Cockpit = ReturnType<typeof createCockpit>;
