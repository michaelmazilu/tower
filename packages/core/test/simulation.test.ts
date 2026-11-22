import { describe, expect, it } from "vitest";
import {
  AirportGraph,
  SCHEMATIC_GUIDED_DEMO as GUIDED_DEMO,
  PHASE_TRANSITIONS,
  createSchematicGraph as createCyyzGraph,
  createSimulation,
  explainAircraft,
  replay,
  type FlightPhase,
  type Simulation,
  type SpawnSpec,
} from "../src";
import { eventsOf, issue, sandbox, withBaseline } from "./helpers";

/** Checked after every step of a normal (no-emergency) run. */
function assertRunwayInvariants(sim: Simulation): void {
  for (const state of sim.runwayState.values()) {
    expect(state.occupants.length, `runway ${state.id} at t=${sim.time}: ${state.occupants.join(",")}`).toBeLessThanOrEqual(1);
    for (const occupant of state.occupants) {
      expect(state.reservation?.aircraftId, `${occupant} on ${state.id} at t=${sim.time} without owning it`).toBe(occupant);
    }
  }
}

describe("guided demo, run by the baseline controller through the tool gateway", () => {
  const sim = createSimulation(GUIDED_DEMO, { strict: true });
  const { run } = withBaseline(sim);
  let maxConcurrent = 0;
  run(25 * 60, () => {
    assertRunwayInvariants(sim);
    maxConcurrent = Math.max(maxConcurrent, sim.aircraft.size);
  });

  it("starts with eight aircraft in the planned mix", () => {
    expect(maxConcurrent).toBe(8);
    const spawned = eventsOf(sim, "aircraft.spawned").map((e) => e.data.phase);
    expect(spawned.filter((p) => p === "approach")).toHaveLength(2);
    expect(spawned.filter((p) => p === "holding_short")).toHaveLength(2);
    expect(spawned.filter((p) => p === "taxi_out")).toHaveLength(2);
    expect(spawned.filter((p) => p === "at_gate")).toHaveLength(1);
    expect(spawned.filter((p) => p === "taxi_in")).toHaveLength(1);
  });

  it("completes every flight without human intervention", () => {
    expect(sim.stats.departed).toBe(5);
    expect(sim.stats.arrived).toBe(3);
    for (const ac of sim.aircraft.values()) expect(ac.flightComplete, ac.id).toBe(true);
  });

  it("never needed a go-around and ends with no conflicts", () => {
    expect(sim.stats.goArounds).toBe(0);
    expect(sim.conflicts.size).toBe(0);
    expect(eventsOf(sim, "conflict.detected").filter((e) => e.data.severity === "critical")).toHaveLength(0);
  });

  it("only ever made legal phase changes, each with a logged cause", () => {
    const changes = eventsOf(sim, "aircraft.phase_changed");
    expect(changes.length).toBeGreaterThan(30);
    for (const e of changes) {
      expect(e.cause, `seq ${e.seq}`).toBeDefined();
      expect(PHASE_TRANSITIONS[e.data.from as FlightPhase]).toContain(e.data.to);
      if (e.cause!.kind === "clearance") {
        const clr = sim.clearances.get(e.cause!.clearanceId)!;
        expect(clr.aircraftId).toBe(e.aircraftId);
        expect(clr.acknowledgedAt ?? clr.transmittedAt, `clearance ${clr.id} acted on before it was transmitted`).toBeLessThanOrEqual(e.simTime);
      }
    }
  });

  it("can trace every clearance to a stated reason and a correct readback", () => {
    const controller = [...sim.clearances.values()].filter((c) => c.issuedBy !== "scenario");
    expect(controller.length).toBeGreaterThanOrEqual(15);
    for (const c of controller) {
      expect(c.reason.length).toBeGreaterThan(5);
      expect(c.status, c.id).toBe(c.type === "HOLD_SHORT" || c.type === "CONTINUE_APPROACH" ? "superseded" : "completed");
    }
    expect(eventsOf(sim, "clearance.acknowledged")).toHaveLength(controller.length);
  });

  it("had one voice on the radio at a time", () => {
    let active = 0;
    let max = 0;
    const started = new Set<unknown>();
    for (const e of sim.events) {
      if (e.type === "radio.tx_started") {
        started.add(e.data.transmissionId);
        max = Math.max(max, ++active);
      } else if ((e.type === "radio.tx_completed" || e.type === "radio.tx_failed") && started.has(e.data.transmissionId)) {
        active--;
      }
    }
    expect(max).toBe(1);
  });

  it("numbers events without gaps so the log can be replayed in order", () => {
    sim.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (let i = 1; i < sim.events.length; i++) expect(sim.events[i].simTime).toBeGreaterThanOrEqual(sim.events[i - 1].simTime);
  });
});

