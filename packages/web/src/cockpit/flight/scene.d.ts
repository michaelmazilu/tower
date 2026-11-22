import type { CockpitState } from "@towerai/contracts";
import type { AirportData } from "@towerai/core";

export interface Palette {
  black: string;
  g900: string;
  g800: string;
  g600: string;
  g400: string;
  g200: string;
  white: string;
  red: string;
}

/** Throws where there is no WebGL. */
export function createFlightScene(
  canvas: HTMLCanvasElement,
  airport: AirportData,
  palette: Palette,
  first: CockpitState,
): { report(state: CockpitState): void; dispose(): void };
