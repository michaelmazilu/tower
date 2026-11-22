import type { Profile } from "./openap/gen";

/** Own approximate figures: round, typical values as publicly quoted. Not from OpenAP or BlueSky data. */
export interface Perf extends Profile {
  heavy: boolean;
  ceilingFt: number;
}

const narrow = (climbCasKt: number, mach: number, approachCasKt: number, ceilingFt: number): Perf => ({
  heavy: false, climbCasKt, descentCasKt: climbCasKt, mach, approachCasKt, ceilingFt,
  climbFpm: [2500, 2400, 2000, 1200],
  descentFpm: [2000, 2300, 1600, 750],
});
const wide = (climbCasKt: number, mach: number, approachCasKt: number, ceilingFt: number): Perf => ({
  heavy: true, climbCasKt, descentCasKt: climbCasKt, mach, approachCasKt, ceilingFt,
  climbFpm: [2200, 2000, 1700, 1000],
  descentFpm: [2000, 2200, 1500, 750],
});

export const PERF = {
  A20N: narrow(290, 0.78, 135, 39000),
  A21N: narrow(300, 0.78, 140, 39000),
  B738: narrow(280, 0.78, 145, 41000),
  B38M: narrow(280, 0.79, 145, 41000),
  E190: narrow(290, 0.78, 135, 41000),
  BCS3: narrow(280, 0.78, 130, 41000),
  A333: wide(300, 0.82, 140, 41000),
  A359: wide(300, 0.85, 140, 43000),
  B789: wide(310, 0.85, 145, 43000),
  B77W: wide(310, 0.84, 150, 43000),
  A388: wide(320, 0.85, 140, 43000),
} satisfies Record<string, Perf>;

export type TypeCode = keyof typeof PERF;
