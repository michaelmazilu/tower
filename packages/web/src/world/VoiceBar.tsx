import { msText } from "./data";
import type { OnAirNow } from "./conversation";

export function VoiceBar({ now, sound, playing, onSound }: { now: OnAirNow | null; sound: boolean; playing: boolean; onSound(): void }) {
  const m = now?.message;
  const speaking = playing && now?.phase === "speaking";
  const timing = sound && now?.voice === "ElevenLabs" && now.timing?.kind === "measured" ? now.timing : undefined;
  const word = !playing ? "paused" : now?.phase === "ended" ? "end of conversation" : now?.voice ?? now?.phase ?? "choose a line";
  return (
    <div className={`wv-onair ${speaking ? "live" : ""}`} role="status">
      <div className="said">
        <em>
          {m && <i className={`voice ${m.from}`} />}
          {m?.speaker ?? "radio"}
        </em>
        <p>{m?.text ?? "Choose a line in the conversation to hear it."}</p>
      </div>
      <div className="source">
        {sound ? (
          <>
            <b>{word}</b>
            {timing && (
              <small title={timing.source}>
                first byte {msText(timing.ms)} measured
                <span>{timing.source.includes("replayed from cache") || m?.audioUrl ? "cached, 0 credits" : "made live"}</span>
              </small>
            )}
          </>
        ) : (
          <button className="wv-hear" onClick={onSound}>
            <b>sound is off</b>
            press to hear
          </button>
        )}
      </div>
    </div>
  );
}
