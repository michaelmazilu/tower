import { NM } from "../geometry";
import { readbackPhrase, requestPhrase, spokenCallsign } from "../radio/phraseology";
import type { Aircraft, Clearance, Command, CommandResult, PilotRequest, RequestType, Transmission } from "../types";
import { confirmReadback, phraseInputFor } from "./clearances";
import { enqueueTransmission } from "./radio";
import { controlPosition } from "./positions";
import { distanceToThreshold, runwayOccupiedBy } from "./runways";
import type { Simulation } from "./simulation";

/**
 * Pilot behaviour that needs no intelligence: asking for the next thing
 * the flight needs, and reading clearances back word for word. Every
 * aircraft gets this by default so the airport runs with no agents at all.
 * An external pilot (human microphone or AI pilot agent) takes an aircraft
 * over with `pilot.claim`, after which its requests and readbacks must
 * arrive as commands.
 */

const isOpenRequest = (r: PilotRequest) => r.status === "transmitting" || r.status === "pending";

interface Need {
  type: RequestType;
  runway?: string;
  holdLabel?: string;
  /** Stopped on the runway itself rather than behind the hold line. */
  onRunway?: boolean;
}

/** What this aircraft needs from the tower right now, if anything. */
export function wantedRequest(sim: Simulation, ac: Aircraft): Need | null {
  if (ac.flags.taxiClearanceCancelled && !runwayOccupiedBy(sim, ac)) {
    return { type: "TAXI", runway: ac.flight === "departure" ? ac.assignedRunway : undefined };
  }
  const g = sim.graph;
  // Nothing to ask for on a runway that has shut: it waits to be given another.
  if (ac.flags.runwayUnavailable && !ac.flags.incursionHold) return null;
  switch (ac.phase) {
    case "at_gate":
      if (ac.flight === "departure" && !ac.flightComplete && sim.time >= ac.readyAt) return { type: "PUSHBACK" };
      return null;
    case "pushback":
      return ac.flags.pushbackComplete ? { type: "TAXI", runway: ac.assignedRunway } : null;
    case "holding_short": {
      const i = ac.currentWaypointIndex;
      const node = g.node(ac.route[i]);
      // Already cleared onto this runway and about to move: nothing to ask for.
      if (node.guards && ac.runwayAuth[node.guards]) return null;
      const crossing =
        i + 2 < ac.route.length &&
        g.node(ac.route[i + 1]).kind === "runway" &&
        g.node(ac.route[i + 2]).kind === "hold_short";
      if (crossing && node.guards) {
        const rw = g.runways.get(node.guards)!;
        const active = [...sim.activeRunways.arrivals, ...sim.activeRunways.departures];
        const designator = rw.ends.find((e) => active.includes(e.designator))?.designator ?? rw.ends[1].designator;
        return { type: "CROSS", runway: designator, holdLabel: node.label };
      }
      if (ac.flight === "departure") return { type: "TAKEOFF", runway: ac.assignedRunway, holdLabel: node.label };
      return null;
    }
    case "line_up": {
      if (ac.holdPosition) return null;
      const rw = g.runwayEnd(ac.assignedRunway)?.runway.id;
      return rw && ac.runwayAuth[rw] !== "takeoff" ? { type: "TAKEOFF", runway: ac.assignedRunway } : null;
    }
    case "approach":
    case "holding":
      return ac.landingCleared ? null : { type: "LANDING", runway: ac.assignedRunway };
    case "taxi_in":
    case "taxi_out": {
      // Stopped on a runway after rolling through a hold line: ask for a way off it.
      if (ac.flags.incursionHold) {
        const on = runwayOccupiedBy(sim, ac);
        if (on) {
          const mine = g.runwayEnd(ac.assignedRunway);
          if (ac.flight === "departure" && mine?.runway.id === on) {
            return { type: "TAKEOFF", runway: ac.assignedRunway, onRunway: true };
          }
          const rw = g.runways.get(on)!;
          const active = [...sim.activeRunways.arrivals, ...sim.activeRunways.departures];
          const designator = rw.ends.find((e) => active.includes(e.designator))?.designator ?? rw.ends[1].designator;
          return { type: "CROSS", runway: designator, onRunway: true };
        }
      }
      const atEnd = ac.distToNextM <= 0 && ac.currentWaypointIndex >= Math.min(ac.routeLimitIndex, ac.route.length - 1);
      const node = g.node(ac.route[ac.currentWaypointIndex]);
      if (ac.phase === "taxi_in" && atEnd && node.kind !== "gate" && ac.speedKts === 0) return { type: "TAXI" };
      // Stuck behind a closed taxiway: ask for another way round.
      if (ac.blockedReason === "blocked_edge" && ac.blockedSince !== undefined && sim.time - ac.blockedSince > 5) {
        return { type: "TAXI", runway: ac.assignedRunway };
      }
      return null;
    }
    default:
      return null;
  }
}

