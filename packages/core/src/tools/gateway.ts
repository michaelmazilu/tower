import { computeTaxiRoute, resolveAircraft } from "../sim/clearances";
import {
  getAircraftDetails,
  getAirportState,
  getConflicts,
  getPendingRequests,
  getRunwayStatus,
} from "../sim/queries";
import type { Simulation } from "../sim/simulation";
import type { ClearanceType, Priority } from "../types";
import { CLEARANCE_TYPES } from "../types";

/**
 * The only door between the controller agent and the simulation.
 *
 * Six tools read authoritative state; two tools ask for a change, and the
 * simulation decides whether the change is allowed. There is deliberately
 * no tool that sets a position, a phase or a speed.
 */

type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: readonly string[]; items?: { type: string } }>;
  required: string[];
};

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, ready to register as an ElevenLabs server tool. */
  parameters: JsonSchema;
  mutates: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_airport_state",
    description:
      "Overview of the whole airport right now: every aircraft with its phase and location, runway occupancy and reservations, pending pilot requests, emergencies and conflicts. Call this first when you are unsure of the situation.",
    parameters: { type: "object", properties: {}, required: [] },
    mutates: false,
  },
  {
    name: "get_aircraft_details",
    description:
      "Everything about one aircraft: state, objective, clearance history, open request, what it will do next, and its recent events.",
    parameters: {
      type: "object",
      properties: { aircraftId: { type: "string", description: "Callsign, e.g. ACA214." } },
      required: ["aircraftId"],
    },
    mutates: false,
  },
  {
    name: "get_runway_status",
    description:
      "Occupancy, reservation, inbound arrivals with time to threshold, aircraft holding short, and time since the last departure. Omit `runway` for all runways.",
    parameters: {
      type: "object",
      properties: { runway: { type: "string", description: 'Runway end or pair, e.g. "23" or "05/23". Optional.' } },
      required: [],
    },
    mutates: false,
  },
  {
    name: "get_taxi_route",
    description:
      "Compute a taxi route for an aircraft through the taxiway graph, avoiding closed taxiways and oncoming traffic. Give `runway` for a departure or `gate` for an arrival. Returns the taxiways to use and any runways the route crosses. This does not move the aircraft.",
    parameters: {
      type: "object",
      properties: {
        aircraftId: { type: "string", description: "Callsign." },
        runway: { type: "string", description: "Departure runway end, e.g. 23." },
        gate: { type: "string", description: "Destination gate, e.g. D28." },
      },
      required: ["aircraftId"],
    },
    mutates: false,
  },
  {
    name: "issue_clearance",
    description:
      "Request a clearance for an aircraft. The simulator validates it against runway occupancy, reservations, arrival spacing and the aircraft's phase, and replies accepted, rejected (with the reason) or needs_clarification. When accepted, say the returned `phraseology` on the radio exactly; the aircraft acts only after it reads the clearance back. Always give the real reason for the decision.",
    parameters: {
      type: "object",
      properties: {
        aircraftId: { type: "string", description: "Callsign." },
        clearanceType: { type: "string", description: "The clearance to issue.", enum: CLEARANCE_TYPES },
        runway: { type: "string", description: "Runway end, e.g. 23 or 24R. Needed for runway clearances." },
        gate: { type: "string", description: "Gate, for TAXI to a gate." },
        route: { type: "array", description: "Optional explicit taxi route as node ids from get_taxi_route.", items: { type: "string" } },
        reason: { type: "string", description: "Why you are making this decision, in one sentence. Shown to the operator." },
        requestId: { type: "string", description: "The pilot request this answers, if any." },
      },
      required: ["aircraftId", "clearanceType", "reason"],
    },
    mutates: true,
  },
  {
    name: "set_aircraft_priority",
    description:
      "Change an aircraft's traffic priority. Emergency aircraft go first on the radio and get a wider protected gap on final.",
    parameters: {
      type: "object",
      properties: {
        aircraftId: { type: "string", description: "Callsign." },
        priority: { type: "string", description: "New priority.", enum: ["normal", "urgent", "emergency"] },
        reason: { type: "string", description: "Why." },
      },
      required: ["aircraftId", "priority", "reason"],
    },
    mutates: true,
  },
  {
    name: "get_pending_requests",
    description: "Pilot requests the tower has heard and not yet resolved, most urgent first.",
    parameters: { type: "object", properties: {}, required: [] },
    mutates: false,
  },
  {
    name: "get_conflicts",
    description:
      "Current and predicted conflicts: runway incursions, arrivals heading for an occupied runway, blocked or deadlocked taxi traffic, loss of airborne separation.",
    parameters: { type: "object", properties: {}, required: [] },
    mutates: false,
  },
];

