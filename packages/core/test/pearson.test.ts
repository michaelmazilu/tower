import { describe, expect, it } from "vitest";
import {
  GUIDED_DEMO,
  PEARSON,
  PEARSON_BUILD_REPORT,
  SANDBOX,
  createPearsonGraph,
  createSimulation,
  projectOnSegment,
  type Scenario,
  type Simulation,
  type SpawnSpec,
} from "../src";
import { eventsOf, issue, sandbox, withBaseline } from "./helpers";

const g = createPearsonGraph();

/** An empty real Pearson with the given aircraft. */
function pearson(aircraft: SpawnSpec[], extra: Partial<Scenario> = {}): Simulation {
  return createSimulation({ ...SANDBOX, emergencyMode: "manual", ...extra, aircraft }, { strict: true });
}

function assertRunwayInvariants(sim: Simulation): void {
  for (const state of sim.runwayState.values()) {
    expect(state.occupants.length, `runway ${state.id} at t=${sim.time}: ${state.occupants.join(", ")}`).toBeLessThanOrEqual(1);
  }
}

/** Ground aircraft closer than a fuselage width apart, ignoring neighbours on their stands. */
function tooClose(sim: Simulation): string[] {
  const ground = [...sim.aircraft.values()].filter((a) => a.altitudeFt === 0 && a.phase !== "at_gate" && a.phase !== "pushback");
  const out: string[] = [];
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      const d = Math.hypot(ground[i].position.x - ground[j].position.x, ground[i].position.y - ground[j].position.y);
      if (d < 25) out.push(`${ground[i].id}/${ground[j].id} ${Math.round(d)} m at t=${Math.round(sim.time)}`);
    }
  }
  return out;
}

