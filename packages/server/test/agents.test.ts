// Lean by instruction. No network: every agent here is a fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { BaselineController, SCENARIOS, ToolGateway, createSimulation } from "@towerai/core";
import { CreditGuard, ElevenLabs, SpendLimitError } from "../src/agents/client";
import { createAskAgent } from "../src/agents/ask";
import { attachPilots, type PilotTurn } from "../src/agents/pilots";
import { parseChoice } from "../src/agents/decide";
import { audioFile } from "../src/voice/voice";

const dir = mkdtempSync(join(tmpdir(), "towerai-agents-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ids = { llm: "test", tower: "t", controller: "c", pilot: "p" };

function fakeApi(reply: () => string, meter: () => number = () => 0) {
  const api = new ElevenLabs("test-key", 5000, async (url) => {
    const path = String(url);
    if (path.endsWith("/subscription")) return Response.json({ character_count: meter() });
    if (path.endsWith("/messages")) return Response.json({ status: "completed", output: [{ text: reply() }] });
    return Response.json({ conversation_id: "conv" });
  });
  Object.assign(api, { guard: new CreditGuard(async () => meter(), 5000, join(dir, `${Math.random()}.json`)) });
  return api;
}

async function fly(enabled: boolean, reply: () => string) {
  const sim = createSimulation(SCENARIOS["guided-demo-schematic"], { radio: { controller: "simulated", pilots: "simulated" } });
  const rules = new BaselineController(sim, new ToolGateway(() => sim)).attach();
  const turns: PilotTurn[] = [];
  const pilots = attachPilots(sim, { enabled, api: fakeApi(reply), ids, maxCalls: 8, onTurn: (t) => turns.push(t) });
  for (let i = 0; i < 9000; i++) {
    sim.step();
    rules.update();
    if (i % 10 === 0) await pilots.update();
  }
  pilots.detach();
  return { sim, turns, pilots };
}

test("spend is refused past the cap, before a check, and when the meter fails", async () => {
  const file = join(dir, "usage.json");
  let meter: number | Error = 90;
  const guard = new CreditGuard(async () => { if (meter instanceof Error) throw meter; return meter; }, 200, file);
  assert.throws(() => guard.reserve(1), SpendLimitError);
  await guard.refresh();
  guard.reserve(100);
  assert.throws(() => guard.reserve(11), SpendLimitError);
  meter = 20; // the account's meter lags and has been seen to go backwards
  assert.equal((await guard.refresh()).estimate, 190);
  meter = new Error("down");
  await assert.rejects(guard.refresh());
  assert.throws(() => guard.reserve(1), SpendLimitError);
});

test("an agent can only pick an offered option, and is off by default", async () => {
  const options = [{ id: "a", action: "x", text: "ACA214, hold position." }];
  const prompt = { role: "pilot" as const, flightId: "ACA214", speaker: "ACA214", position: "tower" as const, context: [], history: [], options };
  assert.throws(() => parseChoice('{"id":"descend","reason":"made up"}', options));
  const api = fakeApi(() => '{"id":"a","reason":"safe","text":"descend now"}');
  assert.equal(await createAskAgent({ api, ids })(prompt), null);
  const reply = await createAskAgent({ enabled: true, voice: false, api, ids })(prompt);
  assert.equal(reply?.optionId, "a");
  assert.equal(reply?.text, undefined);
});

test("AI pilots fly the demo, then hand to rules at the budget", async () => {
  const { sim, turns, pilots } = await fly(true, () => '{"id":"say","reason":"as cleared"}');
  assert.deepEqual([sim.stats.departed, sim.stats.arrived], [5, 3]);
  assert.equal(turns.filter((t) => t.brain === "llm").length, 8);
  assert.equal(pilots.calls(), 8);
});

test("a broken agent leaves the demo to the rules", async () => {
  const { sim, turns } = await fly(true, () => "not json");
  assert.deepEqual([sim.stats.departed, sim.stats.arrived], [5, 3]);
  assert.ok(turns.length > 0 && turns.every((t) => t.brain === "rules"));
});

test("audio paths cannot leave the cache", () => {
  for (const name of ["../../.env", "manifest.json", "a".repeat(24)]) assert.equal(audioFile(name), null);
});
