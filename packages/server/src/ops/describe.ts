import type { ControlPosition } from "@towerai/contracts";
import {
  NM,
  distanceToThreshold,
  type Aircraft,
  type Simulation,
} from "@towerai/core";

export const FACILITY: Record<ControlPosition, string> = {
  ground: "Toronto Ground",
  tower: "Toronto Tower",
  departure: "Toronto Departure",
  approach: "Toronto Approach",
  enroute: "Toronto Centre",
};

const AIRLINES: Record<string, string> = {
  ACA: "Air Canada",
  ROU: "Air Canada Rouge",
  JZA: "Jazz",
  WJA: "WestJet",
  WEN: "WestJet Encore",
  POE: "Porter",
  TSC: "Air Transat",
  SWG: "Sunwing",
  FLE: "Flair",
  DAL: "Delta",
  UAL: "United",
  AAL: "American",
  BAW: "British Airways",
  AFR: "Air France",
  DLH: "Lufthansa",
  KLM: "KLM",
  UAE: "Emirates",
  FDX: "FedEx",
  UPS: "UPS",
};
/** Plausible far ends for synthetic flights; chosen by callsign, so a flight keeps its own. */
const ROUTES: Record<string, string[]> = {
  ACA: ["CYVR", "CYUL", "KSFO", "EGLL"],
  ROU: ["KMCO", "MMUN", "KLAS"],
  JZA: ["CYOW", "CYQB"],
  WJA: ["CYYC", "CYEG", "CYWG"],
  WEN: ["CYTS", "CYQT"],
  POE: ["CYHZ", "CYOW", "KEWR"],
  TSC: ["LFPG", "EGKK", "LIRF"],
  SWG: ["MKJS", "MMUN"],
  FLE: ["CYVR", "CYYC"],
  DAL: ["KATL", "KDTW", "KMSP"],
  UAL: ["KORD", "KDEN", "KEWR"],
  AAL: ["KDFW", "KCLT", "KMIA"],
  BAW: ["EGLL"],
  AFR: ["LFPG"],
  DLH: ["EDDF", "EDDM"],
  KLM: ["EHAM"],
  UAE: ["OMDB"],
  FDX: ["KMEM"],
  UPS: ["KSDF"],
};

export function flightPlan(ac: Aircraft): { airline: string; origin: string; destination: string } {
  const code = ac.callsign.slice(0, 3);
  const options = ROUTES[code] ?? ["CYUL"];
  const other = options[(Number(ac.callsign.slice(3).replace(/\D/g, "")) || 0) % options.length];
  return {
    airline: AIRLINES[code] ?? code,
    origin: ac.flight === "departure" ? "CYYZ" : other,
    destination: ac.flight === "departure" ? other : "CYYZ",
  };
}

const hundreds = (ft: number) => `${(Math.round(ft / 100) * 100).toLocaleString("en-US")} ft`;

export function statusText(sim: Simulation, ac: Aircraft): string {
  const rw = ac.assignedRunway ?? "";
  if (ac.flightComplete) return `arrived at gate ${ac.gate}`;
  if (ac.flags.incursionHold) return "stopped on runway, not cleared";
  if (ac.flags.incursionActive && ac.phase !== "holding_short") return "on runway, not cleared";
  switch (ac.phase) {
    case "at_gate": {
      const wait = Math.ceil((ac.readyAt - sim.time) / 60);
      return wait > 0 ? `gate ${ac.gate}, ready in ${wait} min` : `gate ${ac.gate}, ready to push`;
    }
    case "pushback":
      return ac.flags.pushbackComplete ? "pushed back" : `pushing back ${ac.gate}`;
    case "taxi_out":
    case "taxi_in": {
      const to = ac.phase === "taxi_out" ? rw : `gate ${ac.gate}`;
      if (ac.holdPosition) return `holding position, ${to}`;
      return ac.speedKts > 0.5 ? `taxi to ${to}` : `waiting, to ${to}`;
    }
    case "holding_short": {
      const guards = sim.graph.node(ac.route[ac.currentWaypointIndex]).guards;
      const own = ac.flight === "departure" && guards === sim.graph.runwayEnd(rw)?.runway.id;
      return `holding short ${own ? rw : guards}`;
    }
    case "line_up":
      return `lined up ${rw}`;
    case "takeoff":
      return `taking off ${rw}`;
    case "departure":
      return `climbing ${hundreds(ac.altitudeFt)}`;
    case "approach":
      return `${ac.landingCleared ? "cleared to land" : "inbound"} ${rw}${ac.flags.runwayUnavailable ? " (shut)" : ""}, ${(distanceToThreshold(sim, ac) / NM).toFixed(1)} NM`;
    case "holding":
      return `holding for ${rw}`;
    case "go_around":
      return ac.flags.emergencyReturn ? `returning to ${rw}` : `going around, back to ${rw}`;
    case "landing":
      return `landing ${rw}`;
    case "rollout":
      return `landed ${rw}, slowing`;
  }
}

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

/** The inverse of the projection the airport was built with (tools/osm/import-airport.mjs). */
export function latLon(sim: Simulation, p: { x: number; y: number }): [lat: number, lon: number] {
  const { lat, lon } = sim.graph.data.reference;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return [round(lat + p.y / EARTH_R / DEG), round(lon + p.x / (EARTH_R * Math.cos(lat * DEG)) / DEG)];
}
