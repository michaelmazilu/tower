import { useEffect, useRef, useState } from "react";
import type { CockpitState } from "@towerai/contracts";
import type { AirportData } from "@towerai/core";
import { Windscreen } from "./Windscreen";
import { createFlightScene } from "./flight/scene";

/** The aircraft from outside. Without WebGL, the flat view from the seat. */
export function Flight3D({ airport, state }: { airport: AirportData; state: CockpitState }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<ReturnType<typeof createFlightScene> | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const [flatView, setFlatView] = useState(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
    const palette = { black: v("black"), g900: v("grey-900"), g800: v("grey-800"), g600: v("grey-600"), g400: v("grey-400"), g200: v("grey-200"), white: v("white"), red: v("red") };
    try {
      scene.current = createFlightScene(el, airport, palette, latest.current);
    } catch (error) {
      console.warn("3D view unavailable:", error instanceof Error ? error.message : error);
      setFlatView(true);
    }
    const lost = () => setFlatView(true);
    el.addEventListener("webglcontextlost", lost);
    return () => {
      el.removeEventListener("webglcontextlost", lost);
      scene.current?.dispose();
      scene.current = null;
    };
  }, [airport, flatView]);

  useEffect(() => scene.current?.report(state), [state]);

  if (flatView) return <Windscreen airport={airport} state={state} />;
  return <canvas ref={canvas} aria-label="Your aircraft at Toronto Pearson, in 3D" />;
}
