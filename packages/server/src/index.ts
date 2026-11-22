import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  JUDGE_DEMO,
  SCENARIOS,
  TOOL_DEFINITIONS,
  explainAircraft,
  getAircraftDetails,
  type Command,
  type RadioMode,
  type SimEvent,
} from "@towerai/core";
import { MAX_SPEED, MIN_SPEED, SimHost, isControllerMode } from "./host";

import { towerFromEnv } from "./atc/elevenLabs";
import { ElevenLabs } from "./agents/client";
import { createCockpit, handleCockpit } from "./cockpit";
import { cockpitAgent } from "./cockpit/brain";
import { worldVoice } from "./voice/worldVoice";
import { agentConfig } from "./atc/config";
import { isJsonObject, parseClientJson } from "./json";
import { appFile, isFile, serveFile } from "./files";
import { OPERATOR } from "./ops/ops";
import { plugins } from "./plugins";
import { refusal, type Trust } from "./security";

/**
 * TowerAI server.
 *
 *   GET  /api/airport            static airport geometry for the map
 *   GET  /api/state              full snapshot of the live simulation
 *   GET  /api/events?since=SEQ   the event log after a sequence number
 *   GET  /api/aircraft/:id       one aircraft, with its explanation
 *   GET  /api/tools              controller tool definitions (JSON Schema)
 *   POST /api/tools/:name        controller tool call  <- ElevenLabs webhooks
 *   POST /api/commands           any simulation command <- operator, voice bridge, pilots
 *   POST /api/sim/control        pause / resume / speed / reset / step / controller
 *   POST /api/replay/verify      re-run the recorded commands and compare
 *   WS   /ws                     snapshots (10 Hz) and events, pushed live
 *   GET  /viewer                 a bare-bones live map for checking the simulation by eye
 *   GET  /                       the web app (packages/web/dist)
 *
 * The operator, world, audio and ops routes are documented in @towerai/contracts.
 */

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? "127.0.0.1";
const SECRET = env.TOWERAI_SECRET ?? "";
const CORS_ORIGIN = env.TOWERAI_CORS_ORIGIN?.trim();
const trust: Trust = { host: HOST, origins: CORS_ORIGIN && CORS_ORIGIN !== "*" ? [CORS_ORIGIN] : [] };
const WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const WORLD_FILE = fileURLToPath(new URL("../../world/data/world.json", import.meta.url));
/** The rules-driven judge demo starts over after this, so a server left running stays fresh and quick. */
const DEMO_LOOP_SEC = 40 * 60;
const radioMode = (v: string | undefined): RadioMode => (v === "external" ? "external" : "simulated");

const requested = env.TOWERAI_CONTROLLER ?? "baseline";
if (!isControllerMode(requested)) throw new Error("TOWERAI_CONTROLLER must be baseline, elevenlabs or none.");
// Paid mode exists only if it was asked for at startup; a later request cannot create it.
const createAgent = requested === "elevenlabs" ? towerFromEnv() : undefined;
const controller = requested === "elevenlabs" && !createAgent ? "baseline" : requested;
const hasKey = !!env.ELEVENLABS_API_KEY?.trim();
const SETUP = "node --env-file=.env --import tsx packages/server/src/agents/setup.ts";
const missing = hasKey ? `No tower agent (create it with: ${SETUP})` : "No ELEVENLABS_API_KEY";
if (controller !== requested) console.warn(`${missing}: starting with the rules controller (labelled rules).`);
const host = new SimHost({
  scenarioId: env.TOWERAI_SCENARIO ?? JUDGE_DEMO.id,
  controller,
  createAgent,
  radio: { controller: radioMode(env.TOWERAI_RADIO_CONTROLLER), pilots: radioMode(env.TOWERAI_RADIO_PILOTS) },
  dataDir: env.TOWERAI_DATA_DIR === "off" ? null : resolve(env.TOWERAI_DATA_DIR ?? "data/runs"),
  speed: Number(env.TOWERAI_SPEED ?? 1) || 1,
  plugins,
});

