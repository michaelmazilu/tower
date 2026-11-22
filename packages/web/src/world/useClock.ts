import { useEffect, useMemo, useState } from "react";

/**
 * The map reads `now()` on every frame; React re-renders at 8 Hz for the words
 * and numbers. Seeking and controls render at once.
 */
export function useClock(duration: number, start: number) {
  const [, render] = useState(0);
  const clock = useMemo(() => {
    let base = start;
    let since = performance.now();
    let playing = true;
    let speed = 15;
    const now = () => {
      const t = playing ? base + ((performance.now() - since) / 1000) * speed : base;
      return Math.min(duration, Math.max(0, t));
    };
    const rebase = (t = now()) => {
      base = Math.min(duration, Math.max(0, t));
      since = performance.now();
      render((n) => n + 1);
    };
    return {
      now,
      duration,
      get playing() {
        return playing;
      },
      get speed() {
        return speed;
      },
      seek: (t: number) => rebase(t),
      setPlaying(next: boolean) {
        rebase(next && now() >= duration ? 0 : undefined);
        playing = next;
        render((n) => n + 1);
      },
      setSpeed(next: number) {
        rebase();
        speed = next;
        render((n) => n + 1);
      },
    };
  }, [duration, start]);

  useEffect(() => {
    const id = setInterval(() => {
      if (clock.playing) render((n) => n + 1);
    }, 125);
    return () => clearInterval(id);
  }, [clock]);

  return clock;
}

export type Clock = ReturnType<typeof useClock>;