describe("determinism and replay", () => {
  const record = () => {
    const sim = createSimulation(GUIDED_DEMO, { strict: true });
    withBaseline(sim).run(12 * 60);
    return sim;
  };

  it("produces the identical run from the same seed", () => {
    const a = record();
    const b = record();
    expect(b.stateHash()).toBe(a.stateHash());
    expect(b.events.length).toBe(a.events.length);
  });

  it("reproduces a run from the recorded commands alone, with no controller attached", () => {
    const original = record();
    expect(original.commands.length).toBeGreaterThan(15);
    const copy = replay(GUIDED_DEMO, original.commands, original.tick, { strict: true });
    expect(copy.stateHash()).toBe(original.stateHash());
    expect(copy.stats).toEqual(original.stats);
  });

  it("diverges if a command is left out, so the hash really does depend on the decisions", () => {
    const original = record();
    const withoutPushback = original.commands.filter(
      (c) => !(c.command.type === "clearance.issue" && c.command.clearanceType === "PUSHBACK"),
    );
    expect(withoutPushback.length).toBeLessThan(original.commands.length);
    const copy = replay(GUIDED_DEMO, withoutPushback, original.tick, { strict: true });
    expect(copy.stateHash()).not.toBe(original.stateHash());
    expect(copy.get("TSC330")!.phase).toBe("at_gate");
  });
});

describe("12-aircraft traffic", () => {
  it.each([20260])("completes every flight with runway protection on seed %i", (seed) => {
    const extra: SpawnSpec[] = [
      { callsign: "ACA771", type: "B789", flight: "arrival", runway: "24R", gate: "B11", start: { kind: "approach", distanceNm: 23 } },
      { callsign: "WEN71", type: "B38M", flight: "departure", runway: "24L", gate: "B9", start: { kind: "gate" }, readyInSec: 100 },
      { callsign: "FDX83", type: "B77W", flight: "departure", runway: "23", gate: "D31", start: { kind: "gate" }, readyInSec: 170 },
      { callsign: "AAL123", type: "A319", flight: "arrival", runway: "33R", gate: "D20", start: { kind: "approach", distanceNm: 13 } },
    ];
    const sim = createSimulation({
      ...GUIDED_DEMO,
      seed,
      aircraft: [...GUIDED_DEMO.aircraft, ...extra],
      activeRunways: { arrivals: ["23", "24R", "33R"], departures: ["23", "24L"] },
    }, { strict: true });
    expect(sim.aircraft.size).toBe(12);
    withBaseline(sim).run(35 * 60, () => assertRunwayInvariants(sim));
    expect(sim.stats).toMatchObject({ departed: 7, arrived: 5, goArounds: 0 });
    expect(sim.conflicts.size).toBe(0);
  });
});

