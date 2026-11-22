import type {
  AgentPrompt, AgentReply, AskAgent, Attention, Brain, ControlPosition, FlightRecord, FlightSummary, Marker, Message, Risk, RiskLevel, TrackPoint,
} from "@towerai/contracts";
import type { Port, Runway } from "./airports";
import { step, type Body } from "./body";
import { kwikdist } from "./bluesky/geo";
import type { TypeCode } from "./perf";
import { capital, shortLevel } from "./phrase";
import { closest, separationApplies, minimumNm } from "./separation";
import { random, speechSeconds, timingModel, type ModelTiming } from "./timing";

export interface SimOptions {
  seed: number;
  durationS: number;
  ask?: AskAgent;
  modelTiming?: ModelTiming;
  /** Upper bound on calls to `ask`. */
  maxAgentCalls?: number;
}

/** A procedure yields seconds to wait, a condition to wait for, or a question for an agent. */
export type Wait = number | (() => boolean) | { ask: AgentPrompt };
export type Proc<T = void> = Generator<Wait, T, unknown>;

export interface Flag {
  score: number;
  reason: string;
  attention?: Attention;
  need?: string;
  /** Replaces the status line while the flag is up. */
  status?: string;
}

export interface Option {
  id: string;
  action: string;
  /** The instruction without the callsign. */
  say: string;
  /** Defaults to the instruction. */
  readback?: string;
  reason?: string;
  blockedBy?: string;
  effect?: () => void;
}

export interface Exchange {
  /** Evaluated once the frequency is ours, so the options are validated on current state. */
  options: Option[] | (() => Option[]);
  request?: { text: string; kind?: Message["kind"]; need?: string };
  context?: () => string[];
  reason?: string;
  kind?: Message["kind"];
  readback?: boolean;
  readbackKind?: Message["kind"];
  /** The pilot's first, wrong readback, which the controller must catch. */
  misheard?: string;
  /** Put this exchange to the agents, if any. */
  story?: boolean;
  urgent?: boolean;
  /** A person, here a scripted stand-in, gives the instruction. */
  operator?: boolean;
}

export interface Flight {
  id: string;
  airline: string;
  /** Radiotelephony callsign. */
  spoken: string;
  type: TypeCode;
  origin: string;
  destination: string;
  /** Where the flight plan says. A diversion shows in the status, not by rewriting this. */
  filed: string;
  port: Port;
  runway: Runway;
  body: Body;
  position: ControlPosition;
  facility: string;
  startT: number;
  endT: number | null;
  /** An exchange is in progress. */
  busy: boolean;
  urgent: number;
  /** A conflict resolution or hold owns the aircraft; routine clearances wait. */
  avoid: string | null;
  priority: boolean;
  landingClearance: boolean;
  goAround: string | null;
  vacated: boolean;
  vacateDelayS: number;
  airborneT: number | null;
  misreads: boolean;
  phase: string;
  need: string | null;
  control: boolean;
  flags: Map<string, Flag>;
  track: TrackPoint[];
  messages: Message[];
  markers: Marker[];
  riskSeries: FlightRecord["riskSeries"];
  separation: FlightRecord["separation"];
}

export interface Effect {
  flightId: string;
  action: string;
  t: number;
  messageId: string;
  /** When the transmission that authorised it finished. */
  authorisedT: number;
}

const ORDER: RiskLevel[] = ["normal", "watch", "high", "critical"];
const levelOf = (score: number) => ORDER[score >= 80 ? 3 : score >= 50 ? 2 : score >= 25 ? 1 : 0]!;
const ATTENTION: Attention[] = ["none", "monitor", "intervene", "human_requested", "human_control"];
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r1 = (x: number) => Math.round(x * 10) / 10;

export class Sim {
  t = 0;
  /** The exact time of the procedure now running; the aircraft move on whole seconds. */
  now = 0;
  readonly rand: () => number;
  readonly flights: Flight[] = [];
  readonly effects: Effect[] = [];
  readonly closed = new Set<string>();
  readonly stats = { conflictsPredicted: 0, conflictsResolved: 0, lossesOfSeparation: 0, escalations: 0 };
  private readonly timing: ReturnType<typeof timingModel>;
  private readonly procs: { gen: Generator<Wait, unknown, unknown>; wake: Wait | null; send?: unknown }[] = [];
  private readonly onAir = new Set<string>();
  private readonly urgentOn = new Map<string, number>();
  private readonly heard = new Map<string, string[]>();
  private readonly lost = new Set<string>();
  private calls = 0;

