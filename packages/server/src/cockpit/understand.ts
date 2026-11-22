import type { Clearance } from "@towerai/core";
import { normalizeSpeech } from "@towerai/core";

/** The rules brain: what a person who has never flown meant, from messy speech. Pure. */

export type Claim = "engine" | "smoke" | "fuel" | "crash" | "other" | "airborne" | "ground" | "altitude";
export type Topic =
  | "takeoff" | "land" | "hold" | "checkin" | "pushback" | "taxi" | "cross" | "human" | "allclear" | "insist" | "injection"
  | "status" | "altitude" | "speed" | "engines" | "fuel" | "weather" | "traffic" | "runway" | "callsign"
  | "repeat" | "help" | "hello" | "thanks" | "unknown";
export type Meaning = { kind: "claim"; claim: Claim; feet?: number } | { kind: "topic"; topic: Topic };

const TENS: Record<string, number> = { ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };

/** Lower case, no apostrophes, clause breaks kept as "|" so a pattern cannot reach across one. */
export function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/[,.!?;:]+(?=\s|$)/g, " | ")
    .replace(/[^a-z0-9|]+/g, " ")
    .replace(/\b(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?: (one|two|three|four|five|six|seven|eight|nine|niner))?\b/g, (_, t: string, o?: string) => String(TENS[t]! + (o ? ONES[o]! : 0)))
    .replace(/\b(?:two|to|too|2) (?:four|for|fore|4) (left|right)\b/g, "two four $1")
    .replace(/\b([0-3]\d) (l|r|c)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const NOT_SO =
  /\b(?:false alarm|just kidding|i m kidding|only joking|just joking|everything (?:is |s )?(?:fine|ok|okay|good)|all good|we re (?:fine|ok|okay)|(?:not|aren t|isn t|(?<!oh )no|there s no) (?:(?:on|a|an|any|really) )?(?:crashing|fire|smoke|emergency|mayday|engine failure))\b/g;

const CLAIMS: [Claim, RegExp][] = [
  ["engine", /\bengines? (?:\w+ ){0,3}(?:fail\w*|out|dead|died|dying|gone|lost|stopped|broken?|explod\w*|blew|blown|quit|fire|flames?|not working|isn t working|shut down|cut out|conked)\b|\b(?:lost|losing|no|failed) (?:(?:an|the|my|our|both|left|right|a) )*(?:engines?|power|thrust)\b|\bengine (?:failure|trouble|problem)\b|\bflame ?out\b|\bexplosion in the engine\b/],
  ["smoke", /\bsmok(?:e|y|ing)\b|\bon fire\b|\bfire\b(?! up| truck| department)|\bflames\b|\bburning\b/],
  ["fuel", /\b(?:low|out of|no|running out|run out|empty|minimum|losing|leak\w*|almost out of)(?: \w+){0,2} (?:fuel|gas)\b|\b(?:fuel|gas)(?: \w+){0,2} (?:low|empty|out|leak\w*|critical|gone|emergency)\b|\bbingo fuel\b/],
  ["other", /\b(?:heart attack|passed out|unconscious|not breathing|medical|bleeding|chest pain|seizure|very sick|hijack\w*|bomb|gunman|knife|bird ?strike|hit (?:a |an |some)?(?:bird|thing|something)|hydraulic\w*|door (?:is |s )?open|window (?:is |s )?(?:cracked|broken)|gear (?:is |s )?(?:stuck|broken|jammed)|brakes? (?:failed|aren t|don t|not)|can t breathe|steering (?:failed|is broken))\b/],
  ["crash", /\bcrash(?:ing|ed)?\b|\bgoing down\b|\bmayday\b|\bpan pan\b|\bemergency\b|\bfalling\b|\bplummet\w*|\bwe (?:re |are )?(?:gonna|going to|will) die\b|\bnose ?div\w+|\bstall(?:ing|ed)\b|\blosing altitude\b|\bout of control\b|\blos(?:t|ing) control\b|\bsinking\b|\bsomething(?: is| s)? (?:\w+ )?wrong\b|\bwe (?:have|ve got|got) a (?:big |serious )?problem\b|\bdropping (?:fast|out)\b|\bwe re dropping\b/],
];

const GROUND = /\b(?:haven t|have not|didn t|did not|never) (?:even )?(?:taken|take|took) off\b|\b(?:we re|we are|i m|i am|still) (?:still )?(?:on the ground|parked|stationary)\b|\bwe (?:ve |have )?landed\b/;
const AIRBORNE = /\b(?:we|i) (?:just |already |have |ve )*(?:taken off|took off|lifted off)\b|\b(?:we re|we are|i m|i am) (?:already |now )?(?:airborne|flying|in the (?:air|sky))\b/;
const ALTITUDE = /\b(?:we re|we are|i m|i am|passing|level at|climbing through) (?:at |now )?(\d+|one|two|three|four|five|six|seven|eight|nine) ?(thousand|feet|foot)\b/;

const TOPICS: [Topic, RegExp][] = [
  ["injection", /\b(?:ignore|disregard|forget|override|bypass) (?:all |any |your |the |previous |prior )*(?:instructions?|rules|prompts?|validator|safety|previous)\b|\bsystem prompt\b|\byou are now\b|\bdeveloper mode\b|\bpretend (?:you|to be)\b|\bclear (?:united|delta|westjet|lufthansa|jazz|porter|everyone|all aircraft|the other)\b|\b(?:crash|divert|move) (?:united|delta|westjet|the other)\b/],
  ["allclear", NOT_SO],
  ["insist", /\b(?:i m serious|i am serious|not (?:joking|kidding)|i swear|i mean it|believe me|i m telling you|i can see it|yes we are|for real)\b/],
  ["human", /\bsend (?:help|someone|responders|trucks|an ambulance)\b|\bneed (?:help now|an ambulance|responders)\b|\b(?:human|real person|supervisor|real controller)\b|\bsave (?:me|us)\b/],
  ["checkin", /\bcheck(?:ing|ed)? ?in\b|\bradio check\b/],
  ["hold", /\b(?<!can t )(?:stop|hold|abort|wait|cancel)\b(?! short)|\b(?:don t|do not) want to (?:take ?off|fly|go)\b|\bchanged my mind\b/],
  ["weather", /\b(?:weather|wind|windy|rain|raining|snow|storm|visibility|foggy|fog)\b/],
  ["traffic", /\b(?:traffic|other (?:planes?|aircraft)|planes? (?:near|around|nearby)|anyone (?:near|around|else)|who else)\b/],
  ["altitude", /\b(?:altitude|how high|height)\b/],
  ["speed", /\b(?:how fast|airspeed|my speed|what speed|how many knots)\b/],
  ["engines", /\bengines?\b.*\b(?:ok|okay|fine|normal|status|doing|working|good)\b|\bhow (?:are|is|s) (?:my |the )?engines?\b/],
  ["fuel", /\bfuel\b/],
  ["status", /\bwhere (?:am i|are we)\b|\bwhat (?:do you see|is my status|s my status)\b|\b(?:my )?(?:status|vitals)\b|\bhave (?:i|we) taken off\b|\bare we (?:in the air|flying|moving|crashing)\b/],
  ["land", /\b(?:land|landing|go back|return to the airport|come back)\b/],
  ["callsign", /\b(?:who am i|call ?sign|what s my name|what am i called)\b/],
  ["cross", /\bcross(?:ing)?\b/],
  ["taxi", /\b(?:taxi|taxiing|taxy|taxing)\b|\bready to move\b|\bcontinue\b/],
  ["pushback", /\bpush(?:ing|ed)? ?(?:back|us|me)\b|\bleave the gate\b/],
  ["takeoff", /\btake ?off\b|\btaking off\b|\bdepart(?:ure)?\b|\bready (?:to (?:go|fly|roll|leave)|when you are)\b|\bwant (?:to|2) (?:fly|go|leave)\b|\bwanna (?:fly|go|take ?off|leave)\b|\b(?:can|may|could) (?:i|we) (?:(?:like|just|please|maybe|actually) )*(?:fly|leave|go(?= now| please| \||$))\b|^(?:(?:ok|okay|yes|i m|we re|i am|we are|tower|all|\|) )*ready(?: now| \||$)|\blet s (?:go|fly|roll)\b|\b(?:get|getting) (?:\w+ ){0,3}(?:in the air|off the ground|airborne)\b|\blift ?off\b|\bline up\b/],
  ["repeat", /\b(?:say again|repeat|what was that|pardon|come again|didn t (?:hear|catch)|what do i (?:say|read))\b/],
  ["runway", /\brunway\b/],
  ["help", /\bwhat (?:do|should|can) i\b|\bwhat (?:now|next)\b|\bwhat do (?:i|we) need\b|\bhow do (?:i|you|we)\b|\bi (?:don t|do not) know\b|\bfirst time\b|\bnever (?:flown|done)\b|\bhelp\b|\bguide me\b/],
  ["thanks", /\b(?:thanks|thank you|cheers|appreciate)\b/],
  ["hello", /\b(?:hello|hi|hey|good (?:morning|afternoon|evening)|radio check|can you hear me)\b/],
];

/** Danger first, then the safety words, then everything else. */
export function understand(text: string): Meaning {
  const said = plain(text);
  const asserted = said.replace(NOT_SO, " | ");
  for (const [claim, re] of CLAIMS) if (re.test(asserted)) return { kind: "claim", claim };
  if (TOPICS[0]![1].test(said)) return { kind: "topic", topic: "injection" };
  if (GROUND.test(said)) return { kind: "claim", claim: "ground" };
  if (AIRBORNE.test(said)) return { kind: "claim", claim: "airborne" };
  const level = ALTITUDE.exec(said);
  if (level) return { kind: "claim", claim: "altitude", feet: (ONES[level[1]!] ?? Number(level[1])) * (level[2] === "thousand" ? 1000 : 1) };
  for (const [topic, re] of TOPICS) if (said.search(re) >= 0) return { kind: "topic", topic };
  return { kind: "topic", topic: "unknown" };
}

export interface Readback {
  /** It was an attempt at the readback at all. */
  attempted: boolean;
  missing: string[];
}

/** Any word order, callsign optional. The instruction and every number that matters must still be right. */
export function checkReadback(clearance: Pick<Clearance, "type" | "runway" | "vector">, text: string, holdShort?: string): Readback {
  const words = plain(text).replace(/\btake (?:of|off)\b/g, "takeoff");
  const said = normalizeSpeech(words.replace(/\| (left|right)\b/g, "$1").replace(/\|/g, " x "))
    .replace(/\b(\d) (?:thousand)\b/g, "$1000")
    .replace(/\b(\d{1,2}) (left|right)\b/g, (_, n: string, side: string) => n + side[0]);
  const has = (re: RegExp) => re.test(said);
  const runways = [
    ...[...said.matchAll(/\b(\d{1,2}[lrc])\b/g)].map((m) => m[1]!),
    ...[...said.matchAll(/\brunway (\d{1,2})\b/g)].map((m) => m[1]!),
  ];
  const want = clearance.runway?.toLowerCase() ?? "";
  const missing: string[] = [];
  const question = /^(?:(?:tower|um|uh|so|ok|okay|x) )*(?:am i|are we|is|can|could|may|do|does|what|how|why|when|where|should)\b/.test(said) || has(/\b(?:want|wanna|ready to|request\w*)\b/);
  const acknowledged = has(/^(?:(?:ok|okay|roger|copy|wilco|yes|yeah|yep|got it|understood|that|x) ?)+$/);
  const refused = has(/\b(?:not|unable|negative|cannot|can t|don t|won t|never|cancel|abort)\b/);
  let attempted = runways.length > 0 || acknowledged;

  if (clearance.type === "CLEARED_TAKEOFF") {
    const said2 = has(/\btakeoff\b/);
    attempted ||= said2 && has(/\b(?:cleared|clear)\b/);
    if (!said2 || has(/\bland\b/)) missing.push("cleared for takeoff");
  } else if (clearance.type === "CLEARED_TO_LAND") {
    const said2 = has(/\bland\b/);
    attempted ||= said2 && has(/\b(?:cleared|clear)\b/);
    if (!said2 || has(/\btakeoff\b/)) missing.push("cleared to land");
  } else if (clearance.type === "PUSHBACK") {
    const pushed = has(/\bpush/);
    attempted ||= pushed && has(/\b(?:approved|approve)\b/);
    if (!pushed) missing.push("pushback approved");
  } else if (clearance.type === "TAXI") {
    const taxied = has(/\btax(?:i|y|iing|ing)\b/);
    attempted ||= taxied;
    if (!taxied) missing.push("taxi");
  } else if (clearance.type === "CROSS_RUNWAY") {
    const crossed = has(/\bcross/);
    attempted ||= crossed;
    if (!crossed) missing.push("cross");
  } else if (clearance.type === "CONTINUE_TAXI") {
    const on = has(/\bcontinu/);
    attempted ||= on;
    if (!on) missing.push("continue taxi");
  } else if (clearance.vector) {
    const heading = String(clearance.vector.headingDeg).padStart(3, "0");
    attempted ||= has(/\b(?:heading|maintain)\b/);
    const other = clearance.vector.turn === "left" ? "right" : "left";
    if (!has(new RegExp(`\\b(?:${heading}|${Number(heading)})(?!\\d)`)) || has(new RegExp(`\\bturn ${other}\\b`))) missing.push(`heading ${heading}`);
    if (!has(new RegExp(`(?<!\\d)${clearance.vector.altitudeFt}\\b`))) missing.push(`${clearance.vector.altitudeFt} feet`);
  }
  const short = holdShort?.toLowerCase();
  const named = short ? runways.filter((r) => r !== short) : runways;
  if (want && (!named.length || named.some((r) => r !== want))) missing.push(`runway ${clearance.runway}`);
  // The part of a taxi clearance that must never be left out.
  if (short && (!has(/\bhold/) || !runways.includes(short))) missing.push(`hold short runway ${holdShort}`);
  if (refused) missing.push("a clear yes");
  return { attempted: attempted && !question && !(refused && !runways.length), missing };
}
