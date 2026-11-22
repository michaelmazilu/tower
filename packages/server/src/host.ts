import {
  BaselineController,
  JUDGE_DEMO,
  SCENARIOS,
  ToolGateway,
  createSimulation,
  replay,
  type Command,
  type CommandResult,
  type RadioMode,
  type Scenario,
  type SimConfig,
  type SimEvent,
  type Simulation,
} from "@towerai/core";
import type { OpsState } from "@towerai/contracts";
import { AtcController, type TowerAgent } from "./atc/controller";
import { Director } from "./ops/director";
import { Ops } from "./ops/ops";
import type { PilotDriver, Plugins } from "./ops/plugins";
import { RunRecorder } from "./persistence";

export type ControllerMode = "baseline" | "elevenlabs" | "none";

export function isControllerMode(value: unknown): value is ControllerMode {
  return value === "baseline" || value === "elevenlabs" || value === "none";
}

export interface HostOptions {
  createAgent?: () => TowerAgent;
  scenarioId: string;
  controller: ControllerMode;
  radio: { controller: RadioMode; pilots: RadioMode };
  dataDir: string | null;
  speed: number;
  plugins?: Plugins;
}

const FRAME_MS = 50;
/** A hosted tower that has lost its network or its credit cannot leave the traffic unanswered. */
const AGENT_FAILURES_BEFORE_RULES = 3;
const MAX_STEPS_PER_FRAME = 400;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 16;

/**
 * Owns the live simulation: runs it against the wall clock, records it,
 * and swaps in a fresh one on reset. The simulation itself has no idea
 * what time it really is — speed and pause live here.
 */
export class SimHost {
  sim!: Simulation;
  scenario!: Scenario;
  runId = "";
  speed: number;
  private isPaused = false;
  controllerMode: ControllerMode;

  readonly gateway = new ToolGateway(() => this.sim);
  /** The operator's view of this run. Replaced on reset. */
  ops!: Ops;

  private director: Director | null = null;
  private pilots: PilotDriver | null = null;
  private controller: BaselineController | AtcController | null = null;
  private recorder: RunRecorder | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastFrame = 0;
  private budget = 0;
  private commandsWritten = 0;
  private runCounter = 0;
  private agentFailures = 0;
  private readonly eventListeners = new Set<(e: SimEvent) => void>();
  private readonly resetListeners = new Set<() => void>();

  constructor(private readonly options: HostOptions) {
    this.speed = options.speed;
    this.controllerMode = options.controller;
    this.reset(options.scenarioId);
  }

