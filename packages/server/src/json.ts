/** Far deeper than any real message, and far shallower than what overflows JSON.stringify. */
const MAX_DEPTH = 32;

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function tooDeep(value: unknown, room: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  return room === 0 || Object.values(value).some((child) => tooDeep(child, room - 1));
}

/**
 * Parse JSON from a client. Nesting is limited because whatever is accepted
 * gets stringified again for the run log and every dashboard socket.
 */
export function parseClientJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (tooDeep(value, MAX_DEPTH)) throw new Error("JSON is nested too deeply.");
  return value;
}
