import type { Clearance, ClearanceType, RequestType, Vector } from "../types";

/**
 * Deterministic radio text. Callsigns, runway numbers and clearance wording
 * are generated from structured data so they cannot drift between the
 * instruction, the readback and the log. Every phrase comes in two forms:
 * `text` for the dashboard and `spoken` for TTS.
 */

const TELEPHONY: Record<string, string> = {
  ACA: "Air Canada",
  ROU: "Rouge",
  JZA: "Jazz",
  WJA: "WestJet",
  WEN: "Encore",
  POE: "Porter",
  TSC: "Air Transat",
  SWG: "Sunwing",
  FLE: "Flair",
  DAL: "Delta",
  UAL: "United",
  AAL: "American",
  BAW: "Speedbird",
  AFR: "Air France",
  DLH: "Lufthansa",
  KLM: "K L M",
  UAE: "Emirates",
  FDX: "FedEx",
  UPS: "U P S",
};

const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const PHONETIC: Record<string, string> = {
  A: "Alfa", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf",
  H: "Hotel", I: "India", J: "Juliett", K: "Kilo", L: "Lima", M: "Mike", N: "November",
  O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango", U: "Uniform",
  V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee", Z: "Zulu",
};
const SIDE: Record<string, string> = { L: "left", R: "right", C: "centre" };

export function spokenDigits(s: string): string {
  return s
    .split("")
    .map((c) => (/\d/.test(c) ? DIGITS[Number(c)] : c))
    .join(" ");
}

export function spokenCallsign(callsign: string): string {
  const m = /^([A-Z]{3})(\d+)([A-Z]?)$/.exec(callsign.toUpperCase());
  if (!m) return callsign.split("").map((c) => PHONETIC[c] ?? spokenDigits(c)).join(" ");
  const airline = TELEPHONY[m[1]] ?? m[1].split("").map((c) => PHONETIC[c]).join(" ");
  const suffix = m[3] ? ` ${PHONETIC[m[3]]}` : "";
  return `${airline} ${spokenDigits(m[2])}${suffix}`;
}

export function spokenRunway(designator: string): string {
  const m = /^(\d{2})([LRC]?)$/.exec(designator);
  if (!m) return designator;
  return `${spokenDigits(m[1])}${m[2] ? ` ${SIDE[m[2]]}` : ""}`;
}

/** "A6" -> "Alfa six", "D28" -> "Delta two eight". */
export function spokenAlnum(s: string): string {
  return s
    .toUpperCase()
    .split("")
    .map((c) => PHONETIC[c] ?? (/\d/.test(c) ? DIGITS[Number(c)] : c))
    .join(" ");
}

interface PhraseInput {
  callsign: string;
  type: ClearanceType;
  runway?: string;
  gate?: string;
  via?: string[];
  flight?: "departure" | "arrival";
  vector?: Vector;
  /** RUNWAY_CHANGE: the runway being left. */
  from?: string;
}

export interface Phrase {
  text: string;
  spoken: string;
}

/** The instruction body, without the callsign. */
function body(p: PhraseInput): Phrase {
  const rw = p.runway ?? "";
  const rwS = spokenRunway(rw);
  const via = p.via && p.via.length > 0 ? p.via : undefined;
  const viaText = via ? ` via ${via.join(", ")}` : "";
  const viaSpoken = via ? ` via ${via.map(spokenAlnum).join(", ")}` : "";
  switch (p.type) {
    case "PUSHBACK":
      return { text: "pushback approved", spoken: "pushback approved" };
    case "TAXI":
      if (p.gate) {
        return {
          text: `taxi to gate ${p.gate}${viaText}`,
          spoken: `taxi to gate ${spokenAlnum(p.gate)}${viaSpoken}`,
        };
      }
      return {
        text: `runway ${rw}, taxi${viaText}, hold short runway ${rw}`,
        spoken: `runway ${rwS}, taxi${viaSpoken}, hold short runway ${rwS}`,
      };
    case "HOLD_SHORT":
      return { text: `hold short runway ${rw}`, spoken: `hold short runway ${rwS}` };
    case "CROSS_RUNWAY":
      return { text: `cross runway ${rw}`, spoken: `cross runway ${rwS}` };
    case "LINE_UP_AND_WAIT":
      return { text: `runway ${rw}, line up and wait`, spoken: `runway ${rwS}, line up and wait` };
    case "CLEARED_TAKEOFF":
      return { text: `runway ${rw}, cleared for takeoff`, spoken: `runway ${rwS}, cleared for takeoff` };
    case "CLEARED_TO_LAND":
      return { text: `runway ${rw}, cleared to land`, spoken: `runway ${rwS}, cleared to land` };
    case "GO_AROUND":
      return { text: "go around", spoken: "go around" };
    case "HOLD":
      return {
        text: "hold present position, expect further clearance",
        spoken: "hold present position, expect further clearance",
      };
    case "CONTINUE_APPROACH":
      return { text: `continue approach runway ${rw}`, spoken: `continue approach runway ${rwS}` };
    case "HOLD_POSITION":
      return { text: "hold position", spoken: "hold position" };
    case "CONTINUE_TAXI":
      return { text: "continue taxi", spoken: "continue taxi" };
    case "RUNWAY_CHANGE":
      return { text: `change to runway ${rw}`, spoken: `change to runway ${rwS}` };
    case "VECTOR":
    case "RETURN_TO_LAND": {
      const { turn, headingDeg, altitudeFt, speedKts } = p.vector!;
      const heading = String(headingDeg).padStart(3, "0");
      const thousands = altitudeFt / 1000;
      const start = `turn ${turn} heading`;
      if (p.type === "RETURN_TO_LAND") {
        return {
          text: `${start} ${heading}, maintain ${thousands},000, runway ${rw}, number one`,
          spoken: `${start} ${spokenDigits(heading)}, maintain ${spokenDigits(String(thousands))} thousand, runway ${rwS}, number one`,
        };
      }
      return {
        text: `${start} ${heading}, climb ${thousands},000, speed ${speedKts} knots`,
        spoken: `${start} ${spokenDigits(heading)}, climb ${spokenDigits(String(thousands))} thousand, speed ${spokenDigits(String(speedKts))} knots`,
      };
    }
  }
}

