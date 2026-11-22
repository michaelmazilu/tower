import { useEffect, useState } from "react";

/**
 * Recorded lines play their file. Every other line can be read out by a voice that is
 * installed on this computer: offline, free, and labelled as a browser voice wherever shown.
 */

const KEY = "towerai.sound";
/** Plain installed voices. Anything else on a Mac is mostly novelty. */
const CONTROLLER_VOICES = ["Daniel", "Alex", "Microsoft David"];
const PILOT_VOICES = ["Samantha", "Karen", "Moira", "Rishi", "Tessa", "Fred", "Microsoft Zira", "Microsoft Mark"];
const RATE = 1.3;
/** The last word of a line may run this far into the next. */
const FINISH_MS = 1400;

const AIRLINES: Record<string, string> = {
  ACA: "Air Canada", ROU: "Rouge", JZA: "Jazz", WJA: "WestJet", WEN: "Encore", POE: "Porter", TSC: "Air Transat", SWG: "Sunwing",
  FLE: "Flair", DAL: "Delta", UAL: "United", AAL: "American", BAW: "Speedbird", AFR: "Air France", DLH: "Lufthansa", KLM: "K L M",
};
const SIDE: Record<string, string> = { L: " left", R: " right", C: " centre" };
const digits = (value: string) => [...value].map((c) => (c === "9" ? "niner" : c)).join(" ");

/** Numbers as they are said on the radio: "heading 070", not "heading seventy". */
export function radioWords(text: string): string {
  return text
    .replace(/ \(cut off by priority traffic\)/, "")
    .replace(/\b([A-Z]{3})(\d{1,4})\b/g, (all, code: string, n: string) => (AIRLINES[code] ? `${AIRLINES[code]} ${digits(n)}` : all))
    .replace(/\b(\d{2})([LRC])\b/g, (_, n: string, side: string) => `${digits(n)}${SIDE[side]}`)
    .replace(/\b(\d{1,2}),?000\b/g, (_, n: string) => `${digits(n)} thousand`)
    .replace(/(\d)\.(\d)/g, "$1 decimal $2")
    .replace(/\d+/g, digits);
}

const synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
let voices: SpeechSynthesisVoice[] = [];
const loadVoices = () => {
  // Local only: a remote voice would send the words to someone else.
  voices = synth?.getVoices().filter((v) => v.localService && v.lang.startsWith("en")) ?? [];
};
loadVoices();
synth?.addEventListener?.("voiceschanged", loadVoices);

export const canSpeak = () => voices.length > 0;

function voiceFor(pilot: string | undefined): SpeechSynthesisVoice | undefined {
  const named = (names: string[]) => names.flatMap((name) => voices.find((v) => v.name.startsWith(name)) ?? []);
  if (!pilot) return named(CONTROLLER_VOICES)[0] ?? voices[0];
  const choice = named(PILOT_VOICES);
  let hash = 0;
  for (const c of pilot) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return choice.length ? choice[hash % choice.length] : voices.find((v) => v !== voiceFor(undefined)) ?? voices[0];
}

export interface Spoken {
  text: string;
  /** Set for anyone who is not the controller, so that each keeps a voice. */
  pilot?: string;
  url?: string;
}

export const voiceKind = (url?: string) => (url ? "recorded voice" : canSpeak() ? "browser voice" : "text only");

/** One line at a time. A new line lets the old one finish its last word, then takes over. */
export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private words: SpeechSynthesisUtterance | null = null;
  private next: Spoken | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  say(line: Spoken, rate = 1): void {
    if (!this.audio && !this.words) return this.start(line, rate);
    this.next = line;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.advance(rate), FINISH_MS);
  }

  get busy(): boolean {
    return !!(this.audio || this.words);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.next = null;
    this.silence();
  }

  private silence(): void {
    this.audio?.pause();
    this.audio = null;
    if (this.words) synth?.cancel();
    this.words = null;
  }

  private advance(rate: number): void {
    const line = this.next;
    if (!line) return;
    clearTimeout(this.timer);
    this.next = null;
    this.silence();
    this.start(line, rate);
  }

  private start(line: Spoken, rate: number): void {
    const done = (what: unknown) => {
      if (what !== this.audio && what !== this.words) return;
      this.audio = null;
      this.words = null;
      this.advance(rate);
    };
    if (line.url) {
      const audio = new Audio(line.url);
      audio.playbackRate = rate;
      audio.onended = audio.onerror = () => done(audio);
      this.audio = audio;
      // A missing file leaves the caption, which is the record.
      audio.play().catch(() => done(audio));
      return;
    }
    const voice = voiceFor(line.pilot);
    if (!synth || !voice) return;
    const words = new SpeechSynthesisUtterance(radioWords(line.text));
    words.voice = voice;
    words.lang = voice.lang;
    words.rate = RATE * rate;
    words.onend = words.onerror = () => done(words);
    this.words = words;
    synth.speak(words);
  }
}

export interface Sound {
  on: boolean;
  /** False after a reload until the page has been pressed: browsers stay silent until then. */
  ready: boolean;
  press(): void;
}

export function useSound(): Sound {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "on";
    } catch {
      return false;
    }
  });
  const [ready, setReady] = useState(() => navigator.userActivation?.hasBeenActive ?? false);
  useEffect(() => {
    if (ready) return;
    const arm = () => setReady(true);
    // On the way back up, so that the press that arms it is not also the press that turns it off.
    addEventListener("click", arm);
    addEventListener("keydown", arm);
    return () => {
      removeEventListener("click", arm);
      removeEventListener("keydown", arm);
    };
  }, [ready]);
  const press = () => {
    const next = on && !ready ? true : !on;
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // Private browsing: it just is not remembered.
    }
  };
  return { on, ready, press };
}
