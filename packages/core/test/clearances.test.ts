import { describe, expect, it } from "vitest";
import { AirportGraph, TOOL_DEFINITIONS, ToolGateway, explainAircraft, getPendingRequests, runwayOccupiedBy, type SpawnSpec } from "../src";
import { eventsOf, issue, sandbox, withBaseline } from "./helpers";

const WJA: SpawnSpec = { callsign: "WJA302", flight: "departure", runway: "23", start: { kind: "holding_short" } };
const arrival = (callsign: string, distanceNm: number, runway = "23"): SpawnSpec => ({
  callsign,
  flight: "arrival",
  runway,
  start: { kind: "approach", distanceNm },
});

describe("tool surface", () => {
  it("exposes exactly the eight planned tools and nothing that moves an aircraft directly", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
      [
        "get_aircraft_details",
        "get_airport_state",
        "get_conflicts",
        "get_pending_requests",
        "get_runway_status",
        "get_taxi_route",
        "issue_clearance",
        "set_aircraft_priority",
      ].sort(),
    );
    expect(TOOL_DEFINITIONS.filter((t) => t.mutates).map((t) => t.name)).toEqual(["issue_clearance", "set_aircraft_priority"]);
  });

  it("rejects unknown tools and malformed arguments without touching the simulation", () => {
    const sim = sandbox([WJA]);
    const gw = new ToolGateway(() => sim);
    expect(gw.call("move_aircraft_to", { x: 0, y: 0 })).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    expect(gw.call("issue_clearance", { aircraftId: "WJA302", clearanceType: "TELEPORT", reason: "x" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(gw.call("issue_clearance", { aircraftId: "WJA302", clearanceType: "CLEARED_TAKEOFF" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(sim.clearances.size).toBe(0);
  });

  it("does not act twice on a retried call with the same idempotency key", () => {
    const sim = sandbox([WJA]);
    const gw = new ToolGateway(() => sim);
    const args = { aircraftId: "WJA302", clearanceType: "CLEARED_TAKEOFF", reason: "runway clear" };
    const first = gw.call("issue_clearance", args, { idempotencyKey: "abc" });
    const second = gw.call("issue_clearance", args, { idempotencyKey: "abc" });
    expect(second).toBe(first);
    expect(sim.clearances.size).toBe(1);
    // Even without a key, repeating an unacknowledged clearance is not a new one.
    const third = gw.call("issue_clearance", args);
    expect(third).toMatchObject({ ok: true, result: { status: "accepted", duplicate: true } });
    expect(sim.clearances.size).toBe(1);
  });

  it("declines a stale or wrong-aircraft request and a conflicting retry without queuing radio", () => {
    const sim = sandbox([WJA, arrival("ACA214", 15, "24R")]);
    const gw = new ToolGateway(() => sim);
    sim.run(30);
    const request = getPendingRequests(sim).find((r) => r.aircraftId === "WJA302")!;
    const args = { aircraftId: "WJA302", clearanceType: "CLEARED_TAKEOFF", runway: "23", reason: "Ready for departure." };
    const count = sim.transmissions.size;
    for (const bad of [{ requestId: "missing" }, { requestId: request.requestId, aircraftId: "ACA214" }]) {
      expect(gw.call("issue_clearance", { ...args, ...bad })).toMatchObject({
        ok: true, result: { status: "needs_clarification", code: "INVALID_REQUEST" },
      });
    }
    expect(sim.transmissions.size).toBe(count);
    const accepted = gw.call("issue_clearance", { ...args, requestId: request.requestId });
    expect(accepted).toMatchObject({ ok: true, result: { status: "accepted" } });
    expect(gw.call("issue_clearance", { ...args, runway: "24L" })).toMatchObject({
      ok: true, result: { status: "rejected", code: "CLEARANCE_PENDING" },
    });
    expect(sim.transmissions.size).toBe(count + 1);
    sim.run(25);
    expect(gw.call("issue_clearance", { ...args, requestId: request.requestId })).toMatchObject({
      ok: true, result: { status: "needs_clarification", code: "INVALID_REQUEST" },
    });
  });

  it("computes taxi routes without moving anything", () => {
    const sim = sandbox([{ callsign: "TSC330", flight: "departure", runway: "24L", gate: "B7", start: { kind: "gate" } }]);
    const gw = new ToolGateway(() => sim);
    const res = gw.call("get_taxi_route", { aircraftId: "TSC330" });
    expect(res).toMatchObject({ ok: true, result: { destination: "runway 24L holding point", crossesRunways: ["06L/24R"] } });
    expect(sim.get("TSC330")!.phase).toBe("at_gate");
  });
});

describe("clearance validation", () => {
  it("keeps a departure holding while the runway is reserved for an arrival (the plan's example)", () => {
    const sim = sandbox([arrival("ACA214", 6), WJA]);
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND").status).toBe("accepted");
    const res = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    expect(res).toMatchObject({ status: "rejected", code: "RUNWAY_RESERVED" });
    expect(sim.get("WJA302")!.phase).toBe("holding_short");
    expect(eventsOf(sim, "clearance.rejected")).toHaveLength(1);
  });

  it("protects an arrival on short final even before it is cleared to land", () => {
    const sim = sandbox([arrival("ACA214", 3), WJA]);
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF")).toMatchObject({ status: "rejected", code: "ARRIVAL_TOO_CLOSE" });
    expect(issue(sim, "WJA302", "LINE_UP_AND_WAIT")).toMatchObject({ status: "rejected", code: "ARRIVAL_TOO_CLOSE" });
  });

  it("only clears the first aircraft in the landing sequence", () => {
    const sim = sandbox([arrival("ACA214", 5), arrival("ROU1861", 9)]);
    expect(issue(sim, "ROU1861", "CLEARED_TO_LAND")).toMatchObject({ status: "rejected", code: "NOT_NUMBER_ONE" });
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND").status).toBe("accepted");
    expect(issue(sim, "ROU1861", "CLEARED_TO_LAND")).toMatchObject({ status: "rejected", code: "RUNWAY_RESERVED" });
  });

  it("rejects clearances that do not fit the aircraft's phase, runway or position", () => {
    const sim = sandbox([
      arrival("ACA214", 8),
      WJA,
      { callsign: "TSC330", flight: "departure", runway: "23", gate: "D24", start: { kind: "gate" } },
      { callsign: "KLM692", flight: "departure", runway: "05", start: { kind: "holding_short" } },
    ]);
    expect(issue(sim, "ACA214", "PUSHBACK")).toMatchObject({ status: "rejected", code: "INVALID_PHASE" });
    expect(issue(sim, "WJA302", "CLEARED_TO_LAND")).toMatchObject({ status: "rejected", code: "INVALID_PHASE" });
    expect(issue(sim, "TSC330", "CLEARED_TAKEOFF")).toMatchObject({ status: "rejected", code: "NOT_AT_HOLD_POINT" });
    expect(issue(sim, "TSC330", "TAXI")).toMatchObject({ status: "rejected", code: "INVALID_PHASE" });
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND", { runway: "24R" })).toMatchObject({ status: "rejected", code: "WRONG_RUNWAY" });
    expect(issue(sim, "KLM692", "CLEARED_TAKEOFF")).toMatchObject({ status: "rejected", code: "RUNWAY_NOT_ACTIVE" });
    expect(issue(sim, "ACA214", "HOLD")).toMatchObject({ status: "accepted" });
    expect(sim.stats.clearancesRejected).toBe(6);
  });

  it("asks for clarification instead of guessing at a garbled callsign", () => {
    const sim = sandbox([arrival("ACA214", 8), WJA]);
    expect(issue(sim, "XYZ999", "GO_AROUND")).toMatchObject({ status: "rejected", code: "UNKNOWN_AIRCRAFT" });
    const res = issue(sim, "214", "CLEARED_TO_LAND");
    expect(res).toMatchObject({ status: "needs_clarification", code: "AMBIGUOUS_AIRCRAFT" });
    expect(res.message).toContain("ACA214");
    expect(issue(sim, "aca 214", "CLEARED_TO_LAND").status).toBe("accepted");
  });

  it("asks for clarification instead of inferring a runway when an invalid one was supplied", () => {
    const sim = sandbox([WJA]);
    for (const type of ["HOLD_SHORT", "CROSS_RUNWAY"]) {
      expect(issue(sim, "WJA302", type, { runway: "99" })).toMatchObject({
        status: "needs_clarification",
        code: "UNKNOWN_RUNWAY",
      });
    }
  });

  it("requires a stated reason", () => {
    const sim = sandbox([WJA]);
    const res = sim.dispatch({ type: "clearance.issue", aircraftId: "WJA302", clearanceType: "CLEARED_TAKEOFF", reason: "  " });
    expect(res).toMatchObject({ ok: false, code: "MISSING_REASON" });
  });
});

describe("clearance lifecycle: tool call, transmission and readback are separate steps", () => {
  it("changes nothing until the pilot has read the clearance back", () => {
    const sim = sandbox([WJA]);
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    const clr = sim.clearances.get(clearanceId!)!;
    expect(clr.status).toBe("issued");
    expect(sim.runwayState.get("05/23")!.reservation?.aircraftId).toBe("WJA302");

    sim.run(2);
    expect(clr.status).toBe("issued");
    expect(sim.get("WJA302")!.phase).toBe("holding_short");

    sim.run(4);
    expect(clr.status).toBe("transmitted");
    expect(sim.get("WJA302")!.phase).toBe("holding_short");
    expect(sim.get("WJA302")!.speedKts).toBe(0);

    sim.run(6);
    expect(clr.status).toBe("acknowledged");
    expect(sim.get("WJA302")!.phase).toBe("line_up");

    sim.run(120);
    expect(["takeoff", "departure"]).toContain(sim.get("WJA302")!.phase);
  });

  it("does not treat an instruction as given when the voice output fails", () => {
    const sim = sandbox([WJA], { radio: { controller: "external", pilots: "simulated" } });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    const clr = sim.clearances.get(clearanceId!)!;
    sim.run(1);
    const started = eventsOf(sim, "radio.tx_started").find((e) => e.data.clearanceId === clearanceId)!;
    // An external transmission never finishes on its own.
    sim.run(10);
    expect(clr.status).toBe("issued");

    expect(sim.dispatch({ type: "radio.tx_failed", transmissionId: started.data.transmissionId as string, error: "TTS 500" }).ok).toBe(true);
    expect(clr.status).toBe("expired");
    expect(clr.closeReason).toBe("TTS 500");
    expect(sim.get("WJA302")!.phase).toBe("holding_short");
    expect(sim.get("WJA302")!.clearance?.status).toBe("expired");
    expect(sim.runwayState.get("05/23")!.reservation).toBeUndefined();
    expect(eventsOf(sim, "radio.tx_failed")).toHaveLength(1);
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF")).toMatchObject({ status: "accepted" });
  });

  it("proceeds once the voice layer reports the transmission finished", () => {
    const sim = sandbox([WJA], { radio: { controller: "external", pilots: "simulated" } });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(1);
    const started = eventsOf(sim, "radio.tx_started").find((e) => e.data.clearanceId === clearanceId)!;
    expect(sim.dispatch({ type: "radio.tx_complete", transmissionId: started.data.transmissionId as string }).ok).toBe(true);
    sim.run(8);
    expect(sim.clearances.get(clearanceId!)!.status).toBe("acknowledged");
    expect(sim.get("WJA302")!.phase).toBe("line_up");
  });

  it("matches a human pilot's readback against the structured clearance", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(15);
    // No automatic readback for a claimed aircraft.
    expect(sim.clearances.get(clearanceId!)!.status).toBe("transmitted");

    const wrong = sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      text: "cleared for takeoff runway two four left, WestJet 302",
      spoken: true,
    });
    expect(wrong).toMatchObject({ ok: false, code: "READBACK_INCORRECT" });
    expect(sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      text: "Runway 23, cleared for takeoff, WestJet 901",
      spoken: true,
    })).toMatchObject({ ok: false, code: "READBACK_INCORRECT" });
    expect(sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      text: " ",
      spoken: true,
    })).toMatchObject({ ok: false, code: "MISSING_READBACK" });
    expect(eventsOf(sim, "readback.incorrect")).toHaveLength(2);
    expect(sim.get("WJA302")!.phase).toBe("holding_short");

    const right = sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      text: "runway two three cleared for takeoff, WestJet three zero two",
      spoken: true,
    });
    expect(right).toMatchObject({ ok: true });
    sim.run(1);
    expect(sim.get("WJA302")!.phase).toBe("line_up");
  });

  it.each([0, 1])("withdraws a cancelled clearance from the radio after %s simulated seconds", (delay) => {
    const sim = sandbox([WJA], { radio: { controller: "external", pilots: "simulated" } });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    const clearance = sim.clearances.get(clearanceId!)!;
    sim.run(delay);
    expect(sim.dispatch({ type: "clearance.cancel", clearanceId: clearance.id, reason: "Departure cancelled" }).ok).toBe(true);
    expect(sim.dispatch({ type: "radio.tx_complete", transmissionId: clearance.transmissionId! })).toMatchObject({
      ok: false,
      code: "NOT_ACTIVE",
    });
    sim.run(35);
    expect(sim.transmissions.get(clearance.transmissionId!)!.status).toBe("failed");
    expect(eventsOf(sim, "radio.tx_started").filter((e) => e.data.clearanceId === clearance.id)).toHaveLength(delay);
    expect(eventsOf(sim, "clearance.activated")).toHaveLength(0);
    expect(sim.runwayState.get("05/23")!.reservation).toBeUndefined();
  });

  it("expires a transmitted takeoff clearance if an inbound aircraft is too close at readback", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(6);
    expect(sim.dispatch({ type: "aircraft.spawn", spec: arrival("ACA214", 4) }).ok).toBe(true);
    expect(sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      clearanceId,
      text: "Runway 23, cleared for takeoff, WestJet 302",
      spoken: true,
    })).toMatchObject({ ok: false, code: "CLEARANCE_NO_LONGER_VALID" });
    expect(sim.clearances.get(clearanceId!)!.status).toBe("expired");
    expect(sim.runwayState.get("05/23")!.reservation).toBeUndefined();
    expect(sim.get("WJA302")!.phase).toBe("holding_short");
  });

  it("expires a taxi clearance when its explicit route closes before readback", () => {
    const sim = sandbox(
      [{ ...WJA, start: { kind: "taxiing", from: "C_T1" } }],
      { radio: { controller: "external", pilots: "simulated" } },
    );
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "TAXI");
    const clearance = sim.clearances.get(clearanceId!)!;
    sim.run(1);
    expect(sim.dispatch({ type: "radio.tx_complete", transmissionId: clearance.transmissionId! }).ok).toBe(true);
    expect(sim.dispatch({
      type: "emergency.trigger",
      emergencyType: "taxiway_blocked",
      edgeId: AirportGraph.edgeId("A_C", "A_A4"),
    }).ok).toBe(true);
    expect(sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      clearanceId,
      text: clearance.expectedReadback,
      spoken: true,
    })).toMatchObject({ ok: false, code: "CLEARANCE_NO_LONGER_VALID" });
    expect(clearance.closeReason).toMatch(/closed/);
  });

  it("withdraws pending runway clearances when the runway is deactivated", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(6);
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["24R"], departures: ["24L"] }).ok).toBe(true);
    expect(sim.clearances.get(clearanceId!)!.status).toBe("expired");
    expect(sim.runwayState.get("05/23")!.reservation).toBeUndefined();
    sim.run(150);
    expect(sim.get("WJA302")!.phase).toBe("holding_short");
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
  });

  it("preserves the runway direction while an aircraft is lined up and stops a cancelled takeoff", () => {
    const sim = sandbox([WJA]);
    issue(sim, "WJA302", "LINE_UP_AND_WAIT");
    sim.run(90);
    expect(sim.get("WJA302")!.phase).toBe("line_up");
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["24R"], departures: ["05"] })).toMatchObject({
      ok: false,
      code: "RUNWAY_IN_USE",
    });
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(6);
    expect(sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      clearanceId,
      text: "Runway 23, cleared for takeoff, WJA302",
      spoken: true,
    }).ok).toBe(true);
    expect(sim.dispatch({ type: "clearance.cancel", clearanceId: clearanceId!, reason: "Stop departure" }).ok).toBe(true);
    sim.run(20);
    expect(sim.get("WJA302")!.phase).toBe("line_up");
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["24R"], departures: ["05"] })).toMatchObject({
      ok: false,
      code: "RUNWAY_IN_USE",
    });
  });

  it("keeps an active line-up reservation when its pending takeoff upgrade is cancelled", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const lineUp = sim.clearances.get(issue(sim, "WJA302", "LINE_UP_AND_WAIT").clearanceId!)!;
    sim.run(6);
    expect(sim.dispatch({
      type: "pilot.readback",
      aircraftId: "WJA302",
      clearanceId: lineUp.id,
      text: lineUp.expectedReadback,
      spoken: true,
    }).ok).toBe(true);
    const takeoff = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    expect(takeoff.status).toBe("accepted");
    expect(sim.dispatch({ type: "clearance.cancel", clearanceId: takeoff.clearanceId!, reason: "Wait for departure" }).ok).toBe(true);
    const runway = sim.runwayState.get("05/23")!;
    expect(runway.reservation).toMatchObject({ clearanceId: lineUp.id, kind: "lineup" });
    sim.run(90);
    expect(runway.occupants).toEqual(["WJA302"]);
    expect(runway.reservation?.clearanceId).toBe(lineUp.id);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
  });

  it("expires a clearance nobody reads back and frees the runway", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(40);
    expect(sim.clearances.get(clearanceId!)!.status).toBe("expired");
    expect(sim.runwayState.get("05/23")!.reservation).toBeUndefined();
    expect(sim.get("WJA302")!.phase).toBe("holding_short");
  });

  it("preserves an urgent stop when the readback is missing and allows a follow-up clearance", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const { clearanceId } = issue(sim, "WJA302", "HOLD_SHORT");
    sim.run(40);
    const clr = sim.clearances.get(clearanceId!)!;
    expect(clr).toMatchObject({ status: "readback_missing", active: true });
    expect(clr.acknowledgedAt).toBeUndefined();
    expect(eventsOf(sim, "clearance.acknowledged")).toHaveLength(0);
    expect(eventsOf(sim, "readback.missing")).toMatchObject([{ attention: true }]);
    expect(sim.snapshot().clearances).toContainEqual(expect.objectContaining({ id: clr.id, status: "readback_missing" }));
    expect(explainAircraft(sim, "WJA302")?.governingClearance?.status).toBe("readback_missing");
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF").status).toBe("accepted");
  });

  it("stops a cancelled taxi route and moves again after a new taxi clearance", () => {
    const sim = sandbox([{ ...WJA, start: { kind: "taxiing", from: "C_T1" } }]);
    const { clearanceId } = issue(sim, "WJA302", "TAXI");
    sim.run(18);
    const ac = sim.get("WJA302")!;
    expect(sim.clearances.get(clearanceId!)!.status).toBe("acknowledged");
    expect(ac.speedKts).toBeGreaterThan(0);
    const position = { ...ac.position };
    expect(sim.dispatch({ type: "clearance.cancel", clearanceId: clearanceId!, reason: "Taxi route withdrawn" }).ok).toBe(true);
    sim.run(15);
    expect(ac.position).toEqual(position);
    expect(ac.speedKts).toBe(0);
    expect(getPendingRequests(sim)).toContainEqual(expect.objectContaining({ aircraftId: ac.id, type: "TAXI" }));
    expect(issue(sim, ac.id, "CONTINUE_TAXI")).toMatchObject({ status: "rejected", code: "TAXI_CLEARANCE_REQUIRED" });
    expect(issue(sim, ac.id, "TAXI").status).toBe("accepted");
    sim.run(20);
    expect(ac.position).not.toEqual(position);
  });

  it("vacates a runway before stopping when the taxi route is cancelled during a crossing", () => {
    const sim = sandbox([{ ...WJA, callsign: "POE245", runway: "24L", start: { kind: "taxiing", from: "J_T3" } }]);
    const ac = sim.get("POE245")!;
    sim.run(200);
    expect(issue(sim, ac.id, "CROSS_RUNWAY", { runway: "24R" }).status).toBe("accepted");
    for (let i = 0; i < 300 && !runwayOccupiedBy(sim, ac); i++) sim.step();
    expect(runwayOccupiedBy(sim, ac)).toBe("06L/24R");
    const taxi = [...sim.clearances.values()].find((c) => c.type === "TAXI")!;
    expect(sim.dispatch({ type: "clearance.cancel", clearanceId: taxi.id, reason: "Taxi route withdrawn" }).ok).toBe(true);
    sim.run(90);
    expect(runwayOccupiedBy(sim, ac)).toBeUndefined();
    expect(sim.runwayState.get("06L/24R")?.reservation).toBeUndefined();
    expect(ac.route[ac.currentWaypointIndex]).toBe("HS_D5S");
    expect(ac.speedKts).toBe(0);
    expect(getPendingRequests(sim)).toContainEqual(expect.objectContaining({ aircraftId: ac.id, type: "TAXI" }));
  });

  it("acts on GO_AROUND as soon as it is transmitted and voids the landing clearance", () => {
    const sim = sandbox([arrival("ACA214", 4)]);
    issue(sim, "ACA214", "CLEARED_TO_LAND");
    sim.run(15);
    expect(sim.get("ACA214")!.landingCleared).toBe(true);
    issue(sim, "ACA214", "GO_AROUND");
    sim.run(5);
    const ac = sim.get("ACA214")!;
    expect(ac.phase).toBe("go_around");
    expect(ac.landingCleared).toBe(false);
    expect(sim.runwayState.get("05/23")!.reservation).toBeUndefined();
  });

  it("lets a human pilot make a request that reaches the controller's queue", () => {
    const sim = sandbox([WJA]);
    sim.dispatch({ type: "pilot.claim", aircraftId: "WJA302", by: "human" });
    const res = sim.dispatch({
      type: "pilot.request",
      aircraftId: "WJA302",
      requestType: "TAKEOFF",
      text: "Tower, WestJet 302 ready for departure runway 23",
      spoken: true,
    });
    expect(res.ok).toBe(true);
    const gw = new ToolGateway(() => sim);
    const pending = gw.call("get_pending_requests", {});
    expect(pending).toMatchObject({ ok: true, result: { requests: [{ aircraftId: "WJA302", type: "TAKEOFF" }] } });
  });
});

