import type { BackgroundFlight } from "@towerai/contracts";
import { kwikdist, rad } from "./bluesky/geo";
import { random } from "./timing";

// Typed by hand, rounded city-airport positions.
const HUBS: [number, number][] = [
  [43.68, -79.62], [40.64, -73.78], [33.64, -84.43], [41.98, -87.9], [32.9, -97.04], [39.86, -104.67], [33.94, -118.41], [37.62, -122.38],
  [47.45, -122.31], [25.79, -80.29], [49.19, -123.18], [45.47, -73.74], [19.44, -99.07], [61.17, -149.99], [21.32, -157.92], [42.36, -71.01],
  [29.98, -95.34], [36.08, -115.15], [51.47, -0.45], [49.01, 2.55], [50.04, 8.56], [52.31, 4.76], [40.47, -3.56], [41.8, 12.24],
  [41.26, 28.74], [60.19, 11.1], [63.99, -22.61], [55.62, 12.65], [48.11, 16.57], [38.77, -9.13], [37.94, 23.94], [52.17, 20.97],
  [60.32, 24.96], [30.12, 31.41], [33.37, -7.59], [6.58, 3.32], [-1.32, 36.93], [8.98, 38.8], [-26.14, 28.25], [-33.97, 18.6],
  [14.67, -17.07], [25.25, 55.36], [25.27, 51.61], [24.96, 46.7], [28.57, 77.1], [19.09, 72.87], [13.2, 77.71], [23.84, 90.4],
  [13.69, 100.75], [2.75, 101.71], [1.36, 103.99], [-6.13, 106.65], [14.51, 121.02], [22.31, 113.92], [31.14, 121.81], [40.08, 116.58],
  [23.39, 113.3], [37.46, 126.44], [35.55, 139.78], [43.68, 87.47], [43.35, 77.04], [-33.94, 151.18], [-37.67, 144.84], [-31.94, 115.97],
  [-27.38, 153.12], [-37.01, 174.79], [-17.76, 177.44], [-23.44, -46.47], [-34.82, -58.54], [-33.39, -70.79], [-12.02, -77.11], [4.7, -74.15],
  [9.07, -79.38], [18.44, -66.0], [-3.04, -60.05], [-8.13, -34.92],
];

export function backgroundTraffic(seed: number, durationS: number, count = 1000): BackgroundFlight[] {
  const rand = random(seed ^ 0x2c1b3c6d);
  const out: BackgroundFlight[] = [];
  const pick = () => HUBS[Math.floor(rand() ** 1.15 * HUBS.length)]!;
  while (out.length < count) {
    const from = pick();
    const to = pick();
    const rough = kwikdist(...from, ...to);
    if (rough < 250) continue;
    // Short sectors are more common than long ones.
    if (rand() > Math.min(1, 2200 / rough)) continue;
    const [p1, p2] = [from[0] * rad, to[0] * rad];
    const cos = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos((to[1] - from[1]) * rad);
    const distance = Math.acos(Math.max(-1, Math.min(1, cos))) * 3440;
    if (distance > 8000) continue;
    const flightS = Math.round((distance / 470) * 3600 + 1200);
    out.push({
      id: `SYN${out.length + 1}`, from, to,
      departT: Math.round(rand() * (flightS + durationS * 0.2) - flightS + durationS * 0.1),
      durationS: flightS,
      altFt: 30000 + Math.floor(rand() * 11) * 1000,
    });
  }
  return out;
}
