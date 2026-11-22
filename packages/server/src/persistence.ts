import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { CommandRecord, Scenario, SimConfig, SimEvent } from "@towerai/core";

/**
 * Writes one folder per run:
 *
 *   meta.json       scenario, seed and config — enough to rebuild the start
 *   events.jsonl    every event, one JSON object per line, in sequence order
 *   commands.jsonl  every command with the tick it arrived on
 *
 * meta.json + commands.jsonl reproduce the run exactly (see `replay` in
 * core). events.jsonl is the human-readable decision trail. Animation
 * frames are never stored.
 */
export class RunRecorder {
  readonly dir: string;
  private readonly events: WriteStream;
  private readonly commands: WriteStream;

  constructor(root: string, readonly runId: string, scenario: Scenario, config: SimConfig) {
    this.dir = join(root, runId);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      join(this.dir, "meta.json"),
      JSON.stringify({ runId, startedAt: new Date().toISOString(), scenario, config }, null, 2),
    );
    this.events = createWriteStream(join(this.dir, "events.jsonl"), { flags: "a" });
    this.commands = createWriteStream(join(this.dir, "commands.jsonl"), { flags: "a" });
  }

  event(e: SimEvent): void {
    this.events.write(JSON.stringify(e) + "\n");
  }

  command(c: CommandRecord): void {
    this.commands.write(JSON.stringify(c) + "\n");
  }

  close(): void {
    this.events.end();
    this.commands.end();
  }
}