  constructor(readonly options: SimOptions) {
    this.rand = random(options.seed);
    this.timing = timingModel(random(options.seed ^ 0x5f3759df), options.modelTiming);
  }

  spawn(gen: Generator<Wait, unknown, unknown>): void {
    this.procs.push({ gen, wake: null });
  }

  live(f: Flight): boolean {
    return this.t >= f.startT && f.endT === null;
  }

  airborne(): Flight[] {
    return this.flights.filter((f) => this.live(f) && f.body.mode === "air");
  }

  mark(f: Flight, kind: Marker["kind"], label: string, other?: Flight): void {
    f.markers.push({ t: r1(this.now), kind, label, ...(other && { otherFlightId: other.id }) });
  }

  facts(f: Flight): string[] {
    const b = f.body;
    const where = b.mode === "air" ? `${shortLevel(b.altFt, f.port.transitionFt)}, heading ${Math.round(b.hdg) % 360}, ${Math.round(b.gsKt)} kt` : f.phase;
    return [`${f.id} ${f.type}, ${f.origin} to ${f.filed}: ${where}`, ...[...f.flags.values()].map((x) => x.reason)];
  }

  say(f: Flight, m: Omit<Message, "id" | "t" | "durationS" | "position">): Message {
    const message: Message = { id: `${f.id}-${f.messages.length + 1}`, t: r1(this.now), durationS: speechSeconds(m.text), position: f.position, ...m };
    // The modelled pause paces the radio. It is not a decision time: rules decide at once.
    if (m.brain === "rules" && m.from !== "operator") message.timings = m.timings.filter((x) => x.stage !== "decide");
    f.messages.push(message);
    const log = this.heard.get(f.facility) ?? [];
    log.push(`${m.speaker}: ${m.text}`);
    if (log.length > 8) log.shift();
    this.heard.set(f.facility, log);
    return message;
  }

  /** A line that needs no readback: to responders, a supervisor, or nobody answering. */
  *transmit(
    f: Flight,
    line: { text: string; kind: Message["kind"]; speaker?: string; from?: Message["from"]; decision?: Message["decision"]; replyTo?: Message; urgent?: boolean },
  ): Proc<Message> {
    yield* this.acquire(f, line.urgent);
    const freq = f.facility;
    const from = line.from ?? "controller";
    const timings = [this.timing(from, "decide"), this.timing(from, "voice")];
    yield (timings[0]!.ms + timings[1]!.ms) / 1000;
    const m = this.say(f, {
      from, speaker: line.speaker ?? (from === "pilot" ? f.spoken : f.facility), kind: line.kind, text: line.text, brain: "rules", timings,
      ...(line.decision && { decision: line.decision }), ...(line.replyTo && { replyTo: line.replyTo.id }),
    });
    yield m.durationS;
    this.release(f, freq);
    return m;
  }

  private *acquire(f: Flight, urgent = false): Proc {
    if (urgent) {
      f.urgent++;
      this.urgentOn.set(f.facility, (this.urgentOn.get(f.facility) ?? 0) + 1);
    }
    const asked = f.facility;
    yield () => !f.busy && !this.onAir.has(f.facility) && (urgent || (!f.urgent && !this.urgentOn.get(f.facility)));
    if (urgent) {
      f.urgent--;
      this.urgentOn.set(asked, this.urgentOn.get(asked)! - 1);
    }
    f.busy = true;
    this.onAir.add(f.facility);
  }

  private release(f: Flight, freq: string): void {
    f.busy = false;
    this.onAir.delete(freq);
  }

  private *consult(f: Flight, role: AgentPrompt["role"], context: string[], choices: AgentPrompt["options"]): Proc<AgentReply | null> {
    if (!this.options.ask || this.calls >= (this.options.maxAgentCalls ?? 40)) return null;
    this.calls++;
    const reply = (yield {
      ask: {
        role, flightId: f.id, speaker: role === "pilot" ? f.spoken : f.facility, position: f.position,
        context, history: [...(this.heard.get(f.facility) ?? [])], options: choices,
      },
    }) as AgentReply | null;
    return reply && choices.some((c) => c.id === reply.optionId) ? reply : null;
  }