describe("HOLD_POSITION against a takeoff clearance", () => {
  const onThreshold = () => {
    const sim = sandbox([WJA]);
    issue(sim, "WJA302", "CLEARED_TAKEOFF");
    for (let i = 0; i < 1000 && eventsOf(sim, "aircraft.lined_up").length === 0; i++) sim.step();
    expect(eventsOf(sim, "aircraft.lined_up")).toHaveLength(1);
    return sim;
  };

  it("stops an aircraft that is aligning on the threshold and withdraws its takeoff clearance", () => {
    const sim = onThreshold();
    expect(issue(sim, "WJA302", "HOLD_POSITION")).toMatchObject({ status: "accepted" });
    sim.run(60);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
    expect(sim.get("WJA302")!.runwayAuth["05/23"]).toBe("lineup");
    expect([...sim.clearances.values()].find((c) => c.type === "CLEARED_TAKEOFF")!.status).toBe("cancelled");
    // It is standing on the runway, so nobody else may have it.
    expect(sim.runwayState.get("05/23")!.reservation?.aircraftId).toBe("WJA302");
  });

  it("stays stopped when the runway it was waiting for clears", () => {
    const sim = sandbox([WJA, { ...WJA, callsign: "ACA200", runway: "05" }]);
    issue(sim, "WJA302", "CLEARED_TAKEOFF");
    for (let i = 0; i < 1000 && sim.get("WJA302")!.phase !== "line_up"; i++) sim.step();
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "runway_incursion", aircraftId: "ACA200" }).ok).toBe(true);
    sim.run(60);
    expect(sim.get("WJA302")!.phase).toBe("line_up");
    issue(sim, "WJA302", "HOLD_POSITION");
    sim.run(20);
    sim.dispatch({ type: "aircraft.remove", aircraftId: "ACA200" });
    sim.run(30);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
  });

  it("does not ask for takeoff while held, so a first-come controller cannot undo the stop", () => {
    const sim = onThreshold();
    issue(sim, "WJA302", "HOLD_POSITION");
    withBaseline(sim).run(120);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
  });

  it("needs a new takeoff clearance after being told to continue", () => {
    const sim = onThreshold();
    issue(sim, "WJA302", "HOLD_POSITION");
    sim.run(20);
    issue(sim, "WJA302", "CONTINUE_TAXI");
    sim.run(30);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(0);
    expect(getPendingRequests(sim)).toEqual([expect.objectContaining({ aircraftId: "WJA302", type: "TAKEOFF" })]);
    issue(sim, "WJA302", "CLEARED_TAKEOFF");
    sim.run(30);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(1);
  });

  it.each(["line_up", "holding_short"])("is superseded by a newer takeoff clearance from %s", (phase) => {
    const sim = phase === "line_up" ? onThreshold() : sandbox([WJA]);
    issue(sim, "WJA302", "HOLD_POSITION");
    sim.run(20);
    expect(sim.get("WJA302")!.phase).toBe(phase);
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF")).toMatchObject({ status: "accepted" });
    sim.run(90);
    expect(eventsOf(sim, "aircraft.takeoff_roll")).toHaveLength(1);
    expect([...sim.clearances.values()].find((c) => c.type === "HOLD_POSITION")!.status).toBe("superseded");
  });
});
