// One flight's radio, spoken line after line. The clock follows the voice, not the other way round.
import type { FlightRecord, Message, Timing } from "@towerai/contracts";
import { isBlocked } from "../shared/replay";
import { Speaker } from "../shared/sound";
import type { Clock } from "./useClock";

/** Between two lines, and the fast-forward over a quiet stretch. */
const BREATH_MS = 220;
const SKIP_MS = 550;
const QUIET_S = 1.5;
const REQUEST_MS = 7000;
/** A voice that never reports its end must not stop the conversation. */
const STUCK_MS = 25_000;
const START_MS = 4000;
const RATE = 1.1;

export interface OnAirNow {
  flightId: string;
  message: Message;
  phase: "getting voice" | "speaking" | "next" | "ended";
  voice?: "ElevenLabs" | "browser voice" | "text only";
  timing?: Timing;
}

interface Voice {
  url: string;
  timing?: Timing;
}

const sameOrigin = (url?: string) => (url && /^\/(?!\/)/.test(url) ? url : undefined);
export const sayable = (f: FlightRecord) => f.messages.filter((m) => !isBlocked(m) && m.text);

/** The line in progress at `t`, or else the next one. */
export function lineAt(f: FlightRecord, t: number): Message | undefined {
  return sayable(f).find((m) => m.t + m.durationS >= t);
}

/** Where a click starts: recorded voice, the exchange going on now, the notable one, or the nearest. */
export function openingLine(f: FlightRecord, t: number): Message | undefined {
  const lines = sayable(f);
  const recorded = lines.find((m) => sameOrigin(m.audioUrl));
  if (recorded) return recorded;
  let found: Message | undefined;
  for (const m of lines) if (!found || Math.abs(m.t - t) < Math.abs(found.t - t)) found = m;
  if (!found) return undefined;
  if (Math.abs(found.t - t) > 60) {
    const event = f.markers.find((m) => m.kind === "emergency" || m.kind === "escalation" || m.kind === "conflict");
    found =
      lines.find((m) => m.kind === "emergency" || m.kind === "escalation") ??
      (event && lines.find((m) => m.t >= event.t - 8)) ??
      found;
  }
  // From the call that began the exchange, so that the answer makes sense.
  let i = lines.indexOf(found);
  for (let n = 0; n < 3 && i > 0 && lines[i]!.replyTo === lines[i - 1]!.id; n++) i--;
  return lines[i];
}

export class Conversation {
  private flight: FlightRecord | null = null;
  private lines: Message[] = [];
  private i = 0;
  private sound = false;
  private paused = false;
  private turn = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private audio: HTMLAudioElement | null = null;
  private readonly browser = new Speaker();
  private readonly got = new Map<string, Voice>();
  private readonly asking = new Map<string, { abort: AbortController; voice: Promise<Voice | null> }>();

  constructor(
    private readonly clock: Pick<Clock, "now" | "duration" | "seek" | "hold" | "setSpeed">,
    private readonly changed: (now: OnAirNow | null) => void,
  ) {}

  /** `delayMs` is for scrubbing, so that a drag does not buy every line it passes. */
  play(flight: FlightRecord, m: Message | undefined, delayMs = 0): void {
    this.silence();
    this.flight = flight;
    this.lines = sayable(flight);
    this.i = m ? this.lines.findIndex((x) => x.id === m.id) : -1;
    if (this.i < 0) this.i = this.lines.length;
    this.keepOnly([this.lines[this.i]]);
    if (!delayMs) return this.run();
    this.changed(null);
    this.clock.hold(this.clock.now());
    this.later(delayMs, () => this.run());
  }

