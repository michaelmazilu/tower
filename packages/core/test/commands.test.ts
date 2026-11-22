import { describe, expect, it } from "vitest";
import type { Command } from "../src";
import { sandbox } from "./helpers";

// Commands arrive as JSON from HTTP and WebSocket clients, so the static type is no guarantee.
const untrusted = (value: unknown) => value as Command;

const holding = { callsign: "WJA302", flight: "departure", runway: "23", start: { kind: "holding_short" } } as const;

describe("untrusted commands", () => {
  it.each([
    ["radio.transmit without text", { type: "radio.transmit", from: "TOWER" }],
    ["radio.transmit with null text", { type: "radio.transmit", from: "TOWER", text: null }],
    ["radio.transmit with numeric text", { type: "radio.transmit", from: "TOWER", text: 7 }],
    ["radio.transmit with blank text", { type: "radio.transmit", from: "TOWER", text: " " }],
    ["radio.transmit from a non-string", { type: "radio.transmit", from: {}, text: "say again" }],
    ["pilot.request with numeric text", { type: "pilot.request", aircraftId: "WJA302", requestType: "TAKEOFF", text: 7 }],
    ["pilot.request with an unknown request type", { type: "pilot.request", aircraftId: "WJA302", requestType: "LUNCH" }],
    ["pilot.claim by an unknown pilot type", { type: "pilot.claim", aircraftId: "WJA302", by: "cat" }],
    ["priority.set with an unknown priority", { type: "priority.set", aircraftId: "WJA302", priority: "max", reason: "test" }],
    ["emergency.set_mode with an unknown mode", { type: "emergency.set_mode", mode: "chaos" }],
    ["runways.set_active without lists", { type: "runways.set_active", arrivals: "23", departures: ["23"] }],
    ["aircraft.spawn without a spec", { type: "aircraft.spawn" }],
    [
      "aircraft.spawn on approach without a distance",
      { type: "aircraft.spawn", spec: { callsign: "ACA9", flight: "arrival", start: { kind: "approach" } } },
    ],
  ])("refuses %s and keeps running", (_, command) => {
    const sim = sandbox([holding]);
    sim.run(20); // the pilot's own request is open, so a repeated request takes the reuse path
    expect(sim.dispatch(untrusted(command))).toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    expect(() => sim.run(30)).not.toThrow();
  });

  it.each([{ type: "typo" }, { type: "constructor" }, { type: 7 }, {}, null])(
    "refuses unknown command %j and keeps delivering events",
    (command) => {
      const sim = sandbox([holding]);
      const heard: string[] = [];
      sim.on((e) => heard.push(e.type));
      expect(sim.dispatch(untrusted(command))).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
      sim.run(20);
      expect(heard).toContain("request.pending");
    },
  );

  it("still takes null for an optional field", () => {
    const sim = sandbox([holding]);
    expect(sim.dispatch(untrusted({ type: "radio.transmit", from: "TOWER", to: null, text: "Say again." }))).toMatchObject({ ok: true });
  });
});
