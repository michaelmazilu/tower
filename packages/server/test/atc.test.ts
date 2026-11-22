import { describe, expect, it, vi } from "vitest";
import type { DecisionEvent, ToolResult } from "@towerai/core";
import { SimHost, type HostOptions } from "../src/host";
import { ElevenLabsTower } from "../src/atc/elevenLabs";
import type { TowerAgent, TurnContext } from "../src/atc/controller";

function hostWith(agent: TowerAgent, options: Partial<HostOptions> = {}) {
  return new SimHost({
    scenarioId: "guided-demo", controller: "elevenlabs", createAgent: () => agent,
    speed: 1, dataDir: null, radio: { controller: "simulated", pilots: "simulated" }, ...options,
  });
}

type HeardRequest = { requestId: string; aircraftId: string; runway: string | null; type: string };
const grants: Record<string, string> = {
  PUSHBACK: "PUSHBACK", TAXI: "TAXI", LANDING: "CLEARED_TO_LAND", TAKEOFF: "CLEARED_TAKEOFF", CROSS: "CROSS_RUNWAY",
};

// Deterministic model double. It sees only the briefing and tool results.
const model: TowerAgent = {
  async review({ briefing, call }) {
    if (!briefing.airport.ok) throw new Error("Missing observation.");
    const requests = briefing.airport.result.pendingRequests as HeardRequest[];
    for (const r of requests) {
      const { aircraftId, requestId, runway } = r;
      if (r.type === "TAXI") call("get_taxi_route", { aircraftId });
      else if (runway) call("get_runway_status", { runway });
      call("issue_clearance", {
        aircraftId, requestId, clearanceType: grants[r.type], ...(runway ? { runway } : {}),
        reason: "Serving the oldest eligible request at this priority.",
      });
    }
    return "Reviewed the pending requests.";
  },
};

