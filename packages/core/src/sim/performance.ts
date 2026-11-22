/** Minimal per-type numbers. One shared flight model; only the speeds differ. */
export interface Performance {
  /** Rotation speed, knots. */
  vr: number;
  /** Final approach speed, knots. */
  vapp: number;
  wake: "L" | "M" | "H";
}

const TABLE: Record<string, Performance> = {
  A319: { vr: 135, vapp: 130, wake: "M" },
  A320: { vr: 140, vapp: 135, wake: "M" },
  A321: { vr: 148, vapp: 140, wake: "M" },
  A333: { vr: 150, vapp: 140, wake: "H" },
  B38M: { vr: 142, vapp: 138, wake: "M" },
  B739: { vr: 148, vapp: 142, wake: "M" },
  B77W: { vr: 160, vapp: 148, wake: "H" },
  B789: { vr: 155, vapp: 142, wake: "H" },
  CRJ9: { vr: 135, vapp: 132, wake: "M" },
  E175: { vr: 132, vapp: 128, wake: "M" },
  DH8D: { vr: 115, vapp: 120, wake: "M" },
};

const DEFAULT: Performance = { vr: 140, vapp: 135, wake: "M" };

export function performance(type: string): Performance {
  return TABLE[type.toUpperCase()] ?? DEFAULT;
}

export const KNOWN_TYPES = Object.keys(TABLE);