function priorityValue(ac: Aircraft): number {
  return ac.priority === "emergency" ? 100 : ac.priority === "urgent" ? 40 : 10;
}

function requestPriority(sim: Simulation, ac: Aircraft, req: PilotRequest): number {
  if (ac.flags.incursionHold) return 85;
  if (req.type === "OTHER") return 84;
  if (ac.priority !== "normal") return ac.priority === "emergency" ? 88 : 60;
  // A crew close in cannot wait behind someone asking to push back.
  if (req.type === "LANDING" && distanceToThreshold(sim, ac) < sim.config.rules.clearanceNeededNm * NM) return 70;
  // At the runway, rather than at a gate or far out.
  if (sim.config.oneSpeaker && (req.type === "TAKEOFF" || req.type === "CROSS")) return 40;
  return priorityValue(ac);
}

function transmitRequest(sim: Simulation, ac: Aircraft, req: PilotRequest, alreadySpoken = false): void {
  req.lastTransmittedAt = sim.time;
  enqueueTransmission(sim, {
    from: ac.id,
    to: "TOWER",
    kind: "request",
    text: req.text,
    spoken: req.spoken,
    requestId: req.id,
    // Stopped on a runway it was never cleared onto: that cannot wait its turn.
    priority: requestPriority(sim, ac, req),
    alreadySpoken,
  });
}

const CALLED = { ground: "Ground", tower: "Tower", departure: "Departure", approach: "Approach" };

/** With separate frequencies a crew calls the position it is talking to. */
function addressed(sim: Simulation, ac: Aircraft, line: string): string {
  return sim.config.separateFrequencies ? line.replace(/^Tower,/, `${CALLED[controlPosition(sim, ac)]},`) : line;
}

function createRequest(
  sim: Simulation,
  ac: Aircraft,
  need: Need,
  custom?: { text?: string; alreadySpoken?: boolean },
): PilotRequest {
  const phrase = requestPhrase({
    callsign: ac.callsign,
    type: need.type,
    runway: need.runway,
    gate: ac.gate,
    flight: ac.flight,
    holdLabel: need.holdLabel,
    onRunway: need.onRunway,
    distanceNm: need.type === "LANDING" ? distanceToThreshold(sim, ac) / NM : undefined,
  });
  const req: PilotRequest = {
    id: sim.nextId("REQ"),
    aircraftId: ac.id,
    type: need.type,
    runway: need.runway,
    gate: ac.gate,
    text: custom?.text ?? addressed(sim, ac, phrase.text),
    spoken: custom?.text?.replace(ac.callsign, spokenCallsign(ac.callsign)) ?? addressed(sim, ac, phrase.spoken),
    status: "transmitting",
    priority: ac.priority,
    createdAt: sim.time,
    reminders: 0,
    lastTransmittedAt: sim.time,
  };
  sim.requests.set(req.id, req);
  sim.emit("request.created", {
    aircraftId: ac.id,
    cause: { kind: "pilot", reason: need.type.toLowerCase() },
    data: { requestId: req.id, requestType: req.type, runway: req.runway, text: req.text },
  });
  transmitRequest(sim, ac, req, custom?.alreadySpoken);
  return req;
}

/** A position report that waited for the frequency gives the position it has now. */
export function refreshWords(sim: Simulation, tx: Transmission): void {
  if (tx.kind !== "request" || !sim.config.oneSpeaker || sim.time - tx.queuedAt < 8) return;
  const req = sim.requests.get(tx.requestId ?? "");
  const ac = sim.get(tx.from);
  if (!req || !ac || req.type !== "LANDING" || ac.phase !== "approach" || ac.externallyControlled) return;
  const phrase = requestPhrase({
    callsign: ac.callsign, type: "LANDING", runway: req.runway, gate: ac.gate, flight: ac.flight,
    distanceNm: distanceToThreshold(sim, ac) / NM, reminder: req.reminders > 0,
  });
  req.text = tx.text = addressed(sim, ac, phrase.text);
  req.spoken = tx.spoken = addressed(sim, ac, phrase.spoken);
}

