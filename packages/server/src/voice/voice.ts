import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Timing } from "@towerai/contracts";
import type { ElevenLabs } from "../agents/client";
import { dataPath, readData, writeData } from "../agents/data";
import { radioSpeech } from "./speech";

export const TTS_MODEL = "eleven_flash_v2_5";
const FORMAT = "mp3_22050_32";
const SETTINGS = { speed: 1.12, stability: 0.6, similarity_boost: 0.7 };
/** ElevenLabs premade voices. */
const CONTROLLER = { id: "cjVigY5qzO86Huf0OWal", name: "Eric" };
const PILOTS = [
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
];

export interface Line {
  role: "controller" | "pilot";
  /** Picks the pilot's voice. Use the callsign so a flight keeps its voice. */
  speaker: string;
  text: string;
  /** Set only where `text` cannot be spoken as it stands, such as taxiway letters. */
  spoken?: string;
}

interface Entry {
  text: string;
  voice: string;
  model: string;
  characters: number;
  firstByteMs: number;
  recordedAt: string;
}

export interface VoicedLine {
  audioUrl: string;
  timing: Timing;
  fromCache: boolean;
}

const AUDIO_DIR = dataPath("audio");
const MANIFEST = dataPath("audio", "manifest.json");

/** All pilot lines of one flight map to one voice. */
export function voiceFor(role: Line["role"], speaker: string) {
  if (role === "controller") return CONTROLLER;
  let hash = 0;
  for (const c of speaker.toUpperCase()) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return PILOTS[hash % PILOTS.length];
}

function address(line: Line) {
  const spoken = radioSpeech(line.spoken ?? line.text);
  const voice = voiceFor(line.role, line.speaker);
  const hash = createHash("sha256").update(JSON.stringify([TTS_MODEL, FORMAT, SETTINGS, voice.id, spoken])).digest("hex");
  return { file: `${hash.slice(0, 24)}.mp3`, spoken, voice };
}

function voiced(file: string, entry: Entry, fromCache: boolean): VoicedLine {
  return {
    audioUrl: `/api/audio/${file}`,
    fromCache,
    timing: {
      stage: "voice",
      ms: entry.firstByteMs,
      kind: "measured",
      source: `ElevenLabs ${entry.model}, first byte, recorded ${entry.recordedAt.slice(0, 10)}${fromCache ? ", replayed from cache" : ""}`,
    },
  };
}

/** The file behind GET /api/audio/:file, or null. Only content addresses are accepted. */
export function audioFile(name: string): string | null {
  if (!/^[0-9a-f]{24}\.mp3$/.test(name)) return null;
  const path = dataPath("audio", name);
  return existsSync(path) ? path : null;
}

/** Offline and free. */
export function cachedLine(line: Line): VoicedLine | null {
  const { file } = address(line);
  if (!audioFile(file)) return null;
  const entry = readData<Record<string, Entry>>(MANIFEST, {})[file];
  return entry ? voiced(file, entry, true) : null;
}

/** The recording's length: FORMAT is a constant 32 kbit/s. */
export function cachedSeconds(line: Line): number | undefined {
  const path = audioFile(address(line).file);
  return path ? statSync(path).size / 4000 : undefined;
}

/** Serves the cache, and only with an `api` goes to the network. `fresh` is for latency measurement. */
export async function voiceLine(
  line: Line,
  options: { api?: ElevenLabs | null; fresh?: boolean; timeoutMs?: number } = {},
): Promise<VoicedLine | null> {
  if (!options.fresh) {
    const hit = cachedLine(line);
    if (hit) return hit;
  }
  const api = options.api;
  if (!api) return null;
  await api.prepare();
  const { file, spoken, voice } = address(line);
  // Flash is billed at half a credit per character.
  api.guard.reserve(Math.ceil(spoken.length / 2));
  return api.run(async () => {
    const started = performance.now();
    const response = await api.fetch(
      "POST",
      `/v1/text-to-speech/${voice.id}/stream?output_format=${FORMAT}`,
      { text: spoken, model_id: TTS_MODEL, voice_settings: SETTINGS },
      AbortSignal.timeout(options.timeoutMs ?? 8000),
    );
    if (!response.ok || !response.body) throw new Error(`ElevenLabs voice returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let firstByteMs: number | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value.length) continue;
      firstByteMs ??= Math.round(performance.now() - started);
      chunks.push(value);
    }
    if (firstByteMs === undefined) throw new Error("ElevenLabs returned no audio.");
    mkdirSync(AUDIO_DIR, { recursive: true });
    const path = dataPath("audio", file);
    writeFileSync(`${path}.tmp`, Buffer.concat(chunks));
    renameSync(`${path}.tmp`, path);
    const entry: Entry = {
      text: spoken,
      voice: voice.name,
      model: TTS_MODEL,
      characters: spoken.length,
      firstByteMs,
      recordedAt: new Date().toISOString(),
    };
    writeData(MANIFEST, { ...readData<Record<string, Entry>>(MANIFEST, {}), [file]: entry });
    return voiced(file, entry, false);
  });
}