/** What the controller says before the instruction and the crew does not read back. */
function preamble(p: PhraseInput): Phrase {
  if (p.type === "RETURN_TO_LAND") return { text: "roger mayday, ", spoken: "roger mayday, " };
  if (p.type === "RUNWAY_CHANGE" && p.from) {
    return { text: `runway ${p.from} not available, `, spoken: `runway ${spokenRunway(p.from)} not available, ` };
  }
  return { text: "", spoken: "" };
}

/** Controller instruction: callsign first. */
export function clearancePhrase(p: PhraseInput): Phrase {
  const b = body(p);
  const lead = preamble(p);
  return { text: `${p.callsign}, ${lead.text}${b.text}.`, spoken: `${spokenCallsign(p.callsign)}, ${lead.spoken}${b.spoken}.` };
}

/** Pilot readback: instruction first, callsign last. */
export function readbackPhrase(p: PhraseInput): Phrase {
  const b = body(p);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { text: `${cap(b.text)}, ${p.callsign}.`, spoken: `${cap(b.spoken)}, ${spokenCallsign(p.callsign)}.` };
}

export function requestPhrase(r: {
  callsign: string;
  type: RequestType;
  runway?: string;
  gate?: string;
  flight: "departure" | "arrival";
  distanceNm?: number;
  holdLabel?: string;
  onRunway?: boolean;
  reminder?: boolean;
}): Phrase {
  const cs = r.callsign;
  const csS = spokenCallsign(cs);
  const rw = r.runway ?? "";
  const rwS = spokenRunway(rw);
  const again = r.reminder ? ", still waiting" : "";
  if (r.onRunway) {
    return {
      text: `Tower, ${cs}, stopped on runway ${rw}, request instructions${again}.`,
      spoken: `Tower, ${csS}, stopped on runway ${rwS}, request instructions${again}.`,
    };
  }
  switch (r.type) {
    case "PUSHBACK":
      return {
        text: `Tower, ${cs} at gate ${r.gate ?? ""}, request pushback${again}.`,
        spoken: `Tower, ${csS} at gate ${spokenAlnum(r.gate ?? "")}, request pushback${again}.`,
      };
    case "TAXI":
      if (r.flight === "arrival") {
        return {
          text: `Tower, ${cs}, clear of the runway, request taxi to gate ${r.gate ?? ""}${again}.`,
          spoken: `Tower, ${csS}, clear of the runway, request taxi to gate ${spokenAlnum(r.gate ?? "")}${again}.`,
        };
      }
      return {
        text: `Tower, ${cs}, ready to taxi${again}.`,
        spoken: `Tower, ${csS}, ready to taxi${again}.`,
      };
    case "TAKEOFF":
      return {
        text: `Tower, ${cs}, holding short runway ${rw}, ready for departure${again}.`,
        spoken: `Tower, ${csS}, holding short runway ${rwS}, ready for departure${again}.`,
      };
    case "LANDING": {
      const miles = r.distanceNm !== undefined ? `${Math.max(1, Math.round(r.distanceNm))} mile final` : "on final";
      return {
        text: `Tower, ${cs}, ${miles} runway ${rw}${again}.`,
        spoken: `Tower, ${csS}, ${miles} runway ${rwS}${again}.`,
      };
    }
    case "CROSS":
      return {
        text: `Tower, ${cs}, holding short runway ${rw}, request crossing${again}.`,
        spoken: `Tower, ${csS}, holding short runway ${rwS}, request crossing${again}.`,
      };
    case "OTHER":
      return { text: `Tower, ${cs}.`, spoken: `Tower, ${csS}.` };
  }
}

// ---------------------------------------------------------- readback matching

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", tree: "3", four: "4", fower: "4", five: "5",
  fife: "5", six: "6", seven: "7", eight: "8", nine: "9", niner: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
  seventeen: "17", eighteen: "18", nineteen: "19",
};
const TENS: Record<string, string> = {
  twenty: "2", thirty: "3", forty: "4", fifty: "5", sixty: "6", seventy: "7", eighty: "8", ninety: "9",
};