  private timed(who: "controller" | "pilot" | "operator", reply: AgentReply | null) {
    return (["decide", "voice"] as const).map((stage) => {
      const given = reply?.timings?.find((x) => x.stage === stage && Number.isFinite(x.ms) && x.ms >= 0);
      return given ? { ...given } : this.timing(who, stage);
    });
  }

  /** Request, validated decision, transmission, readback, and only then the effect. */
  *exchange(f: Flight, x: Exchange): Proc<Option | null> {
    yield* this.acquire(f, x.urgent);
    const freq = f.facility;
    let previous: Message | undefined;

    const speak = function* (this: Sim, m: Omit<Message, "id" | "t" | "durationS" | "position">): Proc<Message> {
      yield m.timings.reduce((s, v) => s + v.ms, 0) / 1000;
      const said = this.say(f, { ...m, ...(previous && { replyTo: previous.id }) });
      yield said.durationS;
      previous = said;
      return said;
    }.bind(this);

    if (x.request) {
      const { text, kind = "request", need } = x.request;
      if (need) f.need = need;
      const choice = { id: "transmit", action: kind, text };
      const asked = x.story ? yield* this.consult(f, "pilot", this.facts(f), [choice]) : null;
      // With one thing to say, an agent only counts if its own words are the ones transmitted.
      const own = wording(text, asked);
      const reply = own ? asked : null;
      yield* speak({
        from: "pilot", speaker: f.spoken, kind, text: own ?? text, brain: brainOf(reply), timings: this.timed("pilot", reply), ...audio(reply),
      });
    }

    const options = typeof x.options === "function" ? x.options() : x.options;
    const first = options[0];
    if (!first) {
      f.need = null;
      this.release(f, freq);
      return null;
    }

    const context = [...this.facts(f), ...(x.context?.() ?? [])];
    const full = (o: Option) => `${f.spoken}, ${o.say}.`;
    // With one valid option there is no decision to hand to an agent.
    const reply = x.story && !x.operator && options.length > 1
      ? yield* this.consult(f, "controller", context, options.map((o) => ({ id: o.id, action: o.action, text: full(o) })))
      : null;
    const chosen = options.find((o) => o.id === reply?.optionId) ?? first;
    const kind = x.kind ?? "clearance";
    const issued = yield* speak({
      from: x.operator ? "operator" : "controller",
      speaker: x.operator ? "Supervisor (scripted stand-in)" : f.facility,
      kind,
      text: full(chosen),
      brain: brainOf(reply),
      timings: this.timed(x.operator ? "operator" : "controller", reply),
      ...audio(reply),
      decision: {
        action: chosen.action,
        reason: reply?.reason || chosen.reason || x.reason || "Routine instruction for this stage of flight.",
        context,
        verdict: chosen.blockedBy ? "rejected" : "accepted",
        ...(chosen.blockedBy && { blockedBy: chosen.blockedBy }),
      },
    });

    let authority = issued;
    if (x.readback !== false) {
      const readbackKind = x.readbackKind ?? (kind === "clearance" || kind === "handoff" ? "readback" : "info");
      if (x.misheard) {
        f.flags.set("readback", { score: 38, reason: "Readback did not match the clearance", need: "Corrected clearance", status: "readback error" });
        yield* speak({ from: "pilot", speaker: f.spoken, kind: "readback", text: `${capital(x.misheard)}, ${f.spoken}.`, brain: "rules", timings: this.timed("pilot", null) });
        yield* speak({
          from: "controller", speaker: f.facility, kind: "clearance", text: `${f.spoken}, negative, I say again, ${chosen.readback ?? chosen.say}.`, brain: "rules",
          timings: this.timed("controller", null),
          decision: { action: "correct_readback", reason: "The readback differed from the validated clearance, so nothing changes until it is read back correctly.", context: [`Cleared: ${chosen.say}`, `Read back: ${x.misheard}`], verdict: "rejected", blockedBy: "readback mismatch" },
        });
      }
      const text = `${capital(chosen.readback ?? chosen.say)}, ${f.spoken}.`;
      const unable = { id: "unable", action: "escalate", text: `Unable, request the supervisor, ${f.spoken}.` };
      const mayRefuse = x.story && !x.urgent && !x.misheard && options.length > 1 && chosen.effect && !f.flags.has("unable");
      const heard = mayRefuse
        ? yield* this.consult(f, "pilot", [...this.facts(f), issued.text], [{ id: "readback", action: "readback", text }, unable])
        : null;
      const refused = heard?.optionId === unable.id;
      authority = yield* speak({
        from: "pilot", speaker: f.spoken, kind: refused ? "escalation" : readbackKind, text: refused ? unable.text : text,
        brain: brainOf(heard), timings: this.timed("pilot", heard), ...audio(heard),
      });
      if (refused) {
        f.flags.set("unable", { score: 70, reason: "Pilot refused the clearance", attention: "human_requested", need: "Supervisor", status: "unable, human requested" });
        this.stats.escalations++;
        this.mark(f, "escalation", "Pilot unable: human requested");
        f.need = null;
        this.release(f, freq);
        return null;
      }
      if (x.misheard) {
        f.flags.delete("readback");
        this.mark(f, "resolved", "Readback error caught and corrected");
      }
    }

    if (chosen.effect) {
      chosen.effect();
      this.effects.push({ flightId: f.id, action: chosen.action, t: this.t, messageId: authority.id, authorisedT: authority.t + authority.durationS });
    }
    f.need = null;
    this.release(f, freq);
    return chosen;
  }

