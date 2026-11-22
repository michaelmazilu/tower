import type { Airport, ControlPosition } from "@towerai/contracts";
import { kwikqdrdist, qdrpos, rad } from "./bluesky/geo";

// Typed by hand, rounded, approximate. Runway bearings are degrees true. Frequencies are illustrative.
export interface Runway {
  id: string;
  hdg: number;
  /** NM right of the airport reference point, looking along the runway. */
  offset: number;
}

export interface Port extends Airport {
  elevFt: number;
  transitionFt: number;
  qnh: string;
  wind: string;
  landing: Runway;
  /** Used when the landing runway closes or a longer one is needed. */
  alternate: Runway;
  departing: Runway;
  units: Record<ControlPosition, [facility: string, freq: string]>;
}

type Units = [ground: string, tower: string, departure: string, approach: string, enroute: string];

function port(
  icao: string, name: string, lat: number, lon: number, elevFt: number, transitionFt: number, qnh: string, wind: string, hdg: number,
  [landing, alternate, departing]: [string, string, string], names: Units, freqs: Units, sign = 1,
): Port {
  const order = ["ground", "tower", "departure", "approach", "enroute"] as const;
  return {
    icao, name, lat, lon, elevFt, transitionFt, qnh, wind,
    landing: { id: landing, hdg, offset: -0.7 * sign },
    alternate: { id: alternate, hdg, offset: 0.9 * sign },
    departing: { id: departing, hdg, offset: 0.5 * sign },
    units: Object.fromEntries(order.map((p, i) => [p, [names[i], freqs[i]]])) as Port["units"],
  };
}

export const PORTS = {
  CYYZ: port("CYYZ", "Toronto Pearson", 43.6777, -79.6248, 569, 18000, "altimeter 2992", "240 at 12", 227,
    ["23", "24R", "24L"], ["Toronto Ground", "Toronto Tower", "Toronto Departure", "Toronto Arrival", "Toronto Centre"], ["121.9", "118.7", "128.8", "125.4", "134.425"]),
  EGLL: port("EGLL", "London Heathrow", 51.47, -0.4543, 83, 6000, "QNH 1013", "260 at 14", 270,
    ["27L", "27R", "27R"], ["Heathrow Ground", "Heathrow Tower", "London Departure", "Heathrow Director", "London Control"], ["121.9", "118.5", "119.775", "119.725", "127.425"]),
  KJFK: port("KJFK", "New York JFK", 40.6413, -73.7781, 13, 18000, "altimeter 2990", "220 at 16", 211,
    ["22L", "22R", "22R"], ["Kennedy Ground", "Kennedy Tower", "New York Departure", "New York Approach", "New York Center"], ["121.9", "119.1", "135.9", "127.4", "125.325"]),
  KLAX: port("KLAX", "Los Angeles", 33.9416, -118.4085, 128, 18000, "altimeter 2995", "250 at 9", 263,
    ["24R", "25L", "25R"], ["Los Angeles Ground", "Los Angeles Tower", "SoCal Departure", "SoCal Approach", "Los Angeles Center"], ["121.75", "120.95", "124.3", "124.9", "135.5"], -1),
  EDDF: port("EDDF", "Frankfurt", 50.0379, 8.5622, 364, 5000, "QNH 1016", "240 at 10", 249,
    ["25L", "25R", "25C"], ["Frankfurt Ground", "Frankfurt Tower", "Langen Departure", "Langen Radar", "Rhein Radar"], ["121.8", "119.9", "120.15", "120.8", "132.4"]),
  LFPG: port("LFPG", "Paris Charles de Gaulle", 49.0097, 2.5479, 392, 5000, "QNH 1015", "270 at 11", 265,
    ["26L", "26R", "26R"], ["De Gaulle Ground", "De Gaulle Tower", "De Gaulle Departure", "De Gaulle Approach", "Paris Control"], ["121.8", "119.25", "124.35", "125.825", "128.1"]),
  OMDB: port("OMDB", "Dubai", 25.2532, 55.3657, 62, 13000, "QNH 1009", "300 at 8", 301,
    ["30L", "30R", "30R"], ["Dubai Ground", "Dubai Tower", "Dubai Departure", "Dubai Director", "UAE Control"], ["118.35", "118.75", "121.025", "127.9", "124.85"]),
  WSSS: port("WSSS", "Singapore Changi", 1.3644, 103.9915, 22, 11000, "QNH 1010", "200 at 7", 203,
    ["20R", "20C", "20C"], ["Singapore Ground", "Singapore Tower", "Singapore Departure", "Singapore Arrival", "Singapore Radar"], ["124.3", "118.6", "120.3", "119.3", "133.25"]),
  RJTT: port("RJTT", "Tokyo Haneda", 35.5494, 139.7798, 21, 14000, "QNH 1012", "340 at 12", 330,
    ["34L", "34R", "34R"], ["Tokyo Ground", "Tokyo Tower", "Tokyo Departure", "Tokyo Approach", "Tokyo Control"], ["121.7", "118.1", "126.0", "119.1", "133.5"]),
  YSSY: port("YSSY", "Sydney", -33.9399, 151.1753, 21, 10000, "QNH 1018", "340 at 15", 348,
    ["34L", "34R", "34R"], ["Sydney Ground", "Sydney Tower", "Sydney Departure", "Sydney Approach", "Melbourne Centre"], ["121.7", "120.5", "123.0", "124.4", "128.4"]),
  SBGR: port("SBGR", "Sao Paulo Guarulhos", -23.4356, -46.4731, 2459, 8000, "QNH 1019", "080 at 9", 74,
    ["10L", "10R", "10R"], ["Guarulhos Ground", "Guarulhos Tower", "Sao Paulo Departure", "Sao Paulo Control", "Curitiba Centre"], ["121.7", "118.4", "129.75", "119.8", "126.75"]),
};

export type PortCode = keyof typeof PORTS;

/** A point in runway axes: NM along the landing direction from the threshold, NM right of the centreline. */
export function runwayPoint(p: Port, r: Runway, along: number, across = 0): [lat: number, lon: number] {
  const x = along - 0.9;
  const y = across + r.offset;
  const d = Math.hypot(x, y);
  return d < 1e-6 ? [p.lat, p.lon] : qdrpos(p.lat, p.lon, r.hdg + Math.atan2(y, x) / rad, d);
}

export function runwayAxes(p: Port, r: Runway, lat: number, lon: number): [along: number, across: number] {
  const [b, d] = kwikqdrdist(p.lat, p.lon, lat, lon);
  return [d * Math.cos((b - r.hdg) * rad) + 0.9, d * Math.sin((b - r.hdg) * rad) - r.offset];
}