  setSound(on: boolean): void {
    if (on === this.sound) return;
    this.sound = on;
    if (!on) this.keepOnly([]);
    if (this.flight && !this.paused && this.i < this.lines.length) {
      this.silence();
      this.run();
    }
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!this.flight) return;
    this.silence();
    if (paused) this.keepOnly([]);
    else this.run();
  }

  stop(): void {
    this.silence();
    this.keepOnly([]);
    this.flight = null;
    this.clock.hold(null);
    this.changed(null);
  }

  private silence(): void {
    this.turn++;
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    this.audio?.pause();
    this.audio = null;
    this.browser.stop();
  }

  private later(ms: number, what: () => void): void {
    const turn = this.turn;
    this.timers.push(setTimeout(() => turn === this.turn && what(), ms));
  }

  private run(): void {
    const { flight, clock } = this;
    const m = this.lines[this.i];
    if (!flight) return;
    if (!m) {
      clock.hold(null);
      clock.setSpeed(1);
      return this.changed(null);
    }
    const next = this.lines[this.i + 1];
    clock.seek(m.t + 0.01);
    clock.setSpeed(1);
    // The aircraft keep moving under the voice, but never into the next line.
    clock.hold(Math.min(clock.duration - 0.05, Math.max(m.t + 0.01, next ? next.t - 0.05 : m.t + m.durationS)));
    const show = (phase: OnAirNow["phase"], voice?: OnAirNow["voice"], timing?: Timing) =>
      this.changed({ flightId: flight.summary.id, message: m, phase, voice, timing });
    if (this.paused) return show("next");
    if (!this.sound) {
      show("speaking", "text only");
      return this.later(Math.max(2, m.durationS) * 1000, () => this.finish(show));
    }
    this.keepOnly([m, next]);
    const turn = this.turn;
    show("getting voice");
    void this.voiceOf(flight, m).then((voice) => {
      if (turn !== this.turn) return;
      if (voice) this.playFile(flight, m, voice, show);
      else this.playBrowser(m, show);
    });
  }

  private playFile(flight: FlightRecord, m: Message, voice: Voice, show: (p: OnAirNow["phase"], v?: OnAirNow["voice"], t?: Timing) => void): void {
    const audio = new Audio(voice.url);
    audio.playbackRate = RATE;
    this.audio = audio;
    const mine = () => this.audio === audio;
    let started = false;
    const fail = () => {
      if (!mine()) return;
      this.audio = null;
      audio.pause();
      this.got.delete(m.id);
      if (started) this.finish(show);
      else this.playBrowser(m, show);
    };
    const ended = () => {
      if (!mine()) return;
      this.audio = null;
      this.finish(show, "ElevenLabs", voice.timing);
    };
    audio.onended = ended;
    audio.onerror = fail;
    this.later(START_MS, () => !started && fail());
    this.later(STUCK_MS, fail);
    audio.play().then(() => {
      if (!mine()) return;
      started = true;
      show("speaking", "ElevenLabs", voice.timing);
      // The one line ahead, and only once this one is being heard.
      const next = this.lines[this.i + 1];
      if (next) void this.voiceOf(flight, next);
    }, fail);
  }

  private playBrowser(m: Message, show: (p: OnAirNow["phase"], v?: OnAirNow["voice"], t?: Timing) => void): void {
    this.browser.say({ text: m.text, pilot: m.from === "pilot" || m.speaker.endsWith("(simulated)") ? m.speaker : undefined }, RATE);
    if (!this.browser.busy) {
      show("speaking", "text only");
      return this.later(Math.max(2, m.durationS) * 1000, () => this.finish(show));
    }
    show("speaking", "browser voice");
    const until = Date.now() + Math.min(STUCK_MS, m.text.length * 120 + 4000);
    const wait = () => {
      if (this.browser.busy && Date.now() < until) return this.later(120, wait);
      this.browser.stop();
      this.finish(show, "browser voice");
    };
    this.later(120, wait);
  }

  private finish(show: (p: OnAirNow["phase"], v?: OnAirNow["voice"], t?: Timing) => void, voice?: OnAirNow["voice"], timing?: Timing): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    const next = this.lines[++this.i];
    show(next ? "next" : "ended", voice, timing);
    if (!next) return this.clock.hold(null);
    const now = this.clock.now();
    const quiet = next.t - now;
    this.clock.hold(Math.max(now, next.t - 0.01));
    if (quiet > QUIET_S) this.clock.setSpeed(quiet / (SKIP_MS / 1000));
    this.later(quiet > QUIET_S ? SKIP_MS : BREATH_MS, () => this.run());
  }

  private keepOnly(wanted: (Message | undefined)[]): void {
    for (const [id, { abort }] of this.asking) {
      if (wanted.some((m) => m?.id === id)) continue;
      abort.abort();
      this.asking.delete(id);
    }
  }

  private voiceOf(flight: FlightRecord, m: Message): Promise<Voice | null> {
    const recorded = sameOrigin(m.audioUrl);
    if (recorded) return Promise.resolve({ url: recorded, timing: m.timings.find((x) => x.stage === "voice" && x.kind === "measured") });
    if (m.from === "operator") return Promise.resolve(null);
    const held = this.got.get(m.id);
    if (held) return Promise.resolve(held);
    const pending = this.asking.get(m.id);
    if (pending) return pending.voice;
    const abort = new AbortController();
    const limit = setTimeout(() => abort.abort(), REQUEST_MS);
    const ask = async (): Promise<Voice | null> => {
      try {
        const res = await fetch("/api/world/voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ flightId: flight.summary.id, messageId: m.id }),
          signal: abort.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok: boolean; audioUrl?: string; timing?: Timing };
        const url = body.ok ? sameOrigin(body.audioUrl) : undefined;
        if (!url) return null;
        const voice = { url, timing: body.timing };
        this.got.set(m.id, voice);
        return voice;
      } catch {
        // No server, no credits or no time: the browser reads it out.
        return null;
      } finally {
        clearTimeout(limit);
      }
    };
    const entry = { abort, voice: ask() };
    this.asking.set(m.id, entry);
    void entry.voice.then(() => this.asking.get(m.id) === entry && this.asking.delete(m.id));
    return entry.voice;
  }
}
