import { useEffect, useMemo, useRef, useState } from "react";
import type { FlightRecord, FlightSummary, OpsState } from "@towerai/contracts";
import { FlightDetail } from "../shared/FlightDetail";
import { byUrgency, clock, flightAt, needsHuman, separationAt } from "../shared/replay";
import type { Sound } from "../shared/sound";
import { AirportMap } from "./AirportMap";
import { FlightGrid } from "./FlightGrid";
import { OnAir } from "./OnAir";
import { TakeOverKey, OperatorPanel, useOperator } from "./Operator";
import { get, post, type OpsLink } from "./useOps";
import "./ops.css";

const RECORD_MS = 1000;
const REPLAY_STEP_MS = 80;
const REPLAY_RATE = 4;

export function OpsStatus({ link }: { link: OpsLink }) {
  const { ops, state } = link;
  return (
    <div className="top-status">
      {ops && (
        <div className={`top-controller ${ops.controller.state === "error" ? "top-bad" : ""}`}>
          <small>controller, {ops.controller.state}</small>
          <p title={ops.controller.label}><em>{ops.controller.brain}</em>{ops.controller.label}</p>
        </div>
      )}
      <div className={`top-link ${state === "lost" ? "top-bad" : ""}`}>
        <small>tower link</small>
        <p><i />{state === "live" ? "live" : state === "lost" ? "lost" : "connecting"}</p>
      </div>
      <div className="top-clock">
        <small>{ops?.paused ? "paused" : "sim time"}</small>
        <p>{ops ? clock(ops.t) : "––:––"}</p>
      </div>
    </div>
  );
}

/** A new run is a new history, so nothing carries over a restart. */
export function OpsView({ link, sound }: { link: OpsLink; sound: Sound }) {
  const { ops, airport, state } = link;
  if (!ops || !airport) {
    return (
      <div className="wait">
        <p>{state === "lost" ? "Tower link lost. Trying again." : "Connecting to Toronto Pearson."}</p>
      </div>
    );
  }
  return <Operations key={ops.runId} link={link} ops={ops} sound={sound} />;
}

