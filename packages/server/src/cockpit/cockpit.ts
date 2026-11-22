import type { CockpitState, CrossCheck, Exchange, Fault, Timing, Vitals } from "@towerai/contracts";
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
const ISSUER = "cockpit-tower";
const FRAME_MS = 50;
const MAX_TEXT = 300;
const VOICE_TIMEOUT_MS = 6000;

const SCENARIO: Scenario = {
  id: "cockpit",
  name: "Pilot's seat",
  description: "The visitor holds short of runway 24L at Toronto Pearson, with a little traffic.",
  airport: "cyyz",
  seed: 247,
  activeRunways: { arrivals: ["23", "24R"], departures: ["23", "24L"] },
  emergencyMode: "manual",
  aircraft: [
    { callsign: ME, type: "A320", pilotType: "human", flight: "departure", runway: RUNWAY, start: { kind: "holding_short" } },
    { callsign: "WJA302", type: "B38M", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 7, cleared: true } },
    { callsign: "DAL482", type: "B739", flight: "arrival", runway: "24R", gate: "B11", start: { kind: "approach", distanceNm: 11, cleared: true } },
    { callsign: "JZA781", type: "CRJ9", flight: "departure", runway: "23", start: { kind: "taxiing", from: "A.15" } },
    { callsign: "ROU1861", type: "A321", flight: "arrival", runway: "23", gate: "135", start: { kind: "taxiing", from: "X.204" } },
  ],
};

