import { describe, expect, it } from "vitest";
import { AirportGraph, createSchematicGraph as createCyyzGraph } from "../src";

const g = createCyyzGraph();

describe("schematic airport graph", () => {
  it("passes its own structural validation", () => {
    expect(g.validate()).toEqual([]);
  });

  it("has Pearson's five runways at their real lengths", () => {
    const lengths = Object.fromEntries([...g.runways.values()].map((r) => [r.id, Math.round(r.lengthM)]));
    expect(lengths).toEqual({
      "05/23": 3389,
      "06L/24R": 2956,
      "06R/24L": 2743,
      "15L/33R": 3368,
      "15R/33L": 2770,
    });
  });

  it("resolves runway designators however they are written", () => {
    expect(g.runwayEnd("5")?.end.designator).toBe("05");
    expect(g.runwayEnd("runway 24r")?.end.designator).toBe("24R");
    expect(g.physicalRunway("23")?.id).toBe("05/23");
    expect(g.physicalRunway("06L/24R")?.id).toBe("06L/24R");
    expect(g.runwayEnd("99")).toBeUndefined();
  });

  it("routes every gate to every runway end without taxiing along a runway", () => {
    for (const gate of g.gates.values()) {
      for (const rw of g.runways.values()) {
        for (const end of rw.ends) {
          const res = g.shortestPath(gate.pushbackNode!, g.departureHolds(end.designator));
          expect(res, `${gate.gate} -> ${end.designator}`).not.toBeNull();
          expect(g.validatePath(res!.path)).toBeNull();
          for (let i = 1; i < res!.path.length; i++) {
            expect(g.edgeBetween(res!.path[i - 1], res!.path[i])!.kind).not.toBe("runway");
          }
        }
      }
    }
  });

  it("reaches the outer south runway only by crossing the inner one", () => {
    const res = g.shortestPath("L3_1340", g.departureHolds("24L"))!;
    expect(g.crossings(res.path)).toEqual(["06L/24R"]);
    expect(g.crossings(g.shortestPath("L1_600", g.departureHolds("23"))!.path)).toEqual([]);
  });

  it("routes around a closed taxiway", () => {
    const open = g.shortestPath("C_T1", g.departureHolds("23"))!;
    const closed = new Set([AirportGraph.edgeId("C_T1", "A_C")]);
    const detour = g.shortestPath("C_T1", g.departureHolds("23"), { closedEdges: closed })!;
    expect(detour.path).not.toEqual(open.path);
    expect(detour.lengthM).toBeGreaterThan(open.lengthM);
    expect(g.validatePath(detour.path, closed)).toBeNull();
    expect(g.validatePath(open.path, closed)).toMatch(/closed/);
  });

  it("rejects routes that are not connected or that use a runway as a taxiway", () => {
    expect(g.validatePath(["C_T1", "A_A6"])).toMatch(/not connected/);
    expect(g.validatePath(["RW0523_A1", "RW0523_A2"])).toMatch(/runway/);
  });

  it("names the taxiways along a route", () => {
    const res = g.shortestPath("C_T1", g.departureHolds("23"))!;
    expect(g.viaNames(res.path)).toEqual(["C", "A", "A6"]);
  });
});
