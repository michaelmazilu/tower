import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SimHost } from "../src/host";

const dir = mkdtempSync(join(tmpdir(), "towerai-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const make = (dataDir: string | null = null) =>
  new SimHost({
    scenarioId: "guided-demo",
    controller: "baseline",
    radio: { controller: "simulated", pilots: "simulated" },
    dataDir,
    speed: 1,
  });

describe("SimHost", () => {
  it("runs the guided demo and can prove the run is reproducible from its command log", () => {
    const host = make();
    host.stepOnce(9000); // fifteen simulated minutes
    expect(host.sim.stats.departed).toBeGreaterThanOrEqual(3);
    expect(host.verifyReplay()).toMatchObject({ match: true, tick: 9000 });
    const decision = host.sim.events.find((e) => e.type === "controller.decision")!;
    expect(decision.data.caller).toBe("baseline-controller");
    const [observedSeq] = decision.data.observationSeqs as number[];
    expect(host.sim.events[observedSeq - 1].type).toBe("controller.observation");
  });

  it("restores a clean initial state on reset", () => {
    const host = make();
    const fresh = host.sim.stateHash();
    host.stepOnce(3000);
    host.dispatch({ type: "aircraft.spawn", spec: { callsign: "FDX9", flight: "arrival", runway: "24R", start: { kind: "approach", distanceNm: 9 } } });
    expect(host.sim.stateHash()).not.toBe(fresh);
    const before = host.runId;
    expect(host.reset()).toMatchObject({ ok: true });
    expect(host.runId).not.toBe(before);
    expect(host.sim.stateHash()).toBe(fresh);
    expect(host.sim.aircraft.size).toBe(8);
    // The gateway now talks to the new simulation, not the old one.
    expect(host.gateway.call("get_airport_state", {})).toMatchObject({ ok: true, result: { simTimeSec: 0 } });
  });

  it("leaves requests unanswered when no controller is attached", () => {
    const host = make();
    host.setController("none");
    host.stepOnce(1200);
    expect(host.sim.stats.clearancesIssued).toBe(0);
    const pending = host.gateway.call("get_pending_requests", {});
    expect(pending.ok && (pending.result.requests as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it("refuses an unknown scenario and clamps the speed", () => {
    const host = make();
    expect(host.reset("nope")).toMatchObject({ ok: false });
    expect(host.reset("constructor")).toMatchObject({ ok: false });
    expect(host.setSpeed(1000)).toBe(16);
    expect(host.setSpeed(0)).toBe(0.25);
  });

  it("records the scenario, every event and every command to disk", async () => {
    const host = make(dir);
    host.stepOnce(1500);
    host.stop();
    await new Promise((r) => setTimeout(r, 100));
    const run = join(dir, readdirSync(dir)[0]);
    const meta = JSON.parse(readFileSync(join(run, "meta.json"), "utf8"));
    expect(meta.scenario.id).toBe("guided-demo");
    const events = readFileSync(join(run, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.length).toBe(host.sim.events.length);
    expect(events.map((e) => e.seq)).toEqual(host.sim.events.map((e) => e.seq));
    const commands = readFileSync(join(run, "commands.jsonl"), "utf8").trim().split("\n");
    expect(commands.length).toBe(host.sim.commands.length);
  });
});