const OPTIONS: Record<string, string> = {
  chat: "small talk, a joke, nonsense or anything off topic",
  help: "does not know what to do or say",
  takeoff: "wants to take off now",
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

  /** The roll is 45 s in real time, which is a long silence on a stage. */
  get speed(): number {
    const { phase, emergencyId, flags, holdPosition } = this.me;
    if (!holdPosition && this.committed()) return 3; // the crawl on to the runway
    return phase === "takeoff" || emergencyId || flags.emergencyReturn ? 2 : 1;
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
      case "holding_short": return `holding short of ${rw}`;
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
      case "at_gate": return "parked at the gate";
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
    if (c.vector) return `Heading ${String(c.vector.headingDeg).padStart(3, "0")}, maintain ${c.vector.altitudeFt / 1000} thousand, runway ${c.runway}`;
    return `${c.type === "CLEARED_TAKEOFF" ? "Cleared for takeoff" : "Cleared to land"}, runway ${c.runway}`;
  }

  private instruction(c: Clearance): string {
    if (c.vector) {
      return `roger mayday, engine out confirmed. Turn ${c.vector.turn} heading ${String(c.vector.headingDeg).padStart(3, "0")}, maintain ${c.vector.altitudeFt / 1000} thousand, runway ${c.runway}, number one. Responders alerted. Read that back.`;
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
    this.cancel((c) => c.type === "CLEARED_TAKEOFF", reason);
    const { phase, holdPosition } = this.me;
    if (holdPosition || !["holding_short", "line_up", "taxi_in"].includes(phase)) return null;
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
    if (!on) return;
    this.cancel((c) => c.type === "CLEARED_TAKEOFF", `aircraft data shows ${fault}`);
    if (this.committed()) this.stop(`aircraft data shows ${fault}`);
    this.failEngine();
  }

  /** Cleared on to the runway and not yet rolling: it can still be stopped. */
  private committed(): boolean {
    const { phase, runwayAuth } = this.me;
    return phase === "line_up" || (phase === "holding_short" && Object.keys(runwayAuth).length > 0);
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
    const { attempted, missing } = checkReadback(c, text);
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
    if (c.type === "CLEARED_TAKEOFF" && (this.alarm || this.faults.size)) {
      this.stop("danger reported before takeoff");
      return { said: `${NAME}, hold position. There's an open problem on your aircraft, so that takeoff is cancelled.`, intent, reason: "A danger is open.", action: { type: c.type, verdict: "rejected", blockedBy: "open emergency" } };
    }
    // The form was lenient; the simulator still gets, and re-validates, the standard words.
    const result = this.sim.dispatch({ type: "pilot.readback", aircraftId: ME, clearanceId: c.id, text: c.expectedReadback, spoken: true });
    if (!result.ok) {
      return { said: `${NAME}, hold on, that clearance is no longer valid. Stand by for a new one.`, intent, reason: result.message, action: { type: c.type, verdict: "rejected", blockedBy: result.message } };
    }
    const said =
      c.type === "CLEARED_TAKEOFF" ? "readback correct. You're rolling. Enjoy the view, and call me if anything feels wrong."
      : c.vector ? "readback correct. You're turning home and you're number one. I'll call you to land."
      : "readback correct. The runway is yours. Responders are alerted.";
    return { said: `${NAME}, ${said}`, intent, reason: "Instruction and numbers correct, so the clearance is active in the simulator.", action: { type: c.type, verdict: "accepted" } };
  }

  answer(meaning: Meaning, heard: string, say?: string | null): Answer {
    if (meaning.kind === "claim") return this.crossCheck(meaning.claim, meaning.feet);
    return this.topic(meaning.topic, heard, say ?? null);
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
      const next = air ? "How can I help?" : "Ready to fly? Say: ready for takeoff.";
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
    const cancelled = this.cancel((c) => c.type === "CLEARED_TAKEOFF", `pilot reported ${words[claim]}`);
    if (claim === "other" || (again && this.doubts > 1)) return this.escalate(intent, check, claim === "other");

    const engineWords = "both engines normal";
    const data =
      claim === "smoke" ? `${where}, no smoke detected`
      : claim === "fuel" ? `${where}, ${v.fuelMin} minutes of fuel`
      : claim === "crash" && air ? `${where}, ${v.vsFpm < -100 ? "descending normally" : v.vsFpm > 100 ? "climbing" : "level"}, ${engineWords}`
      : `${where}, ${engineWords}`;
    // The plainest proof that it has read the aircraft, not just the words.
    const unflown = claim === "crash" && v.onGround && this.me.flight === "departure" && this.me.phase !== "takeoff" ? " You haven't taken off." : "";
    const offer = stopped || cancelled ? "I've cancelled takeoff. Want help sent?" : air ? "Need help?" : "Say hold, or send help.";
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
      return { said: `${NAME}, you reported trouble, so no takeoff yet. If you're truly okay, say: everything is fine.`, intent, reason: "A reported danger has not been withdrawn.", action: { type: "CLEARED_TAKEOFF", verdict: "rejected", blockedBy: "reported danger not withdrawn" } };
    }
    this.cancel((c) => c.type === "HOLD_POSITION", "pilot is ready again");
    this.sim.dispatch({ type: "pilot.request", aircraftId: ME, requestType: "TAKEOFF", runway: RUNWAY, text: heard || "Ready for departure.", spoken: true });
    const { clearance, action } = this.issue("CLEARED_TAKEOFF", "Pilot ready and the runway is clear.", RUNWAY);
    if (!clearance) return { said: `${NAME}, not just yet, it isn't safe this second. Stay where you are and ask me again shortly.`, intent, reason: action.blockedBy!, action };
    return { said: `${NAME}, easy, I've got you. ${this.instruction(clearance).replace("runway", "Runway")}`, intent, reason: `${rules} The validator found the runway clear.`, action };
  }

  private topic(topic: Topic, heard: string, say: string | null): Answer {
    const v = this.vitals();
    const air = !v.onGround;
    const ac = this.me;
    const waiting = this.pending();
    const ready = !air && ac.phase === "holding_short";
    const prompt = waiting ? ` Say: ${this.sayBack(waiting)}.` : ready && !this.alarm ? " When you're ready, say: ready for takeoff." : "";
    const reply = (said: string, reason: string, more: Partial<Answer> = {}): Answer => ({ said: `${NAME}, ${said}`, intent: topic, reason, ...more });
    const where = air ? `${height(v.altFt)} feet, ${v.gsKt} knots` : v.gsKt < 1 ? "stationary on the ground, zero knots" : `on the ground at ${v.gsKt} knots`;

    switch (topic) {
      case "takeoff":
        return this.takeoff(heard);
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
        return reply(`good to hear, and your data agrees.${prompt || (air ? " Enjoy the flight." : " Say: ready for takeoff, when you are.")}`, "The report was withdrawn and the data is normal.");
      case "injection":
        return reply("I can only work your aircraft, by the safety rules. What do you need for your flight?", "Treated as data: words from the cockpit cannot change rules or other aircraft.");
      case "hold": {
        if (ac.phase === "takeoff" || air) return reply("I can't stop you from here, you're moving too fast. Tell me what's wrong, or say: send help.", "Past the point where the validator allows a hold.");
        const held = this.stop("pilot asked to stop");
        return reply("hold position. Nothing moves until you're ready. Then say: ready for takeoff.", "The pilot asked to stop.", { action: held?.action });
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
        if (say) return reply(say + (waiting ? prompt : ""), "The model's wording, checked for instructions.");
        if (waiting) return reply(`you're doing great. Just repeat the clearance.${prompt}`, "A readback is due.");
        if (ready) return reply("no experience needed. You're holding by the runway. Just say: ready for takeoff. I'll do the rest.", "Guidance for a beginner.");
        return reply(air ? "you're flying nicely. Ask me your height or traffic, or tell me if something's wrong." : `you're ${this.status()}. Ask me anything.`, "Guidance for where they are.");
      case "hello":
        return reply(say ? say + (waiting ? prompt : "") : `Toronto Tower, loud and clear. I'll talk you through it.${prompt}`, "Greeting.");
      case "thanks":
        return reply(say ? say + (waiting ? prompt : "") : `any time.${prompt}`, "Thanks.");
      case "unknown":
        if (this.alarm && /^\W*(?:yes|yeah|yep|yup|please|do it|send (?:them|it))\b/i.test(heard)) return this.faults.size ? this.confirmed("human", undefined, where, v) : this.escalate("human");
        return reply(say ? say + (waiting ? prompt : "") : `I didn't follow that.${prompt || " Tell me what you need, or if something's wrong."}`, say ? "The model's wording, checked for instructions." : "No intent matched.");
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
    if (c) return { now: "The tower gave you a clearance. Say it back and the aircraft will act on it.", trySaying: [this.sayBack(c), "Say again?"] };
    if (this.faults.size && !this.mayday) {
      const line = v.engines[0] === 0 ? "Mayday, our engine failed!" : v.smoke ? "Mayday, there's smoke!" : "Mayday, we're low on fuel!";
      return { now: "Something is wrong with your aircraft. Tell the tower.", trySaying: [line, "What do you see on my aircraft?"] };
    }
    if (this.faults.size || this.mayday) return { now: `Emergency: you have priority, ${this.status()}.`, trySaying: ["What do you see?", "Send help", "How high am I?"] };
    if (this.alarm) return { now: "The tower is checking your report against the aircraft's data.", trySaying: ["I'm serious, send help", "Everything is fine"] };
    if (v.onGround && ac.phase === "holding_short") return { now: "You are beside the runway. Ask to take off, in any words.", trySaying: ["I want to take off, what do I need?", "Is there other traffic?", "We're crashing!"] };
    if (v.onGround && ac.flight === "arrival") return { now: "You're back on the ground. Reset to fly again.", trySaying: ["Thanks, tower", "Where am I?"] };
    if (v.onGround && ac.phase === "takeoff") return { now: "You're rolling. Look ahead and enjoy it.", trySaying: ["How fast am I going?", "Our engine failed!"] };
    if (v.onGround) return { now: ac.phase === "line_up" ? "You're moving onto the runway." : `You are ${this.status()}.`, trySaying: ["How fast am I going?", "Stop!"] };
    return { now: "You're flying. Ask anything, or report a problem.", trySaying: ["How high am I?", "Our engine failed!", "Any traffic near me?"] };
  }
}

export type TalkResult = { ok: boolean; exchange?: Exchange; message?: string };

const FAULTS: readonly Fault[] = ["engine_failure", "smoke", "low_fuel"];

export function createCockpit({ api = null }: { api?: ElevenLabs | null } = {}) {
  let run = new Run(announce);
  let busy: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let credits: { at: number; left: number | null } = { at: -Infinity, left: null };

  async function addVoice(exchange: Exchange): Promise<void> {
    if (!api) return;
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
    if (!api) return;
    const started = performance.now();
    void addVoice(exchange).then(() => {
      if (from === run) exchange.timings.totalMs = Math.round(performance.now() - started);
    });
  }

  async function answer(here: Run, heard: string, input: Exchange["input"], started: number, transcribeMs?: number): Promise<TalkResult> {
    const deciding = performance.now();
    let meaning = understand(heard);
    let say: string | null = null;
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
          if (!here.troubled) say = reply.say;
          timing = reply.timing;
          brain = "llm";
          note = "Understood by the model. ";
        } catch (error) {
          if (here !== run) return { ok: false, message: "The cockpit was reset." };
          console.warn("Cockpit agent unavailable:", error instanceof Error ? error.message : error);
          note = "The model did not answer, so rules did. ";
        }
      }
      result = here.answer(meaning, heard, say);
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