  async run(): Promise<void> {
    const { durationS } = this.options;
    for (this.t = 0; this.t <= durationS; this.t++) {
      if (this.t > 0) for (const f of this.flights) if (this.live(f)) step(f.body, 1);
      await this.resume();
      this.record();
    }
    this.t = durationS;
    for (const f of this.flights) {
      if (f.track[f.track.length - 1]?.[0] !== (f.endT ?? durationS)) this.trackPoint(f, f.endT ?? durationS);
    }
  }

  private async resume(): Promise<void> {
    for (let i = 0; i < this.procs.length; i++) {
      const p = this.procs[i]!;
      for (;;) {
        if (typeof p.wake === "number") {
          // A procedure can finish waiting between two ticks; keep its exact time.
          if (p.wake > this.t) break;
          this.now = p.wake;
        } else {
          if (typeof p.wake === "function" && !p.wake()) break;
          this.now = this.t;
        }
        const r = p.gen.next(p.send);
        p.send = undefined;
        if (r.done) {
          this.procs.splice(i--, 1);
          break;
        }
        if (typeof r.value === "number") p.wake = this.now + r.value;
        else if (typeof r.value === "function") p.wake = r.value;
        else {
          try {
            p.send = await this.options.ask!(r.value.ask);
          } catch {
            p.send = null;
          }
          p.wake = this.now;
        }
      }
    }
  }

  private trackPoint(f: Flight, t: number): void {
    const b = f.body;
    f.track.push([t, r4(b.lat), r4(b.lon), Math.round(b.altFt / 10) * 10, Math.round(b.gsKt), Math.round(b.hdg) % 360, Math.round(b.vsFpm / 50) * 50]);
  }

  private record(): void {
    const t = this.t;
    const flying = this.airborne();
    for (let i = 0; i < flying.length; i++) {
      for (let j = i + 1; j < flying.length; j++) {
        const a = flying[i]!;
        const b = flying[j]!;
        if (Math.abs(a.body.altFt - b.body.altFt) >= 999 || Math.abs(a.body.lat - b.body.lat) > 0.1 || !separationApplies(a.body, b.body)) continue;
        if (kwikdist(a.body.lat, a.body.lon, b.body.lat, b.body.lon) >= minimumNm(a.body, b.body)) continue;
        const key = `${a.id}/${b.id}`;
        if (this.lost.has(key)) continue;
        this.lost.add(key);
        this.stats.lossesOfSeparation++;
        for (const [f, o] of [[a, b], [b, a]] as const) {
          f.flags.set("los", { score: 100, reason: `Separation lost with ${o.id}`, attention: "intervene" });
          this.mark(f, "conflict", `Separation lost with ${o.id}`, o);
        }
      }
    }

    for (const f of this.flights) {
      if (!this.live(f)) continue;
      const moving = f.body.gsKt > 0;
      if (t === f.startT || t % (moving ? 10 : 60) === 0) this.trackPoint(f, t);
      if (t === f.startT || t % 3 === 0) this.assess(f);
      if (f.body.mode === "air" && t % 20 === 0) {
        const near = closest(f, flying);
        if (near) f.separation.push({ t, ...near });
      }
    }
  }

