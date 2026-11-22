import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Timing, WorldRecording } from "@towerai/contracts";
import type { ElevenLabs } from "../agents/client";
import { cachedLine, voiceLine, type Line, type VoicedLine } from "./voice";

const WORLD = fileURLToPath(new URL("../../../world/data/world.json", import.meta.url));

export interface WorldVoiceResult {
  ok: boolean;
  audioUrl?: string;
  timing?: Timing;
  message?: string;
}

let recording: { changed: number; lines: Map<string, Line> } | undefined;

/** Every line that may be voiced, with the voices record-world.ts gave them. */
function recordedLines(): Map<string, Line> {
  const changed = statSync(WORLD).mtimeMs;
  if (recording?.changed === changed) return recording.lines;
  const world = JSON.parse(readFileSync(WORLD, "utf8")) as WorldRecording;
  const lines = new Map<string, Line>();
  for (const { summary, messages } of world.flights) {
    for (const m of messages) {
      // A line the validator stopped was never said.
      if (m.from === "operator" || !m.text || (m.decision?.verdict === "rejected" && m.durationS === 0)) continue;
      const responder = m.speaker.endsWith("(simulated)");
      const role = m.from === "pilot" || responder ? "pilot" : "controller";
      lines.set(`${summary.id}\n${m.id}`, { role, speaker: responder ? m.speaker : summary.id, text: m.text });
    }
  }
  recording = { changed, lines };
  return lines;
}

const making = new Map<string, Promise<VoicedLine | null>>();

/** POST /api/world/voice. The client names a recorded line and can never supply the words. */
export async function worldVoice(body: { flightId?: unknown; messageId?: unknown }, api: ElevenLabs | null): Promise<WorldVoiceResult> {
  const { flightId, messageId } = body;
  if (typeof flightId !== "string" || typeof messageId !== "string") return { ok: false, message: "A flight and a message are needed." };
  try {
    const line = recordedLines().get(`${flightId}\n${messageId}`);
    if (!line) return { ok: false, message: "No such line to voice in the world recording." };
    let voiced = cachedLine(line);
    if (!voiced && api) {
      const key = JSON.stringify(line);
      let work = making.get(key);
      if (!work) {
        work = voiceLine(line, { api }).finally(() => making.delete(key));
        making.set(key, work);
      }
      voiced = await work;
    }
    return voiced ? { ok: true, audioUrl: voiced.audioUrl, timing: voiced.timing } : { ok: false, message: "ElevenLabs is off and this line is not cached." };
  } catch (error) {
    console.error(`world voice: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, message: "ElevenLabs could not voice this line." };
  }
}
