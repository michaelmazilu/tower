import { useEffect, useRef } from "react";
import type { Message } from "@towerai/contracts";
import { isBlocked } from "../shared/replay";
import { Speaker } from "../shared/sound";

const STEP_MS = 80;
/** Through the quiet between lines. A line being spoken plays at 1x. */
const QUIET_RATE = 4;
/** A browser voice can fail to say it has finished. Playback must not wait on it for ever. */
const LONGEST_LINE_MS = 15000;

interface Replay {
  cursor: number | null;
  playing: boolean;
  audible: boolean;
  messages: readonly Message[];
  /** The newest moment: playback hands back to live there. */
  end: number;
  onMove(t: number): void;
  onEnd(): void;
}

/** Plays a flight's history, saying each of its lines and letting one finish before the next. */
export function useReplay(replay: Replay): void {
  const latest = useRef(replay);
  latest.current = replay;
  const running = replay.cursor !== null && replay.playing;

  useEffect(() => {
    if (!running) return;
    const speaker = new Speaker();
    const said = new Set<string>();
    let from = latest.current.cursor!;
    let at = from;
    let spokeAt = 0;

    const timer = setInterval(() => {
      const { cursor, audible, messages, end, onMove, onEnd } = latest.current;
      if (cursor === null) return;
      if (cursor !== at) {
        // Dragged or clicked to another moment.
        speaker.stop();
        said.clear();
        from = at = cursor;
      }
      if (!audible) speaker.stop();
      const talking = speaker.busy && Date.now() - spokeAt < LONGEST_LINE_MS;
      let next = at + (STEP_MS / 1000) * (talking ? 1 : QUIET_RATE);
      const due = messages.find((m) => !said.has(m.id) && m.t <= next && m.t + m.durationS > from && !isBlocked(m));
      if (due) {
        if (talking) return; // hold here until the line before it has been heard
        said.add(due.id);
        if (audible) {
          speaker.stop();
          speaker.say({
            text: due.text,
            url: due.audioUrl?.startsWith("/api/audio/") ? due.audioUrl : undefined,
            pilot: due.from === "operator" || /^Toronto /.test(due.speaker) ? undefined : due.speaker,
          });
          spokeAt = Date.now();
          next = Math.max(at, Math.min(next, due.t));
        }
      } else if (next >= end) {
        if (!talking) onEnd();
        return;
      }
      at = next;
      onMove(at);
    }, STEP_MS);

    return () => {
      clearInterval(timer);
      speaker.stop();
    };
  }, [running]);
}
