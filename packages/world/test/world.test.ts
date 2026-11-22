import { describe, expect, it } from "vitest";
import { kwikdist } from "../src/bluesky/geo";
import { near, overflight } from "../src/flights";
import { Sim, simulateWorld, startServices } from "../src/index";

const run = simulateWorld({ seed: 7 });

/** Two aircraft on crossing tracks at one level, with or without the separation service. */
async function crossing(controlled: boolean) {
  const sim = new Sim({ seed: 1, durationS: 780 });
  const point = near("CYYZ", 20, 190);
  const spec = { from: "CYUL", to: "CYYC", type: "B789", port: "CYYZ" } as const;
  overflight(sim, { ...spec, id: "ACA860" }, point, 290, 600, 360);
  overflight(sim, { ...spec, id: "DAL156" }, point, 38, 600, 360);
  if (controlled) startServices(sim);
  await sim.run();
  return sim;
}

describe("world recording", () => {
  it("is deterministic for a seed", async () => {
    expect(JSON.stringify((await simulateWorld({ seed: 7 })).recording)).toBe(JSON.stringify((await run).recording));
  });

  it("resolves a conflict that would otherwise lose separation", async () => {
    expect((await crossing(false)).stats.lossesOfSeparation).toBe(1);
    const sim = await crossing(true);
    expect(sim.stats.lossesOfSeparation).toBe(0);
    expect(sim.effects.some((e) => e.action === "turn_heading")).toBe(true);
    const [a, b] = sim.records();
    let nearest = Infinity;
    for (const [i, p] of a!.track.entries()) {
      const q = b!.track[i]!;
      if (Math.abs(p[3] - q[3]) < 990) nearest = Math.min(nearest, kwikdist(p[1], p[2], q[1], q[2]));
    }
    expect(nearest).toBeGreaterThanOrEqual(4.95);
    expect((await run).recording.stats.lossesOfSeparation).toBe(0);
  });

  it("changes nothing before the clearance is read back", async () => {
    const { recording, effects } = await run;
    expect(effects.length).toBeGreaterThan(100);
    for (const e of effects) {
      const messages = recording.flights.find((f) => f.summary.id === e.flightId)!.messages;
      const authority = messages.find((m) => m.id === e.messageId)!;
      expect(authority.from).toBe("pilot");
      expect(messages.find((m) => m.id === authority.replyTo)?.decision ?? null).not.toBeNull();
      expect(e.t).toBeGreaterThanOrEqual(authority.t + authority.durationS - 1e-6);
    }
    const sim = await crossing(true);
    const turned = sim.effects.find((e) => e.action === "turn_heading")!;
    const track = sim.records().find((f) => f.summary.id === turned.flightId)!.track;
    const before = track.filter((p) => p[0] <= turned.t);
    expect(Math.max(...before.map((p) => p[5])) - Math.min(...before.map((p) => p[5]))).toBeLessThanOrEqual(2);
  });

  it("falls back to rules when the agent fails", async () => {
    let calls = 0;
    const { recording } = await simulateWorld({
      seed: 7,
      maxAgentCalls: 4,
      ask: async () => {
        if (++calls % 2) throw new Error("offline");
        return null;
      },
    });
    expect(calls).toBe(4);
    expect(recording.flights.every((f) => f.messages.every((m) => m.brain === "rules"))).toBe(true);
    expect(recording.stats.lossesOfSeparation).toBe(0);
  });
});
