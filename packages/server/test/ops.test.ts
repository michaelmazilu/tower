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

  it("briefs the person before takeover, sends only what was shown, and says what the agent picks up", () => {
    const host = demo();
    host.stepOnce(450);
    const brief = () => host.opsState().flights.find((f) => f.id === "DLH471")!.brief!;
    const before = brief();
    expect(before.problem).toBe("Passenger medical emergency");
    expect(before.context).toMatch(/^Landing on runway 23, \d+ miles out, about \d+ min from touchdown\.$/);
    expect(before.deadline?.then).toBe("it has to abort the landing");
    expect(before.deadline!.inS).toBeGreaterThan(60);
    expect(before.now).toEqual(["The agent is still handling DLH471 until you take over.", "It is not cleared to land yet."]);
    expect(before.recommend.map((r) => r.label)).toEqual(["Give it priority to land on 23", "Call paramedics to gate 173"]);
    expect(before.onHandback).toBeNull();

    // Approval is for what was on screen, nothing else.
    expect(host.ops.accept("DLH471", ["ALERT_MEDICAL"]).ok).toBe(false);
    expect(host.sim.get("DLH471")!.humanControl).toBeFalsy();

    const accepted = host.ops.accept("DLH471", ["PRIORITY_LANDING", "ALERT_MEDICAL"]);
    expect(accepted).toMatchObject({ ok: true, message: expect.stringMatching(/^You have DLH471\. Sent: .*number one.*Paramedics/) });
    const after = brief();
    expect(after.recommend).toEqual([]);
    expect(after.now).toEqual([
      "You are in control. The agent will not talk to DLH471.",
      "It has priority to land on runway 23.",
      "Paramedics are on their way to gate 173.",
      "It is not cleared to land yet.",
    ]);
    expect(after.onHandback).toBe("The agent will clear it to land on 23 ahead of other traffic once the runway is free.");
    expect(host.ops.handback("DLH471").message).toBe(`The agent has DLH471. ${after.onHandback}`);
    expect(host.opsState().flights.find((f) => f.id === "DLH471")!.brief).toBeUndefined();
    expect(host.verifyReplay().match).toBe(true);
  });

  it("says a runway conflict in plain words, and that the agent is already on it", () => {
    const host = demo();
    host.stepOnce(145);
    const brief = (id: string) => host.opsState().flights.find((f) => f.id === id)!.brief!;
    expect(brief("WJA302")).toMatchObject({
      problem: "On runway 23 without permission",
      context: "ACA214 is coming in to land on that runway, 2 miles out.",
      agentDoing: { text: "telling WJA302 to stop where it is", cancelledByTakeover: true },
    });
    expect(brief("ACA214")).toMatchObject({
      problem: "Its runway is blocked",
      context: expect.stringMatching(/^WJA302 is on runway 23\. ACA214 is \d+ miles out/),
      agentDoing: { text: "telling ACA214 to abort the landing and climb away" },
    });
    for (const id of ["WJA302", "ACA214"]) expect(JSON.stringify(brief(id))).not.toMatch(/reserved|05\/23|NM/);
  });

  it("never says a departure turning back aborted a landing", () => {
    const host = demo();
    let context: string | undefined;
    for (let i = 0; i < 160 && !context; i++) {
      host.stepOnce(10);
      const ac = host.sim.get("UAL119");
      if (ac?.flags.emergencyReturn && ac.phase === "go_around") context = host.opsState().flights.find((f) => f.id === "UAL119")?.brief?.context;
    }
    expect(context).toMatch(/Turning back to land/);
  });

  it("does not swap the arrival and the aircraft in its way", () => {
    const host = demo();
    host.stepOnce(10);
    const arrival = host.sim.get("DAL482")!;
    const blocker = host.sim.get("UAL119")!;
    host.sim.conflicts.clear();
    host.sim.conflicts.set("test", {
      key: "test", type: "arrival_runway_occupied", severity: "critical", detectedAt: host.sim.time,
      aircraftIds: [arrival.id, blocker.id], runwayId: "06L/24R", description: "test",
    });
    const card = (host.ops as any).runwayConflict(blocker, 1, 1);
    expect(card.context).toMatch(/^DAL482 is coming in to land/);
    expect((host.ops as any).runwayConflict(arrival, 1, 1).context).toMatch(/^UAL119 is on runway/);
  });

  it("warns before handback when help the agent will not call has not been called", () => {
    const host = demo();
    host.stepOnce(450);
    expect(host.ops.takeover("DLH471").message).toBe("You have DLH471.");
    expect(host.opsState().flights.find((f) => f.id === "DLH471")!.brief!.onHandback).toMatch(/will not call paramedics/);
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
