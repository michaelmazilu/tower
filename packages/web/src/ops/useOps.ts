import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { OpsState } from "@towerai/contracts";
import type { AirportData, SimSnapshot } from "@towerai/core";

export type LinkState = "connecting" | "live" | "lost";

export interface OpsLink {
  ops: OpsState | null;
  state: LinkState;
  airport: AirportData | null;
  /** The raw 10 Hz snapshot, read by the map for cleared routes without re-rendering. */
  snapshot: RefObject<SimSnapshot | null>;
  refresh(): void;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return (await res.json()) as T;
}

/** A refusal is a normal answer here: the validator says no and we show why. */
export async function post(path: string, body: unknown = {}): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: res.ok && reply.ok !== false, message: reply.message ?? reply.error };
  } catch {
    return { ok: false, message: "The tower link did not answer." };
  }
}

const STALE_MS = 3500;
const POLL_AFTER_MS = 1500;

export function useOps(): OpsLink {
  const [ops, setOps] = useState<OpsState | null>(null);
  const [state, setState] = useState<LinkState>("connecting");
  const [airport, setAirport] = useState<AirportData | null>(null);
  const snapshot = useRef<SimSnapshot | null>(null);
  const heard = useRef(0);

  const take = useCallback((next: OpsState) => {
    heard.current = Date.now();
    setOps(next);
    setState("live");
  }, []);
  const refresh = useCallback(() => void get<OpsState>("/api/ops").then(take).catch(() => undefined), [take]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const opened = Date.now();

    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "ops") take(message.ops);
          else if (message.snapshot) snapshot.current = message.snapshot;
        } catch {
          // A frame we cannot read is not a lost link; the staleness check decides that.
        }
      };
      socket.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 1000);
      };
    };
    connect();
    refresh();

    const watch = setInterval(() => {
      const quiet = Date.now() - (heard.current || opened);
      if (!heard.current || quiet > POLL_AFTER_MS) refresh();
      if (quiet > STALE_MS) setState("lost");
    }, 1000);

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watch);
      socket?.close();
    };
  }, [take, refresh]);

  useEffect(() => {
    if (airport) return;
    const load = () => void get<AirportData>("/api/airport").then(setAirport).catch(() => undefined);
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [airport]);

  return { ops, state, airport, snapshot, refresh };
}
