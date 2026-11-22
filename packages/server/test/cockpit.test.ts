import { describe, expect, it } from "vitest";
import { createCockpit, type Cockpit } from "../src/cockpit";

const until = (cockpit: Cockpit, done: () => boolean, seconds = 400) => {
  for (let i = 0; i < seconds && !done(); i++) cockpit.advance(1);
  expect(done()).toBe(true);
};
const verdict = async (cockpit: Cockpit, words: string) => (await cockpit.say(words)).exchange?.action?.verdict;

describe("pilot's seat", () => {
  it("checks a crash call against the aircraft, then guides a beginner from the gate off the ground", async () => {
    const cockpit = createCockpit();
    cockpit.advance(1);
    const now = () => cockpit.state();
    expect(now().phase).toBe("at_gate");
    const crash = await cockpit.say("Oh no, we're crashing!");
    expect(crash.exchange?.check?.verdict).toBe("contradicted");
    expect(now().humanCalled).toBe(false);
    await cockpit.say("everything is fine");

    expect(now().stage).toBe("check_in");
    await cockpit.say(now().coach.trySaying[0]!);
    expect(now().stage).toBe("pushback");
    // Each suggested line is enough on its own, and each readback shown passes.
    for (const stage of ["pushback", "taxi", "cross", "takeoff"] as const) {
      until(cockpit, () => now().stage === stage && now().waiting);
      expect(await verdict(cockpit, now().coach.trySaying[0]!)).toBe("accepted");
      if (stage === "taxi") expect(await verdict(cockpit, "taxi to runway two four left")).toBe("rejected");
      if (stage === "takeoff") expect(await verdict(cockpit, "cleared for takeoff runway two three")).toBe("rejected");
      expect(await verdict(cockpit, now().readBack!)).toBe("accepted");
      expect(now().speed).toBeGreaterThan(1);
    }
    until(cockpit, () => now().vitals.altFt > 400);
    expect(now().stage).toBe("climb");
    cockpit.fault("engine_failure", true);
    until(cockpit, () => now().phase === "departure" || now().phase === "go_around");
    cockpit.advance(1);
    expect((await cockpit.say("mayday, our engine failed")).exchange?.check?.verdict).toBe("confirmed");
    expect(now().humanCalled).toBe(true);
  });

  it("stops a taxiing aircraft when the pilot reports danger, and starts it again", async () => {
    const cockpit = createCockpit();
    cockpit.advance(1);
    const now = () => cockpit.state();
    await cockpit.say(now().coach.trySaying[0]!);
    for (const stage of ["pushback", "taxi"]) {
      until(cockpit, () => now().stage === stage && now().waiting);
      await cockpit.say(now().coach.trySaying[0]!);
      await cockpit.say(now().readBack!);
    }
    cockpit.advance(8);
    await cockpit.say("we're crashing");
    cockpit.advance(30);
    expect(now().vitals.gsKt).toBe(0);
    expect(now().speed).toBe(1);
    await cockpit.say("everything is fine");
    await cockpit.say(now().coach.trySaying[0]!);
    await cockpit.say(now().readBack!);
    cockpit.advance(20);
    expect(now().vitals.gsKt).toBeGreaterThan(0);
  });

  const flyTo = async (cockpit: Cockpit, stages: readonly string[]) => {
    await cockpit.say("checking in");
    for (const stage of stages) {
      until(cockpit, () => cockpit.state().stage === stage && cockpit.state().waiting);
      await cockpit.say(cockpit.state().coach.trySaying[0]!);
      await cockpit.say(cockpit.state().readBack!);
    }
  };

  it("can always move again after a stop past the crossing", async () => {
    const cockpit = createCockpit();
    cockpit.advance(1);
    await flyTo(cockpit, ["pushback", "taxi", "cross"]);
    const now = () => cockpit.state();
    until(cockpit, () => now().stage === "takeoff" && now().phase === "taxi_out");
    await cockpit.say("stop");
    cockpit.advance(15);
    await cockpit.say(now().coach.trySaying[0]!);
    expect(now().readBack).toBe("Continue taxi");
    await cockpit.say(now().readBack!);
    until(cockpit, () => now().phase === "holding_short" && now().waiting);
  });

  it("guides on once a fault on the ground is cleared", async () => {
    const cockpit = createCockpit();
    cockpit.advance(1);
    cockpit.fault("smoke", true);
    await cockpit.say("mayday, there's smoke");
    cockpit.fault("smoke", false);
    expect(cockpit.state().coach.trySaying[0]).toBe("Everything is fine");
  });

  it("is in real time while an engine failure waits to be reported", async () => {
    const cockpit = createCockpit();
    cockpit.advance(1);
    await flyTo(cockpit, ["pushback", "taxi", "cross", "takeoff"]);
    until(cockpit, () => cockpit.state().phase === "departure");
    cockpit.fault("engine_failure", true);
    cockpit.advance(2);
    expect(cockpit.state().speed).toBe(1);
  });
});
