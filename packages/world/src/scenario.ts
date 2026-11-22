import type { PortCode } from "./airports";
import { qdrpos } from "./bluesky/geo";
import * as fly from "./flights";
import type { TypeCode } from "./perf";
import * as proc from "./procedures";
import type { Flight, Sim } from "./sim";
import * as story from "./storylines";

export function buildWorld(sim: Sim): void {
  const all = new Map<string, Flight>();
  const add = (f: Flight) => all.set(f.id, f).get(f.id)!;
  const get = (id: string) => all.get(id)!;
  const jitter = (n: number) => (sim.rand() - 0.5) * n;

  const inbound = (id: string, type: TypeCode, from: string, port: PortCode, bearing: number, dist: number, finalNm?: number) => {
    const f = add(fly.arrival(sim, { id, type, from, to: port, port }, bearing + jitter(3), dist + jitter(1.5), finalNm));
    sim.spawn(proc.arrival(sim, f, { wait: 4 + sim.rand() * 50 }));
  };
  const outbound = (id: string, type: TypeCode, port: PortCode, to: string, towards: number, readyS: number, cruiseFL: number) => {
    const f = add(fly.departure(sim, { id, type, from: port, to, port }, towards, all.size));
    sim.spawn(proc.departure(sim, f, readyS + jitter(16) + 8, cruiseFL * 100));
  };
  const over = (
    id: string, type: TypeCode, port: PortCode, from: string, to: string, point: readonly [number, number],
    hdg: number, inS: number, fl: number, climbFrom?: number, quiet?: boolean,
  ) => {
    const f = add(fly.overflight(sim, { id, type, from, to, port }, point, hdg, inS, fl, climbFrom));
    sim.spawn(proc.cruise(sim, f, quiet ? { quiet } : {}));
  };

  inbound("ACA857", "A333", "EGLL", "CYYZ", 62, 150);
  inbound("WJA418", "B738", "CYYC", "CYYZ", 285, 165);
  inbound("ACA1038", "BCS3", "KORD", "CYYZ", 250, 70);
  outbound("ACA107", "B789", "CYYZ", "CYVR", 300, 60, 380);
  outbound("WJA655", "B38M", "CYYZ", "KMCO", 170, 1250, 370);

  inbound("BAW178", "B77W", "KJFK", "EGLL", 96, 152);
  inbound("VIR26", "A359", "KBOS", "EGLL", 84, 157);
  inbound("EZY834", "A20N", "LFMN", "EGLL", 160, 172);
  outbound("BAW117", "A359", "EGLL", "KJFK", 290, 190, 380);

  inbound("JBU616", "A21N", "KBOS", "KJFK", 48, 66);
  inbound("AAL100", "B789", "EGLL", "KJFK", 62, 70);
  inbound("DAL1842", "B738", "KATL", "KJFK", 240, 185);
  outbound("DAL401", "A21N", "KJFK", "KLAS", 265, 30, 340);

  inbound("UAL1175", "B738", "KDEN", "KLAX", 80, 92);
  inbound("AAL2454", "A21N", "KDFW", "KLAX", 88, 88);
  inbound("QFA11", "A388", "YSSY", "KLAX", 235, 190);
  outbound("SWA2210", "B38M", "KLAX", "KPHX", 100, 1420, 350);

  inbound("DLH431", "A20N", "EDDM", "EDDF", 75, 52);
  inbound("DLH903", "A21N", "EPWA", "EDDF", 62, 78);
  inbound("SWR1070", "BCS3", "LSZH", "EDDF", 165, 110);
  outbound("DLH400", "A333", "EDDF", "KJFK", 300, 480, 360);

  inbound("AFR083", "B77W", "KSFO", "LFPG", 185, 178);
  inbound("KLM1233", "E190", "EHAM", "LFPG", 20, 56);
  outbound("AFR1380", "A20N", "LFPG", "LEMD", 215, 280, 370);

  inbound("UAE2", "A388", "EGLL", "OMDB", 320, 100);
  inbound("FDB1780", "B38M", "OPKC", "OMDB", 100, 135);
  outbound("UAE51", "B77W", "OMDB", "EDDM", 320, 640, 340);

  inbound("SIA636", "A359", "RJTT", "WSSS", 30, 168);
  inbound("MAS605", "B738", "WMKK", "WSSS", 340, 50);
  outbound("SIA322", "A359", "WSSS", "EGLL", 310, 1020, 360);

  inbound("JAL45", "B789", "VHHH", "RJTT", 235, 125);
  outbound("ANA106", "B789", "RJTT", "KSFO", 70, 360, 370);

  inbound("QFA430", "B738", "YMML", "YSSY", 215, 128);
  inbound("ANZ103", "A21N", "NZAA", "YSSY", 110, 150);

  inbound("GLO1431", "B738", "SBRJ", "SBGR", 250, 180);
  outbound("TAM3301", "A20N", "SBGR", "SBRF", 40, 760, 350);

  // Converging tracks, solved by a heading.
  const north = fly.near("CYYZ", 20, 190);
  over("ACA860", "B789", "CYYZ", "CYUL", "CYYC", north, 290, 640, 360);
  over("DAL156", "A359", "CYYZ", "KDTW", "EHAM", north, 38, 640, 360);
  const alps = fly.near("EDDF", 150, 170);
  over("SWR22", "A333", "EDDF", "LSZH", "EKCH", alps, 15, 1960, 380);
  over("KLM871", "B789", "EDDF", "EHAM", "OMDB", alps, 105, 1960, 380);
  // Opposite direction, solved by a level.
  const sea = fly.near("WSSS", 70, 200);
  over("CPA714", "A359", "WSSS", "VHHH", "WIII", sea, 205, 1120, 370);
  over("QFA81", "A333", "WSSS", "YSSY", "VTBS", sea, 25, 1120, 370);
  // A climb through a crossing level.
  const wash = fly.near("EGLL", 340, 160);
  over("KLM643", "B789", "EGLL", "EHAM", "KMSP", wash, 310, 160, 370, 270);
  over("BAW38", "A21N", "EGLL", "EIDW", "EKCH", wash, 80, 160, 310);
  // The same track, a faster aircraft behind, solved by speed.
  const gulf = fly.near("OMDB", 110, 180);
  over("FDB415", "B38M", "OMDB", "OKBK", "VIDP", gulf, 95, 600, 370);
  over("QTR504", "A359", "OMDB", "OTHH", "VTBS", gulf, 95, 655, 370);
  const tasman = fly.near("YSSY", 150, 260);
  over("ANZ829", "B738", "YSSY", "YMML", "NZAA", tasman, 110, 600, 350);
  over("QFA145", "A359", "YSSY", "YPPH", "NZWN", tasman, 110, 760, 350);
  // Weather on one side, traffic on the other.
  const penn = fly.near("KJFK", 300, 190);
  over("JBU523", "A20N", "KJFK", "KBOS", "KLAX", penn, 265, 800, 340);
  over("AAL291", "B738", "KJFK", "KBOS", "KPHX", qdrpos(...penn, 355, 8.6), 265, 800, 340);
  over("JAL514", "B738", "RJTT", "RJAA", "RJCC", fly.near("RJTT", 10, 190), 20, 1300, 370);
  // A requested level that is occupied.
  const desert = fly.near("KLAX", 45, 190);
  over("UAL408", "A21N", "KLAX", "KSFO", "KIAH", desert, 120, 700, 350);
  over("DAL977", "B738", "KLAX", "KSEA", "KMSY", qdrpos(...desert, 30, 3.9), 120, 700, 370);
  // Passing traffic, vertical separation only.
  const loire = fly.near("LFPG", 225, 200);
  over("EZY61", "A20N", "LFPG", "LEMD", "EBBR", loire, 30, 1350, 340);
  over("AFR946", "B789", "LFPG", "LFPO", "SBGR", loire, 210, 1350, 350);

  over("QTR721", "B77W", "OMDB", "OTHH", "VOMM", fly.near("OMDB", 10, 85), 118, 260, 330, undefined, true);
  over("ANA861", "A359", "RJTT", "RCTP", "PANC", fly.near("RJTT", 85, 95), 50, 1770, 390);
  over("SWA1509", "B738", "KLAX", "KOAK", "KELP", fly.near("KLAX", 20, 120), 118, 1000, 390, undefined, true);
  over("TAM8084", "B77W", "SBGR", "SCEL", "LPPT", fly.near("SBGR", 320, 170), 40, 1500, 350);

  get("BAW178").vacateDelayS = 150;
  for (const id of ["QFA430", "UAE51"]) get(id).misreads = true;

  const everyone = [...all.values()];
  sim.spawn(story.engineFailure(sim, get("DAL401"), "KJFK"));
  sim.spawn(story.depressurisation(sim, get("ANA861"), "RJTT", 1720));
  sim.spawn(story.medical(sim, get("UAL1175"), 120));
  sim.spawn(story.minimumFuel(sim, get("ANZ103"), 900));
  sim.spawn(story.closure(sim, everyone, get("DLH431"), "debris on the runway"));
  sim.spawn(story.windshear(sim, everyone, get("MAS605"), 330));
  sim.spawn(story.weatherDeviation(sim, get("JBU523"), 700, 260));
  sim.spawn(story.weatherDeviation(sim, get("JAL514"), 1500, 300));
  sim.spawn(story.blockedClimb(sim, get("UAL408"), 540, 37000));
  sim.spawn(story.radioFailure(sim, get("SWA1509"), 1380));
  sim.spawn(story.diversionDecision(sim, get("QTR721"), "OMDB", 3));
  sim.spawn(story.hydraulicFailure(sim, get("AFR083"), 900));
  sim.spawn(story.unresolvedHuman(sim, get("TAM8084"), 1600));
}