  private assess(f: Flight): void {
    const flags = [...f.flags.values()].sort((a, b) => b.score - a.score);
    const factors: [number, string][] = flags.map((x) => [x.score, x.reason]);
    const b = f.body;
    if (b.mode === "air" && b.kind === "arr" && b.ils) factors.push([12, "On final approach"]);
    else if (b.mode === "air" && b.altFt - b.elevFt < 10000) factors.push([8, "Low altitude in terminal airspace"]);
    else if (b.mode === "roll" || b.mode === "lineup") factors.push([14, "On an active runway"]);
    factors.sort((x, y) => y[0] - x[0]);
    // The worst factor sets the score; each further one adds a fifth of itself.
    const score = Math.min(100, Math.round(factors.reduce((s, [v], i) => s + (i ? v / 5 : v), 2)));
    const risk: Risk = { score, level: levelOf(score), reasons: factors.map((x) => x[1]) };

    let attention: Attention = score >= 25 ? "monitor" : "none";
    for (const x of flags) if (x.attention && ATTENTION.indexOf(x.attention) > ATTENTION.indexOf(attention)) attention = x.attention;
    if (f.control) attention = "human_control";
    const need = flags.find((x) => x.need)?.need ?? f.need;
    const status = f.control ? "under human control" : flags.find((x) => x.status)?.status ?? describe(f);
    const last = f.riskSeries[f.riskSeries.length - 1];
    if (
      last && last.attention === attention && last.need === need && last.status === status && last.position === f.position &&
      last.facility === f.facility && last.risk.score === score && last.risk.reasons.join() === risk.reasons.join()
    ) return;
    f.riskSeries.push({ t: this.t, risk, attention, need, status, position: f.position, facility: f.facility });
  }

  records(): FlightRecord[] {
    const end = this.options.durationS;
    return this.flights.filter((f) => f.startT <= end).map((f) => {
      const last = f.riskSeries[f.riskSeries.length - 1]!;
      const [, lat, lon, altFt, gsKt, hdg, vsFpm] = f.track[f.track.length - 1]!;
      const summary: FlightSummary = {
        id: f.id, callsign: f.id, airline: f.airline, type: f.type, origin: f.origin, destination: f.filed,
        status: last.status, position: f.position, facility: f.facility, lat, lon, altFt, gsKt, hdg, vsFpm,
        risk: last.risk, attention: last.attention, need: last.need, lastMessage: f.messages[f.messages.length - 1]?.text ?? null,
      };
      return {
        summary, startT: f.startT, endT: f.endT ?? end, track: f.track,
        messages: f.messages.sort((a, b) => a.t - b.t),
        markers: f.markers.sort((a, b) => a.t - b.t),
        riskSeries: f.riskSeries, separation: f.separation,
      };
    });
  }
}

const brainOf = (reply: AgentReply | null): Brain => (reply?.brain === "llm" ? "llm" : "rules");
const audio = (reply: AgentReply | null) => (reply?.audioUrl ? { audioUrl: reply.audioUrl } : {});

/** An agent may reword a line, but may not introduce a number. */
function wording(text: string, reply: AgentReply | null): string | null {
  const said = reply?.text?.trim();
  if (!said || said.length > 260) return null;
  const allowed: string[] = text.match(/\d+/g) ?? [];
  return (said.match(/\d+/g) ?? []).every((n) => allowed.includes(n)) ? said : null;
}

function describe(f: Flight): string {
  const b = f.body;
  if (b.mode === "rollout") return `landed ${f.runway.id}`;
  if (b.mode === "roll") return `taking off ${f.runway.id}`;
  if (b.mode !== "air") return f.phase;
  if (b.orbit) return `holding ${shortLevel(b.clearedAlt, f.port.transitionFt)}`;
  if (b.heading !== null) return `on heading ${String(Math.round(b.heading) || 360).padStart(3, "0")}`;
  if (b.kind === "arr" && b.ils) return `${f.landingClearance ? "cleared to land" : "approach"} ${f.runway.id}`;
  if (b.kind === "arr" && b.speed !== null && !f.priority) return `sequenced, speed ${b.speed}`;
  const to = shortLevel(b.clearedAlt, f.port.transitionFt);
  if (b.clearedAlt > b.altFt + 50) return `climbing ${to}`;
  if (b.clearedAlt < b.altFt - 50) return `descending ${to}`;
  return `${b.kind === "cruise" ? "cruise" : "level"} ${to}`;
}
