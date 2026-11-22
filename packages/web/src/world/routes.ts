import type { FlightRecord, WorldRecording } from "@towerai/contracts";
import { greatCircle, nearX, project, type XY } from "./geo";

// Where a flight's filed route starts and ends, beyond the airports in the recording.
// Typed by hand, rounded, approximate: for drawing only.
const ELSEWHERE: Record<string, [lat: number, lon: number]> = {
  CYUL: [45.47, -73.74], CYVR: [49.19, -123.18], CYYC: [51.11, -114.02], EBBR: [50.9, 4.48], EDDM: [48.35, 11.79],
  EHAM: [52.31, 4.76], EIDW: [53.42, -6.27], EKCH: [55.62, 12.65], EPWA: [52.17, 20.97], KATL: [33.64, -84.43],
  KBOS: [42.36, -71.01], KDEN: [39.86, -104.67], KDFW: [32.9, -97.04], KDTW: [42.21, -83.35], KELP: [31.81, -106.38],
  KIAH: [29.98, -95.34], KLAS: [36.08, -115.15], KMCO: [28.43, -81.31], KMSP: [44.88, -93.22], KMSY: [29.99, -90.26],
  KOAK: [37.72, -122.22], KORD: [41.98, -87.9], KPHX: [33.43, -112.01], KSEA: [47.45, -122.31], KSFO: [37.62, -122.38],
  LEMD: [40.47, -3.56], LFMN: [43.66, 7.22], LFPO: [48.73, 2.36], LPPT: [38.77, -9.13], LSZH: [47.46, 8.55],
  NZAA: [-37.01, 174.79], NZWN: [-41.33, 174.81], OKBK: [29.23, 47.97], OPKC: [24.91, 67.16], OTHH: [25.27, 51.61],
  PANC: [61.17, -149.99], RCTP: [25.08, 121.23], RJAA: [35.77, 140.39], RJCC: [42.78, 141.69], SBRF: [-8.13, -34.92],
  SBRJ: [-22.91, -43.16], SCEL: [-33.39, -70.79], VHHH: [22.31, 113.92], VIDP: [28.57, 77.1], VOMM: [12.99, 80.17],
  VTBS: [13.69, 100.75], WIII: [-6.13, 106.65], WMKK: [2.75, 101.71], YMML: [-37.67, 144.84], YPPH: [-31.94, 115.97],
};
const STEPS = 48;

type LatLon = [lat: number, lon: number];

/**
 * The recording holds 40 minutes of each flight. This carries it out to where it came from and
 * where it is going as known at that moment: a diversion is not drawn before it is declared.
 */
export interface Route {
  from: string;
  to(t: number): string;
  behind(t: number, now: LatLon, detailed: boolean): XY[];
  ahead(t: number, now: LatLon): XY[];
}

function arc(a: LatLon, b: LatLon): XY[] {
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05) return [project(...b)];
  const at = greatCircle(a, b);
  return Array.from({ length: STEPS + 1 }, (_, i) => at(i / STEPS));
}

export function routeOf(world: WorldRecording, { summary, track, riskSeries }: FlightRecord): Route {
  const where = (icao: string): LatLon | undefined => {
    const a = world.airports.find((p) => p.icao === icao);
    return a ? [a.lat, a.lon] : ELSEWHERE[icao];
  };
  const points = track.map((p) => project(p[1], p[2]));
  const cutAt = (t: number) => {
    const i = track.findIndex((p) => p[0] > t);
    return i < 0 ? track.length : i;
  };
  const first: LatLon = [track[0]![1], track[0]![2]];
  const last: LatLon = [track[track.length - 1]![1], track[track.length - 1]![2]];

  const origin = where(summary.origin);
  const before = origin ? arc(origin, first) : [];
  // Where the recording picks a flight up past its turn, its track would fold the line back on itself.
  const moved = points.find((p) => Math.hypot(p[0] - points[0]![0], p[1] - points[0]![1]) > 0.02);
  let folds = false;
  if (before.length > 1 && moved) {
    const [ax, ay] = before[before.length - 2]!;
    const [bx, by] = before[before.length - 1]!;
    folds = (nearX(bx, ax) - ax) * (nearX(moved[0], bx) - bx) + (by - ay) * (moved[1] - by) < 0;
  }

  let change = { t: Infinity, icao: summary.destination };
  for (const r of riskSeries) {
    const icao = /(?:diverting|returning) ([A-Z]{4})/.exec(r.status)?.[1];
    if (!icao) continue;
    change = { t: r.t, icao };
    break;
  }
  const end = where(change.icao);
  const filed = where(summary.destination);
  const after = end ? arc(last, end) : [];

  return {
    from: summary.origin,
    to: (t) => (t < change.t ? summary.destination : change.icao),
    behind(t, now, detailed) {
      const to = project(...now);
      if (origin && folds && !detailed) return arc(origin, now);
      return [...(folds ? [] : before), ...points.slice(0, cutAt(t)), to];
    },
    ahead(t, now) {
      if (t < change.t && change.t !== Infinity) return filed ? arc(now, filed) : [];
      return [project(...now), ...points.slice(cutAt(t)), ...after];
    },
  };
}
