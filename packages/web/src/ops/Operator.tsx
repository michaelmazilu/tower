import { useEffect, useState } from "react";
import type { FlightSummary, OperatorInstruction } from "@towerai/contracts";
import { needsHuman } from "../shared/replay";
import { get, post } from "./useOps";

type Action = { clearanceType: string; label: string };

export function useOperator(id: string | null, held: boolean, refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [actions, setActions] = useState<Action[]>([]);

  useEffect(() => {
    setResult(null);
    setActions([]);
  }, [id]);

  useEffect(() => {
    if (!id || !held) return;
    let stopped = false;
    const load = () =>
      get<{ actions: Action[] }>(`/api/ops/flights/${encodeURIComponent(id)}/actions`)
        .then((r) => !stopped && setActions(r.actions))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, held]);

  useEffect(() => {
    if (!result?.ok) return;
    const timer = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(timer);
  }, [result]);

  const send = async (verb: "takeover" | "handback" | "instruct", body?: OperatorInstruction, done = "") => {
    if (!id || busy) return;
    setBusy(true);
    const res = await post(`/api/ops/flights/${encodeURIComponent(id)}/${verb}`, body);
    setBusy(false);
    setResult({ ok: res.ok, text: res.ok ? (res.message ?? done) : (res.message ?? "The validator refused this.") });
    refresh();
  };

  return { busy, result, actions, send };
}

type Operator = ReturnType<typeof useOperator>;

export function TakeOverKey({ flight, operator }: { flight: FlightSummary; operator: Operator }) {
  if (flight.attention === "human_control") {
    return (
      <button className="btn btn-invert btn-wide" disabled={operator.busy} onClick={() => void operator.send("handback", undefined, "The agent has control again.")}>
        <b>hand back</b>
        <span>to agent</span>
      </button>
    );
  }
  return (
    <button
      className={`btn btn-wide ${needsHuman(flight.attention) ? "btn-invert" : "btn-red"}`}
      disabled={operator.busy}
      onClick={() => void operator.send("takeover", undefined, "You have control.")}
    >
      <b>take over</b>
      <span>from agent</span>
    </button>
  );
}

export function OperatorPanel({ flight, operator }: { flight: FlightSummary; operator: Operator }) {
  const [reason, setReason] = useState("");
  const { result, actions, busy, send } = operator;
  const held = flight.attention === "human_control";
  if (!held && !result) return null;
  return (
    <div className="instruct">
      {result && (!held || !result.ok) && <p className={`instruct-result ${result.ok ? "" : "instruct-refused"}`} role="status">{result.ok ? "" : "not sent: "}{result.text}</p>}
      {held && (
        <>
          <label className="instruct-reason">
            <span role="status">{result?.ok ? result.text : "instruct, with reason"}</span>
            <input value={reason} maxLength={160} placeholder="say why, then pick an instruction" onChange={(e) => setReason(e.currentTarget.value)} />
          </label>
          <div className="instruct-actions">
            {actions.length === 0 && <span className="instruct-none">No valid instruction for this flight right now.</span>}
            {actions.map((a) => (
              <button
                key={a.clearanceType + a.label}
                disabled={busy}
                onClick={() => void send("instruct", { clearanceType: a.clearanceType, reason: reason.trim() || "operator decision" }, `Sent: ${a.label}`)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
