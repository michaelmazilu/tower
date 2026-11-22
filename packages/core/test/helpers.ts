import {
  BaselineController,
  SCHEMATIC_SANDBOX as SANDBOX,
  ToolGateway,
  createSimulation,
  type Scenario,
  type SimConfig,
  type Simulation,
  type SpawnSpec,
} from "../src";

export function sandbox(aircraft: SpawnSpec[] = [], overrides: Partial<SimConfig> = {}, extra: Partial<Scenario> = {}): Simulation {
  return createSimulation({ ...SANDBOX, emergencyMode: "manual", ...extra, aircraft }, { strict: true, ...overrides });
}

export function withBaseline(sim: Simulation) {
  const gateway = new ToolGateway(() => sim);
  const controller = new BaselineController(sim, gateway).attach();
  const run = (seconds: number, eachStep?: () => void) => {
    const steps = Math.round(seconds / sim.config.dt);
    for (let i = 0; i < steps; i++) {
      sim.step();
      controller.update();
      eachStep?.();
    }
  };
  return { gateway, controller, run };
}

/** Issue a clearance and return the gateway's verdict. */
export function issue(sim: Simulation, aircraftId: string, clearanceType: string, extra: Record<string, unknown> = {}) {
  const gateway = new ToolGateway(() => sim);
  const res = gateway.call("issue_clearance", { aircraftId, clearanceType, reason: "test", ...extra });
  if (!res.ok) throw new Error(`tool error: ${res.error.message}`);
  return res.result as { status: string; code?: string; message?: string; clearanceId?: string; phraseology?: string };
}

export const eventsOf = (sim: Simulation, type: string) => sim.events.filter((e) => e.type === type);