export type ToolResult =
  | { ok: true; tool: string; result: Record<string, unknown> }
  | { ok: false; tool: string; error: { code: string; message: string; details?: Record<string, unknown> } };

export interface ToolCallMeta {
  /** Retried calls with the same key return the first result instead of acting twice. */
  idempotencyKey?: string;
  caller?: string;
}

const MAX_REMEMBERED = 500;

export class ToolGateway {
  private readonly remembered = new Map<string, ToolResult>();

  /** Pass a getter so the gateway survives a simulation reset. */
  constructor(private readonly getSim: () => Simulation) {}

  reset(): void {
    this.remembered.clear();
  }

  definitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  call(name: string, rawArgs: unknown, meta: ToolCallMeta = {}): ToolResult {
    const sim = this.getSim();
    const def = TOOL_DEFINITIONS.find((t) => t.name === name);
    if (!def) {
      return this.err(name, "UNKNOWN_TOOL", `No tool "${name}". Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`);
    }
    const key = meta.idempotencyKey ? `${name}:${meta.idempotencyKey}` : undefined;
    if (key && this.remembered.has(key)) return this.remembered.get(key)!;

    const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
    const problem = checkArgs(def, args);
    const result = problem ? this.err(name, "INVALID_ARGUMENTS", problem) : this.run(sim, name, args, meta);

    // Read-only calls are logged too: the decision feed shows what the
    // controller looked at before it acted.
    if (!def.mutates || !result.ok) {
      sim.annotate(
        "tool.called",
        {
          tool: name,
          args,
          ok: result.ok,
          caller: meta.caller ?? "controller",
          ...(result.ok ? { summary: summarize(name, result.result) } : { error: result.error }),
        },
        typeof args.aircraftId === "string" ? args.aircraftId.toUpperCase() : undefined,
      );
    }
    if (key) {
      if (this.remembered.size >= MAX_REMEMBERED) this.remembered.delete(this.remembered.keys().next().value!);
      this.remembered.set(key, result);
    }
    return result;
  }

  private err(tool: string, code: string, message: string, details?: Record<string, unknown>): ToolResult {
    return { ok: false, tool, error: { code, message, ...(details ? { details } : {}) } };
  }

  private run(sim: Simulation, name: string, args: Record<string, unknown>, meta: ToolCallMeta): ToolResult {
    const ok = (result: Record<string, unknown>): ToolResult => ({ ok: true, tool: name, result });
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);