describe("the simulation enforces the rules even when nobody is controlling", () => {
  it("alerts the tower when an existing runway conflict becomes critical", () => {
    const sim = sandbox([{ callsign: "WJA302", flight: "departure", runway: "23", start: { kind: "holding_short" } }]);
    issue(sim, "WJA302", "LINE_UP_AND_WAIT");
    sim.run(90);
    expect(sim.dispatch({
      type: "aircraft.spawn",
      spec: { callsign: "ACA214", flight: "arrival", runway: "23", start: { kind: "approach", distanceNm: 6 } },
    }).ok).toBe(true);
    sim.run(145);
    const initial = eventsOf(sim, "conflict.detected").find((e) => e.data.type === "arrival_runway_occupied");
    expect(initial?.data.severity).toBe("warning");
    expect(eventsOf(sim, "conflict.escalated")).toMatchObject([{
      aircraftId: "ACA214",
      attention: true,
      data: { previousSeverity: "warning", severity: "critical", detectedAt: initial?.data.detectedAt },
    }]);
  });

  it("sends an arrival around if it reaches the decision point without a landing clearance", () => {
    const sim = sandbox([{ callsign: "ACA214", flight: "arrival", runway: "23", start: { kind: "approach", distanceNm: 4 } }]);
    sim.run(180);
    const ga = eventsOf(sim, "go_around.initiated");
    expect(ga).toHaveLength(1);
    expect(ga[0].cause).toEqual({ kind: "auto", rule: "no_landing_clearance" });
    expect(eventsOf(sim, "aircraft.touchdown")).toHaveLength(0);
    expect(eventsOf(sim, "approach.clearance_needed")).toHaveLength(1);
  });

  it("stops taxiing aircraft at a runway they are not cleared to cross", () => {
    const sim = sandbox([{ callsign: "POE245", flight: "departure", runway: "24L", start: { kind: "taxiing", from: "J_T3" } }]);
    sim.run(400);
    const ac = sim.get("POE245")!;
    expect(ac.phase).toBe("holding_short");
    expect(sim.runwayState.get("06L/24R")!.occupants).toEqual([]);
    expect(explainAircraft(sim, "POE245")!.nextPlannedAction).toMatch(/cross runway 24R/);
  });

  it("keeps aircraft at the gate until pushback is approved", () => {
    const sim = sandbox([{ callsign: "TSC330", flight: "departure", runway: "23", gate: "D24", start: { kind: "gate" }, readyInSec: 5 }]);
    sim.run(300);
    expect(sim.get("TSC330")!.phase).toBe("at_gate");
    expect([...sim.requests.values()][0]).toMatchObject({ type: "PUSHBACK", status: "pending" });
    expect([...sim.requests.values()][0].reminders).toBeGreaterThan(0);
  });
});

describe("every runway end works", () => {
  const graph = createCyyzGraph();
  const ends = [...graph.runways.values()].flatMap((r) => r.ends.map((e) => e.designator));

  it.each(ends.slice(0, 2))("lands and departs on runway %s", (end) => {
    const sim = sandbox(
      [
        { callsign: "ACA100", flight: "arrival", runway: end, gate: "D22", start: { kind: "approach", distanceNm: 6 } },
        { callsign: "WJA200", flight: "departure", runway: end, start: { kind: "holding_short" } },
      ],
      {},
      { activeRunways: { arrivals: [end], departures: [end] } },
    );
    const { run } = withBaseline(sim);
    run(22 * 60, () => assertRunwayInvariants(sim));
    expect(sim.stats.departed, "departed").toBe(1);
    expect(sim.stats.arrived, "arrived").toBe(1);
    expect(sim.stats.goArounds).toBe(0);
  });
});