// Live speech exists only if it was asked for at startup, like paid control.
const talkApi = env.TOWERAI_TALK === "on" ? ElevenLabs.fromEnv() : null;
if (env.TOWERAI_TALK === "on" && !talkApi) console.warn("No ELEVENLABS_API_KEY: the cockpit takes typed input only.");
if (talkApi && !cockpitAgent()) console.warn(`No cockpit agent, so the cockpit understands by rules only. Create it with: ${SETUP}`);
const cockpit = createCockpit({ api: talkApi });
let stopMeter: (() => void) | undefined;

// ------------------------------------------------------------------- http

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "x-content-type-options": "nosniff",
    ...(CORS_ORIGIN
      ? {
          "access-control-allow-origin": CORS_ORIGIN,
          "access-control-allow-headers": "content-type, authorization, x-towerai-secret, x-idempotency-key",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        }
      : {}),
  });
  res.end(text);
}

const VIEWER_FILES: Record<string, { file: string; type: string }> = {
  "/viewer": { file: "./dev/viewer.html", type: "text/html; charset=utf-8" },
  "/viewer/scene3d.js": { file: "./dev/scene3d.js", type: "text/javascript; charset=utf-8" },
};
const THREE_BUILD = dirname(createRequire(import.meta.url).resolve("three"));

function sendFile(res: ServerResponse, file: string | URL, type: string, cache: string): void {
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": cache });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = parseClientJson(Buffer.concat(chunks).toString("utf8"));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    throw new HttpError(400, "Request body is not valid JSON, or is nested too deeply.");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, "The path is not valid.");
  }
}

/** A tool caller names itself. It may not pass as the operator or as the hosted agent. */
function callerName(header: unknown): string {
  if (typeof header !== "string" || !header.trim()) return "controller";
  return [OPERATOR, "elevenlabs-tower", "baseline-controller"].includes(header.trim()) ? `http:${header.trim()}` : header.trim();
}

/** Anything that changes the simulation needs the shared secret, when one is configured. */
function authorize(req: IncomingMessage): void {
  if (!SECRET) return;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? String(req.headers["x-towerai-secret"] ?? "");
  const a = Buffer.from(header);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Missing or wrong secret.");
}

let verifyFreeAt = 0;

/** Provenance is ours to state: nobody outside may sign as the operator or as one of our controllers. */
function asOutsideCommand(body: Record<string, unknown>): Command {
  if (body.type === "clearance.issue") return { ...body, issuedBy: callerName(body.issuedBy) } as unknown as Command;
  if (body.type === "advisory.issue" && body.by === "operator") return { ...body, by: "tower" } as unknown as Command;
  return body as unknown as Command;
}

function control(body: Record<string, unknown>) {
  switch (body.action) {
    case "pause":
      host.paused = true;
      break;
    case "resume":
      host.paused = false;
      break;
    case "speed": {
      const speed = Number(body.speed);
      if (!Number.isFinite(speed) || speed <= 0) throw new HttpError(400, `speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}.`);
      host.setSpeed(speed);
      break;
    }
    case "step":
      host.stepOnce(Math.min(Math.max(1, Number(body.steps) || 1), 6000));
      break;
    case "controller":
      if (!isControllerMode(body.mode)) throw new HttpError(400, "mode must be baseline, elevenlabs or none.");
      if (body.mode === "elevenlabs" && !createAgent) throw new HttpError(400, "The tower agent was not enabled at startup: it needs a key, the agents from agents/setup.ts, and npm run judge:live.");
      host.setController(body.mode);
      break;
    case "reset": {
      const res = host.reset(
        typeof body.scenarioId === "string" ? body.scenarioId : undefined,
        typeof body.seed === "number" ? body.seed : undefined,
      );
      if (!res.ok) throw new HttpError(400, res.message);
      break;
    }
    default:
      throw new HttpError(400, 'action must be one of: pause, resume, speed, step, controller, reset.');
  }
  broadcast({ type: "status", status: host.status() });
  return host.status();
}