function Operations({ link, ops, sound }: { link: OpsLink; ops: OpsState; sound: Sound }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [records, setRecords] = useState<Record<string, FlightRecord>>({});
  const replaying = cursor !== null;

  const flights = useMemo(() => [...ops.flights].sort(byUrgency), [ops.flights]);
  const nameOf = (id: string) => ops.flights.find((f) => f.id === id)?.callsign ?? records[id]?.summary.callsign ?? id;

  const select = (id: string | null) => {
    setSelectedId(id);
    if (!id) {
      setCursor(null);
      setPlaying(false);
    }
  };

  // The selected flight's history keeps growing while it is open.
  useEffect(() => {
    if (!selectedId) return;
    let stopped = false;
    const load = () =>
      get<FlightRecord>(`/api/ops/flights/${encodeURIComponent(selectedId)}`)
        .then((r) => !stopped && setRecords((all) => ({ ...all, [selectedId]: r })))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, RECORD_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selectedId]);

  // Replaying one flight replays the traffic around it.
  const ids = ops.flights.map((f) => f.id).sort().join(",");
  useEffect(() => {
    if (!replaying || !ids) return;
    let stopped = false;
    void Promise.all(ids.split(",").map((id) => get<FlightRecord>(`/api/ops/flights/${encodeURIComponent(id)}`).catch(() => null))).then((got) => {
      if (stopped) return;
      const found = got.filter((r) => r !== null);
      setRecords((all) => ({ ...all, ...Object.fromEntries(found.map((r) => [r.summary.id, r])) }));
    });
    return () => {
      stopped = true;
    };
  }, [replaying, ids]);

  useEffect(() => {
    if (!replaying || !playing) return;
    const timer = setInterval(() => setCursor((c) => (c === null ? c : c + (REPLAY_STEP_MS / 1000) * REPLAY_RATE)), REPLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [replaying, playing]);

  useEffect(() => {
    if (cursor !== null && playing && cursor >= ops.t) {
      setCursor(null);
      setPlaying(false);
    }
  }, [cursor, playing, ops.t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const mapFlights = useMemo(
    () =>
      cursor === null
        ? flights
        : Object.values(records)
            .filter((r) => r.startT <= cursor && cursor <= Math.max(r.endT + 2, ids.split(",").includes(r.summary.id) ? ops.t : 0))
            .map((r) => flightAt(r, cursor))
            .sort(byUrgency),
    [cursor, flights, records, ids, ops.t],
  );

  const summary = flights.find((f) => f.id === selectedId);
  const stored = selectedId ? records[selectedId] : undefined;
  // Open the moment it is clicked; the history fills in when it arrives.
  const record: FlightRecord | null = stored
    ? { ...stored, summary: summary ?? stored.summary }
    : summary ? { summary, startT: 0, endT: ops.t, track: [], messages: [], markers: [], riskSeries: [], separation: [] } : null;

  const t = cursor ?? ops.t;
  const operator = useOperator(selectedId, summary?.attention === "human_control", link.refresh);
  const alert = ops.alerts
    // The person holding the flight needs the room for the controls more than its own alert.
    .filter((a) => !a.acknowledged && (a.level === "critical" || !(summary?.attention === "human_control" && a.flightId === summary.id)))
    .sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level] || b.t - a.t);
  const separation = useMemo(() => (stored ? separationAt(stored, t) : null), [stored, t]);
  // Where responders are standing by, by the flight they are waiting for.
  const responding = ops.alerts.filter((a) => a.flightId && a.level === "critical" && a.detail.includes("fire + rescue")).map((a) => a.flightId!);

  return (
    <div className="ops">
      <section className="ops-left" aria-label="airport">
        <Runways runways={ops.runways} nameOf={nameOf} dimmed={replaying} />
        <AirportMap
          airport={link.airport!}
          flights={mapFlights}
          runways={ops.runways}
          selectedId={selectedId}
          track={stored?.track ?? NO_TRACK}
          separation={separation}
          responders={responding}
          snapshot={link.snapshot}
          replayT={cursor}
          t={t}
          onSelect={select}
        />
      </section>

      <section className="ops-right" aria-label="flights">
        {link.state === "lost" && <p className="lost">Link lost. Showing the last state received at {clock(ops.t)}.</p>}
        {!record && <Summary flights={flights} />}
        {alert.length > 0 && (
          <Alert
            key={alert[0]!.id}
            alert={alert[0]!}
            count={alert.length}
            callsign={alert[0]!.flightId ? nameOf(alert[0]!.flightId) : null}
            onOpen={alert[0]!.flightId && alert[0]!.flightId !== selectedId ? () => select(alert[0]!.flightId) : undefined}
            onDone={link.refresh}
          />
        )}
        <div className="ops-main">
          {record ? (
            <FlightDetail
              key={selectedId}
              record={record}
              t={t}
              endT={Math.max(ops.t, record.startT + 1)}
              live={!replaying}
              playing={replaying && playing}
              onSeek={(next) => setCursor(Math.min(next, ops.t))}
              onPlay={(on) => {
                setPlaying(on);
                if (cursor === null) setCursor(on ? record.startT : ops.t);
              }}
              onLive={() => {
                setCursor(null);
                setPlaying(false);
              }}
              onClose={() => select(null)}
              nameOf={nameOf}
              action={summary && <TakeOverKey flight={summary} operator={operator} />}
              controls={!replaying && summary && <OperatorPanel flight={summary} operator={operator} />}
            />
          ) : (
            <FlightGrid flights={flights} onSelect={select} />
          )}
        </div>
      </section>

      <OnAir ops={ops} muted={replaying} sound={sound} nameOf={nameOf} onOpen={select} refresh={link.refresh} />
    </div>
  );
}

const NO_TRACK: FlightRecord["track"] = [];
// An outcome shows for its few seconds, under nothing but a critical alert.
const SEVERITY = { critical: 3, normal: 2, high: 1, watch: 0 };

function Runways({ runways, nameOf, dimmed }: { runways: OpsState["runways"]; nameOf(id: string): string; dimmed: boolean }) {
  return (
    <ul className={`runways ${dimmed ? "runways-now" : ""}`} title={dimmed ? "Runway states are live, not replayed" : undefined}>
      {runways.map((r) => (
        <li key={r.id} className={`runway runway-${r.state}`}>
          <b>{r.id}</b>
          <span>{r.flightId && (r.state === "occupied" || r.state === "reserved") ? nameOf(r.flightId) : r.state}</span>
          <i />
        </li>
      ))}
    </ul>
  );
}

function Summary({ flights }: { flights: FlightSummary[] }) {
  const needing = flights.filter((f) => needsHuman(f.attention)).length;
  const held = flights.filter((f) => f.attention === "human_control").length;
  return (
    <dl className="summary">
      <div><dt>flights</dt><dd>{flights.length}</dd></div>
      <div><dt>agent controlled</dt><dd>{flights.length - held}</dd></div>
      <div><dt>human controlled</dt><dd>{held}</dd></div>
      <div className={needing ? "summary-red" : ""}><dt>need you</dt><dd>{needing}</dd></div>
    </dl>
  );
}

function Alert({ alert, count, callsign, onOpen, onDone }: {
  alert: OpsState["alerts"][number]; count: number; callsign: string | null; onOpen?(): void; onDone(): void;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const busy = useRef(false);
  const ack = async () => {
    if (busy.current) return;
    busy.current = true;
    const res = await post(`/api/ops/alerts/${encodeURIComponent(alert.id)}/ack`);
    busy.current = false;
    setFailed(res.ok ? null : (res.message ?? "Not acknowledged."));
    if (res.ok) onDone();
  };
  return (
    <div className={`alert alert-${alert.level}`} role="alert">
      <div className="alert-tag">
        <b>{alert.level === "normal" ? "outcome" : "alert"}</b>
        <span>{count > 1 ? `1 of ${count}` : clock(alert.t)}</span>
      </div>
      <p>
        <b>{callsign && !alert.title.includes(callsign) ? `${callsign}: ` : ""}{alert.title}</b>
        <span title={[alert.detail, alert.suggestedAction].filter(Boolean).join(". ")}>{failed ?? alert.suggestedAction ?? alert.detail}</span>
      </p>
      {onOpen && <button className="btn" onClick={onOpen}><b>open</b><span>flight</span></button>}
      <button className="btn" onClick={() => void ack()}><b>ack</b><span>seen</span></button>
    </div>
  );
}
