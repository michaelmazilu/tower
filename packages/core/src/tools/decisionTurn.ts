import type { Simulation } from "../sim/simulation";
import type { DecisionEvent } from "../types";
import { ToolGateway, type ToolResult } from "./gateway";

/** Links each proposal to the immutable tool results observed so far in this review. */
export class DecisionTurn {
  readonly id: string;
  private readonly observations: number[] = [];

  constructor(private sim: Simulation, private gateway: ToolGateway, readonly caller: string) {
    this.id = sim.nextId("ATC");
  }

  call(tool: string, args: Record<string, unknown> = {}): ToolResult {
    const result = structuredClone(this.gateway.call(tool, args, { caller: this.caller }));
    const common = { turnId: this.id, caller: this.caller, tool, args: structuredClone(args), result };
    if (this.gateway.definitions().some((t) => t.name === tool && t.mutates)) {
      const data: DecisionEvent["data"] = {
        ...common, reason: typeof args.reason === "string" ? args.reason : "", observationSeqs: [...this.observations],
      };
      this.sim.annotate("controller.decision", data, typeof args.aircraftId === "string" ? args.aircraftId.toUpperCase() : undefined);
    } else {
      this.observations.push(this.sim.annotate("controller.observation", common).seq);
    }
    return result;
  }
}
