import type { Brain, Timing } from "@towerai/contracts";
import type { Simulation, ToolGateway, Transmission } from "@towerai/core";

/**
 * Where AI pilots and voice plug in. All of it is optional: with none of it
 * the simulator's scripted pilots talk and the app shows captions.
 */

export interface SpokenLine {
  role: "controller" | "pilot";
  /** The callsign for a pilot, "TOWER" for the controller. */
  speaker: string;
  text: string;
  /** The same words shaped for text to speech. */
  spoken: string;
}

export interface VoicePlugin {
  label: string;
  /** Must not block or spend: cached audio only. Same shape as voice/voice.ts cachedLine. */
  line(line: SpokenLine): { audioUrl: string; timing: Timing } | null;
  /** How long that recording runs. Pure: the same line always gives the same answer. */
  seconds?(line: SpokenLine): number | undefined;
  /** The file behind GET /api/audio/:file, or null. */
  file(name: string): string | null;
}

export interface PilotDriver {
  /** Called after every simulation step. */
  update?(): void;
  detach(): void;
}

export interface Plugins {
  voice?: VoicePlugin;
  /** Called for each run. A driver claims aircraft with pilot.claim and answers through commands. */
  pilots?: (run: { sim: Simulation; gateway: ToolGateway }) => PilotDriver;
  /** Who really produced a line and how long it took, when a plugin knows. */
  describe?: (tx: Transmission) => { brain?: Brain; timings?: Timing[] } | undefined;
}
