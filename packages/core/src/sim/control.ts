import type { Command, CommandResult } from "../types";
import { closeClearance, resolveAircraft } from "./clearances";
import { enqueueTransmission } from "./radio";
import type { Simulation } from "./simulation";

/** A person takes a flight from the agent, or gives it back. */
export function setHumanControl(sim: Simulation, aircraftId: string, human: boolean): CommandResult {
  const found = resolveAircraft(sim, aircraftId);
  if (found.error) return found.error;
  const ac = found.ac;
  if (Boolean(ac.humanControl) === human) {
    return human
      ? { ok: false, code: "ALREADY_HUMAN_CONTROL", message: `${ac.callsign} is already under human control.` }
      : { ok: false, code: "NOT_HUMAN_CONTROL", message: `${ac.callsign} is not under human control.` };
  }
  ac.humanControl = human;
  const type = human ? "control.takeover" : "control.handback";
  if (human) {
    // What the agent decided but has not yet said is withdrawn.
    for (const c of sim.clearances.values()) {
      if (c.aircraftId !== ac.id || c.issuedBy === "human") continue;
      // A change of runway that has not been read back is now the person's to give.
      const unmoved = c.type === "RUNWAY_CHANGE" && c.status === "transmitted" && !c.active;
      if (c.status === "issued" || unmoved) closeClearance(sim, c, "cancelled", "a person took control");
    }
    for (const r of sim.requests.values()) {
      if (r.aircraftId !== ac.id || r.type !== "OTHER" || (r.status !== "pending" && r.status !== "transmitting")) continue;
      r.status = "answered";
      r.answeredBy = "human";
      r.closedAt = sim.time;
      sim.emit("request.answered", {
        aircraftId: ac.id,
        cause: { kind: "operator", action: type },
        data: { requestId: r.id, requestType: r.type },
      });
    }
  }
  sim.emit(type, { aircraftId: ac.id, attention: true, cause: { kind: "operator", action: type }, data: { callsign: ac.callsign } });
  return { ok: true, aircraftId: ac.id, humanControl: human };
}

const PRIORITY = { weather: 82, closure: 87, traffic: 50, handoff: 52, responders: 88, responders_ack: 88, details: 82, escalation: 91, info: 45 };
const OPERATOR_PRIORITY = 94;

export function issueAdvisory(sim: Simulation, cmd: Extract<Command, { type: "advisory.issue" }>): CommandResult {
  const ac = cmd.aircraftId ? sim.get(cmd.aircraftId) : undefined;
  if (cmd.aircraftId && !ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${cmd.aircraftId}.` };
  const pilot = cmd.by === "pilot";
  if (pilot && !ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: "A pilot line needs an aircraft." };
  const tx = enqueueTransmission(sim, {
    from: pilot ? ac!.id : "TOWER",
    to: pilot ? "TOWER" : (ac?.id ?? "ALL"),
    kind: pilot ? "report" : "info",
    text: cmd.text,
    spoken: cmd.spoken ?? cmd.text,
    priority: cmd.by === "operator" ? OPERATOR_PRIORITY : pilot ? (cmd.kind === "details" ? 84 : 83) : PRIORITY[cmd.kind],
  });
  sim.emit("advisory.issued", {
    aircraftId: ac?.id,
    // The controller should look again when something has changed the picture.
    attention: !pilot && ["weather", "closure", "responders"].includes(cmd.kind),
    cause: { kind: "auto", rule: `advisory_${cmd.kind}` },
    data: {
      kind: cmd.kind,
      by: cmd.by ?? "tower",
      text: cmd.text,
      transmissionId: tx.id,
      replyTo: cmd.replyTo,
      reason: cmd.reason,
    },
  });
  return { ok: true, transmissionId: tx.id };
}
