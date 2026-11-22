import { PORTS, runwayPoint, type Port, type PortCode, type Runway } from "./airports";
import { arrivalRoute, toGo, trueSpeed, type Body } from "./body";
import { kwikqdrdist, qdr, qdrpos } from "./bluesky/geo";
import { trueAirspeedKt } from "./openap/gen";
import { PERF, type TypeCode } from "./perf";
import { REGION, hash } from "./regions";
import type { Flight, Sim } from "./sim";

// Real operator names and telephony designators; every flight and flight number is fictional.
const AIRLINES: Record<string, [name: string, telephony: string]> = {
  ACA: ["Air Canada", "Air Canada"], WJA: ["WestJet", "WestJet"], BAW: ["British Airways", "Speedbird"], VIR: ["Virgin Atlantic", "Virgin"],
  DAL: ["Delta", "Delta"], AAL: ["American", "American"], UAL: ["United", "United"], JBU: ["JetBlue", "JetBlue"], SWA: ["Southwest", "Southwest"],
  DLH: ["Lufthansa", "Lufthansa"], AFR: ["Air France", "Air France"], KLM: ["KLM", "KLM"], EZY: ["easyJet", "Easy"], SWR: ["Swiss", "Swiss"],
  UAE: ["Emirates", "Emirates"], FDB: ["flydubai", "Skydubai"], QTR: ["Qatar Airways", "Qatari"], SIA: ["Singapore Airlines", "Singapore"],
  MAS: ["Malaysia Airlines", "Malaysian"], CPA: ["Cathay Pacific", "Cathay"], ANA: ["All Nippon", "All Nippon"], JAL: ["Japan Airlines", "Japan Air"],
  QFA: ["Qantas", "Qantas"], ANZ: ["Air New Zealand", "New Zealand"], TAM: ["LATAM Brasil", "TAM"], GLO: ["Gol", "Gol"],
};

export interface Spec {
  id: string;
  type: TypeCode;
  from: string;
  to: string;
  port: PortCode;
  startT?: number;
}

function create(sim: Sim, s: Spec, body: Pick<Body, "kind" | "mode" | "lat" | "lon" | "hdg" | "altFt" | "clearedAlt" | "route">, runway: Runway): Flight {
  const port: Port = PORTS[s.port];
  const [airline, telephony] = AIRLINES[s.id.slice(0, 3)]!;
  const perf = PERF[s.type];
  const f: Flight = {
    id: s.id, airline, spoken: `${telephony} ${s.id.slice(3)}`, type: s.type, origin: s.from, destination: s.to, filed: s.to, port, runway,
    body: {
      perf, elevFt: port.elevFt, leg: 0, gsKt: 0, vsFpm: 0, heading: null, speed: null, mach: null,
      orbit: false, ils: false, emergencyDescent: false, runwayHdg: runway.hdg, ...body,
    },
    position: "ground", facility: port.units.ground[0], startT: s.startT ?? 0, endT: null,
    busy: false, urgent: 0, avoid: null, priority: false, landingClearance: false, goAround: null, vacated: false, vacateDelayS: 0,
    airborneT: null, misreads: false, phase: "at gate", need: null, control: false,
    flags: new Map(), track: [], messages: [], markers: [], riskSeries: [], separation: [],
  };
  sim.flights.push(f);
  return f;
}

/** An inbound already in the air, `distNm` from the airport on `bearing` from it. */
export function arrival(sim: Sim, s: Spec, bearing: number, distNm: number, finalNm = 12): Flight {
  const p = PORTS[s.port];
  const perf = PERF[s.type];
  const [lat, lon] = qdrpos(p.lat, p.lon, bearing, distNm);
  const route = arrivalRoute(p, p.landing, lat, lon, finalNm);
  const f = create(sim, s, { kind: "arr", mode: "air", lat, lon, hdg: qdr(lat, lon, route[0]!.lat, route[0]!.lon), altFt: 0, clearedAlt: 0, route }, p.landing);
  const b = f.body;
  const dtg = toGo(b);
  b.altFt = b.clearedAlt = Math.min(perf.ceilingFt - 2000, Math.max(Math.round((dtg * 260 + p.elevFt) / 1000) * 1000, Math.ceil(p.elevFt / 1000) * 1000 + 4000));
  b.gsKt = trueSpeed(b, dtg);
  [f.position, f.facility] = distNm < 45 ? ["approach", p.units.approach[0]] : ["enroute", p.units.enroute[0]];
  f.phase = "inbound";
  return f;
}

export function departure(sim: Sim, s: Spec, towards: number, stand: number): Flight {
  const p = PORTS[s.port];
  const r = p.departing;
  const [lat, lon] = qdrpos(p.lat, p.lon, r.hdg + 90, 0.06 + (stand % 6) * 0.05);
  const exit = qdrpos(p.lat, p.lon, towards, 70);
  const out = runwayPoint(p, r, 9);
  const far = qdrpos(...exit, towards, 1500);
  const route = [
    { name: "CLIMB", lat: out[0], lon: out[1] },
    { name: "SORTI", lat: exit[0], lon: exit[1] },
    { name: s.to, lat: far[0], lon: far[1] },
  ];
  return create(sim, s, { kind: "dep", mode: "parked", lat, lon, hdg: r.hdg, altFt: p.elevFt, clearedAlt: p.elevFt, route }, r);
}

/** An overflight that will be over `over` after `inS` seconds if nobody changes anything. */
export function overflight(
  sim: Sim, s: Spec, over: readonly [number, number], hdg: number, inS: number, flightLevel: number, climbFrom?: number,
): Flight {
  const perf = PERF[s.type];
  const altFt = (climbFrom ?? flightLevel) * 100;
  const gs = trueAirspeedKt(perf.climbCasKt, perf.mach, altFt);
  const back = (gs * inS) / 3600;
  const [lat, lon] = qdrpos(over[0], over[1], hdg + 180, back);
  const track = back > 0.01 ? qdr(lat, lon, over[0], over[1]) : hdg;
  const { fixes } = REGION[s.port];
  // Two crossing flights are still sent to their own fixes.
  const first = hash(s.id) % fixes.length;
  const route = [300, 700, 1500].map((d, i) => {
    const [la, lo] = qdrpos(lat, lon, track, d);
    return { name: [fixes[first], fixes[(first + 1) % fixes.length], s.to][i]!, lat: la, lon: lo };
  });
  const f = create(sim, s, { kind: "cruise", mode: "air", lat, lon, hdg: track, altFt, clearedAlt: flightLevel * 100, route }, PORTS[s.port].landing);
  f.body.gsKt = gs;
  f.body.elevFt = 0;
  [f.position, f.facility] = ["enroute", f.port.units.enroute[0]];
  f.phase = "cruise";
  return f;
}

export const near = (port: PortCode, bearing: number, distNm: number) => qdrpos(PORTS[port].lat, PORTS[port].lon, bearing, distNm);
export const distanceFrom = (f: Flight) => kwikqdrdist(f.port.lat, f.port.lon, f.body.lat, f.body.lon)[1];