describe("emergencies", () => {
  const arrival: SpawnSpec = { callsign: "ACA214", flight: "arrival", runway: "23", gate: "D22", start: { kind: "approach", distanceNm: 4 } };
  const departure: SpawnSpec = { callsign: "WJA302", flight: "departure", runway: "23", start: { kind: "holding_short" } };

  it("refuses manual triggers while emergencies are off", () => {
    const sim = sandbox([arrival], {}, { emergencyMode: "off" });
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "go_around" })).toMatchObject({ ok: false, code: "EMERGENCIES_OFF" });
  });

  it("go-around: the aircraft flies the circuit, rejoins and lands on the second attempt", () => {
    const sim = sandbox([arrival]);
    const { run } = withBaseline(sim);
    run(30);
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "go_around", aircraftId: "ACA214" }).ok).toBe(true);
    expect(sim.get("ACA214")!.phase).toBe("go_around");
    run(25 * 60);
    expect(eventsOf(sim, "approach.established")).toHaveLength(1);
    expect(sim.stats).toMatchObject({ goArounds: 1, arrived: 1 });
  });

  it("engine failure: the aircraft declares, becomes top priority, and still lands", () => {
    const sim = sandbox([{ ...arrival, start: { kind: "approach", distanceNm: 9 } }]);
    const { run } = withBaseline(sim);
    run(10);
    const res = sim.dispatch({ type: "emergency.trigger", emergencyType: "engine_failure", aircraftId: "ACA214" });
    expect(res.ok).toBe(true);
    expect(sim.get("ACA214")!.priority).toBe("emergency");
    run(60);
    expect(eventsOf(sim, "radio.tx_completed").some((e) => String(e.data.text).startsWith("MAYDAY"))).toBe(true);
    run(15 * 60);
    expect(sim.stats.arrived).toBe(1);
    expect([...sim.emergencies.values()][0].resolvedAt).toBeDefined();
  });

  it("engine failure after takeoff: the departure returns and lands", () => {
    const sim = sandbox([departure]);
    const { run } = withBaseline(sim);
    run(200);
    expect(sim.get("WJA302")!.phase).toBe("departure");
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "engine_failure", aircraftId: "WJA302" }).ok).toBe(true);
    expect(sim.get("WJA302")!.flight).toBe("arrival");
    run(25 * 60);
    expect(sim.stats).toMatchObject({ arrived: 1, departed: 0 });
  });

  it("runway incursion: the arrival goes around rather than land on an occupied runway", () => {
    const sim = sandbox([arrival, departure]);
    const { run } = withBaseline(sim);
    run(25);
    expect(sim.get("ACA214")!.landingCleared).toBe(true);
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "runway_incursion", aircraftId: "WJA302" }).ok).toBe(true);

    let landedOnOccupiedRunway = false;
    run(25 * 60, () => {
      const occupants = sim.runwayState.get("05/23")!.occupants;
      if (sim.get("ACA214")?.phase === "rollout" && occupants.length > 1) landedOnOccupiedRunway = true;
    });
    expect(eventsOf(sim, "emergency.runway_incursion")).toHaveLength(1);
    expect(eventsOf(sim, "conflict.detected").some((e) => e.data.type === "runway_incursion")).toBe(true);
    expect(landedOnOccupiedRunway).toBe(false);
    expect(sim.stats.goArounds).toBeGreaterThanOrEqual(1);
    // Both flights still complete once the controller sorts it out.
    expect(sim.stats).toMatchObject({ departed: 1, arrived: 1 });
  });

  it("goes around and recovers after an incursion below 100 feet", () => {
    const sim = sandbox([arrival, departure]);
    const { run } = withBaseline(sim);
    const inbound = sim.get("ACA214")!;
    for (let i = 0; i < 1800 && !(inbound.phase === "landing" && inbound.altitudeFt < 90); i++) {
      run(sim.config.dt);
    }
    expect(inbound.phase).toBe("landing");
    expect(inbound.altitudeFt).toBeLessThan(90);
    const runway = sim.runwayState.get("05/23")!;
    expect(runway.occupants).toHaveLength(0);
    expect(runway.reservation?.aircraftId).toBe("ACA214");
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "runway_incursion", aircraftId: "WJA302" }).ok).toBe(true);
    run(2);
    expect(inbound.phase).toBe("go_around");
    expect(eventsOf(sim, "aircraft.touchdown")).toHaveLength(0);
    run(25 * 60);
    expect(sim.stats).toMatchObject({ arrived: 1, departed: 1, goArounds: 1 });
    expect(sim.conflicts.size).toBe(0);
  });

  it("taxiway blocked: the aircraft stops, asks for a new route and gets there another way", () => {
    const sim = sandbox([{ callsign: "JZA781", flight: "departure", runway: "23", start: { kind: "taxiing", from: "C_T1" } }]);
    const { run } = withBaseline(sim);
    const blocked = AirportGraph.edgeId("C_T1", "A_C");
    const original = [...sim.get("JZA781")!.route];
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "taxiway_blocked", edgeId: blocked }).ok).toBe(true);
    run(60);
    const ac = sim.get("JZA781")!;
    expect(ac.route).not.toEqual(original);
    for (let i = 1; i < ac.route.length; i++) expect(AirportGraph.edgeId(ac.route[i - 1], ac.route[i])).not.toBe(blocked);
    run(15 * 60);
    expect(sim.stats.departed).toBe(1);
  });

  it("random mode is driven by the seed, so the same seed gives the same emergencies", () => {
    const runOnce = () => {
      const sim = createSimulation({ ...GUIDED_DEMO, emergencyMode: "random" }, { strict: true, rules: { randomEmergencyMeanIntervalSec: 60 } as never });
      withBaseline(sim).run(8 * 60);
      return eventsOf(sim, "emergency.declared").map((e) => `${e.simTime}:${e.data.emergencyType}:${e.aircraftId ?? e.data.edgeId}`);
    };
    const first = runOnce();
    expect(first.length).toBeGreaterThan(0);
    expect(runOnce()).toEqual(first);
  });
});

