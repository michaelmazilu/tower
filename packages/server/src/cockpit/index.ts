import type { IncomingMessage, ServerResponse } from "node:http";
import type { Fault } from "@towerai/contracts";
import { isJsonObject, parseClientJson } from "../json";
import { MAX_CLIP_BYTES } from "./brain";
import type { Cockpit } from "./cockpit";

export { COCKPIT_AGENT, COCKPIT_PROMPT, setupCockpitAgent, transcribe } from "./brain";
export { createCockpit, type Cockpit, type TalkResult } from "./cockpit";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Keep draining so the visitor gets an answer instead of a broken connection.
    if (size <= limit) chunks.push(chunk as Buffer);
    else if (size > limit * 3) return null;
  }
  return size > limit ? null : Buffer.concat(chunks);
}

/**
 * The /api/cockpit routes. Resolves false for any other path. The caller applies
 * its origin check first, and authorizes the POSTs.
 */
export async function handleCockpit(cockpit: Cockpit, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method === "GET" && path === "/api/cockpit") {
    send(res, 200, cockpit.state());
    return true;
  }
  const action = /^\/api\/cockpit\/(talk|say|fault|reset)$/.exec(path)?.[1];
  if (req.method !== "POST" || !action) return false;

  if (action === "reset") {
    send(res, 200, cockpit.reset());
    return true;
  }
  const body = await readBody(req, action === "talk" ? MAX_CLIP_BYTES : 4096);
  if (!body) {
    send(res, 413, { ok: false, message: "That is too large." });
    return true;
  }
  if (action === "talk") {
    const result = await cockpit.talk(body, String(req.headers["content-type"] ?? ""));
    send(res, result.ok ? 200 : 409, result);
    return true;
  }
  let input: unknown;
  try {
    input = parseClientJson(body.toString("utf8"));
  } catch {
    input = null;
  }
  if (!isJsonObject(input)) {
    send(res, 400, { ok: false, message: "Send a JSON object." });
    return true;
  }
  const result = action === "say" ? await cockpit.say(input.text as string) : cockpit.fault(input.fault as Fault, input.on as boolean);
  send(res, result.ok ? 200 : 409, result);
  return true;
}