describe("Toronto Pearson from OpenStreetMap", () => {
  it("builds without anything a person needs to look at", () => {
    expect(PEARSON_BUILD_REPORT.warnings).toEqual([]);
    expect(g.validate()).toEqual([]);
  });

  it("credits its source", () => {
    expect(PEARSON.attribution).toMatch(/OpenStreetMap contributors/);
  });

  it("has the five runways at their real lengths and bearings", () => {
    const facts = Object.fromEntries([...g.runways.values()].map((r) => [r.id, [Math.round(r.lengthM), Math.round(r.ends[0].headingDeg)]]));
    // Published lengths: 3389, 2956, 2743, 3368, 2770 m. Headings are true, not magnetic.
    expect(facts).toEqual({
      "05/23": [3387, 46],
      "06L/24R": [2968, 46],
      "06R/24L": [2738, 46],
      "15L/33R": [3365, 137],
      "15R/33L": [2768, 137],
    });
  });

  it("knows which runways cross", () => {
    expect(g.intersecting("05/23").sort()).toEqual(["15L/33R", "15R/33L"]);
    expect(g.intersecting("15L/33R")).toEqual(["05/23"]);
    expect(g.intersecting("15R/33L")).toEqual(["05/23"]);
    expect(g.intersecting("06L/24R")).toEqual([]);
    expect(g.intersecting("06R/24L")).toEqual([]);
  });

  it("puts a hold line between every taxiway and every runway", () => {
    for (const e of PEARSON.edges) {
      if (e.kind === "runway") continue;
      const ends = [g.node(e.from), g.node(e.to)];
      const onRunway = ends.find((n) => n.kind === "runway");
      if (!onRunway) continue;
      // The only way onto a runway is a link from a hold line guarding that runway.
      expect(e.kind, e.id).toBe("runway_link");
      const other = ends.find((n) => n !== onRunway)!;
      expect(other.kind, e.id).toBe("hold_short");
      expect(other.guards, e.id).toBe(onRunway.runway);
    }
    for (const n of PEARSON.nodes) {
      if (n.kind !== "hold_short") continue;
      const r = g.runways.get(n.guards!)!;
      const pr = projectOnSegment(n, r.paved![0], r.paved![1]);
      if (pr.t >= 0 && pr.t <= pr.length) {
        expect(pr.lateral, `${n.id} distance from the centreline`).toBeGreaterThan(70);
        expect(pr.lateral, `${n.id} distance from the centreline`).toBeLessThan(100);
      }
    }
  });

  it("has real taxiway names and Terminal 1 and Terminal 3 gates", () => {
    const names = new Set(PEARSON.edges.map((e) => e.name).filter(Boolean));
    for (const name of ["A", "B", "C", "D", "E", "F", "H", "J"]) expect(names.has(name), `taxiway ${name}`).toBe(true);
    const gates = [...g.gates.values()];
    expect(gates.filter((n) => n.terminal === "T1").length).toBeGreaterThan(40);
    expect(gates.filter((n) => n.terminal === "T3").length).toBeGreaterThan(25);
    expect(g.gates.has("141")).toBe(true); // Terminal 1: stand numbers, as mapped
    expect(g.gates.has("B11")).toBe(true); // Terminal 3: gate names
    // Parked aircraft do not overlap.
    for (const a of gates) {
      for (const b of gates) {
        if (a.id < b.id) expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.gate} / ${b.gate}`).toBeGreaterThanOrEqual(38);
      }
    }
  });

  it("carries the shapes the frontend needs to draw it", () => {
    expect(PEARSON.drawing!.runways).toHaveLength(5);
    expect(PEARSON.drawing!.taxiways.length).toBeGreaterThan(300);
    expect(PEARSON.drawing!.stands.length).toBeGreaterThan(200);
    expect(PEARSON.terminals.map((t) => t.id)).toContain("T1");
  });

  it("gives a real taxi instruction for a real route", () => {
    const res = g.shortestPath(g.gates.get("141")!.pushbackNode!, g.departureHolds("23"))!;
    expect(g.validatePath(res.path)).toBeNull();
    expect(g.viaNames(res.path).slice(-3)).toEqual(["A", "H", "Q"]);
    expect(res.lengthM).toBeGreaterThan(2000);
    expect(res.lengthM).toBeLessThan(3500);
  });
});

describe("guided demo on the real layout", () => {
  const sim = createSimulation(GUIDED_DEMO, { strict: true });
  const { run } = withBaseline(sim);
  const close = new Set<string>();
  let step = 0;
  run(20 * 60, () => {
    assertRunwayInvariants(sim);
    if (step++ % 10 === 0) for (const c of tooClose(sim)) close.add(c.split(" ")[0]);
  });

  it("completes all eight flights with no go-around and no conflict left open", () => {
    expect(sim.stats).toMatchObject({ departed: 5, arrived: 3, goArounds: 0 });
    for (const ac of sim.aircraft.values()) expect(ac.flightComplete, ac.id).toBe(true);
    expect(sim.conflicts.size).toBe(0);
  });

  it("never brings two taxiing aircraft together", () => {
    expect([...close]).toEqual([]);
  });

  it("is the same run every time", () => {
    const again = createSimulation(GUIDED_DEMO, { strict: true });
    withBaseline(again).run(20 * 60);
    expect(again.stateHash()).toBe(sim.stateHash());
  });
});

describe("every runway end works on the real layout", () => {
  const ends = [...g.runways.values()].flatMap((r) => r.ends.map((e) => e.designator));

  it.each(ends)("lands and departs on runway %s", (end) => {
    const sim = pearson(
      [
        { callsign: "ACA100", flight: "arrival", runway: end, gate: "141", start: { kind: "approach", distanceNm: 6 } },
        { callsign: "WJA200", flight: "departure", runway: end, start: { kind: "holding_short" } },
      ],
      { activeRunways: { arrivals: [end], departures: [end] } },
    );
    withBaseline(sim).run(25 * 60, () => assertRunwayInvariants(sim));
    expect(sim.stats.departed, "departed").toBe(1);
    expect(sim.stats.arrived, "arrived").toBe(1);
    expect(sim.stats.goArounds).toBe(0);
  });
});

describe("runways that cross are used one at a time", () => {
  const crossing = { activeRunways: { arrivals: ["23", "15L", "24R"], departures: ["15L", "23"] } };

  it("refuses a takeoff while an aircraft is cleared to land on the crossing runway", () => {
    const sim = pearson(
      [
        { callsign: "ACA214", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 9 } },
        { callsign: "WJA302", flight: "departure", runway: "15L", start: { kind: "holding_short" } },
      ],
      crossing,
    );
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND").status).toBe("accepted");
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF")).toMatchObject({ status: "rejected", code: "CROSSING_RUNWAY_IN_USE" });
    // Lining up does not put anything on the crossing point, so it is still allowed.
    expect(issue(sim, "WJA302", "LINE_UP_AND_WAIT").status).toBe("accepted");
  });

  it("refuses a takeoff ahead of an arrival that is close in on the crossing runway", () => {
    const sim = pearson(
      [
        { callsign: "ACA214", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 4 } },
        { callsign: "WJA302", flight: "departure", runway: "15L", start: { kind: "holding_short" } },
      ],
      crossing,
    );
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF")).toMatchObject({ status: "rejected", code: "ARRIVAL_TOO_CLOSE" });
  });

  it("refuses a landing while a departure is rolling on the crossing runway, but not on a parallel one", () => {
    const sim = pearson(
      [
        { callsign: "WJA302", flight: "departure", runway: "23", start: { kind: "holding_short" } },
        { callsign: "ACA214", flight: "arrival", runway: "15L", gate: "141", start: { kind: "approach", distanceNm: 12 } },
        { callsign: "DAL482", flight: "arrival", runway: "24R", gate: "B11", start: { kind: "approach", distanceNm: 12 } },
      ],
      crossing,
    );
    expect(issue(sim, "WJA302", "CLEARED_TAKEOFF").status).toBe("accepted");
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND")).toMatchObject({ status: "rejected", code: "CROSSING_RUNWAY_IN_USE" });
    expect(issue(sim, "DAL482", "CLEARED_TO_LAND").status).toBe("accepted");
    // Once the departure is airborne the crossing runway is free again.
    sim.run(150);
    expect(eventsOf(sim, "aircraft.airborne")).toHaveLength(1);
    expect(sim.get("WJA302")!.phase).toBe("departure");
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND").status).toBe("accepted");
  });

  it("does not let a taxi crossing of one runway block the runway it crosses", () => {
    const sim = pearson(
      [
        { callsign: "ACA214", flight: "arrival", runway: "23", gate: "141", start: { kind: "approach", distanceNm: 12 } },
        { callsign: "WJA302", flight: "departure", runway: "15L", start: { kind: "holding_short" } },
      ],
      crossing,
    );
    expect(issue(sim, "WJA302", "LINE_UP_AND_WAIT").status).toBe("accepted");
    sim.run(90);
    expect(sim.get("WJA302")!.phase).toBe("line_up");
    expect(issue(sim, "ACA214", "CLEARED_TO_LAND").status).toBe("accepted");
  });
});

describe("taxi routes never meet head-on", () => {
  // Schematic layout. POE245 taxis south down taxiway J (J_T3 -> D_J) on its way to runway 24L.
  // ROU1861 starts on taxiway D, bound for gate B11, and the short way there is north up J.
  const pair: SpawnSpec[] = [
    { callsign: "POE245", flight: "departure", runway: "24L", start: { kind: "taxiing", from: "J_T3" } },
    { callsign: "ROU1861", flight: "arrival", runway: "24R", gate: "B11", start: { kind: "taxiing", from: "D_E" } },
  ];

  it("refuses a route that runs against another aircraft's cleared route", () => {
    const sim = sandbox(pair);
    sim.step();
    expect(sim.get("POE245")!.route.slice(0, 2)).toEqual(["J_T3", "D_J"]);
    const res = issue(sim, "ROU1861", "TAXI", { gate: "B11", route: ["D_D4", "D_J", "J_T3", "L3_1580", "G_B11"] });
    expect(res).toMatchObject({ status: "rejected", code: "TAXI_ROUTE_CONFLICT" });
    expect(res.message).toMatch(/POE245/);
  });

  it("finds another way round when one exists", () => {
    const sim = sandbox(pair);
    sim.step();
    const res = issue(sim, "ROU1861", "TAXI", { gate: "B11" }) as { status: string; clearanceId?: string };
    expect(res.status).toBe("accepted");
    const route = sim.clearances.get(res.clearanceId!)!.route!;
    expect(route.includes("J_T3"), route.join(" ")).toBe(false);
    expect(route[route.length - 1]).toBe("G_B11");
  });

  it("clears the same route once the other aircraft has gone by", () => {
    const sim = sandbox(pair);
    sim.step();
    expect(issue(sim, "ROU1861", "HOLD_POSITION").status).toBe("accepted");
    sim.run(150);
    const other = sim.get("POE245")!;
    expect(other.currentWaypointIndex, "POE245 has left taxiway J").toBeGreaterThan(other.route.indexOf("D_J"));
    expect(issue(sim, "ROU1861", "TAXI", { gate: "B11", route: ["D_D4", "D_J", "J_T3", "L3_1580", "G_B11"] }).status).toBe("accepted");
  });

  it("does not let two aircraft push back onto the same piece of apron", () => {
    const sim = pearson([
      { callsign: "ACA101", flight: "departure", runway: "23", gate: "131", start: { kind: "gate" }, readyInSec: 1 },
      { callsign: "WJA202", flight: "departure", runway: "23", gate: "133", start: { kind: "gate" }, readyInSec: 1 },
    ]);
    expect(issue(sim, "ACA101", "PUSHBACK").status).toBe("accepted");
    expect(issue(sim, "WJA202", "PUSHBACK")).toMatchObject({ status: "rejected", code: "APRON_BLOCKED" });
  });

  it("holds a pushback while another aircraft is cleared to taxi behind the gate", () => {
    // The arrival's way in to gate 135 runs along the taxilane behind several other gates.
    const wayIn = g.shortestPath("X.204", g.gates.get("135")!.id)!.path;
    const passed = [...g.gates.values()].find((n) => n.gate !== "135" && wayIn.includes(n.pushbackNode!));
    expect(passed, "a gate whose push spot lies on the arrival's route").toBeDefined();
    const sim = pearson([
      { callsign: "ACA101", flight: "departure", runway: "23", gate: passed!.gate, start: { kind: "gate" }, readyInSec: 1 },
      { callsign: "ROU1861", flight: "arrival", runway: "23", gate: "135", start: { kind: "taxiing", from: "X.204" } },
    ]);
    sim.step();
    expect(issue(sim, "ACA101", "PUSHBACK")).toMatchObject({ status: "rejected", code: "APRON_BLOCKED" });
    // Once the arrival is parked, the pushback is approved.
    sim.run(600);
    expect(sim.get("ROU1861")!.phase).toBe("at_gate");
    expect(issue(sim, "ACA101", "PUSHBACK").status).toBe("accepted");
  });
});

describe("continuous traffic on the real layout", () => {
  it.each([8])("keeps 12 aircraft moving for 40 minutes on seed %i", (seed) => {
    const sim = createSimulation({ ...GUIDED_DEMO, seed }, { strict: true });
    const { run } = withBaseline(sim);
    const airlines = ["ACA", "WJA", "DAL", "UAL", "JZA", "POE"];
    let n = 0;
    let step = 0;
    let longestBlock = 0;
    const close = new Set<string>();
    run(40 * 60, () => {
      assertRunwayInvariants(sim);
      step++;
      for (const ac of sim.aircraft.values()) {
        if (ac.blockedSince !== undefined) longestBlock = Math.max(longestBlock, sim.time - ac.blockedSince);
      }
      if (step % 10 === 0) for (const c of tooClose(sim)) close.add(c.split(" ")[0]);
      if (step % 450 === 0 && sim.aircraft.size < 12) {
        const callsign = `${airlines[n % airlines.length]}${500 + n}`;
        const arrival = n % 2 === 0;
        n++;
        sim.dispatch({
          type: "aircraft.spawn",
          spec: arrival
            ? { callsign, flight: "arrival", runway: n % 4 === 1 ? "23" : "24R", start: { kind: "approach", distanceNm: 14 } }
            : { callsign, flight: "departure", runway: n % 4 === 2 ? "23" : "24L", start: { kind: "gate" }, readyInSec: 15 },
        });
      }
      if (step % 600 === 0) {
        for (const ac of [...sim.aircraft.values()]) {
          if (ac.flightComplete && sim.time - ac.phaseSince > 120) sim.dispatch({ type: "aircraft.remove", aircraftId: ac.id });
        }
      }
    });
    expect(sim.stats.departed + sim.stats.arrived, "movements").toBeGreaterThan(15);
    // Queueing behind an aircraft that is waiting for the runway is normal; sitting for ten minutes is a standoff.
    expect(longestBlock, "longest time any aircraft was physically blocked").toBeLessThan(600);
    expect([...close]).toEqual([]);
  });
});
