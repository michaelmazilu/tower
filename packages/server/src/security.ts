import type { IncomingMessage } from "node:http";

/**
 * A key that spends money lives on this machine, so a web page the operator
 * happens to have open must not be able to drive this server.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export interface Trust {
  /** The address the server listens on. */
  host: string;
  /** Further origins allowed to change state, e.g. TOWERAI_CORS_ORIGIN. */
  origins: string[];
}

/** Why the request is refused, or null. `change` is true for WebSockets, which accept commands. */
export function refusal(req: IncomingMessage, trust: Trust, change = !READS.has(req.method ?? "GET")): string | null {
  const own = parse(`http://${req.headers.host ?? "localhost"}`);
  // Listening only on this machine, any other name in Host is DNS rebinding.
  if (!own || (LOOPBACK.has(trust.host) && !LOOPBACK.has(own.hostname))) return "Unknown host.";
  if (!change) return null;
  const origin = req.headers.origin;
  if (origin === undefined) return req.headers["sec-fetch-site"] === "cross-site" ? "Cross-origin request refused." : null;
  if (trust.origins.includes(origin)) return null;
  const from = parse(origin);
  if (!from) return "Cross-origin request refused.";
  // The dev server's proxy keeps the browser's Host, so it counts as the same origin.
  if (from.host === own.host) return null;
  return "Cross-origin request refused.";
}
