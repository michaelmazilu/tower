import type {
  Brain,
  ControlPosition,
  FlightRecord,
  FlightSummary,
  HandoffBrief,
  Marker,
  Message,
  OperatorInstruction,
  OpsState,
  RiskLevel,
  Timing,
} from "@towerai/contracts";
import {
  DecisionTurn,
  availableClearances,
  controlPosition,
  distanceToThreshold,
  flyingSec,
  NM,
  inboundArrivals,
  touchdownIn,
  type Aircraft,
  type ClearanceType,
  type PilotRequest,
  type SimEvent,
  type Simulation,
  type ToolGateway,
  type ToolResult,
  type Transmission,
} from "@towerai/core";
import { assess, escalationReason, nearestTraffic } from "./assess";
import { FACILITY, flightPlan, latLon, statusText } from "./describe";
import { radioSpeech } from "../voice/speech";
import type { Plugins } from "./plugins";

/**
 * What the operator sees: live summaries, alerts and every flight's history
 * since the run began. It is derived from simulation state and events and
 * never changes the world, except where a person explicitly acts through it.
 */

const LIST_AFTER_HANDOFF_SEC = 90;
const ALERTS_SHOWN = 30;
const ALERT_REPEAT_SEC = 120;
/** News goes off the banner by itself. An emergency or a call for a person stays until it is dealt with. */
const ALERT_STALE_SEC = 60;
const OUTCOME_SHOWN_SEC = 25;
/** An instruction this soon after an incursion is the answer to it. */
const INCURSION_ANSWER_SEC = 20;
const AGENT_CALLER = "elevenlabs-tower";
export const OPERATOR = "human";

type Alert = OpsState["alerts"][number];
type Result = { ok: boolean; message?: string };

const SEVERITY = { normal: 0, watch: 1, high: 2, critical: 3 };
const ATTENTION_RANK = { human_requested: 4, intervene: 3, human_control: 2, monitor: 1, none: 0 };

const CONFLICT_TITLE: Record<string, [title: string, suggested: (ids: string[]) => string]> = {
  runway_incursion: ["Runway incursion", ([intruder, holder]) => `Stop ${intruder}, send ${holder} around`],
  arrival_runway_occupied: ["Runway not clear", ([arrival]) => `Send ${arrival} around if it stays blocked`],
  airborne_separation: ["Below minimum separation", ([one]) => `Take over ${one} and turn it away`],
  taxi_blocked: ["Taxi traffic blocked", ([one]) => `Reroute ${one}`],
};

const ADVISORY_KIND: Record<string, Message["kind"]> = {
  weather: "advisory",
  closure: "advisory",
  traffic: "advisory",
  handoff: "handoff",
  responders: "emergency",
  responders_ack: "info",
  details: "emergency",
  escalation: "escalation",
  info: "info",
};

const LABEL: Record<ClearanceType, string> = {
  PUSHBACK: "Approve pushback",
  TAXI: "Taxi",
  HOLD_SHORT: "Hold short",
  CROSS_RUNWAY: "Cross runway",
  LINE_UP_AND_WAIT: "Line up and wait",
  CLEARED_TAKEOFF: "Clear for takeoff",
  CLEARED_TO_LAND: "Clear to land",
  GO_AROUND: "Go around",
  HOLD: "Hold",
  CONTINUE_APPROACH: "Continue approach",
  HOLD_POSITION: "Hold position",
  CONTINUE_TAXI: "Continue taxi",
  RUNWAY_CHANGE: "Change to runway",
  VECTOR: "Heading, altitude, speed",
  RETURN_TO_LAND: "Priority return",
};
/** Things a person can do that are not clearances. */
const PRIORITY_LANDING = "PRIORITY_LANDING";
const ALERT_MEDICAL = "ALERT_MEDICAL";

interface History {
  record: FlightRecord;
  /** Set when the flight has left the simulation. */
  left?: "handed_off" | "removed";
  lastRejection?: string;
  runwayChangedAt?: number;
  seriesKey?: string;
  escalation?: string;
  medicsAlerted?: boolean;
  prioritised?: boolean;
  maydayLine?: string;
  maydayT?: number;
}

/** What an event told us about a transmission before it went on the air. */
interface Note {
  kind?: Message["kind"];
  speaker?: string;
  operator?: boolean;
  /** When the alert this answers went up. */
  alertT?: number;
  replyTo?: string;
  decision?: Message["decision"];
  timings?: Timing[];
}

