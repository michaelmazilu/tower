import { ADVISORY_KINDS, type Command, type CommandResult, type SpawnSpec } from "../types";

/**
 * Commands arrive as JSON from HTTP, WebSocket and replay files, so their
 * static type proves nothing. Check the shape before anything reads it: a
 * bad value that gets into the world surfaces later, in the middle of a
 * step, where there is no caller left to answer.
 */

type Check = (value: unknown) => boolean;
/** One check per field. A new field on the type will not compile without one. */
type Fields<T> = { [F in keyof T]-?: Check };

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const string: Check = (v) => typeof v === "string";
const words: Check = (v) => typeof v === "string" && v.trim() !== "";
const number: Check = (v) => Number.isFinite(v);
const boolean: Check = (v) => typeof v === "boolean";
const strings: Check = (v) => Array.isArray(v) && v.every(string);
const optional = (check: Check): Check => (v) => v === undefined || v === null || check(v);
const oneOf = (...allowed: string[]): Check => (v) => typeof v === "string" && allowed.includes(v);
const shape = <T>(fields: Fields<T>): Check => (v) =>
  record(v) && Object.entries<Check>(fields).every(([key, check]) => check(v[key]));

const priority = oneOf("normal", "urgent", "emergency");

const start: Check = (v) => {
  if (!record(v)) return false;
  if (v.kind === "taxiing") return string(v.from);
  // A runway permission exists only in a scenario's opening, never from a command.
  if (v.cleared !== undefined) return false;
  if (v.kind === "approach") return number(v.distanceNm);
  return v.kind === "gate" || v.kind === "holding_short";
};

const COMMANDS: { [K in Command["type"]]: Fields<Omit<Extract<Command, { type: K }>, "type">> } = {
  "clearance.issue": {
    aircraftId: string,
    clearanceType: string, // the rulebook rejects unknown types itself, so the attempt reaches the decision log
    runway: optional(string),
    gate: optional(string),
    route: optional(strings),
    reason: string,
    requestId: optional(string),
    issuedBy: optional(string),
  },
  "clearance.cancel": { clearanceId: string, reason: string },
  "priority.set": { aircraftId: string, priority, reason: string },
  "pilot.request": {
    aircraftId: string,
    requestType: oneOf("PUSHBACK", "TAXI", "TAKEOFF", "LANDING", "CROSS", "OTHER"),
    runway: optional(string),
    text: optional(string),
    spoken: optional(boolean),
  },
  "pilot.readback": { aircraftId: string, clearanceId: optional(string), text: optional(string), spoken: optional(boolean) },
  "pilot.claim": { aircraftId: string, by: oneOf("human", "ai") },
  "pilot.release": { aircraftId: string },
  "radio.tx_complete": { transmissionId: string },
  "radio.tx_failed": { transmissionId: string, error: optional(string) },
  "radio.transmit": { from: words, to: optional(words), text: words, spoken: optional(boolean) },
  "emergency.set_mode": { mode: oneOf("off", "manual", "random") },
  "emergency.trigger": { emergencyType: string, aircraftId: optional(string), edgeId: optional(string) },
  "emergency.resolve": { emergencyId: string },
  "aircraft.spawn": {
    spec: shape<SpawnSpec>({
      callsign: string,
      type: optional(string),
      pilotType: optional(oneOf("ai", "scripted", "human")),
      priority: optional(priority),
      flight: oneOf("departure", "arrival"),
      runway: optional(string),
      gate: optional(string),
      start,
      readyInSec: optional(number),
    }),
  },
  "aircraft.remove": { aircraftId: string },
  "runways.set_active": { arrivals: strings, departures: strings, closed: optional(strings), reason: optional(string) },
  "control.takeover": { aircraftId: string },
  "control.handback": { aircraftId: string },
  "advisory.issue": {
    kind: oneOf(...ADVISORY_KINDS),
    text: words,
    spoken: optional(words),
    aircraftId: optional(string),
    by: optional(oneOf("tower", "pilot", "operator")),
    replyTo: optional(string),
    reason: optional(string),
  },
};

/** The failure to return, or null when the command is safe to apply. */
export function checkCommand(command: unknown): CommandResult | null {
  if (!record(command) || typeof command.type !== "string" || !Object.hasOwn(COMMANDS, command.type)) {
    return { ok: false, code: "UNKNOWN_COMMAND", message: "That is not a command this simulation knows." };
  }
  const fields: Record<string, Check> = COMMANDS[command.type as Command["type"]];
  for (const [field, check] of Object.entries(fields)) {
    if (!check(command[field])) {
      return { ok: false, code: "INVALID_COMMAND", message: `${command.type} has a missing or invalid "${field}".` };
    }
  }
  return null;
}