/** Lower-case, digits as digits, "two three left" -> "23l". */
export function normalizeSpeech(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w);
  // "twenty three" is 23, and "twenty" alone is 20.
  for (let i = 0; i < words.length; i++) {
    const tens = TENS[words[i]];
    if (!tens) continue;
    const unit = /^[1-9]$/.test(words[i + 1] ?? "");
    words.splice(i, unit ? 2 : 1, tens + (unit ? words[i + 1] : "0"));
  }
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prevIsDigit = /\d$/.test(out);
    if (/^\d+$/.test(w) && prevIsDigit) out += w;
    else if (prevIsDigit && (w === "left" || w === "right" || w === "centre" || w === "center")) out += w[0];
    else out += (out ? " " : "") + w;
  }
  return out;
}

const KEYWORDS: Record<ClearanceType, string[][]> = {
  PUSHBACK: [["push"]],
  TAXI: [["taxi"]],
  HOLD_SHORT: [["hold short", "holding short"]],
  CROSS_RUNWAY: [["cross"]],
  LINE_UP_AND_WAIT: [["line up", "lining up"]],
  CLEARED_TAKEOFF: [["takeoff", "take off"]],
  CLEARED_TO_LAND: [["land"]],
  GO_AROUND: [["go around", "going around"]],
  HOLD: [["hold"]],
  CONTINUE_APPROACH: [["continue"]],
  HOLD_POSITION: [["hold position", "holding position", "holding"]],
  CONTINUE_TAXI: [["continue", "taxi"]],
  RUNWAY_CHANGE: [["change", "runway"]],
  VECTOR: [["heading"], ["climb"], ["speed"]],
  RETURN_TO_LAND: [["heading"], ["maintain"]],
};

export interface ReadbackCheck {
  ok: boolean;
  missing: string[];
}

/**
 * Check a free-text readback (human microphone / STT) against the
 * structured clearance: the instruction and its critical identifiers.
 */
export function matchReadback(
  clearance: Pick<Clearance, "type" | "runway" | "gate" | "vector"> & { callsign?: string },
  text: string,
): ReadbackCheck {
  const said = normalizeSpeech(text);
  const contains = (phrase: string) => ` ${said} `.includes(` ${phrase} `);
  const missing: string[] = [];
  const declined = /\b(?:unable|negative|not cleared|do not|don t)\b/.test(said);
  for (const group of KEYWORDS[clearance.type]) {
    if (declined || !group.some((k) => said.includes(k))) missing.push(`instruction ("${group[0]}")`);
  }
  if (clearance.runway && RUNWAY_CRITICAL.has(clearance.type)) {
    const want = clearance.runway.toLowerCase();
    const wantNoZero = want.replace(/^0/, "");
    const namedRunways = [...said.matchAll(/\b(?:runway|rwy) (\d{1,2}[lrc]?)\b/g)].map((m) => m[1]);
    const matches = namedRunways.length
      ? namedRunways.every((r) => r === want || r === wantNoZero)
      : contains(want) || contains(wantNoZero);
    if (!matches) missing.push(`runway ${clearance.runway}`);
  }
  if (clearance.vector) {
    const { headingDeg, altitudeFt, speedKts } = clearance.vector;
    if (!contains(`heading ${String(headingDeg).padStart(3, "0")}`)) missing.push(`heading ${headingDeg}`);
    if (!contains(String(altitudeFt)) && !contains(`${altitudeFt / 1000} thousand`)) missing.push(`altitude ${altitudeFt}`);
    if (clearance.type === "VECTOR" && !contains(`speed ${speedKts}`)) missing.push(`speed ${speedKts}`);
  }
  if (clearance.type === "TAXI" && clearance.gate) {
    const gate = clearance.gate.toLowerCase();
    const spaced = gate.replace(/([a-z])(\d)/, "$1 $2");
    const spokenGate = normalizeSpeech(spokenAlnum(clearance.gate));
    if (![gate, spaced, spokenGate].some((identifier) => contains(`gate ${identifier}`))) {
      missing.push(`gate ${clearance.gate}`);
    }
  }
  if (clearance.callsign) {
    const callsign = clearance.callsign.toLowerCase();
    const spaced = callsign.replace(/([a-z])(\d)/, "$1 $2");
    const spoken = normalizeSpeech(spokenCallsign(clearance.callsign));
    if (![callsign, spaced, spoken].some(contains)) missing.push(`callsign ${clearance.callsign}`);
  }
  return { ok: missing.length === 0, missing };
}

const RUNWAY_CRITICAL: ReadonlySet<ClearanceType> = new Set<ClearanceType>([
  "HOLD_SHORT",
  "CROSS_RUNWAY",
  "LINE_UP_AND_WAIT",
  "CLEARED_TAKEOFF",
  "CLEARED_TO_LAND",
  "TAXI",
  "CONTINUE_APPROACH",
  "RUNWAY_CHANGE",
  "RETURN_TO_LAND",
]);
