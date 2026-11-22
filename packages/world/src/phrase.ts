import type { Body } from "./body";
import { kwikqdrdist, mod, turn } from "./bluesky/geo";
import type { TypeCode } from "./perf";

export function level(ft: number, transitionFt = 18000): string {
  return ft >= transitionFt ? `flight level ${String(Math.round(ft / 100)).padStart(3, "0")}` : `${Math.round(ft / 100) * 100} feet`;
}

export function shortLevel(ft: number, transitionFt = 18000): string {
  return ft >= transitionFt ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : `${Math.round(ft / 100) * 100} ft`;
}

export function bearing(deg: number): string {
  return String(Math.round(mod(deg, 360)) || 360).padStart(3, "0");
}

export const direction = (from: number, to: number) => (turn(from, to) < 0 ? "left" : "right");
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CITY: Record<string, string> = {
  CYVR: "Vancouver", KMCO: "Orlando", KJFK: "New York Kennedy", KLAS: "Las Vegas", KPHX: "Phoenix", LEMD: "Madrid", EDDM: "Munich",
  EGLL: "London Heathrow", KSFO: "San Francisco", SBRF: "Recife",
};
export const city = (icao: string) => CITY[icao] ?? icao;

export const TYPE_NAME: Record<TypeCode, string> = {
  A20N: "Airbus A320", A21N: "Airbus A321", B738: "Boeing 737", B38M: "Boeing 737 MAX", E190: "Embraer 190", BCS3: "Airbus A220",
  A333: "Airbus A330", A359: "Airbus A350", B789: "Boeing 787", B77W: "Boeing 777", A388: "Airbus A380",
};

export function trafficCall(own: Body, other: Body, type: TypeCode): string {
  const [b, d] = kwikqdrdist(own.lat, own.lon, other.lat, other.lon);
  const clock = mod(Math.round(turn(own.hdg, b) / 30), 12) || 12;
  const delta = Math.abs(turn(own.hdg, other.hdg));
  const way = delta < 30 ? "same direction" : delta > 150 ? "opposite direction" : turn(own.hdg, other.hdg) < 0 ? "crossing right to left" : "crossing left to right";
  const dv = Math.round((other.altFt - own.altFt) / 100) * 100;
  const vertical = dv === 0 ? "same level" : `${Math.abs(dv)} feet ${dv > 0 ? "above" : "below"}`;
  return `traffic, ${clock} o'clock, ${Math.max(1, Math.round(d))} miles, ${way}, ${TYPE_NAME[type]}, ${vertical}`;
}
