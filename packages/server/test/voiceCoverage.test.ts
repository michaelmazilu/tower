import { readFileSync } from "node:fs";
import type { WorldRecording } from "@towerai/contracts";
import { expect, test } from "vitest";
import { createCockpit } from "../src/cockpit";
import { audioFile, voiceFor } from "../src/voice/voice";
import { worldLine } from "../src/voice/worldVoice";

const world = JSON.parse(readFileSync(new URL("../../world/data/world.json", import.meta.url), "utf8")) as WorldRecording;

test("every line World can say has a recording, the supervisor's included", () => {
  const silent = world.flights.flatMap(({ summary, messages }) =>
    messages
      .filter((m) => m.text && !(m.decision?.verdict === "rejected" && m.durationS === 0))
      .filter((m) => !m.audioUrl || !audioFile(m.audioUrl.split("/").pop()!))
      .map((m) => `${summary.id} ${m.t} ${m.speaker}`),
  );
  expect(silent).toEqual([]);
});

test("the supervisor sounds like neither the controller nor any pilot", () => {
  const supervisor = voiceFor("standIn", "Supervisor").id;
  expect(supervisor).not.toBe(voiceFor("controller", "").id);
  for (const { summary } of world.flights) expect(supervisor).not.toBe(voiceFor("pilot", summary.id).id);
});

test("the cockpit plays recorded voice with no key, for answers and for calls the tower starts", async () => {
  const cockpit = createCockpit();
  cockpit.advance(1);
  expect((await cockpit.say("Oh no, we're crashing!")).exchange?.audioUrl).toBeTruthy();
  await cockpit.say("Everything is fine.");
  await cockpit.say(cockpit.state().coach.trySaying[0]!);
  await new Promise((done) => setImmediate(done));
  expect(cockpit.state().exchanges.filter((e) => !e.audioUrl).map((e) => e.said)).toEqual([]);
});

test("no two people on one flight's radio share a voice", () => {
  for (const { summary, messages } of world.flights) {
    const people = new Map<string, string>();
    for (const m of messages) {
      const line = worldLine(summary.id, m);
      const who = m.from === "pilot" ? "pilot" : m.speaker.endsWith("(simulated)") || m.from === "operator" ? m.speaker : "controller";
      people.set(who, voiceFor(line.role, line.speaker).id);
    }
    expect(new Set(people.values()).size, summary.id).toBe(people.size);
  }
});