    switch (name) {
      case "get_airport_state":
        return ok(getAirportState(sim));

      case "get_aircraft_details": {
        const found = resolveAircraft(sim, str("aircraftId")!);
        if (found.error) return this.err(name, found.error.code, found.error.message, found.error.details);
        return ok(getAircraftDetails(sim, found.ac.id)!);
      }

      case "get_runway_status": {
        const status = getRunwayStatus(sim, str("runway"));
        if (!status) return this.err(name, "UNKNOWN_RUNWAY", `"${str("runway")}" is not a runway at this airport.`);
        return ok({ runways: status });
      }

      case "get_taxi_route": {
        const found = resolveAircraft(sim, str("aircraftId")!);
        if (found.error) return this.err(name, found.error.code, found.error.message, found.error.details);
        const ac = found.ac;
        const gate = str("gate") ?? (ac.flight === "arrival" ? ac.gate : undefined);
        const runway = str("runway") ?? (ac.flight === "departure" ? ac.assignedRunway : undefined);
        const v = computeTaxiRoute(sim, ac, gate && !str("runway") ? { gate } : { runway });
        if (!v.ok) return this.err(name, v.code, v.message, v.details);
        const route = v.plan.route!;
        return ok({
          aircraftId: ac.id,
          destination: v.plan.gate ? `gate ${v.plan.gate}` : `runway ${v.plan.runway} holding point`,
          via: v.plan.via ?? [],
          route,
          distanceM: Math.round(sim.graph.pathLength(route)),
          crossesRunways: sim.graph.crossings(route),
        });
      }

      case "issue_clearance": {
        const res = sim.dispatch({
          type: "clearance.issue",
          aircraftId: str("aircraftId")!,
          clearanceType: str("clearanceType") as ClearanceType,
          runway: str("runway"),
          gate: str("gate"),
          route: Array.isArray(args.route) ? (args.route as string[]) : undefined,
          reason: str("reason") ?? "",
          requestId: str("requestId"),
          issuedBy: meta.caller ?? "controller",
        });
        if (res.ok) {
          const { ok: _ok, status: clearanceStatus, ...rest } = res;
          return ok({ status: "accepted", clearanceStatus, ...rest });
        }
        return ok({
          status: res.needsClarification ? "needs_clarification" : "rejected",
          code: res.code,
          message: res.message,
          details: res.details ?? {},
        });
      }

      case "set_aircraft_priority": {
        const found = resolveAircraft(sim, str("aircraftId")!);
        if (found.error) return this.err(name, found.error.code, found.error.message, found.error.details);
        if (found.ac.humanControl && meta.caller !== "human") {
          return this.err(name, "HUMAN_CONTROL", `${found.ac.callsign} is under human control.`);
        }
        const res = sim.dispatch({
          type: "priority.set",
          aircraftId: found.ac.id,
          priority: str("priority") as Priority,
          reason: str("reason") ?? "",
        });
        if (!res.ok) return this.err(name, res.code, res.message);
        return ok({ aircraftId: res.aircraftId, priority: res.priority });
      }

      case "get_pending_requests":
        return ok({ requests: getPendingRequests(sim) });

      case "get_conflicts":
        return ok({ conflicts: getConflicts(sim) });
    }
    return this.err(name, "UNKNOWN_TOOL", `No tool "${name}".`);
  }
}

function checkArgs(def: ToolDefinition, args: Record<string, unknown>): string | null {
  for (const key of def.parameters.required) {
    const v = args[key];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = def.parameters.properties[key];
    if (!spec || value === undefined || value === null) continue;
    if (spec.type === "string" && typeof value !== "string") return `Argument "${key}" must be a string.`;
    if (spec.type === "array" && !Array.isArray(value)) return `Argument "${key}" must be an array.`;
    if (spec.items?.type === "string" && Array.isArray(value) && value.some((v) => typeof v !== "string")) return `Argument "${key}" must contain only strings.`;
    if (spec.enum && !spec.enum.includes(value as string)) {
      return `Argument "${key}" must be one of: ${spec.enum.join(", ")}.`;
    }
  }
  return null;
}

/** One-line description of what a read returned, for the decision feed. */
function summarize(tool: string, result: Record<string, unknown>): string {
  const count = (k: string) => (Array.isArray(result[k]) ? (result[k] as unknown[]).length : 0);
  switch (tool) {
    case "get_airport_state":
      return `${count("aircraft")} aircraft, ${count("pendingRequests")} pending requests, ${count("conflicts")} conflicts`;
    case "get_pending_requests":
      return `${count("requests")} pending requests`;
    case "get_conflicts":
      return `${count("conflicts")} conflicts`;
    case "get_runway_status":
      return (result.runways as { runwayId: string; clear: boolean }[])
        .map((r) => `${r.runwayId} ${r.clear ? "clear" : "in use"}`)
        .join("; ");
    case "get_taxi_route":
      return `${result.destination} via ${(result.via as string[]).join(", ") || "direct"}`;
    case "get_aircraft_details":
      return `${result.id}: ${result.location}`;
    default:
      return "";
  }
}
