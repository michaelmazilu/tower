// Fictional en-route fixes and invented weather for each part of the world, so that no two regions sound alike.
import type { PortCode } from "./airports";

interface Region {
  fixes: string[];
  /** Significant weather, as a controller would pass it. */
  hazards: string[];
}

export const REGION: Record<PortCode, Region> = {
  CYYZ: { fixes: ["OLBEN", "KAVRI", "MUNDO"], hazards: ["severe icing between flight level 180 and 240 east of Lake Huron", "moderate turbulence below flight level 340 over the lakes"] },
  EGLL: { fixes: ["TORVA", "BEDLI", "HALMO"], hazards: ["severe turbulence flight level 300 to 380 over the Irish Sea", "mountain wave over Scotland up to flight level 280"] },
  KJFK: { fixes: ["PEQUA", "WIDLO", "SARNY"], hazards: ["a squall line west of Harrisburg, tops flight level 420", "clear air turbulence near the jet stream off Cape Cod"] },
  KLAX: { fixes: ["DESRA", "COYBO", "MOHVI"], hazards: ["mountain wave over the Sierra, moderate to severe", "isolated storms over the Mojave, tops flight level 350"] },
  EDDF: { fixes: ["ALPIN", "RENKA", "GIMBO"], hazards: ["severe mountain wave north of the Alps", "embedded storms over Bavaria, tops flight level 360"] },
  LFPG: { fixes: ["LOVAR", "SENTI", "BRIVA"], hazards: ["icing over the Massif Central up to flight level 220", "thunderstorms over the Bay of Biscay, moving east"] },
  OMDB: { fixes: ["RASMO", "DUNEK", "FALAJ"], hazards: ["blowing dust below flight level 120 over the Gulf", "isolated storms over the Hajar mountains, tops flight level 400"] },
  WSSS: { fixes: ["BATAM", "SELKU", "NIPAR"], hazards: ["towering cumulus over the strait, tops flight level 480", "volcanic ash advisory south of Sumatra below flight level 250"] },
  RJTT: { fixes: ["SAKRU", "HOKTO", "MIYAZ"], hazards: ["severe turbulence in the jet east of Honshu", "ash from Sakurajima below flight level 160"] },
  YSSY: { fixes: ["WOLLA", "TASMI", "KEMPS"], hazards: ["severe turbulence over the Blue Mountains below flight level 140", "a line of storms off the New South Wales coast"] },
  SBGR: { fixes: ["PARAN", "IGUVA", "SANTI"], hazards: ["storm cells over Minas Gerais, tops flight level 450", "moderate icing over the Serra do Mar"] },
};

/** The same string always gives the same number. */
export function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export const vary = <T>(key: string, from: readonly T[]): T => from[hash(key) % from.length]!;

/** Invented weather for a destination; the same airport reads the same to every flight. */
export function destinationWeather(icao: string): string {
  const h = hash(icao);
  const wind = `wind ${String(((h % 35) + 1) * 10).padStart(3, "0")} at ${5 + ((h >>> 6) % 17)}`;
  const seen = ["visibility 10 kilometres", "visibility 4000 metres in rain", "visibility 6 kilometres in haze", "visibility more than 10 kilometres"][(h >>> 10) % 4];
  const sky = ["broken 1800 feet", "scattered 4000 feet", "overcast 900 feet", "few clouds 3000 feet"][(h >>> 14) % 4];
  return `${icao} reports ${wind}, ${seen}, ${sky}`;
}