/** What a step does, in words a newcomer reads at a glance. */
function plainStep(a: { clearanceType: string; label: string }, ac: Aircraft): string {
  switch (a.clearanceType) {
    case PRIORITY_LANDING: return `Give it priority to land on ${ac.assignedRunway}`;
    case ALERT_MEDICAL: return `Call paramedics to gate ${ac.gate}`;
    case "CLEARED_TO_LAND": return `Clear it to land on ${ac.assignedRunway}`;
    case "HOLD_POSITION": return "Stop it where it is";
    case "RETURN_TO_LAND": return "Bring it straight back to land";
    case "RUNWAY_CHANGE": return a.label.replace("Change to runway", "Move it to runway");
    default: return a.label;
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const tidy = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const normalRisk = () => ({ score: 0, level: "normal" as const, reasons: [] });
const brainOf = (caller: string): Brain => (caller === OPERATOR ? "human" : caller === AGENT_CALLER ? "llm" : "rules");

export class Ops {
  private readonly flights = new Map<string, History>();
  private readonly messages = new Map<string, Message>();
  private readonly notes = new Map<string, Note>();
  private readonly requestLine = new Map<string, string>();
  private readonly alerts = new Map<string, Alert>();
  /** Alert key -> the alert currently standing for it. */
  private readonly standing = new Map<string, Alert>();
  private readonly conflictPairs = new Map<string, string[]>();
  private incursion: { id: string; t: number; brokeOff?: { id: string; nm: number; afterS: number } } | undefined;
  private agentState: OpsState["controller"]["state"] = "listening";
  private reviewStarted: number | undefined;
  private reviewIsModel = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly sim: Simulation,
    private readonly gateway: ToolGateway,
    private readonly plugins: Plugins = {},
  ) {
    this.unsubscribe = sim.on((e) => this.record(e));
    this.refresh(true);
  }

  detach(): void {
    this.unsubscribe();
  }

  /** Call after each step. Samples once per simulated second. */
  update(): void {
    if (this.sim.tick % Math.round(1 / this.sim.config.dt) !== 0) return;
    this.refresh(true);
    for (const [key, alert] of this.standing) {
      if (alert.level === "critical" || key.startsWith("human:")) continue;
      if (this.sim.time - alert.t > (alert.level === "normal" ? OUTCOME_SHOWN_SEC : ALERT_STALE_SEC)) alert.acknowledged = true;
    }
  }

  /** The rules controller is about to run; its decisions are timed from here. */
  thinking(): void {
    this.reviewStarted = performance.now();
    this.reviewIsModel = false;
  }

  // ------------------------------------------------------------------- reads

  state(run: { runId: string; paused: boolean; speed: number; mode: string }): OpsState {
    const { sim } = this;
    const flights: FlightSummary[] = [];
    for (const { record, left } of this.flights.values()) {
      if (!left || (left === "handed_off" && sim.time - record.endT < LIST_AFTER_HANDOFF_SEC)) flights.push(record.summary);
    }
    const gone = (f: FlightSummary) => (this.flights.get(f.id)?.left ? 1 : 0);
    flights.sort(
      (a, b) =>
        gone(a) - gone(b) ||
        ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
        b.risk.score - a.risk.score ||
        a.id.localeCompare(b.id),
    );

    const active = sim.radio.active;
    const line = active ? this.messages.get(active.id) : undefined;
    const agent = run.mode === "elevenlabs";
    return {
      runId: run.runId,
      t: tidy(sim.time, 1),
      paused: run.paused,
      speed: run.speed,
      controller: {
        brain: agent ? "llm" : run.mode === "none" ? "human" : "rules",
        label: agent ? "ElevenLabs agent" : run.mode === "none" ? "No agent attached" : "Rules controller",
        state: agent ? this.agentState : "listening",
      },
      voice: { available: !!this.plugins.voice, label: this.plugins.voice?.label ?? "Captions only, no voice connected" },
      flights,
      onAir:
        active && line
          ? {
              flightId: active.from !== "TOWER" ? active.from : active.to === "ALL" ? null : active.to,
              speaker: line.speaker,
              text: line.text,
              audioUrl: line.audioUrl,
            }
          : null,
      alerts: [...this.alerts.values()].sort((a, b) => b.t - a.t).slice(0, ALERTS_SHOWN),
      runways: [...sim.runwayState.values()].map((r) => {
        const ends = sim.graph.runways.get(r.id)!.ends;
        const inUse = ends.some(
          (e) => sim.activeRunways.arrivals.includes(e.designator) || sim.activeRunways.departures.includes(e.designator),
        );
        // Taxiing across a closed runway does not open it.
        const state = sim.closedRunways.includes(r.id)
          ? "closed"
          : r.occupants.length
            ? "occupied"
            : r.reservation
              ? "reserved"
              : inUse
                ? "clear"
                : "inactive";
        return { id: r.id, state, flightId: r.occupants[0] ?? r.reservation?.aircraftId ?? null };
      }),
    };
  }

  flight(id: string): FlightRecord | null {
    return this.flights.get(id.toUpperCase())?.record ?? null;
  }

  actions(id: string): { clearanceType: string; label: string }[] {
    const ac = this.sim.get(id.toUpperCase());
    if (!ac) return [];
    const extra: { clearanceType: string; label: string }[] = [];
    const h = this.flights.get(ac.id);
    if (h?.escalation || ac.priority === "urgent") {
      if (!h?.prioritised && (ac.phase === "approach" || ac.phase === "holding")) extra.push({ clearanceType: PRIORITY_LANDING, label: `Priority landing ${ac.assignedRunway}` });
      if (!h?.medicsAlerted && ac.flight === "arrival") extra.push({ clearanceType: ALERT_MEDICAL, label: "Alert paramedics" });
    }
    const valid = availableClearances(this.sim, ac.id).map(({ type, runway, gate }) => {
      const where = type === "TAXI" && ac.flight === "arrival" ? `to gate ${gate}` : type === "TAXI" ? `to runway ${runway}` : runway;
      const bare = ["PUSHBACK", "GO_AROUND", "HOLD", "HOLD_POSITION", "CONTINUE_TAXI", "VECTOR"].includes(type);
      return { clearanceType: type as string, label: where && !bare ? `${LABEL[type]} ${where}` : LABEL[type] };
    });
    // The instruction a shut runway needs comes first.
    valid.sort((a, b) => Number(b.clearanceType === "RUNWAY_CHANGE") - Number(a.clearanceType === "RUNWAY_CHANGE"));
    return valid[0]?.clearanceType === "RUNWAY_CHANGE" ? [...valid, ...extra] : [...extra, ...valid];
  }

  // --------------------------------------------------------- the operator

  /** "I have control": the person is told exactly what the agent withdrew, so nothing it had planned surprises them later. */
  takeover(id: string): Result {
    const ac = this.sim.get(id.toUpperCase());
    const withdrawn = ac ? this.agentUnsaid(ac).map((c) => this.clearanceWords(c)) : [];
    const result = this.sim.dispatch({ type: "control.takeover", aircraftId: id.toUpperCase() });
    if (!result.ok) return { ok: false, message: result.message };
    const callsign = ac?.callsign ?? id.toUpperCase();
    return { ok: true, message: `You have ${callsign}.${withdrawn.length ? ` The agent withdrew what it had not yet said: ${withdrawn.join(", ")}.` : ""}` };
  }

  /** "You have control": the agent says what it picks up, the same words the person read before pressing. */
  handback(id: string): Result {
    const ac = this.sim.get(id.toUpperCase());
    const plan = ac ? this.onHandback(ac) : null;
    const result = this.sim.dispatch({ type: "control.handback", aircraftId: id.toUpperCase() });
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, message: `The agent has ${ac?.callsign ?? id.toUpperCase()}.${plan ? ` ${plan}` : ""}` };
  }

  /**
   * One press for the agent's recommendation: take control if needed, then send
   * the steps the person saw, in their name. If the picture has changed since
   * the brief was drawn, nothing is sent and they are asked to look again.
   */
  accept(id: string, steps: readonly string[]): Result {
    const ac = this.sim.get(id.toUpperCase());
    if (!ac) return { ok: false, message: `${id} is no longer here.` };
    const now = this.recommend(ac);
    const same = steps.length > 0 && steps.length === now.length && steps.every((s, i) => s === now[i]!.clearanceType);
    if (!same) return { ok: false, message: "The situation changed since this was shown. Read the new recommendation, then accept again." };
    if (!ac.humanControl) {
      const took = this.takeover(ac.id);
      if (!took.ok) return took;
    }
    const said: string[] = [];
    for (const step of now) {
      const r = this.instruct(ac.id, { clearanceType: step.clearanceType, reason: `accepted the agent's recommendation: ${step.why}` });
      if (!r.ok) return { ok: false, message: `${said.length ? `Sent: ${said.join(" ")} ` : ""}Not sent, ${step.label}: ${r.message}. You have control.` };
      said.push(r.message ?? step.label);
    }
    return { ok: true, message: `You have ${ac.callsign}. Sent: ${said.join(" ")}` };
  }

  // ------------------------------------------------------------- the briefing

  /** Clearances the agent decided but has not said. Taking over withdraws them. */
  private agentUnsaid(ac: Aircraft) {
    return [...this.sim.clearances.values()].filter((c) => c.aircraftId === ac.id && c.issuedBy !== OPERATOR && c.status === "issued");
  }

  private clearanceWords(c: { type: ClearanceType; runway?: string; gate?: string }): string {
    const where = c.type === "TAXI" && c.gate ? `to gate ${c.gate}` : c.runway;
    return (where ? `${LABEL[c.type]} ${where}` : LABEL[c.type]).toLowerCase();
  }

  /**
   * What the agent would do now, at most two steps, from the actions the
   * validator allows. Deterministic: the same picture gives the same advice.
   */
  private recommend(ac: Aircraft): HandoffBrief["recommend"] {
    const h = this.flights.get(ac.id);
    const valid = new Map(this.actions(ac.id).map((a) => [a.clearanceType, a]));
    const steps: HandoffBrief["recommend"] = [];
    const pick = (type: string, why: string) => {
      const a = valid.get(type);
      if (a && steps.length < 2 && !steps.some((s) => s.clearanceType === type)) steps.push({ ...a, label: plainStep(a, ac), why });
    };
    const emergency = ac.emergencyId ? this.sim.emergencies.get(ac.emergencyId) : undefined;
    if (ac.flags.incursionActive || ac.flags.incursionHold) pick("HOLD_POSITION", "it is on or near a runway without a clearance");
    if (ac.flags.runwayUnavailable) pick("RUNWAY_CHANGE", `runway ${ac.assignedRunway} is shut`);
    if (emergency?.type === "engine_failure" && ac.altitudeFt > 0) pick("RETURN_TO_LAND", "engine failure: bring it straight back");
    if (h?.escalation || ac.priority === "urgent") {
      const why = h?.escalation ?? "urgent priority";
      pick(PRIORITY_LANDING, `${why}: land it ahead of routine traffic`);
      pick(ALERT_MEDICAL, `so help is waiting at gate ${ac.gate} when it arrives`);
    }
    if (ac.phase === "approach" && !ac.landingCleared) pick("CLEARED_TO_LAND", `runway ${ac.assignedRunway} is available`);
    const asked = [...this.sim.requests.values()].find((r) => r.aircraftId === ac.id && r.status === "pending" && r.type !== "OTHER");
    const answer = { PUSHBACK: "PUSHBACK", TAXI: "TAXI", TAKEOFF: "CLEARED_TAKEOFF", LANDING: "CLEARED_TO_LAND", CROSS: "CROSS_RUNWAY" } as Record<string, string>;
    if (asked && answer[asked.type]) pick(answer[asked.type]!, "the pilot asked for it");
    return steps;
  }

  /** Where it is on the way in, who else is landing on that runway, and whether the runway is clear. */
  private surroundings(ac: Aircraft): Pick<HandoffBrief, "approach" | "around"> {
    const { sim } = this;
    const runway = ac.assignedRunway;
    const end = runway ? sim.graph.runwayEnd(runway) : undefined;
    if (!runway || !end || (ac.phase !== "approach" && ac.phase !== "landing")) return { approach: null, around: null };
    const physical = end.runway.id;
    const inbound = inboundArrivals(sim, physical);
    const mine = inbound.findIndex((x) => x.aircraft.id === ac.id);
    const miles = distanceToThreshold(sim, ac) / NM;
    const others = inbound
      .filter((x) => x.aircraft.id !== ac.id && x.distanceNm < Math.max(miles * 1.6, 8))
      .map((x) => ({ callsign: x.aircraft.callsign, miles: tidy(x.distanceNm, 1) }));
    const parts: string[] = [];
    const ahead = mine > 0 ? inbound[mine - 1] : undefined;
    const behind = mine >= 0 ? inbound[mine + 1] : undefined;
    parts.push(ahead ? `${ahead.aircraft.callsign} lands before it, ${Math.round(ahead.distanceNm)} miles out.` : `Nothing is ahead of it to runway ${ac.assignedRunway}.`);
    if (behind) parts.push(`${behind.aircraft.callsign} is ${Math.max(1, Math.round(behind.distanceNm - miles))} miles behind it.`);
    const on = sim.runwayState.get(physical)?.occupants.filter((id) => id !== ac.id) ?? [];
    if (sim.closedRunways.includes(physical)) parts.push(`Runway ${ac.assignedRunway} is closed.`);
    else parts.push(on.length ? `${on.map((id) => sim.get(id)?.callsign ?? id).join(" and ")} ${on.length > 1 ? "are" : "is"} on runway ${ac.assignedRunway} now.` : `Runway ${ac.assignedRunway} is clear right now.`);
    return {
      approach: { runway, miles: tidy(miles, 1), decisionNm: sim.config.rules.decisionDistanceNm, others },
      around: parts.join(" "),
    };
  }

  /** The few moments that explain how this flight got here, in plain words, oldest first. */
  private story(ac: Aircraft, h: History): HandoffBrief["story"] {
    const { record } = h;
    const lines: { t: number; text: string }[] = [];
    const add = (t: number, text: string) => {
      if (lines[lines.length - 1]?.text !== text) lines.push({ t, text });
    };
    const events = [
      ...record.markers.map((m) => ({ t: m.t, marker: m })),
      ...record.messages.map((m) => ({ t: m.t, message: m })),
    ].sort((a, b) => a.t - b.t);
    // The clearance behind a line has the gate and runway it named. A line said again has a new id, hence the fallback.
    const instruction = (m: Message) => {
      const type = m.decision!.action as ClearanceType;
      return [...this.sim.clearances.values()].find((x) => x.transmissionId === m.id) ?? { type, gate: ac.flight === "arrival" ? ac.gate : undefined };
    };
    for (const e of events) {
      if ("marker" in e && e.marker) {
        const m = e.marker;
        const other = m.otherFlightId ? (this.sim.get(m.otherFlightId)?.callsign ?? m.otherFlightId) : undefined;
        if (m.kind === "conflict") add(m.t, other ? `Runway conflict with ${other}` : "Runway conflict");
        else if (m.kind === "takeover") add(m.t, "You took over");
        else if (m.kind === "handback") add(m.t, "You handed it back to the agent");
        else if (m.kind === "closure") {
          // The all-stations closure is everyone's news; only a flight it moved has a story here.
          const shut = /^Runway (\S+) shut: (\S+)/.exec(m.label);
          const moved = /^Runway (\S+) to (\S+), after readback/.exec(m.label);
          if (shut) add(m.t, `Its runway ${shut[1]} closed; it was offered ${shut[2]}`);
          else if (moved) add(m.t, `Moved to runway ${moved[2]}`);
        }
        continue;
      }
      const m = (e as { message: Message }).message;
      if (m.decision?.verdict === "rejected") continue;
      if (m.from === "pilot" && (m.kind === "escalation" || m.kind === "emergency")) {
        add(m.t, h.escalation && m.kind === "escalation" ? `Pilot reported a ${h.escalation} and asked for a person` : "Pilot declared an emergency");
      } else if (m.from === "controller" && m.kind === "escalation") {
        add(m.t, "Agent told the pilot to stand by for a person");
      } else if (m.from === "operator") {
        if (/priority/i.test(m.text)) add(m.t, `You gave it priority to land on ${ac.assignedRunway}`);
        else if (/paramedics/i.test(m.text)) add(m.t, `You called paramedics to gate ${ac.gate}`);
        else if (m.decision?.action) add(m.t, `You told it to ${this.order(instruction(m), ac)}`);
      } else if (m.from === "controller" && m.kind === "clearance" && m.decision?.action) {
        add(m.t, `Agent told it to ${this.order(instruction(m), ac)}`);
      }
    }
    return lines.slice(-4);
  }

  /** A clearance as an order in plain words: "stop where it is", "abort the landing and climb away". */
  private order(c: { type: ClearanceType; runway?: string; gate?: string }, ac: Aircraft): string {
    const rw = c.runway ?? ac.assignedRunway;
    switch (c.type) {
      case "HOLD_POSITION": return "stop where it is";
      case "GO_AROUND": return "abort the landing and climb away";
      case "CLEARED_TO_LAND": return `land on runway ${rw}`;
      case "CLEARED_TAKEOFF": return `take off from runway ${rw}`;
      case "HOLD_SHORT": return `stop before runway ${rw}`;
      case "LINE_UP_AND_WAIT": return `line up on runway ${rw} and wait`;
      case "CROSS_RUNWAY": return `cross runway ${rw}`;
      case "CONTINUE_APPROACH": return `keep coming in to runway ${rw}`;
      case "TAXI": return c.gate ? `taxi to gate ${c.gate}` : `taxi to runway ${rw}`;
      case "RETURN_TO_LAND": return "come straight back to land";
      default: return this.clearanceWords(c);
    }
  }

  /** A mayday, said plainly: what failed, what it is doing about it, and how far it has to go. */
  private engineFailure(ac: Aircraft, miles: number): { problem: string; context: string } | null {
    const emergency = ac.emergencyId ? this.sim.emergencies.get(ac.emergencyId) : undefined;
    if (emergency?.type !== "engine_failure") return null;
    const rw = ac.assignedRunway;
    if (ac.altitudeFt <= 0) return { problem: "Engine failure, now on the ground", context: `It landed on runway ${rw}. Fire and rescue are with it.` };
    const where = `${miles} miles from runway ${rw}, at ${Math.round(ac.altitudeFt / 100) * 100} ft`;
    return ac.flags.emergencyReturn
      ? { problem: "Engine failure after takeoff", context: `It is turning back to land on runway ${rw}. Now ${where}.` }
      : { problem: "Engine failure", context: `It is landing on runway ${rw} as soon as it can. Now ${where}.` };
  }

  /** Two aircraft and one runway, said the way a person would say it. */
  private runwayConflict(ac: Aircraft, miles: number, minutes: number): { problem: string; context: string } | null {
    const { sim } = this;
    const c = [...sim.conflicts.values()].find(
      (x) => x.aircraftIds.includes(ac.id) && (x.type === "runway_incursion" || x.type === "arrival_runway_occupied"),
    );
    const intruder = ac.flags.incursionActive || ac.flags.incursionHold;
    if (!c && !intruder) return null;
    const name = (id: string | undefined) => (id ? (sim.get(id)?.callsign ?? id) : "another aircraft");
    const physical = c?.runwayId;
    const rw = physical && physical.split("/").includes(ac.assignedRunway ?? "") ? ac.assignedRunway : (physical ?? ac.assignedRunway);
    let other = c?.aircraftIds.find((id) => id !== ac.id);
    if (!other && physical) other = sim.runwayState.get(physical)?.occupants.find((id) => id !== ac.id);
    if (intruder) {
      const o = other ? sim.get(other) : undefined;
      const oMiles = o && o.altitudeFt > 0 ? Math.max(1, Math.round(distanceToThreshold(sim, o) / NM)) : null;
      return {
        problem: `On runway ${rw} without permission`,
        context: o
          ? oMiles !== null
            ? `${name(other)} is coming in to land on that runway, ${oMiles} miles out.`
            : `${name(other)} is using that runway.`
          : "It needs to stop, then get off the runway.",
      };
    }
    // An arrival conflict lists the arrival first; an incursion lists whoever is in the way first.
    const inTheWay = c?.type === "arrival_runway_occupied" ? c.aircraftIds[0] !== ac.id : c?.aircraftIds[0] === ac.id;
    if (inTheWay) {
      const o = other ? sim.get(other) : undefined;
      return {
        problem: `In the way on runway ${rw}`,
        context: o && o.altitudeFt > 0 ? `${name(other)} is coming in to land on that runway.` : `${name(other)} needs that runway.`,
      };
    }
    return {
      problem: "Its runway is blocked",
      context:
        ac.phase === "go_around"
          ? `${name(other)} is on runway ${rw}. ${ac.callsign} has aborted its landing and is climbing away.`
          : `${name(other)} is on runway ${rw}. ${ac.callsign} is ${miles} miles out, about ${minutes} min from touchdown.`,
    };
  }

  /** Before handing back, the person reads what the agent will and will not do. */
  private onHandback(ac: Aircraft): string {
    const h = this.flights.get(ac.id);
    const first = h?.prioritised || ac.priority === "urgent" || ac.priority === "emergency";
    let will: string;
    if (ac.flags.runwayUnavailable) will = "The agent will move it to an open runway.";
    else if (ac.phase === "approach" && !ac.landingCleared) will = `The agent will clear it to land on ${ac.assignedRunway}${first ? " ahead of other traffic" : ""} once the runway is free.`;
    else if (ac.phase === "approach" || ac.phase === "landing") will = `The agent will land it on ${ac.assignedRunway} and taxi it to gate ${ac.gate}.`;
    else if (ac.phase === "go_around" || ac.phase === "holding") will = `The agent will bring it back to land on ${ac.assignedRunway}.`;
    else will = "The agent will handle its next request.";
    const wont = h?.escalation && ac.flight === "arrival" && !h.medicsAlerted ? " It will not call paramedics, so call them first if needed." : "";
    return will + wont;
  }

  private brief(ac: Aircraft, attention: FlightSummary["attention"], status: string, open: readonly PilotRequest[]): HandoffBrief | undefined {
    if (attention !== "human_requested" && attention !== "intervene" && attention !== "human_control") return undefined;
    const { sim } = this;
    const h = this.flights.get(ac.id)!;
    const held = attention === "human_control";
    const cap = (x: string) => x[0]!.toUpperCase() + x.slice(1);

    const miles = Math.max(1, Math.round(distanceToThreshold(sim, ac) / NM));
    const minutes = Math.max(1, Math.round(touchdownIn(sim, ac) / 60));
    const runway = this.runwayConflict(ac, miles, minutes) ?? this.engineFailure(ac, miles);
    const problem = cap(h.escalation ?? runway?.problem ?? h.record.summary.risk.reasons[0] ?? "The pilot asked for a person");
    const context = runway
      ? runway.context
      : ac.phase === "approach" || ac.phase === "landing"
        ? `Landing on runway ${ac.assignedRunway}, ${miles} miles out, about ${minutes} min from touchdown.`
        : ac.phase === "go_around" && ac.flags.emergencyReturn
          ? `Turning back to land on runway ${ac.assignedRunway}.`
        : ac.phase === "go_around"
          ? `Aborted its landing and is coming back around for runway ${ac.assignedRunway}.`
          : ac.phase === "holding"
            ? `Circling in a hold, waiting to land on runway ${ac.assignedRunway}.`
            : `${cap(status)}.`;

    let deadline: HandoffBrief["deadline"] = null;
    if (ac.phase === "approach" && !ac.landingCleared) {
      const inS = Math.round(touchdownIn(sim, ac) - flyingSec(sim.config.rules.decisionDistanceNm * NM));
      if (Number.isFinite(inS) && inS > 0) deadline = { inS, then: "it has to abort the landing" };
    }

    // What is true right now, so nobody has to work it out from the radio log.
    const now: string[] = [held ? `You are in control. The agent will not talk to ${ac.callsign}.` : `The agent is still handling ${ac.callsign} until you take over.`];
    if (h.prioritised) now.push(`It has priority to land on runway ${ac.assignedRunway}.`);
    if (h.medicsAlerted) now.push(`Paramedics are on their way to gate ${ac.gate}.`);
    if (ac.phase === "approach" && !ac.landingCleared) now.push("It is not cleared to land yet.");
    let agentDoing: HandoffBrief["agentDoing"] = null;
    const latest = ac.clearance ? sim.clearances.get(ac.clearance.id) : undefined;
    if (latest) {
      const order = this.order(latest, ac);
      const who = latest.issuedBy === OPERATOR ? "You" : "The agent";
      const recent = sim.time - (latest.acknowledgedAt ?? -Infinity) < 60;
      if (latest.status === "transmitted") now.push(`${who} told ${ac.callsign} to ${order}. Waiting for the pilot to confirm.`);
      else if (latest.status === "readback_missing") now.push(`The pilot did not confirm the order to ${order}.`);
      // Before takeover, the suggestion line already says it was confirmed.
      else if (latest.status === "acknowledged" && recent && latest.issuedBy !== OPERATOR && held) now.push(`${ac.callsign} confirmed it will ${order}.`);
      if (!held && latest.issuedBy !== OPERATOR && latest.status === "transmitted") {
        agentDoing = { text: `The agent is already telling ${ac.callsign} to ${order}.`, cancelledByTakeover: false };
      } else if (!held && latest.issuedBy !== OPERATOR && latest.status === "acknowledged" && recent) {
        agentDoing = { text: `The agent has told ${ac.callsign} to ${order}, and the pilot confirmed.`, cancelledByTakeover: false };
      }
    }
    if (!held) {
      for (const c of this.agentUnsaid(ac)) {
        now.push(`The agent is about to tell ${ac.callsign} to ${this.order(c, ac)}.`);
        agentDoing = { text: `The agent is already telling ${ac.callsign} to ${this.order(c, ac)}.`, cancelledByTakeover: true };
      }
    }
    for (const r of open) {
      if (r.type !== "OTHER" && r.heardAt !== undefined && sim.time - r.heardAt >= 60) now.push(`The pilot has waited ${Math.floor((sim.time - r.heardAt) / 60)} min for ${r.type.toLowerCase()}.`);
    }

    return {
      problem, context, deadline, recommend: this.recommend(ac), now, agentDoing,
      ...this.surroundings(ac), story: this.story(ac, h), onHandback: held ? this.onHandback(ac) : null };
  }

  instruct(id: string, body: Partial<OperatorInstruction>): Result {
    const ac = this.sim.get(id.toUpperCase());
    if (!ac) return { ok: false, message: `${id} is no longer here.` };
    if (!ac.humanControl) return { ok: false, message: `Take over ${ac.callsign} before instructing it.` };
    const { clearanceType, reason, runway, gate } = body;
    if (clearanceType === PRIORITY_LANDING || clearanceType === ALERT_MEDICAL) return this.assist(ac, clearanceType, reason);
    const result = new DecisionTurn(this.sim, this.gateway, OPERATOR).call("issue_clearance", {
      aircraftId: ac.id,
      clearanceType,
      reason,
      ...(runway ? { runway } : {}),
      ...(gate ? { gate } : {}),
    });
    if (!result.ok) return { ok: false, message: result.error.message };
    return result.result.status === "accepted"
      ? { ok: true, message: str(result.result.phraseology) }
      : { ok: false, message: str(result.result.message) };
  }

  private assist(ac: Aircraft, action: string, reason?: string): Result {
    if (!this.actions(ac.id).some((a) => a.clearanceType === action)) return { ok: false, message: `That is not available for ${ac.callsign} now.` };
    const why = reason?.trim() || "operator decision";
    const landing = action === PRIORITY_LANDING;
    const text = landing
      ? `${ac.callsign}, you have priority, number one for runway ${ac.assignedRunway}.`
      : `Paramedics, Toronto Tower operator, medical emergency ${ac.callsign}, meet at gate ${ac.gate}.`;
    if (landing) this.sim.dispatch({ type: "priority.set", aircraftId: ac.id, priority: "urgent", reason: why });
    const said = this.sim.dispatch({
      type: "advisory.issue", kind: landing ? "info" : "responders", text, spoken: radioSpeech(text), aircraftId: ac.id, by: "operator", reason: why,
    });
    if (!said.ok) return { ok: false, message: said.message };
    const h = this.flights.get(ac.id)!;
    if (landing) h.prioritised = true;
    else h.medicsAlerted = true;
    // The brief must stop recommending what was just done.
    this.refresh(false);
    return { ok: true, message: text };
  }

  acknowledge(alertId: string): Result {
    const alert = this.alerts.get(alertId);
    if (!alert) return { ok: false, message: `No alert ${alertId}.` };
    alert.acknowledged = true;
    return { ok: true };
  }

  // ----------------------------------------------------------------- sampling

  private history(ac: Aircraft): History {
    let h = this.flights.get(ac.id);
    if (h) {
      h.left = undefined;
      return h;
    }
    const position = controlPosition(this.sim, ac);
    const [lat, lon] = latLon(this.sim, ac.position);
    h = {
      record: {
        summary: {
          id: ac.id,
          callsign: ac.callsign,
          ...flightPlan(ac),
          type: ac.type,
          status: statusText(this.sim, ac),
          position,
          facility: FACILITY[position],
          lat,
          lon,
          altFt: tidy(ac.altitudeFt),
          gsKt: tidy(ac.speedKts),
          hdg: tidy(ac.headingDeg) % 360,
          vsFpm: 0,
          risk: normalRisk(),
          attention: "none",
          need: null,
          lastMessage: null,
        },
        startT: this.sim.time,
        endT: this.sim.time,
        track: [],
        messages: [],
        markers: [],
        riskSeries: [],
        separation: [],
      },
    };
    this.flights.set(ac.id, h);
    return h;
  }

  private refresh(sample: boolean): void {
    const { sim } = this;
    const open = new Map<string, PilotRequest[]>();
    for (const r of sim.requests.values()) {
      if (r.status !== "pending" && r.status !== "transmitting") continue;
      // A call for a person counts from the moment it can be heard.
      if (r.type === "OTHER" && !this.requestLine.has(r.id)) continue;
      open.set(r.aircraftId, [...(open.get(r.aircraftId) ?? []), r]);
    }
    const t = tidy(sim.time, 1);

    for (const ac of sim.aircraft.values()) {
      const h = this.history(ac);
      const { record } = h;
      const [lat, lon] = latLon(sim, ac.position);
      const alt = tidy(ac.altitudeFt);
      const last = record.track[record.track.length - 1];
      let vsFpm = record.summary.vsFpm;
      if (sample && last?.[0] !== t) {
        vsFpm = last && alt > 0 ? tidy(((alt - last[3]) / (t - last[0])) * 6) * 10 : 0;
        record.track.push([t, lat, lon, alt, tidy(ac.speedKts), tidy(ac.headingDeg) % 360, vsFpm]);
      }

      const near = nearestTraffic(sim, ac);
      if (sample && near && record.separation[record.separation.length - 1]?.t !== t) record.separation.push({ t, ...near });

      const { risk, attention, need } = assess(sim, ac, open.get(ac.id) ?? [], near, h.runwayChangedAt, h.escalation);
      const position = controlPosition(sim, ac);
      const facility = FACILITY[position];
      const status = statusText(sim, ac);
      if (position !== record.summary.position) {
        this.mark(ac.id, "handoff", `${record.summary.facility} to ${facility}`);
      }
      record.endT = t;
      record.summary = {
        ...record.summary,
        status,
        position,
        facility,
        lat,
        lon,
        altFt: alt,
        gsKt: tidy(ac.speedKts),
        hdg: tidy(ac.headingDeg) % 360,
        vsFpm,
        risk,
        attention,
        need,
      };
      const brief = this.brief(ac, attention, status, open.get(ac.id) ?? []);
      if (brief) record.summary.brief = brief;
      else delete record.summary.brief;
      this.pushSeries(h, t);
    }
  }

  private pushSeries(h: History, t: number): void {
    const { risk, attention, need, status, position, facility } = h.record.summary;
    // A distance ticking down in the wording is not a new step.
    const key = JSON.stringify([risk, attention, need, status, position]).replace(/\d+\.\d/g, (n) => String(Math.round(Number(n))));
    if (key === h.seriesKey) return;
    h.seriesKey = key;
    const series = h.record.riskSeries;
    if (series[series.length - 1]?.t === t) series.pop();
    series.push({ t, risk, attention, need, status, position, facility });
  }

  private mark(id: string | undefined, kind: Marker["kind"], label: string, otherFlightId?: string): void {
    if (!id) return;
    this.flights.get(id)?.record.markers.push({ t: tidy(this.sim.time, 1), kind, label, ...(otherFlightId ? { otherFlightId } : {}) });
  }

  private markAll(kind: Marker["kind"], label: string): void {
    for (const id of this.sim.aircraft.keys()) this.mark(id, kind, label);
  }

  private alert(
    key: string,
    flightId: string | null,
    level: RiskLevel,
    title: string,
    detail: string,
    suggestedAction: string | null,
  ): void {
    const t = tidy(this.sim.time, 1);
    const prior = this.standing.get(key);
    if (prior && t - prior.t < ALERT_REPEAT_SEC) {
      if (SEVERITY[level] > SEVERITY[prior.level]) prior.acknowledged = false;
      Object.assign(prior, { level, title, detail, suggestedAction });
      return;
    }
    const alert = { id: `A${this.alerts.size + 1}`, flightId, t, level, title, detail, suggestedAction, acknowledged: false };
    this.alerts.set(alert.id, alert);
    this.standing.set(key, alert);
  }

  private settle(key: string, how: string): void {
    const alert = this.standing.get(key);
    if (!alert || alert.level === "normal") return;
    Object.assign(alert, { level: "normal", title: `${how}: ${alert.title}`, suggestedAction: null, acknowledged: true });
  }

  private retitle(key: string, title: string): void {
    const alert = this.standing.get(key);
    if (alert) Object.assign(alert, { level: "normal", title, suggestedAction: null, acknowledged: true });
  }

  // ------------------------------------------------------------------- events

  private record(e: SimEvent): void {
    const { sim } = this;
    const d = e.data;
    const id = e.aircraftId;
    switch (e.type) {
      case "aircraft.spawned":
        this.refresh(true);
        return;

      case "aircraft.handed_off":
      case "aircraft.removed":
        this.leave(id!, e.type === "aircraft.handed_off" ? "handed_off" : "removed");
        return;

      case "radio.tx_started": {
        const tx = sim.transmissions.get(str(d.transmissionId));
        if (tx) this.onAir(tx, Number(d.estimatedDurationSec) || 0);
        return;
      }
      case "radio.tx_requeued": {
        const note = this.notes.get(str(d.replaces));
        if (note) this.notes.set(str(d.transmissionId), note);
        return;
      }
      case "radio.tx_interrupted": {
        const message = this.messages.get(str(d.transmissionId));
        if (!message) return;
        message.durationS = Math.max(0.1, tidy(e.simTime - message.t, 1));
        message.text = `${message.text.replace(/\.$/, "")} (cut off by priority traffic)`;
        delete message.audioUrl;
        return;
      }
      case "radio.tx_completed":
      case "radio.tx_failed": {
        const message = this.messages.get(str(d.transmissionId));
        if (message && message.durationS > 0) message.durationS = Math.max(0.1, tidy(e.simTime - message.t, 1));
        return;
      }

      case "controller.review_started":
        this.agentState = "reviewing";
        this.reviewStarted = performance.now();
        this.reviewIsModel = true;
        return;
      case "controller.review_completed":
      case "controller.review_cancelled":
        this.agentState = "listening";
        return;
      case "controller.error":
        this.agentState = "error";
        this.alert("agent", null, "high", "Controller agent error", str(d.message), "Take over flights that need an answer");
        return;

      case "clearance.issued": {
        const clearance = sim.clearances.get(str(d.clearanceId));
        const ac = id ? sim.get(id) : undefined;
        if (!clearance?.transmissionId) return;
        const caller = str(d.issuedBy);
        const brain = brainOf(caller);
        const timings: Timing[] = [];
        // Only our own controllers are timed: from the start of their review to this instruction.
        if (this.reviewStarted !== undefined && (caller === "baseline-controller" || (brain === "llm" && this.reviewIsModel))) {
          timings.push({
            stage: "decide",
            ms: tidy(performance.now() - this.reviewStarted, 1),
            kind: "measured",
            source: brain === "llm" ? "ElevenLabs agent, timed on this run" : "Rules controller (not an LLM), timed on this run",
          });
        }
        const request = clearance.requestId ?? this.openRequestLine(id, brain);
        const asked = request ? this.requestLine.get(request) : undefined;
        const type = str(d.clearanceType);
        const answering = type === "RETURN_TO_LAND" ? (id && this.flights.get(id)?.maydayLine) : asked;
        const { incursion } = this;
        this.notes.set(clearance.transmissionId, {
          timings,
          replyTo: id && answering && !this.answered(id, answering) ? answering : undefined,
          ...(incursion && e.simTime - incursion.t < INCURSION_ANSWER_SEC && (type === "GO_AROUND" || (type === "HOLD_POSITION" && id === incursion.id))
            ? { alertT: incursion.t }
            : {}),
          decision: {
            action: str(d.clearanceType),
            reason: str(d.reason),
            context: ac ? this.contextFor(ac, clearance.runway) : [],
            verdict: "accepted",
          },
        });
        const h = id ? this.flights.get(id) : undefined;
        if (h) h.lastRejection = undefined;
        return;
      }

      case "controller.decision":
        this.decided(e);
        return;

      case "advisory.issued":
        this.advised(e);
        return;

      case "runway.change_needed": {
        const [from, to] = [str(d.from), str(d.to)];
        const h = id ? this.flights.get(id) : undefined;
        if (h) h.runwayChangedAt = e.simTime;
        this.mark(id, "closure", `Runway ${from} shut: ${to} offered, no effect before readback`);
        if (id && sim.get(id)?.humanControl) {
          this.alert(`change:${id}`, id, "critical", `${id}: runway ${from} shut, needs your instruction`, `${id} is under your control; the agent will not move it.`, `Change it to runway ${to}`);
        }
        this.refresh(false);
        return;
      }
      case "aircraft.runway_changed": {
        const h = id ? this.flights.get(id) : undefined;
        if (h) h.runwayChangedAt = e.simTime;
        this.mark(id, "closure", `Runway ${str(d.from)} to ${str(d.to)}, after readback`);
        this.settle(`change:${id}`, "Done");
        this.refresh(false);
        return;
      }

      case "runways.configuration_changed": {
        const closing = (d.closing as string[] | undefined) ?? [];
        if (closing.length) {
          const label = `Runway ${closing.join(", ")} closed`;
          this.markAll("closure", label);
          const next = (d.arrivals as string[] | undefined)?.join(" and ");
          this.alert("closure", null, "high", label, str(d.reason), next ? `Arrivals move to ${next} as each reads back` : null);
        } else if (!sim.closedRunways.length && this.standing.has("closure")) {
          this.markAll("closure", "Closed runway reopened");
          const alert = this.standing.get("closure")!;
          Object.assign(alert, { level: "normal", title: alert.title.replace(/closed$/, "reopened"), suggestedAction: null, acknowledged: true });
        }
        return;
      }

      case "conflict.detected":
      case "conflict.escalated": {
        if (d.severity === "advisory") return;
        const ids = d.aircraftIds as string[];
        const key = str(d.key);
        this.conflictPairs.set(key, ids);
        for (const one of ids) this.mark(one, "conflict", str(d.description), ids.find((o) => o !== one));
        const [title, action] = CONFLICT_TITLE[str(d.type)] ?? ["Conflict", null];
        this.alert(key, ids[0] ?? null, d.severity === "critical" ? "critical" : "high", title, str(d.description), action?.(ids) ?? null);
        this.refresh(false);
        return;
      }
      case "conflict.resolved": {
        const key = str(d.key);
        const ids = this.conflictPairs.get(key);
        if (!ids) return;
        this.conflictPairs.delete(key);
        const title = this.standing.get(key)?.title.replace(/^Resolved: /, "") ?? "Conflict";
        for (const one of ids) this.mark(one, "resolved", `Resolved: ${title}`, ids.find((o) => o !== one));
        this.settle(key, "Resolved");
        this.refresh(false);
        return;
      }

      case "emergency.declared": {
        const type = str(d.emergencyType);
        const detail = str(d.description);
        this.mark(id, "emergency", detail);
        const key = str(d.emergencyId);
        if (type === "engine_failure") {
          const h = id ? this.flights.get(id) : undefined;
          if (h) h.maydayT = e.simTime;
          this.alert(key, id ?? null, "critical", "Mayday: engine failure", detail, "Number one, keep the runway clear");
        } else if (type === "runway_incursion") {
          this.alert(`incursion:${str(d.runwayId)}:${id}`, id ?? null, "critical", "Entering the runway uncleared", detail, "Stop it, send arrivals around");
        } else if (type === "taxiway_blocked") this.alert(key, null, "watch", "Taxiway blocked", detail, null);
        this.refresh(false);
        return;
      }
      case "emergency.resolved":
        this.mark(id, "resolved", `Over: ${str(d.emergencyType).replace(/_/g, " ")}`);
        this.settle(str(d.emergencyId), "Over");
        if (d.emergencyType === "runway_incursion") {
          for (const key of this.standing.keys()) if (key.startsWith("incursion:") && key.endsWith(`:${id}`)) this.settle(key, "Over");
          const away = this.incursion?.id === id ? this.incursion?.brokeOff : undefined;
          if (away) {
            const told = `${away.id} broke off at ${away.nm.toFixed(1)} NM, ${away.afterS.toFixed(0)} s after the alert`;
            for (const one of [id, away.id]) this.mark(one, "resolved", `Collision avoided: ${told}`);
            this.alert(`avoided:${id}`, null, "normal", `Collision avoided, ${away.nm.toFixed(1)} NM`, told, null);
          }
        }
        this.refresh(false);
        return;

      case "emergency.runway_incursion":
        if (id) this.incursion = { id, t: e.simTime };
        return;

      case "go_around.initiated":
        if (id && this.incursion && !this.incursion.brokeOff && e.simTime - this.incursion.t < INCURSION_ANSWER_SEC) {
          const ac = sim.get(id);
          if (ac) this.incursion.brokeOff = { id, nm: distanceToThreshold(sim, ac) / NM, afterS: e.simTime - this.incursion.t };
        }
        this.alert(`go_around:${id}`, id ?? null, "watch", `${id} going around`, `Runway ${str(d.runway)}: ${str(d.reason)}.`, null);
        return;

      case "readback.incorrect":
      case "readback.missing":
        this.alert(`readback:${id}`, id ?? null, "high", "Readback not confirmed", `${id}: the clearance was not read back correctly.`, "Take over and repeat it");
        this.refresh(false);
        return;

      case "aircraft.touchdown": {
        const h = id ? this.flights.get(id) : undefined;
        if (h?.maydayT === undefined) return;
        const took = e.simTime - h.maydayT;
        const when = took < 60 ? `${Math.round(took)} s` : `${Math.floor(took / 60)} min ${Math.round(took % 60)} s`;
        this.mark(id, "resolved", `Landed safely, ${when} after the mayday`);
        const ac = sim.get(id!);
        if (ac?.emergencyId) this.settle(ac.emergencyId, "Landed");
        this.alert(`landed:${id}`, id!, "normal", `${id} landed safely`, `${when} after the mayday, responders in attendance (simulated)`, null);
        return;
      }

      case "control.takeover": {
        this.mark(id, "takeover", "Operator took control; agent clearances blocked");
        this.retitle(`human:${id}`, `${id} under operator control`);
        this.refresh(false);
        const ac = id ? sim.get(id) : undefined;
        if (ac?.flags.runwayUnavailable) {
          this.alert(`change:${id}`, id!, "critical", `${id}: runway ${ac.assignedRunway} shut, needs your instruction`, `${id} is under your control; the agent will not move it.`, "Change its runway");
        }
        return;
      }
      case "control.handback":
        this.mark(id, "handback", "Handed back to the agent");
        this.retitle(`human:${id}`, `${id} handed back to the agent`);
        this.settle(`change:${id}`, "Handed back");
        this.refresh(false);
        return;

      case "aircraft.priority_changed":
        this.refresh(false);
    }
  }

  private leave(id: string, how: "handed_off" | "removed"): void {
    const h = this.flights.get(id);
    if (!h) return;
    h.left = how;
    this.settle(`human:${id}`, "Flight left");
    const t = tidy(this.sim.time, 1);
    const { record } = h;
    record.endT = t;
    const position: ControlPosition = how === "handed_off" ? "enroute" : record.summary.position;
    if (position !== record.summary.position) this.mark(id, "handoff", `${record.summary.facility} to ${FACILITY[position]}`);
    record.summary = {
      ...record.summary,
      status: how === "handed_off" ? "departed, to Centre" : record.summary.status,
      position,
      facility: FACILITY[position],
      risk: normalRisk(),
      attention: "none",
      need: null,
      brief: undefined,
    };
    this.pushSeries(h, t);
  }

  private advised(e: SimEvent): void {
    const d = e.data;
    const kind = str(d.kind);
    const pilot = d.by === "pilot";
    const id = e.aircraftId;
    this.notes.set(str(d.transmissionId), {
      kind: pilot ? (kind === "details" ? "info" : "readback") : ADVISORY_KIND[kind],
      operator: d.by === "operator",
      ...(kind === "responders" && d.by !== "operator" ? { speaker: "Toronto Tower to fire + rescue" } : {}),
      ...(kind === "handoff" && !pilot
        ? { speaker: /Tower/.test(str(d.text)) ? FACILITY.approach : /Centre/.test(str(d.text)) ? FACILITY.departure : FACILITY.tower }
        : {}),
      ...(kind === "responders_ack" ? { speaker: `${str(d.text).startsWith("Fire") ? "Fire + rescue" : "Paramedics"} (simulated)` } : {}),
      replyTo: d.replyTo ? str(d.replyTo) : undefined,
      decision:
        !pilot && d.reason ? { action: kind.toUpperCase(), reason: str(d.reason), context: [], verdict: "accepted" } : undefined,
    });
    if (pilot) return;
    if (kind === "weather") {
      this.markAll("weather", str(d.text));
      const said = str(d.text).replace(/^All stations, Toronto weather, /, "").replace(/\.$/, "");
      this.alert("weather", null, "watch", "Weather update", str(d.text), said);
    } else if (kind === "responders" || kind === "responders_ack") {
      const unit = /^Fire/.test(str(d.text)) ? "fire + rescue" : "paramedics";
      const at = Math.floor(e.simTime);
      const when = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
      const state = `${unit}: ${kind === "responders" ? "alerted" : "standing by"} ${when} (simulated)`;
      this.mark(id, "emergency", state);
      const emergency = id ? this.standing.get(this.sim.get(id)?.emergencyId ?? "") : undefined;
      if (emergency) {
        emergency.detail = state;
        emergency.suggestedAction = `Number one, ${state}`;
      } else {
        this.alert(`responders:${id}`, id ?? null, "watch", "Responders alerted (simulated)", state, state);
      }
    }
  }

  private decided(e: SimEvent): void {
    const data = e.data as { caller: string; tool: string; args: Record<string, unknown>; reason: string; observationSeqs: number[]; result: ToolResult };
    if (data.tool !== "issue_clearance") return;
    const { result } = data;
    const verdict = result.ok ? result.result : { status: "rejected", code: result.error.code, message: result.error.message };
    if (verdict.status === "accepted") {
      const seen = this.reviewed(data.observationSeqs);
      const note = this.notes.get(str(verdict.transmissionId));
      if (note?.decision && seen && !note.decision.context.includes(seen)) note.decision.context.push(seen);
      return;
    }
    const h = e.aircraftId ? this.flights.get(e.aircraftId) : undefined;
    if (!h || h.left) return;
    const action = str(data.args.clearanceType);
    const key = `${data.caller}:${action}:${str(verdict.code)}`;
    // A controller retries while it waits; one entry tells the story.
    if (h.lastRejection === key) return;
    h.lastRejection = key;
    const operator = data.caller === OPERATOR;
    const ac = this.sim.get(e.aircraftId!);
    const seen = this.reviewed(data.observationSeqs);
    h.record.messages.push({
      id: `D${e.seq}`,
      t: tidy(e.simTime, 1),
      durationS: 0,
      from: operator ? "operator" : "controller",
      speaker: operator ? "Operator" : h.record.summary.facility,
      position: h.record.summary.position,
      kind: "info",
      text: `Not transmitted. ${(LABEL as Record<string, string>)[action] ?? action} blocked: ${str(verdict.message)}`,
      brain: brainOf(data.caller),
      timings: [],
      decision: {
        action,
        reason: data.reason,
        context: [...(ac ? this.contextFor(ac, str(data.args.runway)) : []), ...(seen ? [seen] : [])],
        verdict: "rejected",
        blockedBy: `${str(verdict.code)}: ${str(verdict.message)}`,
      },
    });
  }

  private reviewed(seqs: number[]): string | null {
    const parts = new Set<string>();
    for (const seq of seqs) {
      const observation = this.sim.events[seq - 1]?.data as { tool?: string; result?: ToolResult } | undefined;
      if (!observation?.result?.ok) continue;
      const r = observation.result.result;
      if (observation.tool === "get_conflicts") parts.add(`conflicts (${(r.conflicts as unknown[]).length})`);
      else if (observation.tool === "get_pending_requests") parts.add(`pending requests (${(r.requests as unknown[]).length})`);
      else if (observation.tool) parts.add(observation.tool.replace(/^get_/, "").replace(/_/g, " "));
    }
    return parts.size ? `Controller reviewed ${[...parts].join(", ")}` : null;
  }

  /** The facts the decision was checked against. */
  private contextFor(ac: Aircraft, runway?: string): string[] {
    const { sim } = this;
    const out = [`${ac.callsign}: ${statusText(sim, ac)}, ${tidy(ac.speedKts)} kt${ac.altitudeFt > 0 ? `, ${tidy(ac.altitudeFt)} ft` : ""}`];
    const rw = sim.graph.physicalRunway(runway || ac.assignedRunway);
    if (!rw) return out;
    const state = sim.runwayState.get(rw.id)!;
    const on = state.occupants.filter((o) => o !== ac.id);
    const held = state.reservation?.aircraftId;
    out.push(
      sim.closedRunways.includes(rw.id)
        ? `Runway ${rw.id} closed`
        : on.length
          ? `Runway ${rw.id} occupied by ${on.join(", ")}`
          : held && held !== ac.id
            ? `Runway ${rw.id} reserved for ${held}`
            : `Runway ${rw.id} free of other traffic`,
    );
    const next = inboundArrivals(sim, rw.id).find((a) => a.aircraft.id !== ac.id);
    out.push(next ? `Nearest other arrival ${next.aircraft.callsign}, ${next.distanceNm.toFixed(1)} NM, ${Math.round(next.etaSec)} s` : "No other arrival inbound to it");
    const near = nearestTraffic(sim, ac);
    if (near && near.lateralNm < 10) {
      const rule = near.requiredNm ? `minimum ${near.requiredNm} NM or ${near.requiredFt} ft` : "independent parallel";
      out.push(`Nearest traffic ${near.otherFlightId}, ${near.lateralNm} NM and ${near.verticalFt} ft (${rule})`);
    }
    return out;
  }

  /** A person answering a request does not quote its id, so link the last one. */
  private openRequestLine(id: string | undefined, brain: Brain): string | undefined {
    if (!id || brain !== "human") return undefined;
    let found: string | undefined;
    for (const r of this.sim.requests.values()) if (r.aircraftId === id && r.heardAt !== undefined) found = r.id;
    return found;
  }

  /** Whether the controller has already replied, for example with "continue approach": only a first reply is a response time. */
  private answered(id: string, line: string): boolean {
    const said = this.flights.get(id)?.record.messages ?? [];
    const at = said.findIndex((m) => m.id === line);
    return at >= 0 && said.slice(at + 1).some((m) => m.from !== "pilot" && m.durationS > 0 && m.decision);
  }

  private onAir(tx: Transmission, estimatedS: number): void {
    const { sim } = this;
    const note = this.notes.get(tx.id) ?? {};
    const tower = tx.from === "TOWER";
    const flightId = tower ? (tx.to === "ALL" ? undefined : tx.to) : tx.from;
    const flight = flightId ? this.flights.get(flightId) : undefined;
    const ac = flightId ? sim.get(flightId) : undefined;
    const position = note.speaker?.includes("fire") || note.speaker?.includes("simulated") ? "tower" : ac ? controlPosition(sim, ac) : (flight?.record.summary.position ?? "tower");
    const clearance = tx.clearanceId ? sim.clearances.get(tx.clearanceId) : undefined;
    const request = tx.requestId ? sim.requests.get(tx.requestId) : undefined;
    const operator = note.operator || (tower ? clearance?.issuedBy === OPERATOR : !flight);

    let kind: Message["kind"] = note.kind ?? "info";
    let replyTo = note.replyTo;
    const timings = [...(note.timings ?? [])];
    if (tx.kind === "clearance") kind = "clearance";
    else if (tx.kind === "emergency") {
      kind = "emergency";
      if (flight) flight.maydayLine = tx.id;
    } else if (tx.kind === "request") {
      kind = request?.type === "OTHER" ? "escalation" : "request";
      if (request) {
        const first = request.type === "OTHER" && !this.requestLine.has(request.id);
        this.requestLine.set(request.id, tx.id);
        if (first && flight && ac) {
          flight.escalation = escalationReason(request.text, ac.callsign) || undefined;
          this.mark(ac.id, "escalation", "Pilot asked for a person");
          this.alert(`human:${ac.id}`, ac.id, "high", `${ac.id} calling for a human`, request.text, flight.escalation ? `${flight.escalation}: take over` : "Take over");
          this.refresh(false);
        }
      }
    } else if (tx.kind === "readback") {
      kind = "readback";
      replyTo = clearance?.transmissionId;
      if (ac && !ac.externallyControlled && clearance?.transmittedAt !== undefined) {
        timings.push({
          stage: "decide",
          ms: tidy((tx.queuedAt - clearance.transmittedAt) * 1000),
          kind: "modelled",
          source: "Scripted pilot reaction, assumed 0.2-0.5 s",
        });
      }
    }

    const known = this.plugins.describe?.(tx);
    if (known?.timings) timings.push(...known.timings);
    const voiced = this.plugins.voice?.line({
      role: tower ? "controller" : "pilot",
      speaker: tx.from,
      text: tx.text,
      spoken: tx.spoken,
    });
    // Only a recording was timed. Anything else is spoken by the browser and gets no figure.
    if (voiced && !operator) timings.push(voiced.timing);
    let decision = note.decision;
    if (decision && note.alertT !== undefined) {
      const after = ((tx.startedAt ?? sim.time) - note.alertT).toFixed(1);
      decision = { ...decision, context: [`Alert to action ${after} s`, ...decision.context], reason: `${decision.reason} Alert to action ${after} s.` };
    }

    const message: Message = {
      id: tx.id,
      t: tidy(tx.startedAt ?? sim.time, 1),
      durationS: tidy(Math.max(0.1, estimatedS), 1),
      from: operator ? "operator" : tower ? "controller" : "pilot",
      speaker: operator ? "Operator" : (note.speaker ?? (tower ? FACILITY[position] : tx.from)),
      position,
      kind,
      text: tx.text,
      brain: known?.brain ?? (operator ? "human" : tower && clearance ? brainOf(clearance.issuedBy) : "rules"),
      timings,
      ...(replyTo ? { replyTo } : {}),
      ...(decision ? { decision } : {}),
      ...(voiced ? { audioUrl: voiced.audioUrl } : {}),
    };
    this.messages.set(tx.id, message);

    const hearers = flight ? [flight] : tx.to === "ALL" ? [...sim.aircraft.keys()].flatMap((id) => this.flights.get(id) ?? []) : [];
    for (const h of hearers) {
      h.record.messages.push(message);
      // A broadcast is in every history, but it is not what this flight last said or was told.
      if (flight) h.record.summary.lastMessage = message.text;
    }
  }
}
