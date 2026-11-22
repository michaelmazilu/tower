import { Server } from "node:http";
import { Server as NetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const deep = "[".repeat(60_000) + "]".repeat(60_000);

describe.each(["", "test-secret"])("server input boundary (secret: %j)", (secret) => {
  let server: Server;
  let port: number;
  const timers: NodeJS.Timeout[] = [];

  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv("TOWERAI_SECRET", secret);
    vi.stubEnv("TOWERAI_DATA_DIR", "off");
    vi.stubEnv("TOWERAI_CONTROLLER", "none");
    vi.spyOn(console, "log").mockImplementation(() => {});

    // index.ts starts itself on import: give it a free loopback port and keep what it starts for cleanup.
    const setTimer = globalThis.setInterval;
    const intervals = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
      const timer = setTimer(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const netListen = NetServer.prototype.listen as (this: NetServer, port: number, host: string, done: () => void) => NetServer;
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
      server = this;
      const started = args[args.length - 1] as () => void;
      netListen.call(this, 0, "127.0.0.1", () => {
        started();
        ready();
      });
      return this;
    } as typeof Server.prototype.listen);

    await import("../src/index");
    await listening;
    intervals.mockRestore();
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    timers.forEach(clearInterval);
    server.closeAllConnections();
    server.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const post = (path: string, body: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      body,
    });

  const reply = (raw: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("no reply to the message"));
      }, 2000);
      ws.on("open", () => ws.send(raw));
      ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type !== "error" && message.type !== "result") return;
        clearTimeout(timeout);
        ws.close();
        resolve(message);
      });
    });

  it.each([
    ["null", "null"],
    ["a number", "7"],
    ["an array", "[]"],
    ["deeply nested JSON", `{"type":"control","action":"pause","id":${deep}}`],
  ])("answers a WebSocket message that is %s with an error", async (_, raw) => {
    expect(await reply(raw)).toMatchObject({ type: "error" });
  });

  it.each(["/api/commands", "/api/tools/get_conflicts"])("refuses deeply nested JSON on %s", async (path) => {
    expect((await post(path, `{"type":"emergency.set_mode","mode":"manual","x":${deep}}`)).status).toBe(400);
  });

  it("answers an unknown command with a failed result", async () => {
    const res = await post("/api/commands", '{"type":"typo"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });

  it("still accepts a well-formed control message", async () => {
    expect(await reply(JSON.stringify({ type: "control", action: "pause", secret }))).toMatchObject({ type: "result" });
  });
});
