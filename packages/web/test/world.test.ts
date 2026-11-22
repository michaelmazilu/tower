import type { FlightRecord, WorldRecording } from "@towerai/contracts";
import { describe, expect, it } from "vitest";
import { indexWorld, poseAt, statsAt } from "../src/world/data";

const sample = (t: number, lateralNm: number, verticalFt: number, otherFlightId: string) =>
  ({ t, lateralNm, verticalFt, otherFlightId, requiredNm: 5, requiredFt: 1000 });
const flight = (id: string, over: Partial<FlightRecord>) =>
  ({ summary: { id }, startT: 0, endT: 100, track: [[0, 10, 179, 1000, 400, 350, 0], [100, 10, -179, 1000, 400, 10, 0]],
    messages: [], markers: [], riskSeries: [], separation: [], ...over }) as FlightRecord;

const world = indexWorld({
  background: [],
  flights: [
    flight("A", {
      markers: [{ t: 10, kind: "conflict", label: "", otherFlightId: "B" }, { t: 60, kind: "resolved", label: "", otherFlightId: "B" }],
      separation: [sample(20, 4, 900, "B"), sample(30, 4, 800, "B"), sample(40, 2, 1000, "B")],
    }),
    flight("B", {
      markers: [{ t: 10, kind: "conflict", label: "", otherFlightId: "A" }, { t: 60, kind: "resolved", label: "", otherFlightId: "A" }],
      separation: [sample(20, 4, 900, "A"), sample(30, 4, 800, "A"), sample(40, 2, 1000, "A")],
    }),
  ],
} as unknown as WorldRecording);

describe("world totals at the playhead", () => {
  it("counts a pair once, and only what has happened by then", () => {
    expect(statsAt(world, 15)).toMatchObject({ conflicts: 1, resolved: 0, losses: 0 });
    expect(statsAt(world, 100)).toMatchObject({ conflicts: 1, resolved: 1, losses: 1 });
  });

  it("flies the short way over the antimeridian", () => {
    expect(Math.abs(poseAt(world.flights[0]!, 50).lon)).toBe(180);
  });
});
