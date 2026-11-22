import { describe, expect, it } from "vitest";
import {
  CLEARANCE_TYPES,
  clearancePhrase,
  matchReadback,
  normalizeSpeech,
  readbackPhrase,
  spokenCallsign,
  spokenRunway,
} from "../src";

describe("phraseology", () => {
  it("speaks callsigns and runways the way ATC does", () => {
    expect(spokenCallsign("ACA214")).toBe("Air Canada two one four");
    expect(spokenCallsign("WJA39")).toBe("WestJet three niner");
    expect(spokenRunway("06L")).toBe("zero six left");
    expect(spokenRunway("23")).toBe("two three");
  });

  it("puts the callsign first for the tower and last for the pilot", () => {
    const p = { callsign: "WJA302", type: "CLEARED_TAKEOFF" as const, runway: "23" };
    expect(clearancePhrase(p).text).toBe("WJA302, runway 23, cleared for takeoff.");
    expect(readbackPhrase(p).text).toBe("Runway 23, cleared for takeoff, WJA302.");
  });

  it("normalises spoken numbers into identifiers", () => {
    expect(normalizeSpeech("Runway two four right, cleared to land")).toBe("runway 24r cleared to land");
    expect(normalizeSpeech("zero six left")).toBe("06l");
    expect(normalizeSpeech("twenty-four left")).toBe("24l");
    expect(normalizeSpeech("ten thousand")).toBe("10 thousand");
    expect(matchReadback({ type: "CLEARED_TAKEOFF", runway: "23" }, "cleared for takeoff runway twenty three").ok).toBe(true);
    expect(matchReadback({ type: "CLEARED_TAKEOFF", runway: "23" }, "cleared for takeoff runway twenty four").ok).toBe(false);
  });

  it("accepts its own readback for every clearance type, written or spoken", () => {
    for (const type of CLEARANCE_TYPES) {
      const vector = type === "VECTOR" || type === "RETURN_TO_LAND" ? { turn: "left" as const, headingDeg: 70, altitudeFt: 3000, speedKts: 180 } : undefined;
      const input = { callsign: "ACA214", type, runway: "06L", gate: type === "TAXI" ? undefined : "D22", via: ["C", "A"], vector };
      const rb = readbackPhrase(input);
      expect(matchReadback({ type, runway: "06L", vector }, rb.text), `${type} text`).toEqual({ ok: true, missing: [] });
      expect(matchReadback({ type, runway: "06L", vector }, rb.spoken), `${type} spoken`).toEqual({ ok: true, missing: [] });
    }
  });

  it("catches a readback with the wrong runway or the wrong instruction", () => {
    const clr = { type: "CLEARED_TO_LAND" as const, runway: "24R" };
    expect(matchReadback(clr, "cleared to land two four left, Delta 482").ok).toBe(false);
    expect(matchReadback(clr, "cleared to land runway two four right, Delta 482").ok).toBe(true);
    expect(matchReadback({ type: "HOLD_SHORT", runway: "23" }, "line up and wait runway 23").ok).toBe(false);
    expect(matchReadback({ type: "CLEARED_TAKEOFF", runway: "23" }, "roger").missing.length).toBe(2);
  });

  it("checks taxi destinations, callsigns and contradictory runway readbacks", () => {
    const taxi = { type: "TAXI" as const, gate: "D22", callsign: "ACA214" };
    expect(matchReadback(taxi, "Taxi to gate Delta two two, Air Canada two one four").ok).toBe(true);
    expect(matchReadback(taxi, "Taxi to gate D22, ACA 214").ok).toBe(true);
    expect(matchReadback(taxi, "Taxi to gate B7, Air Canada two one four").missing).toEqual(["gate D22"]);
    expect(matchReadback(taxi, "Taxi to gate D22, Delta two one four").missing).toEqual(["callsign ACA214"]);
    const takeoff = { type: "CLEARED_TAKEOFF" as const, runway: "23", callsign: "ACA214" };
    expect(matchReadback(takeoff, "Runway 24, cleared for takeoff runway 23, ACA214").ok).toBe(false);
    expect(matchReadback(takeoff, "Runway 23, not cleared for takeoff, ACA214").ok).toBe(false);
  });
});