  onEvent(fn: (e: SimEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onReset(fn: () => void): () => void {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  /** Throw the world away and start the scenario again from a clean state. */
  reset(scenarioId?: string, seed?: number): { ok: true; runId: string } | { ok: false; message: string } {
    const id = scenarioId ?? this.scenario?.id ?? this.options.scenarioId;
    const base = Object.hasOwn(SCENARIOS, id) ? SCENARIOS[id] : undefined;
    if (!base) return { ok: false, message: `Unknown scenario "${scenarioId}". Known: ${Object.keys(SCENARIOS).join(", ")}.` };
    const scenario: Scenario = seed !== undefined ? { ...base, seed } : base;

    this.controller?.detach();
    this.director?.detach();
    this.pilots?.detach();
    this.ops?.detach();
    this.recorder?.close();
    this.gateway.reset();

    const sim = createSimulation(scenario, this.simConfig());
    this.sim = sim;
    this.scenario = scenario;
    this.runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${++this.runCounter}`;
    this.budget = 0;
    this.commandsWritten = 0;
    this.agentFailures = 0;
    this.lastFrame = Date.now();

    this.recorder = this.options.dataDir ? new RunRecorder(this.options.dataDir, this.runId, scenario, sim.config) : null;
    // Scenario setup happened before anyone was listening; record it now.
    for (const e of sim.events) this.recorder?.event(e);
    sim.on((e) => {
      this.recorder?.event(e);
      if (e.type === "controller.error") this.agentFailures++;
      else if (e.type === "controller.review_completed") this.agentFailures = 0;
      this.flushCommands();
      for (const fn of this.eventListeners) fn(e);
    });

    const { plugins } = this.options;
    this.ops = new Ops(sim, this.gateway, plugins);
    this.director = scenario.id === JUDGE_DEMO.id ? new Director(sim) : null;
    this.pilots = plugins?.pilots?.({ sim, gateway: this.gateway }) ?? null;
    this.setController(this.controllerMode);
    for (const fn of this.resetListeners) fn();
    return { ok: true, runId: this.runId };
  }

  setController(mode: ControllerMode): void {
    let next: BaselineController | AtcController | null = null;
    if (mode === "elevenlabs") {
      if (!this.options.createAgent) throw new Error("Set ELEVENLABS_API_KEY to enable the tower agent (npm run judge:live).");
      if (!this.paused) next = new AtcController(this.sim, this.gateway, this.options.createAgent());
    } else if (mode === "baseline") {
      next = new BaselineController(this.sim, this.gateway).attach();
    }
    this.controller?.detach();
    this.agentFailures = 0;
    this.controller = next;
    this.controllerMode = mode;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  set paused(value: boolean) {
    if (value === this.isPaused) return;
    this.isPaused = value;
    if (this.controllerMode === "elevenlabs") this.setController("elevenlabs");
  }

  setSpeed(speed: number): number {
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
    return this.speed;
  }

  dispatch(command: Command): CommandResult {
    const result = this.sim.dispatch(command);
    this.flushCommands();
    return result;
  }

  private flushCommands(): void {
    const all = this.sim.commands;
    for (; this.commandsWritten < all.length; this.commandsWritten++) {
      this.recorder?.command(all[this.commandsWritten]);
    }
  }

  /** Advance by exactly n steps regardless of pause (used when stepping manually). */
  stepOnce(n = 1): void {
    for (let i = 0; i < n; i++) {
      if (this.controllerMode === "elevenlabs" && this.agentFailures >= AGENT_FAILURES_BEFORE_RULES) this.setController("baseline");
      this.sim.step();
      this.pilots?.update?.();
      this.director?.update();
      if (this.controllerMode === "baseline") this.ops.thinking();
      this.controller?.update();
      this.ops.update();
    }
    this.flushCommands();
  }

  start(): void {
    if (this.timer) return;
    this.lastFrame = Date.now();
    this.timer = setInterval(() => this.frame(), FRAME_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.detach();
    this.controller = null;
    this.director?.detach();
    this.director = null;
    this.pilots?.detach();
    this.pilots = null;
    this.recorder?.close();
  }

  private frame(): void {
    const now = Date.now();
    const elapsed = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (this.paused) return;
    this.budget += elapsed * this.speed;
    const dt = this.sim.config.dt;
    let steps = Math.floor(this.budget / dt);
    if (steps > MAX_STEPS_PER_FRAME) {
      // Fell behind (laptop slept, debugger paused): drop the backlog instead of fast-forwarding.
      steps = MAX_STEPS_PER_FRAME;
      this.budget = 0;
    } else {
      this.budget -= steps * dt;
    }
    if (steps > 0) this.stepOnce(steps);
  }

  /**
   * Prove the run is reproducible: rebuild it from the scenario, seed and
   * recorded commands alone and compare the resulting world to the live one.
   */
  verifyReplay(): { match: boolean; tick: number; commands: number } {
    const live = this.sim;
    const copy = replay(this.scenario, live.commands, live.tick, this.simConfig());
    return { match: copy.stateHash() === live.stateHash(), tick: live.tick, commands: live.commands.length };
  }

  private simConfig(): Partial<SimConfig> {
    const { radio, plugins } = this.options;
    const voice = plugins?.voice;
    if (!voice?.seconds) return { radio };
    return { radio, clipSec: (from, text, spoken) => voice.seconds!({ role: from === "TOWER" ? "controller" : "pilot", speaker: from, text, spoken }) };
  }

  opsState(): OpsState {
    return this.ops.state({ runId: this.runId, paused: this.paused, speed: this.speed, mode: this.controllerMode });
  }

  status() {
    return {
      runId: this.runId,
      scenario: { id: this.scenario.id, name: this.scenario.name, seed: this.scenario.seed, airport: this.scenario.airport },
      speed: this.speed,
      paused: this.paused,
      controller: this.controllerMode,
      radio: this.options.radio,
      simTime: this.sim.time,
      tick: this.sim.tick,
    };
  }
}