export function onRequestHeard(sim: Simulation, tx: Transmission): void {
  const req = tx.requestId ? sim.requests.get(tx.requestId) : undefined;
  if (!req || !isOpenRequest(req)) return;
  const first = req.status === "transmitting";
  req.status = "pending";
  req.heardAt ??= sim.time;
  sim.emit("request.pending", {
    aircraftId: req.aircraftId,
    attention: true,
    cause: { kind: "request", requestId: req.id },
    data: {
      requestId: req.id,
      requestType: req.type,
      runway: req.runway,
      text: req.text,
      priority: req.priority,
      reminder: !first,
    },
  });
}

export function onReadbackHeard(sim: Simulation, tx: Transmission): void {
  const clr = tx.clearanceId ? sim.clearances.get(tx.clearanceId) : undefined;
  if (!clr) return;
  confirmReadback(sim, clr, tx.text);
}

/** The answer to an urgent instruction is as urgent as it was. */
function readbackPriority(sim: Simulation, clr: Clearance): number {
  const asked = sim.transmissions.get(clr.transmissionId ?? "")?.priority ?? 0;
  return asked >= 84 ? 92 : 83;
}

export function stepPilots(sim: Simulation): void {
  // Scripted readbacks that have come due.
  if (sim.pendingReadbacks.length > 0) {
    const due = sim.pendingReadbacks;
    sim.pendingReadbacks = [];
    for (const id of due) {
      const clr = sim.clearances.get(id);
      const ac = clr ? sim.get(clr.aircraftId) : undefined;
      if (!clr || !ac || clr.status !== "transmitted" || ac.externallyControlled) continue;
      const phrase = readbackPhrase(phraseInputFor(ac, clr));
      enqueueTransmission(sim, {
        from: ac.id,
        to: "TOWER",
        kind: "readback",
        text: phrase.text,
        spoken: phrase.spoken,
        clearanceId: clr.id,
        priority: readbackPriority(sim, clr),
      });
    }
  }

  // Requests are reconciled once a second; that is plenty.
  if (sim.tick % Math.round(1 / sim.config.dt) !== 0) return;
  const rules = sim.config.rules;

  // A queued call grows more pressing as the aircraft closes in.
  for (const tx of sim.radio.queue) {
    const req = tx.kind === "request" ? sim.requests.get(tx.requestId ?? "") : undefined;
    const ac = req && sim.get(tx.from);
    if (ac) tx.priority = requestPriority(sim, ac, req);
  }
  for (const ac of sim.aircraft.values()) {
    const need = wantedRequest(sim, ac);
    let open: PilotRequest | undefined;
    for (const r of sim.requests.values()) {
      if (r.aircraftId !== ac.id || !isOpenRequest(r)) continue;
      if (need && r.type === need.type) {
        open = r;
      } else if (r.type !== "OTHER") {
        // The situation moved on; the request no longer makes sense.
        r.status = "withdrawn";
        r.closedAt = sim.time;
        sim.radio.queue = sim.radio.queue.filter((tx) => tx.requestId !== r.id);
        sim.emit("request.withdrawn", {
          aircraftId: ac.id,
          cause: { kind: "auto", rule: "no_longer_needed" },
          data: { requestId: r.id, requestType: r.type },
        });
      }
    }
    if (!need || ac.externallyControlled) continue;

    const awaitingReadback = [...sim.clearances.values()].some(
      (c) => c.aircraftId === ac.id && (c.status === "issued" || c.status === "transmitted"),
    );
    if (awaitingReadback) continue;

    if (!open) {
      createRequest(sim, ac, need);
      continue;
    }
    // Still waiting: remind the tower, but only a few times.
    // Told to continue the approach: the crew waits to be sequenced and does not nag until it is close in.
    if (open.deferredBy && open.type === "LANDING" && distanceToThreshold(sim, ac) > rules.clearanceNeededNm * NM) continue;
    const quietFor = sim.time - Math.max(open.lastTransmittedAt, open.deferredAt ?? 0);
    const patience = open.deferredBy || sim.config.oneSpeaker ? rules.requestReminderSec * 2 : rules.requestReminderSec;
    // No reminder while the call is itself still waiting for the frequency.
    const unsaid = quietFor > patience && [...sim.radio.queue, ...sim.radio.onAir].some((tx) => tx.requestId === open.id);
    if (quietFor > patience && !unsaid && open.reminders < rules.maxReminders) {
      open.reminders++;
      const phrase = requestPhrase({
        callsign: ac.callsign,
        type: open.type,
        runway: open.runway,
        gate: ac.gate,
        flight: ac.flight,
        distanceNm: open.type === "LANDING" ? distanceToThreshold(sim, ac) / NM : undefined,
        reminder: true,
      });
      open.text = addressed(sim, ac, phrase.text);
      open.spoken = addressed(sim, ac, phrase.spoken);
      transmitRequest(sim, ac, open);
    }
  }
}

