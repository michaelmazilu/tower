/**
 * Run the guided demo with no server, no voice and no agents, as fast as
 * the CPU allows, and print the decision feed. The rule-based baseline
 * controller stands in for the AI controller.
 *
 *   npm run demo                # 15 simulated minutes
 *   npm run demo -- 30          # 30 simulated minutes
 *   npm run demo -- 15 --all    # include movement and radio queue events
 */
import { BaselineController, GUIDED_DEMO, ToolGateway, createSimulation, type SimEvent } from "@towerai/core";

const minutes = Number(process.argv[2] ?? 15) || 15;
const showAll = process.argv.includes("--all");

const sim = createSimulation(GUIDED_DEMO, { strict: true });
const gateway = new ToolGateway(() => sim);
const controller = new BaselineController(sim, gateway).attach();

const QUIET = new Set([
  "radio.tx_queued",
  "radio.tx_started",
  "runway.reserved",
  "runway.occupied",
  "clearance.transmitted",
  "clearance.activated",
  "clearance.closed",
  "request.created",
  "request.answered",
  "tool.called",
  "controller.observation",
  "controller.decision",
  "conflict.resolved",
]);

function clock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function line(e: SimEvent): string | null {
  const d = e.data as Record<string, any>;
  const who = (e.aircraftId ?? "").padEnd(8);
  switch (e.type) {
    case "radio.tx_completed":
      return `${who} 📻 ${d.from === "TOWER" ? "TWR" : d.from}: ${d.text}`;
    case "clearance.issued":
      return `${who} ✅ ${d.clearanceType} accepted — ${d.reason}`;
    case "clearance.rejected":
      return `${who} ⛔ ${d.clearanceType} rejected [${d.code}] ${d.message}`;
    case "clearance.acknowledged":
      return `${who} ↩︎  readback correct (${d.clearanceType})`;
    case "aircraft.phase_changed":
      return `${who} → ${d.from} ⇒ ${d.to}${e.cause?.kind === "clearance" ? ` (${e.cause.clearanceId})` : e.cause?.kind === "auto" ? ` (auto: ${e.cause.rule})` : ""}`;
    default:
      return `${who} · ${e.type} ${JSON.stringify(d)}`;
  }
}

sim.on((e) => {
  if (!showAll && QUIET.has(e.type)) return;
  const text = line(e);
  if (text) console.log(`${clock(e.simTime)}  ${text}`);
});

const steps = Math.round((minutes * 60) / sim.config.dt);
const started = Date.now();
for (let i = 0; i < steps; i++) {
  sim.step();
  controller.update();
}

console.log("\n──────── summary ────────");
console.log(`simulated ${minutes} min in ${Date.now() - started} ms, ${sim.events.length} events, ${sim.commands.length} commands`);
console.log(sim.stats);
for (const ac of sim.aircraft.values()) {
  console.log(`  ${ac.id.padEnd(8)} ${ac.phase.padEnd(14)} ${ac.flightComplete ? "complete" : ""}`);
}
console.log("open conflicts:", [...sim.conflicts.values()].map((c) => c.description));
