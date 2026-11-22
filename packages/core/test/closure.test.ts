import { expect, it } from "vitest";
import { SCHEMATIC_SANDBOX, createSimulation } from "../src";
import { issue, withBaseline } from "./helpers";

it("a closed runway moves its traffic instead of stranding it in go-arounds", () => {
  const sim = createSimulation(
    {
      ...SCHEMATIC_SANDBOX,
      aircraft: [
        { callsign: "ACA100", flight: "arrival", runway: "24R", start: { kind: "approach", distanceNm: 3 } },
        { callsign: "DAL200", flight: "arrival", runway: "24R", start: { kind: "approach", distanceNm: 14 } },
      ],
    },
    { strict: true },
  );
  const { run } = withBaseline(sim);
  issue(sim, "ACA100", "CLEARED_TO_LAND");
  run(14);
  expect(sim.get("ACA100")!.landingCleared).toBe(true);

  expect(sim.dispatch({ type: "runways.set_active", arrivals: ["23"], departures: ["23"], closed: ["06L/24R"] }).ok).toBe(true);
  // Permission goes at once. The runway changes only when the change has been read back.
  expect(sim.get("ACA100")).toMatchObject({ assignedRunway: "24R", landingCleared: false });
  expect(sim.get("DAL200")).toMatchObject({ assignedRunway: "24R" });
  let moved = false;
  for (let i = 0; i < 1500 && !moved; i++) {
    run(0.1);
    moved = sim.get("DAL200")!.assignedRunway === "23";
    const acknowledged = sim.events.some((e) => e.type === "clearance.acknowledged" && e.aircraftId === "DAL200" && e.data.clearanceType === "RUNWAY_CHANGE");
    expect(moved).toBe(acknowledged);
  }
  expect(moved).toBe(true);
  run(25 * 60);
  expect(sim.stats).toMatchObject({ arrived: 2, goArounds: 1 });
});
