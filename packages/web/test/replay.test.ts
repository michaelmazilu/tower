import type { FlightRecord, FlightSummary, Message } from "@towerai/contracts";
import { describe, expect, it } from "vitest";
import { byUrgency, flightAt, isBlocked, tooClose } from "../src/shared/replay";

const normal = { score: 5, level: "normal" as const, reasons: [] };
const summary = { id: "A", callsign: "A", risk: normal, attention: "none", status: "live", lastMessage: "now" } as unknown as FlightSummary;

describe("operations replay", () => {
  it("shows position, words and risk as they were at t", () => {
    const record = {
      summary, startT: 0, endT: 20, markers: [], separation: [],
      track: [[0, 10, 20, 1000, 200, 350, 0], [20, 12, 22, 2000, 220, 10, 0]],
      messages: [
        { id: "1", t: 2, durationS: 2, text: "then" },
        { id: "2", t: 5, durationS: 0, text: "never sent", decision: { verdict: "rejected" } },
        { id: "3", t: 15, durationS: 2, text: "later" },
      ],
      riskSeries: [{ t: 0, risk: normal, attention: "none", status: "start" }, { t: 11, risk: normal, attention: "intervene", status: "late" }],
    } as unknown as FlightRecord;
    expect(flightAt(record, 10)).toMatchObject({ lat: 11, altFt: 1500, hdg: 0, status: "start", attention: "none", lastMessage: "then" });
    expect(flightAt(record, 11).attention).toBe("intervene");
  });

  it("puts a call for a human above any risk score", () => {
    const risky = { ...summary, id: "R", risk: { score: 99, level: "critical" as const, reasons: [] } };
    const calling = { ...summary, id: "H", attention: "human_requested" as const };
    expect([risky, calling].sort(byUrgency).map((f) => f.id)).toEqual(["H", "R"]);
  });

  it("shows a refusal that was spoken as transmitted", () => {
    expect(isBlocked({ durationS: 3, decision: { verdict: "rejected" } } as Message)).toBe(false);
    expect(isBlocked({ durationS: 0, decision: { verdict: "rejected" } } as Message)).toBe(true);
  });

  it("only calls separation lost when both axes are short", () => {
    const s = { t: 0, otherFlightId: "B", lateralNm: 2, verticalFt: 1200, requiredNm: 3, requiredFt: 1000 };
    expect(tooClose(s)).toBe(false);
    expect(tooClose({ ...s, verticalFt: 800 })).toBe(true);
  });
});
