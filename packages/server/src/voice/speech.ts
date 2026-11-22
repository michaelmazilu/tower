import { spokenCallsign, spokenRunway } from "@towerai/core";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
/** Spaced numerals read out one at a time and bill at a fraction of the spelled words. */
const digits = (value: string) => [...value].map((c) => (c === "9" ? "niner" : c)).join(" ");
const compact = (spoken: string) =>
  spoken.replace(/\b(zero|one|two|three|four|five|six|seven|eight)\b/g, (word) => String(WORDS.indexOf(word)));

/** Both the simulator's spoken form and plain text end up identical, so they share one cached file. */
export function radioSpeech(text: string): string {
  return compact(expand(text));
}

/** Turns dashboard text into what a pilot would say, so "23" is never read as "twenty-three". */
function expand(text: string): string {
  return text
    // Taxiways and stands are letters on the screen and words on the radio. spokenCallsign spells them.
    .replace(/\bgate ([A-Z]?\d{1,3}[A-Z]?)\b/g, (_, gate: string) => `gate ${spokenCallsign(gate)}`)
    .replace(/\bvia ((?:[A-Z]{1,2}\d{0,2})(?:, [A-Z]{1,2}\d{0,2})*)(?=[,.]|$)/g, (_, via: string) => `via ${via.split(", ").map(spokenCallsign).join(", ")}`)
    .replace(/\b[A-Z]{3}\d{1,4}[A-Z]?\b/g, (callsign) => spokenCallsign(callsign))
    .replace(/\brunway (\d{2}[LRC]?)\b/gi, (match, rw: string) => `${match.slice(0, 6)} ${spokenRunway(rw.toUpperCase())}`)
    .replace(/\bFL ?(\d{2,3})\b/g, (_, level: string) => `flight level ${digits(level)}`)
    .replace(/\b(\d{1,2}),?000\b/g, (_, n: string) => `${digits(n)} thousand`)
    .replace(/\d+\.\d+/g, (n) => n.split(".").map(digits).join(" decimal "))
    .replace(/\d+/g, (n) => ` ${digits(n)} `)
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