describe("tower intelligence integration", () => {
  it("completes all eight guided flights through the gateway and records the evidence and outcomes", async () => {
    const host = hostWith(model);
    for (let i = 0; i < 900; i++) {
      host.stepOnce(10);
      await Promise.resolve();
    }
    expect(host.sim.stats).toMatchObject({ departed: 5, arrived: 3 });
    expect(host.verifyReplay().match).toBe(true);
    const decisions = host.sim.events.filter((e): e is DecisionEvent => e.type === "controller.decision");
    const accepted = decisions.find((e) => e.data.result.ok && e.data.result.result.status === "accepted")!;
    expect(accepted.data.observationSeqs.length).toBeGreaterThan(1);
    const obs = host.sim.events[accepted.data.observationSeqs[0] - 1];
    expect(obs).toMatchObject({ type: "controller.observation", data: {
      turnId: accepted.data.turnId, tool: "get_airport_state", result: { result: { aircraft: expect.any(Array) } },
    } });
    expect(decisions.some((e) => e.data.result.ok && e.data.result.result.status === "rejected")).toBe(true);
    const issued = [...host.sim.clearances.values()].filter((c) => c.issuedBy !== "scenario");
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every((c) => c.issuedBy === "elevenlabs-tower")).toBe(true);
    host.stop();
  });

  it("hands the accepted instruction to external voice and waits for transmission and pilot readback", async () => {
    const host = hostWith(model, { scenarioId: "sandbox", radio: { controller: "external", pilots: "simulated" } });
    host.dispatch({ type: "aircraft.spawn", spec: { callsign: "TST1", flight: "departure", runway: "23", start: { kind: "holding_short" } } });
    for (let i = 0; i < 15; i++) {
      host.stepOnce(10);
      await Promise.resolve();
      if (host.sim.radio.active?.from === "TOWER") break;
    }
    const tx = host.sim.radio.active!;
    expect(tx).toMatchObject({ from: "TOWER", mode: "external", kind: "clearance" });
    expect(host.sim.get("TST1")?.phase).toBe("holding_short");
    host.dispatch({ type: "radio.tx_complete", transmissionId: tx.id });
    expect(host.sim.get("TST1")?.phase).toBe("holding_short");
    host.stepOnce(250);
    expect(host.sim.events).toContainEqual(expect.objectContaining({ type: "clearance.activated", cause: { kind: "clearance", clearanceId: tx.clearanceId } }));
    host.stop();
  });

  it.each(["pause", "reset", "none", "stop"])("ignores a late model reply after %s", async (operation) => {
    let resolve!: (text: string) => void;
    let turn!: TurnContext;
    const host = hostWith({ review(ctx) { turn = ctx; return new Promise((r) => { resolve = r; }); } });
    host.stepOnce(400);
    const original = host.sim;
    if (operation === "pause") host.paused = true;
    if (operation === "reset") host.reset();
    if (operation === "none") host.setController("none");
    if (operation === "stop") host.stop();
    expect(turn.signal.aborted).toBe(true);
    expect(() => turn.call("set_aircraft_priority", { aircraftId: "ACA214", priority: "urgent", reason: "late" })).toThrow();
    resolve("late response");
    await Promise.resolve();
    expect(original.events.some((e) => e.type === "controller.review_completed")).toBe(false);
    expect(host.sim.get("ACA214")!.priority).toBe("normal");
    host.stop();
  });

  it("coalesces new emergencies during a turn and rechecks their current state", async () => {
    let resolve!: (text: string) => void;
    const turns: TurnContext[] = [];
    const host = hostWith({ review(ctx) { turns.push(ctx); return new Promise((r) => { resolve = r; }); } });
    host.stepOnce(100);
    host.dispatch({ type: "emergency.set_mode", mode: "manual" });
    host.dispatch({ type: "emergency.trigger", emergencyType: "engine_failure", aircraftId: "ACA214" });
    host.stepOnce(40);
    expect(turns).toHaveLength(1);
    resolve("Done");
    await Promise.resolve();
    host.stepOnce();
    expect(turns[1].briefing.triggers.some((e) => e.type === "emergency.declared")).toBe(true);
    expect(turns[1].briefing.airport).toMatchObject({ result: {
      emergencies: [expect.objectContaining({ type: "engine_failure", aircraftId: "ACA214" })],
    } });
    resolve("Emergency observed");
    await Promise.resolve();
    host.stop();
  });

  it("backs off on provider failure and retries pending traffic with fresh observations", async () => {
    vi.useFakeTimers();
    try {
      const review = vi.fn<TowerAgent["review"]>().mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValue("Waiting");
      const host = hostWith({ review });
      host.stepOnce(400);
      await Promise.resolve();
      host.stepOnce(400);
      expect(review).toHaveBeenCalledTimes(1);
      expect(host.sim.events).toContainEqual(expect.objectContaining({ type: "controller.error" }));
      vi.advanceTimersByTime(2100);
      host.stepOnce();
      expect(review).toHaveBeenCalledTimes(2);
      expect([...host.sim.clearances.values()].every((c) => c.issuedBy === "scenario")).toBe(true);
      await Promise.resolve();
      host.stop();
    } finally { vi.useRealTimers(); }
  });
});

describe("ElevenLabs text tool protocol", () => {
  it("creates an agent conversation, answers repeated tool calls once and returns the actual rejection to the model", async () => {
    const action = { type: "client_tool_call", tool_call_id: "call-1", tool_name: "issue_clearance", parameters: { runway: "23" } };
    const replies = [
      { conversation_id: "conv-1" },
      { status: "requires_action", required_actions: [action] },
      { status: "requires_action", required_actions: [action] },
      { status: "completed", output: [{ text: "Waiting for the arrival." }] },
      { status: "completed", output: [{ text: "Traffic reviewed." }] },
    ];
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const agent = new ElevenLabsTower("tower-1", "test-key", async (url, init) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(replies.shift());
    });
    const rejection: ToolResult = { ok: true, tool: "issue_clearance", result: { status: "rejected", code: "RUNWAY_RESERVED" } };
    const context = {
      briefing: { turnId: "ATC-1", triggers: [], airport: { ok: true, tool: "get_airport_state", result: {} } as ToolResult },
      call: vi.fn(() => rejection), signal: new AbortController().signal,
    };
    expect(await agent.review(context)).toBe("Waiting for the arrival.");
    expect(await agent.review(context)).toBe("Traffic reviewed.");
    expect(context.call).toHaveBeenCalledTimes(1);
    expect(posted[0].body).toEqual({ agent: { type: "persisted", agent_id: "tower-1" } });
    expect(posted.slice(1).every((p) => p.url.endsWith("/conv-1/messages"))).toBe(true);
    expect(posted[2].body.input).toEqual([{ type: "client_tool_result", tool_call_id: "call-1", is_error: false, result: JSON.stringify(rejection) }]);
  });
});
