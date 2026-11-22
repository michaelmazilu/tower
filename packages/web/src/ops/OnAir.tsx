import { useEffect, useRef, useState } from "react";
import type { OpsState } from "@towerai/contracts";
import { Speaker, voiceKind, type Sound } from "../shared/sound";
import { post } from "./useOps";

const SPEEDS = [1, 2, 4];
/** Where each beat of the judge scenario begins, for skipping the quiet between them. */
const BEATS: [name: string, at: number][] = [["incursion", 12], ["human call", 24], ["weather", 46], ["mayday", 76], ["closure", 100], ["landing", 292]];
/** The server's limit on one step. */
const MOST_STEPS = 6000;

export function OnAir({ ops, muted, sound, nameOf, onOpen, refresh }: {
  ops: OpsState; muted: boolean; sound: Sound; nameOf(id: string): string; onOpen(id: string): void; refresh(): void;
}) {
  const { onAir, voice } = ops;
  const [failed, setFailed] = useState<string | null>(null);
  const speaker = useRef(new Speaker());
  const audioUrl = onAir?.audioUrl?.startsWith("/api/audio/") ? onAir.audioUrl : undefined;
  const line = onAir ? `${onAir.flightId}|${onAir.speaker}|${onAir.text}` : "";
  const audible = sound.on && sound.ready && !muted && !ops.paused && ops.speed <= 1;

  useEffect(() => {
    if (!audible) speaker.current.stop();
  }, [audible]);

  useEffect(() => {
    if (!audible || !onAir) return;
    // Crews and responders each keep a voice of their own.
    const controller = /^Toronto |^Operator$/.test(onAir.speaker);
    speaker.current.say({ text: onAir.text, url: audioUrl, pilot: controller ? undefined : onAir.speaker });
  }, [audible, line]);

  useEffect(() => () => speaker.current.stop(), []);

  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setFailed(null), 4000);
    return () => clearTimeout(timer);
  }, [failed]);

  const send = async (path: string, body?: unknown) => {
    const res = await post(path, body);
    setFailed(res.ok ? null : (res.message ?? "That control did not work."));
    refresh();
  };
  const beat = BEATS.find(([, at]) => at > ops.t + 1);
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(ops.speed) + 1) % SPEEDS.length]!;

  return (
    <footer className="air">
      <div className={`air-now ${onAir ? "air-on" : ""}`}>
        <div className="air-tag">
          <i />
          <span>{onAir ? "on air" : "standby"}</span>
        </div>
        <div className="air-line">
          <p className="air-from">
            {onAir ? (
              <>
                <b>{onAir.speaker}</b>
                {onAir.flightId && nameOf(onAir.flightId) !== onAir.speaker && (
                  <button onClick={() => onOpen(onAir.flightId!)}>{nameOf(onAir.flightId)}</button>
                )}
                <span>{muted ? "live, muted during replay" : ops.speed > 1 ? "sound plays at 1x" : voiceKind(audioUrl)}</span>
              </>
            ) : (
              <span>{voice.available ? `${voice.label}. Browser voice for the rest` : "Browser voice"}</span>
            )}
          </p>
          <p className="air-words" role="status">{failed ?? (ops.paused && !onAir ? "Paused." : (onAir?.text ?? "Frequency clear."))}</p>
        </div>
      </div>
      <button
        className={`btn ${sound.on && !sound.ready ? "btn-red" : sound.on ? "btn-on" : ""}`}
        title={`${voice.label}. Lines without a recording use a voice installed on this computer.`}
        aria-pressed={sound.on}
        onClick={sound.press}
      >
        <b>{sound.on ? (sound.ready ? "on" : "press") : "off"}</b>
        <span>{sound.on && !sound.ready ? "for sound" : "sound"}</span>
      </button>
      <button className={`btn ${ops.paused ? "btn-on" : ""}`} onClick={() => void send("/api/sim/control", { action: ops.paused ? "resume" : "pause" })}>
        <i className={ops.paused ? "glyph-play" : "glyph-pause"} />
        <span>{ops.paused ? "resume" : "pause"}</span>
      </button>
      <button className="btn" onClick={() => void send("/api/sim/control", { action: "speed", speed: nextSpeed })}>
        <b className="btn-number">{ops.speed}x</b>
        <span>speed</span>
      </button>
      <button
        className="btn air-skip"
        disabled={!beat}
        title={beat ? `Run the simulation ahead to the ${beat[0]}` : "The scripted beats have all started"}
        onClick={() => beat && void send("/api/sim/control", { action: "step", steps: Math.min(MOST_STEPS, Math.ceil((beat[1] - ops.t) * 10)) })}
      >
        <b>{beat ? beat[0] : "done"}</b>
        <span>skip to</span>
      </button>
      <button className="btn" onClick={() => void send("/api/demo/restart")}>
        <i className="glyph-restart" />
        <span>restart</span>
      </button>
    </footer>
  );
}
