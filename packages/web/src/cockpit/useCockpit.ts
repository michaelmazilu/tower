import { useCallback, useEffect, useRef, useState } from "react";
import type { CockpitState, Exchange } from "@towerai/contracts";
import { get, post } from "../ops/useOps";
import { Speaker } from "../shared/sound";

const POLL_MS = 250;
const MIN_MS = 300;
const MAX_MS = 12_000;
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export type Mic = "unasked" | "asking" | "ready" | "blocked";
export type Phase = "idle" | "listening" | "thinking" | "speaking";

const mimeFor = () => MIMES.find((m) => MediaRecorder.isTypeSupported(m));
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));

export function useCockpit() {
  const [state, setState] = useState<CockpitState | null>(null);
  const [lost, setLost] = useState(false);
  const [mic, setMic] = useState<Mic>("unasked");
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ runId?: string; exchange: Exchange } | null>(null);
  const r = useRef({
    alive: false,
    held: false,
    /** The seq of the call the tower is answering. A press then would throw that answer away. */
    sending: 0,
    seq: 0,
    runId: undefined as string | undefined,
    speaker: new Speaker(),
    stream: null as MediaStream | null,
    opening: null as Promise<MediaStream | null> | null,
    recorder: null as MediaRecorder | null,
    limit: undefined as ReturnType<typeof setTimeout> | undefined,
  }).current;

  const refresh = useCallback(async () => {
    try {
      const next = await get<CockpitState>("/api/cockpit");
      if (!r.alive) return;
      if (r.runId && r.runId !== next.runId) setAnswer(null);
      r.runId = next.runId;
      setState(next);
      setLost(false);
    } catch {
      if (r.alive) setLost(true);
    }
  }, [r]);

  const send = useCallback(async (path: string, body: Blob | string, type: string) => {
    const seq = ++r.seq;
    r.sending = seq;
    r.speaker.stop();
    setPhase("thinking");
    setNote("");
    let reply: { ok?: boolean; exchange?: Exchange; message?: string };
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": type }, body, signal: AbortSignal.timeout(25_000) });
      reply = await res.json();
      if (!res.ok) reply.ok = false;
    } catch {
      reply = { ok: false, message: "The tower did not answer. Try again, or type it." };
    }
    if (r.sending === seq) r.sending = 0;
    if (!r.alive) return;
    // A newer press or a reset owns the radio now.
    if (seq !== r.seq) return void refresh();
    setSent(null);
    if (reply.ok === false || !reply.exchange) {
      setNote(reply.message ?? "The tower did not catch that. Try again, or type it.");
      setPhase("idle");
    } else {
      r.speaker.say({ text: reply.exchange.said, url: reply.exchange.audioUrl });
      setAnswer({ runId: r.runId, exchange: reply.exchange });
      setPhase(r.speaker.busy ? "speaking" : "idle");
    }
    void refresh();
  }, [r, refresh]);

  const release = useCallback(() => {
    r.held = false;
    clearTimeout(r.limit);
    if (r.recorder?.state === "recording") r.recorder.stop();
    r.recorder = null;
  }, [r]);

  const record = useCallback((stream: MediaStream) => {
    try {
      const mimeType = mimeFor();
      const rec = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      const seq = ++r.seq;
      let began = 0;
      rec.onstart = () => (began = performance.now());
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        if (!r.alive || seq !== r.seq) return;
        const type = rec.mimeType || chunks[0]?.type || "audio/webm";
        if (began && chunks.length && performance.now() - began >= MIN_MS) return void send("/api/cockpit/talk", new Blob(chunks, { type }), type);
        setPhase("idle");
        setNote("Too short. Keep holding space while you talk.");
      };
      rec.start();
      r.recorder = rec;
      r.limit = setTimeout(release, MAX_MS);
      setPhase("listening");
      setSent(null);
      setNote("");
    } catch {
      setMic("blocked");
      setPhase("idle");
      setNote("This browser cannot record. Open this page in Chrome, Safari or Vivaldi.");
    }
  }, [r, release, send]);

  /** One request for the microphone at a time, shared by the screen opening and by the key. */
  const openMic = useCallback(() => {
    if (r.stream?.getAudioTracks().some((t) => t.readyState === "live")) return Promise.resolve(r.stream);
    if (r.opening) return r.opening;
    const asked = (async () => {
      setMic("asking");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        // Permission can be answered after the screen has gone.
        if (!r.alive) {
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
        r.stream = stream;
        setMic("ready");
        setNote("");
        return stream;
      } catch {
        r.held = false;
        if (!r.alive) return null;
        setMic("blocked");
        setNote("The microphone is blocked. Allow it in the address bar, then hold space again.");
        return null;
      }
    })();
    r.opening = asked;
    void asked.finally(() => (r.opening = null));
    return asked;
  }, [r]);

  const press = useCallback(async () => {
    if (r.held || r.sending) return;
    r.held = true;
    r.speaker.stop();
    setPhase((p) => (p === "speaking" ? "idle" : p));
    const stream = await openMic();
    if (stream && r.held && !r.recorder) record(stream);
  }, [r, openMic, record]);

  useEffect(() => {
    r.alive = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      r.alive = false;
      release();
      r.speaker.stop();
      r.stream?.getTracks().forEach((t) => t.stop());
      r.stream = null;
    };
  }, [r, refresh, release]);

  const canTalk = !!state?.speech.available;
  // Ask as the screen opens, so the first hold of the key is already heard.
  useEffect(() => {
    if (canTalk) void openMic();
  }, [canTalk, openMic]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat && canTalk) void press();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      // A focused button would take the released space as a click.
      if (!typing(e.target)) e.preventDefault();
      release();
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", release);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", release);
    };
  }, [canTalk, press, release]);

  useEffect(() => {
    if (phase !== "speaking") return;
    const timer = setInterval(() => !r.speaker.busy && setPhase("idle"), 150);
    return () => clearInterval(timer);
  }, [phase, r]);

  // The tower also calls first: the way home, the landing clearance. Those arrive by polling.
  const heardCalls = useRef(new Set<string>()).current;
  useEffect(() => {
    if (!state || phase !== "idle" || r.held) return;
    const call = state.exchanges.find(
      // Its voice follows the words by a moment. totalMs is set when that is settled.
      (e) => !e.heard && !heardCalls.has(e.id) && (!!e.audioUrl || !state.speech.available || e.timings.totalMs > 0),
    );
    if (!call) return;
    heardCalls.add(call.id);
    r.speaker.say({ text: call.said, url: call.audioUrl });
    if (r.speaker.busy) setPhase("speaking");
  }, [state, phase, r, heardCalls]);

  const say = (text: string) => {
    if (!text.trim() || r.sending) return;
    // Cancels a recording still in progress: the newest thing said wins.
    r.seq++;
    release();
    setSent(text.trim());
    void send("/api/cockpit/say", JSON.stringify({ text: text.trim() }), "application/json");
  };

  const command = async (path: string, body: object = {}) => {
    if (path.endsWith("/reset")) {
      r.seq++;
      r.sending = 0;
      release();
      r.speaker.stop();
      setPhase("idle");
      setAnswer(null);
      setSent(null);
      setNote("");
    }
    const reply = await post(path, body);
    if (!reply.ok) setNote(reply.message ?? "The tower refused that.");
    void refresh();
  };

  let exchanges = state?.exchanges ?? [];
  if (answer && answer.runId === state?.runId && !exchanges.some((e) => e.id === answer.exchange.id)) exchanges = [...exchanges, answer.exchange];

  return { state, lost, mic, phase, note, sent, exchanges, canTalk, press, release, say, command };
}
