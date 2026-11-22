import {
  DecisionTurn, type SimEvent, type Simulation, type ToolGateway, type ToolResult,
} from "@towerai/core";

export interface TurnContext {
  briefing: { turnId: string; triggers: SimEvent[]; airport: ToolResult };
  signal: AbortSignal;
  call(tool: string, args: Record<string, unknown>): ToolResult;
}

export interface TowerAgent {
  review(context: TurnContext): Promise<string>;
}

export class AtcController {
  private readonly unsubscribe: () => void;
  private triggers: SimEvent[] = [];
  private active?: AbortController;
  private turnId?: string;
  private detached = false;
  private nextReview = 0;
  private retryAt = 0;
  private failures = 0;

  constructor(private sim: Simulation, private gateway: ToolGateway, private agent: TowerAgent) {
    this.unsubscribe = sim.on((event) => {
      if (event.attention || event.type === "clearance.acknowledged" || event.type === "runways.configuration_changed") {
        if (this.triggers.length === 32) this.triggers.shift();
        this.triggers.push(event);
      }
    });
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.unsubscribe();
    this.active?.abort();
    if (this.turnId) this.sim.annotate("controller.review_cancelled", { turnId: this.turnId });
  }

  update(): void {
    if (this.detached || this.active || Date.now() < this.retryAt) return;
    if (!this.triggers.length) {
      if (this.sim.time < this.nextReview) return;
      this.nextReview = this.sim.time + 12;
      const pending = [...this.sim.requests.values()].some((r) => r.status === "pending");
      const held = [...this.sim.aircraft.values()].some((a) => a.holdPosition || a.phase === "holding");
      const emergency = [...this.sim.emergencies.values()].some((e) => e.resolvedAt === undefined);
      if (!pending && !held && !emergency && !this.sim.conflicts.size && !this.failures) return;
    }
    this.active = new AbortController();
    void this.review(this.active, this.triggers.splice(0));
  }

  private async review(active: AbortController, triggers: SimEvent[]): Promise<void> {
    const turn = new DecisionTurn(this.sim, this.gateway, "elevenlabs-tower");
    const turnId = turn.id;
    this.turnId = turnId;
    const timeout = setTimeout(() => active.abort(new Error("Tower review timed out.")), 60_000);
    const call = (tool: string, args: Record<string, unknown>): ToolResult => {
      active.signal.throwIfAborted();
      return turn.call(tool, args);
    };
    try {
      this.sim.annotate("controller.review_started", { turnId, triggerSeqs: triggers.map((e) => e.seq) });
      const airport = call("get_airport_state", {});
      const summary = await this.agent.review({ briefing: { turnId, triggers, airport }, call, signal: active.signal });
      active.signal.throwIfAborted();
      this.sim.annotate("controller.review_completed", { turnId, summary });
      this.failures = 0;
      this.retryAt = 0;
    } catch (error) {
      if (!this.detached) {
        this.failures++;
        const retryInSec = Math.min(30, 2 ** Math.min(this.failures, 5));
        this.retryAt = Date.now() + retryInSec * 1000;
        this.sim.annotate("controller.error", {
          turnId, message: error instanceof Error ? error.message : "Tower review failed.", retryInSec,
        });
      }
    } finally {
      clearTimeout(timeout);
      active.abort();
      this.active = undefined;
      this.turnId = undefined;
      this.nextReview = this.failures ? 0 : this.sim.time + 12;
    }
  }
}