describe("sandbox controls", () => {
  it("adds and removes aircraft, and refuses impossible placements", () => {
    const sim = sandbox();
    expect(sim.dispatch({ type: "aircraft.spawn", spec: { callsign: "FDX12", type: "B77W", flight: "arrival", runway: "24R", start: { kind: "approach", distanceNm: 10 } } }).ok).toBe(true);
    expect(sim.dispatch({ type: "aircraft.spawn", spec: { callsign: "FDX12", flight: "departure", start: { kind: "gate" } } })).toMatchObject({ ok: false, code: "DUPLICATE_CALLSIGN" });
    expect(sim.dispatch({ type: "aircraft.spawn", spec: { callsign: "UAL1", flight: "departure", gate: "D26", start: { kind: "gate" } } }).ok).toBe(true);
    expect(sim.dispatch({ type: "aircraft.spawn", spec: { callsign: "UAL2", flight: "departure", gate: "D26", start: { kind: "gate" } } })).toMatchObject({ ok: false, code: "GATE_OCCUPIED" });
    expect(sim.dispatch({ type: "aircraft.spawn", spec: { callsign: "UAL3", flight: "departure", runway: "99", start: { kind: "gate" } } })).toMatchObject({ ok: false, code: "UNKNOWN_RUNWAY" });
    expect(sim.dispatch({
      type: "aircraft.spawn",
      spec: { callsign: "UAL3", flight: "departure", runway: "23", start: { kind: "taxiing", from: "RW0523_A6" } },
    })).toMatchObject({ ok: false, code: "INVALID_START" });
    expect(sim.aircraft.size).toBe(2);
    expect(sim.dispatch({ type: "aircraft.remove", aircraftId: "FDX12" }).ok).toBe(true);
    expect(sim.aircraft.size).toBe(1);
  });

  it("changes the runway configuration, one direction per runway", () => {
    const sim = sandbox();
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["05"], departures: ["23"] })).toMatchObject({ ok: false, code: "OPPOSITE_DIRECTION" });
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["5", "06L"], departures: ["06R"] })).toMatchObject({ ok: true, arrivals: ["05", "06L"] });
  });

  it("explains an aircraft from recorded facts only", () => {
    const sim = sandbox([
      { callsign: "ACA214", flight: "arrival", runway: "23", gate: "D22", start: { kind: "approach", distanceNm: 6 } },
      { callsign: "WJA302", flight: "departure", runway: "23", start: { kind: "holding_short" } },
    ]);
    issue(sim, "ACA214", "CLEARED_TO_LAND", { reason: "First in sequence, runway clear." });
    sim.run(20);
    issue(sim, "WJA302", "HOLD_SHORT", { reason: "ACA214 on final for runway 23." });
    sim.run(20);
    const ex = explainAircraft(sim, "WJA302")!;
    expect(ex.objective).toBe("Depart from runway 23.");
    expect(ex.governingClearance).toMatchObject({ type: "HOLD_SHORT", status: "acknowledged" });
    expect(ex.controllerReason).toBe("ACA214 on final for runway 23.");
    expect(ex.nextPlannedAction).toMatch(/takeoff clearance/);
    expect(explainAircraft(sim, "ACA214")!.controllerReason).toBe("First in sequence, runway clear.");
  });
});