/** An operator action: the screen should change now, not on the next tick. */
function acted(res: ServerResponse, result: { ok: boolean; message?: string }): void {
  send(res, result.ok ? 200 : 409, result);
  if (result.ok) broadcast({ type: "ops", ops: host.opsState() });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refused = refusal(req, trust);
  if (refused) throw new HttpError(403, refused);
  const url = new URL(`http://localhost${req.url?.startsWith("/") ? req.url : "/"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return send(res, 200, {});

  if (method === "GET" || method === "HEAD") {
    if (path === "/health") return send(res, 200, { ok: true, service: "towerai", ...host.status() });
    // The viewer: two files of ours, read on every request so they can be edited without a
    // restart, plus the three.js build it uses for its 3D mode. Only these exact names are served.
    const page = VIEWER_FILES[path];
    if (page) return sendFile(res, new URL(page.file, import.meta.url), page.type, "no-store");
    const vendor = /^\/vendor\/three\/(three\.(?:module|core)\.js)$/.exec(path);
    if (vendor) return sendFile(res, join(THREE_BUILD, vendor[1]), "text/javascript; charset=utf-8", "max-age=3600");
    if (path === "/api/airport") return send(res, 200, host.sim.graph.data);
    if (path === "/api/state") return send(res, 200, { status: host.status(), snapshot: host.sim.snapshot() });
    if (path === "/api/status") return send(res, 200, host.status());
    if (path === "/api/atc/config") return send(res, 200, agentConfig);
    if (path === "/api/tools") return send(res, 200, { tools: TOOL_DEFINITIONS });
    if (path === "/api/scenarios") {
      return send(res, 200, {
        scenarios: Object.values(SCENARIOS).map((s) => ({ id: s.id, name: s.name, description: s.description, airport: s.airport, aircraft: s.aircraft.length })),
      });
    }
    if (path === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 500) || 500, 5000);
      const all = host.sim.events;
      // seq starts at 1 and has no gaps, so the log can be indexed directly.
      const events = all.slice(since, since + limit);
      return send(res, 200, { events, lastSeq: all.length });
    }
    if (path.startsWith("/api/aircraft/")) {
      const id = decoded(path.slice("/api/aircraft/".length)).toUpperCase();
      const details = getAircraftDetails(host.sim, id);
      if (!details) throw new HttpError(404, `No aircraft ${id}.`);
      return send(res, 200, { ...details, explanation: explainAircraft(host.sim, id) });
    }

    if (path === "/api/ops") return send(res, 200, host.opsState());
    const flight = /^\/api\/ops\/flights\/([^/]+)(\/actions)?$/.exec(path);
    if (flight) {
      const id = decoded(flight[1]);
      const record = host.ops.flight(id);
      if (!record) throw new HttpError(404, `No flight ${id} in this run.`);
      return send(res, 200, flight[2] ? { actions: host.ops.actions(id) } : record);
    }
    if (path === "/api/world") {
      if (!(await isFile(WORLD_FILE))) throw new HttpError(404, "No world recording yet. Run npm run record:world.");
      return serveFile(req, res, WORLD_FILE, "no-cache");
    }
    if (path.startsWith("/api/audio/")) {
      const file = plugins.voice?.file(decoded(path.slice("/api/audio/".length)));
      if (!file) throw new HttpError(404, "No audio by that name.");
      return serveFile(req, res, file, "public, max-age=31536000, immutable");
    }
    if (!/^\/(api|ws|vendor)(\/|$)/.test(path)) {
      const file = await appFile(WEB_DIST, path);
      if (file) return serveFile(req, res, file, path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      if (path === "/") return send(res, 200, { ok: true, service: "towerai", note: "Web app not built: run npm run build.", ...host.status() });
    }
  }

  if (path === "/api/cockpit" || path.startsWith("/api/cockpit/")) {
    if (method === "POST") authorize(req);
    if (await handleCockpit(cockpit, req, res, path)) return;
  }

  // Maritime's agent contract: {"message": "..."} in, {"response": "..."} out within 30 s.
  // It only answers questions about the live picture and changes nothing, so it needs no secret.
  if (method === "POST" && path === "/chat") {
    const body = await readJson(req);
    return send(res, 200, { response: host.ops.chat(typeof body.message === "string" ? body.message.slice(0, 500) : "") });
  }

  if (method === "POST") {
    authorize(req);
    if (path === "/api/world/voice") return send(res, 200, await worldVoice(await readJson(req), talkApi));
    if (path.startsWith("/api/tools/")) {
      const name = decoded(path.slice("/api/tools/".length));
      const body = await readJson(req);
      const key = req.headers["x-idempotency-key"];
      const result = host.gateway.call(name, body, {
        idempotencyKey: typeof key === "string" ? key : undefined,
        caller: callerName(req.headers["x-towerai-caller"]),
      });
      // Tool-level failures are still a 200: the agent should read the error, not see a transport fault.
      return send(res, result.ok || result.error.code !== "UNKNOWN_TOOL" ? 200 : 404, result);
    }
    if (path === "/api/replay/verify") {
      // It re-simulates the whole run on this thread, so one at a time and not back to back.
      if (Date.now() < verifyFreeAt) throw new HttpError(429, "A replay check has just run. Try again shortly.");
      const result = host.verifyReplay();
      verifyFreeAt = Date.now() + 5000;
      return send(res, 200, result);
    }
    if (path === "/api/commands") {
      const body = await readJson(req);
      if (typeof body.type !== "string") throw new HttpError(400, 'A command needs a "type".');
      return send(res, 200, host.dispatch(asOutsideCommand(body)));
    }
    if (path === "/api/sim/control") return send(res, 200, control(await readJson(req)));
    if (path === "/api/demo/restart") {
      host.paused = false;
      host.setSpeed(1);
      const result = host.reset(JUDGE_DEMO.id, JUDGE_DEMO.seed);
      broadcast({ type: "status", status: host.status() });
      return send(res, 200, { ok: result.ok });
    }
    const ack = /^\/api\/ops\/alerts\/([^/]+)\/ack$/.exec(path);
    if (ack) return acted(res, host.ops.acknowledge(decoded(ack[1])));
    const action = /^\/api\/ops\/flights\/([^/]+)\/(takeover|handback|instruct|accept|ask)$/.exec(path);
    if (action) {
      const id = decoded(action[1]);
      if (action[2] === "takeover") return acted(res, host.ops.takeover(id));
      if (action[2] === "handback") return acted(res, host.ops.handback(id));
      const body = await readJson(req);
      // A question changes nothing, so it answers without a broadcast.
      if (action[2] === "ask") return send(res, 200, host.ops.ask(id, typeof body.question === "string" ? body.question.slice(0, 300) : ""));
      if (action[2] === "accept") {
        const steps = Array.isArray(body.steps) ? body.steps.filter((x): x is string => typeof x === "string").slice(0, 4) : [];
        return acted(res, host.ops.accept(id, steps));
      }
      const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
      return acted(
        res,
        host.ops.instruct(id, { clearanceType: text("clearanceType"), reason: text("reason"), runway: text("runway"), gate: text("gate") }),
      );
    }
  }

  throw new HttpError(404, `No route for ${method} ${path}.`);
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message });
    console.error(err);
    send(res, 500, { ok: false, error: "Internal server error." });
  });
});

// -------------------------------------------------------------- websocket

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 1_000_000,
  // The socket takes commands, so it is guarded like a POST.
  verifyClient: ({ req }: { req: IncomingMessage }) => refusal(req, trust, true) === null,
});
const clients = new Set<WebSocket>();
let pendingEvents: SimEvent[] = [];

function broadcast(message: unknown): void {
  if (clients.size === 0) return;
  const text = JSON.stringify(message);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(text);
}

function hello(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "hello",
      status: host.status(),
      snapshot: host.sim.snapshot(),
      recentEvents: host.sim.events.slice(-300),
    }),
  );
  ws.send(JSON.stringify({ type: "ops", ops: host.opsState() }));
}

wss.on("connection", (ws) => {
  clients.add(ws);
  hello(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  ws.on("message", (raw) => {
    // The socket is read-mostly; commands over it are a convenience for the dashboard.
    let msg: Record<string, unknown>;
    try {
      const parsed = parseClientJson(String(raw));
      if (!isJsonObject(parsed)) throw new Error("Not an object.");
      msg = parsed;
    } catch {
      return ws.send(JSON.stringify({ type: "error", error: "Message must be a JSON object without deep nesting." }));
    }
    if (SECRET && msg.secret !== SECRET) {
      return ws.send(JSON.stringify({ type: "error", id: msg.id, error: "Missing or wrong secret." }));
    }
    try {
      if (msg.type === "command" && msg.command && typeof msg.command === "object") {
        ws.send(JSON.stringify({ type: "result", id: msg.id, result: host.dispatch(asOutsideCommand(msg.command as Record<string, unknown>)) }));
      } else if (msg.type === "control") {
        ws.send(JSON.stringify({ type: "result", id: msg.id, result: control(msg) }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", id: msg.id, error: err instanceof Error ? err.message : String(err) }));
    }
  });
});

// The caption and the voice follow the radio, so a new line is sent as it starts.
let airChanged = false;
host.onEvent((e) => {
  pendingEvents.push(e);
  if (e.type === "radio.tx_started" || e.type === "radio.tx_interrupted") airChanged = true;
});
host.onReset(() => {
  pendingEvents = [];
  for (const ws of clients) if (ws.readyState === ws.OPEN) hello(ws);
});

// Events go out in batches with the next frame; positions go out at 10 Hz.
setInterval(() => {
  if (pendingEvents.length > 0) {
    const events = pendingEvents;
    pendingEvents = [];
    broadcast({ type: "events", events });
  }
  if (clients.size > 0) broadcast({ type: "snapshot", status: host.status(), snapshot: host.sim.snapshot() });
  if (airChanged && clients.size > 0) broadcast({ type: "ops", ops: host.opsState() });
  airChanged = false;
}, 100);

setInterval(() => {
  // Only the rules demo loops: a hosted agent would spend on every new run.
  const stale = host.scenario.id === JUDGE_DEMO.id && host.controllerMode === "baseline" && host.sim.time >= DEMO_LOOP_SEC;
  if (stale && ![...host.sim.aircraft.values()].some((ac) => ac.humanControl)) host.reset();
  if (clients.size > 0) broadcast({ type: "ops", ops: host.opsState() });
}, 500);

// ------------------------------------------------------------------ start

server.listen(PORT, HOST, () => {
  const s = host.status();
  console.log(`TowerAI listening on http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT} (bound to ${HOST})`);
  console.log(`  scenario:   ${s.scenario.name} (seed ${s.scenario.seed})`);
  console.log(`  controller: ${s.controller}${s.controller === "baseline" ? "  (rule-based stand-in, not the AI controller)" : ""}`);
  console.log(`  radio:      controller=${s.radio.controller} pilots=${s.radio.pilots}`);
  console.log(`  secret:     ${SECRET ? "required for POST" : "none (set TOWERAI_SECRET before exposing this beyond localhost)"}`);
  host.start();
  cockpit.start();
  stopMeter = talkApi?.watchMeter();
  console.log(`  cockpit:    ${talkApi ? "live ElevenLabs speech (spends credits)" : "typed input, rules, no spend (npm run judge:talk for speech)"}`);
});

function shutdown(): void {
  host.stop();
  cockpit.stop();
  stopMeter?.();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
