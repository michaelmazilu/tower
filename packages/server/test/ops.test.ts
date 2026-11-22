import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { SimHost } from "../src/host";
import { refusal } from "../src/security";

const demo = (controller: "baseline" | "none" = "baseline") =>
  new SimHost({
    scenarioId: "judge-demo",
    controller,
    radio: { controller: "simulated", pilots: "simulated" },
    dataDir: null,
    speed: 1,
  });

describe("live operations", () => {
  it("opens the judge demo on time, with history, and replays from its commands", () => {
    const host = demo();
    expect(host.opsState().flights.length).toBeGreaterThanOrEqual(14);
    host.stepOnce(250);
    expect(host.opsState().flights.some((f) => f.risk.level === "critical")).toBe(true);
    host.stepOnce(200);
    expect(host.opsState().flights.find((f) => f.id === "DLH471")?.attention).toBe("human_requested");
    host.stepOnce(1350);

    const { alerts, runways } = host.opsState();
    for (const title of [/engine failure/, /Weather/, /closed/, /Collision avoided/]) {
      expect(alerts.map((a) => a.title).join("; ")).toMatch(title);
    }
    expect(alerts.find((a) => /engine failure/.test(a.title))?.detail).toMatch(/fire \+ rescue: standing by/);

    // The mayday is answered at once and the emergency lands ahead of anyone moved to its runway.
    const mayday = host.ops.flight("UAL119")!.messages;
    const call = mayday.find((m) => m.kind === "emergency" && m.from === "pilot")!;
    const answer = mayday.find((m) => m.replyTo === call.id)!;
    expect(answer.decision?.action).toBe("RETURN_TO_LAND");
    expect(answer.t - call.t - call.durationS).toBeLessThan(5);
    const incursion = host.sim.events.find((e) => e.type === "emergency.runway_incursion")!;
    for (const id of ["ACA214", "WJA302"]) {
      const action = host.ops.flight(id)!.messages.find((m) => ["GO_AROUND", "HOLD_POSITION"].includes(m.decision?.action ?? ""))!;
      expect(action.t - incursion.simTime).toBeLessThan(5);
    }
    expect(runways.find((r) => r.id === "06L/24R")?.state).toBe("closed");

    const moved = host.ops.flight("AFR356")!;
    expect(moved.markers.some((m) => m.kind === "closure")).toBe(true);
    expect(moved.track.length).toBeGreaterThanOrEqual(175);
    expect(moved.messages.find((m) => m.kind === "clearance")?.decision).toMatchObject({ verdict: "accepted" });
    const readback = moved.messages.find((m) => m.kind === "readback" && m.replyTo)!;
    expect(moved.messages.some((m) => m.id === readback.replyTo)).toBe(true);
    expect(moved.messages.every((m) => m.brain !== "llm")).toBe(true);
    host.stepOnce(1400);
    const landed = host.sim.events.filter((e) => e.type === "aircraft.touchdown").map((e) => e.aircraftId);
    expect(landed).toContain("UAL119");
    expect(landed).not.toContain("AFR356");
    expect(host.verifyReplay().match).toBe(true);
  });

  it("keeps separation when the operator sends the featured flight around, and never moves a flight a person holds", () => {
    const host = demo();
    host.stepOnce(500);
    expect(host.ops.takeover("DLH471").ok).toBe(true);
    expect(host.ops.instruct("DLH471", { clearanceType: "GO_AROUND", reason: "test" }).ok).toBe(true);
    expect(host.ops.takeover("AFR356").ok).toBe(true);
    host.stepOnce(1000);
    expect(host.sim.closedRunways).toContain("06L/24R");
    expect(host.sim.get("AFR356")!.assignedRunway).toBe("24R");
    expect(host.opsState().alerts.find((a) => a.flightId === "AFR356")).toMatchObject({ level: "critical" });
    expect(host.ops.handback("DLH471").ok).toBe(true);
    host.stepOnce(3500);
    expect(host.sim.events.filter((e) => e.type === "conflict.detected" && e.data.type === "airborne_separation")).toEqual([]);
  });

  it("blocks the agent under human control and wakes it on handback", () => {
    const host = demo("none");
    host.stepOnce(80); // the arrival's request has been heard
    const land = () => host.gateway.call("issue_clearance", { aircraftId: "ACA214", clearanceType: "CLEARED_TO_LAND", reason: "agent" });

    expect(host.ops.takeover("ACA214").ok).toBe(true);
    expect(land()).toMatchObject({ result: { status: "rejected", code: "HUMAN_CONTROL" } });
    expect(host.ops.instruct("UAL119", { clearanceType: "CLEARED_TAKEOFF", reason: "test" }).ok).toBe(false);
    expect(host.ops.instruct("ACA214", { clearanceType: "CLEARED_TAKEOFF", reason: "wrong phase" }).ok).toBe(false);
    expect(host.ops.instruct("ACA214", { clearanceType: "CLEARED_TO_LAND", reason: "operator lands it" }).ok).toBe(true);
    expect([...host.sim.clearances.values()].pop()).toMatchObject({ issuedBy: "human", type: "CLEARED_TO_LAND" });

    expect(host.ops.handback("ACA214").ok).toBe(true);
    expect(host.sim.events.filter((e) => e.type === "control.handback")[0].attention).toBe(true);
    expect(host.verifyReplay().match).toBe(true);
  });

  it("refuses cross-origin changes and keeps the dev proxy working", () => {
    const ask = (host: string, origin?: string) =>
      refusal({ method: "POST", headers: { host, origin } } as IncomingMessage, { host: "127.0.0.1", origins: [] });
    expect(ask("localhost:8787", "http://localhost:8787")).toBeNull();
    expect(ask("localhost:5181", "http://localhost:5181")).toBeNull();
    expect(ask("localhost:8787")).toBeNull();
    for (const origin of ["http://localhost:5173", "https://evil.example", "http://localhost:3000", "null"]) expect(ask("localhost:8787", origin)).not.toBeNull();
    expect(ask("evil.example:8787", "http://evil.example:8787")).not.toBeNull();
  });
});