// ------------------------------------------------------- external pilots

export function claimPilot(sim: Simulation, aircraftId: string, by: "human" | "ai"): CommandResult {
  const ac = sim.get(aircraftId);
  if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${aircraftId}.` };
  ac.externallyControlled = true;
  ac.pilotType = by;
  sim.emit("pilot.claimed", { aircraftId: ac.id, cause: { kind: "operator", action: "pilot.claim" }, data: { by } });
  return { ok: true, aircraftId: ac.id, pilotType: by };
}

export function releasePilot(sim: Simulation, aircraftId: string): CommandResult {
  const ac = sim.get(aircraftId);
  if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${aircraftId}.` };
  ac.externallyControlled = false;
  sim.emit("pilot.released", { aircraftId: ac.id, cause: { kind: "operator", action: "pilot.release" }, data: {} });
  return { ok: true, aircraftId: ac.id };
}

export function externalRequest(sim: Simulation, cmd: Extract<Command, { type: "pilot.request" }>): CommandResult {
  const ac = sim.get(cmd.aircraftId);
  if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${cmd.aircraftId}.` };
  const existing = [...sim.requests.values()].find(
    (r) => r.aircraftId === ac.id && isOpenRequest(r) && r.type === cmd.requestType && cmd.requestType !== "OTHER",
  );
  if (existing) {
    if (cmd.text) {
      existing.text = cmd.text;
      existing.spoken = cmd.text;
    }
    existing.reminders++;
    transmitRequest(sim, ac, existing, cmd.spoken);
    return { ok: true, requestId: existing.id, repeated: true };
  }
  const req = createRequest(
    sim,
    ac,
    { type: cmd.requestType, runway: cmd.runway ?? ac.assignedRunway },
    { text: cmd.text?.trim() || undefined, alreadySpoken: cmd.spoken },
  );
  return { ok: true, requestId: req.id };
}

export function externalReadback(sim: Simulation, cmd: Extract<Command, { type: "pilot.readback" }>): CommandResult {
  const ac = sim.get(cmd.aircraftId);
  if (!ac) return { ok: false, code: "UNKNOWN_AIRCRAFT", message: `No aircraft ${cmd.aircraftId}.` };
  const clr = cmd.clearanceId
    ? sim.clearances.get(cmd.clearanceId)
    : [...sim.clearances.values()].filter((c) => c.aircraftId === ac.id && c.status === "transmitted").pop();
  if (!clr || clr.aircraftId !== ac.id) {
    return { ok: false, code: "NOTHING_TO_READ_BACK", message: `${ac.callsign} has no clearance awaiting a readback.` };
  }
  if (clr.status !== "transmitted") {
    return { ok: false, code: "NOT_AWAITING_READBACK", message: `Clearance ${clr.id} is ${clr.status}.` };
  }
  const transcript = cmd.text?.trim();
  if (!transcript && (cmd.spoken || ac.externallyControlled)) {
    return { ok: false, code: "MISSING_READBACK", message: "Send the pilot's readback text." };
  }
  const text = transcript || clr.expectedReadback;
  const tx = enqueueTransmission(sim, {
    from: ac.id,
    to: "TOWER",
    kind: "readback",
    text,
    spoken: transcript || clr.expectedReadback.replace(ac.callsign, spokenCallsign(ac.callsign)),
    clearanceId: clr.id,
    priority: readbackPriority(sim, clr),
    alreadySpoken: cmd.spoken,
  });
  // When the words were already spoken the readback has been checked by now.
  if (cmd.spoken) {
    if (clr.acknowledgedAt !== undefined) return { ok: true, clearanceId: clr.id, status: clr.status };
    if (clr.closeReason) return { ok: false, code: "CLEARANCE_NO_LONGER_VALID", message: clr.closeReason };
    return { ok: false, code: "READBACK_INCORRECT", message: "Readback did not match the clearance.", details: { expected: clr.expectedReadback } };
  }
  return { ok: true, clearanceId: clr.id, transmissionId: tx.id, status: "queued" };
}
