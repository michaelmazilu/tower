import { describe, expect, it } from "vitest";
import { createCockpit } from "../src/cockpit";

describe("pilot's seat", () => {
  it("checks a crash call against the aircraft, then guides a beginner off the ground", async () => {
    const cockpit = createCockpit();
    cockpit.advance(1);
    const crash = await cockpit.say("Oh no, we're crashing!");
    expect(crash.exchange?.check?.verdict).toBe("contradicted");
    expect(cockpit.state().humanCalled).toBe(false);
    await cockpit.say("everything is fine");
    expect((await cockpit.say("I want to take off, what do I need?")).exchange?.action?.verdict).toBe("accepted");
    expect((await cockpit.say("cleared for takeoff runway two three")).exchange?.action?.verdict).toBe("rejected");
    expect((await cockpit.say("cleared for takeoff runway two four left")).exchange?.action?.verdict).toBe("accepted");
    cockpit.advance(150);
    expect(cockpit.state().vitals.onGround).toBe(false);
    cockpit.fault("engine_failure", true);
    cockpit.advance(1);
    expect((await cockpit.say("mayday, our engine failed")).exchange?.check?.verdict).toBe("confirmed");
    expect(cockpit.state().humanCalled).toBe(true);
  });
});