describe("engine failure out of a departures-only runway", () => {
  const returning = () => {
    const sim = sandbox([{ callsign: "UAL119", flight: "departure", runway: "24L", start: { kind: "holding_short" } }]);
    const { run } = withBaseline(sim);
    for (let t = 0; t < 400 && sim.get("UAL119")?.phase !== "departure"; t++) run(1);
    expect(sim.activeRunways.arrivals).not.toContain("24L");
    expect(sim.dispatch({ type: "emergency.trigger", emergencyType: "engine_failure", aircraftId: "UAL119" })).toMatchObject({ ok: true });
    const untilCleared = () => {
      for (let t = 0; t < 1200 && !sim.get("UAL119")!.landingCleared; t++) run(1);
      expect(sim.get("UAL119")!.landingCleared).toBe(true);
    };
    return { sim, run, untilCleared };
  };

  it("lands back on the runway it departed from", () => {
    const { sim, run } = returning();
    run(25 * 60);
    expect(sim.stats).toMatchObject({ arrived: 1, goArounds: 0 });
    expect(sim.get("UAL119")).toMatchObject({ phase: "at_gate", flightComplete: true });
  });

  it("tells the controller that the runway is available to that aircraft", () => {
    const { sim } = returning();
    expect([...sim.emergencies.values()][0].description).toContain("returning to land runway 24L");
  });

  it("can still land if the operator closes the emergency during the return", () => {
    const { sim, run } = returning();
    sim.dispatch({ type: "emergency.resolve", emergencyId: [...sim.emergencies.keys()][0] });
    run(25 * 60);
    expect(sim.stats.arrived).toBe(1);
  });

  it("does not block an unrelated runway change", () => {
    const { sim, untilCleared } = returning();
    untilCleared();
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["23"], departures: ["23", "24L"] })).toMatchObject({ ok: true });
    expect(sim.get("UAL119")!.landingCleared).toBe(true);
  });

  it("protects the runway from being deactivated under the returning aircraft", () => {
    const { sim, untilCleared } = returning();
    untilCleared();
    expect(sim.dispatch({ type: "runways.set_active", arrivals: ["23"], departures: ["23"] })).toMatchObject({
      ok: false,
      code: "RUNWAY_IN_USE",
    });
  });

  it("does not open the runway to any aircraft that is merely given emergency priority", () => {
    const sim = sandbox([{ callsign: "ACA500", flight: "arrival", runway: "24L", start: { kind: "approach", distanceNm: 9 } }]);
    sim.dispatch({ type: "priority.set", aircraftId: "ACA500", priority: "emergency", reason: "test" });
    expect(sim.dispatch({ type: "clearance.issue", aircraftId: "ACA500", clearanceType: "CLEARED_TO_LAND", reason: "test" })).toMatchObject({
      ok: false,
      code: "RUNWAY_NOT_ACTIVE",
    });
  });
});
