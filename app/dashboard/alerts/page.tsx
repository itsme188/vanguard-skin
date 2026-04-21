"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { LevelAlert, AlertResponse } from "@/lib/types";
import { useToast } from "../components/Toast";

interface EnrichedAlert extends LevelAlert {
  symbol: string | null;
  security_name: string | null;
  level: {
    level_type: string;
    price: number;
    direction: string | null;
    source: string;
    source_author: string | null;
    thesis: string | null;
  } | null;
}

const FILTER_OPTIONS: Array<{ label: string; value: AlertResponse | "all" }> = [
  { label: "Pending", value: "pending" },
  { label: "Acted", value: "acted" },
  { label: "Ignored", value: "ignored" },
  { label: "Dismissed", value: "dismissed" },
  { label: "All", value: "all" },
];

export default function AlertsPage() {
  const { toast } = useToast();
  const [alerts, setAlerts] = useState<EnrichedAlert[]>([]);
  const [filter, setFilter] = useState<AlertResponse | "all">("pending");
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const q = filter === "all" ? "" : `?response=${filter}`;
      const res = await fetch(`/api/alerts${q}`);
      const json = await res.json();
      if (json.success) {
        setAlerts(json.alerts);
        setPendingCount(json.pendingCount);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function respond(id: number, response: AlertResponse, note?: string) {
    const res = await fetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, response, note }),
    });
    if (res.ok) {
      const kind: "success" | "info" = response === "acted" ? "success" : "info";
      toast(`Alert marked ${response}`, kind);
    } else {
      toast("Failed to update alert", "error");
    }
    refresh();
  }

  async function runDetect() {
    setDetecting(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/alerts/detect", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        const { scanned, fired, deduped } = json as {
          scanned: number;
          fired: number;
          deduped: number;
        };
        setActionStatus(
          fired > 0
            ? `Scan complete — ${fired} new alert${fired === 1 ? "" : "s"} fired${
                deduped > 0 ? ` (${deduped} already alerted today)` : ""
              }.`
            : scanned === 0
              ? "Scan complete. No levels have been crossed by the current price. This is normal — a level only fires an alert when the price actually reaches it (e.g., a $150 support fires when the price drops to $150). Your levels are still active and being monitored."
              : `Scan complete — ${scanned} level${scanned === 1 ? "" : "s"} already alerted today; nothing new to report.`
        );
      } else {
        setActionStatus("Scan failed — see console for details.");
      }
      await refresh();
    } finally {
      setDetecting(false);
    }
  }

  async function runSuggest(alertId?: number) {
    setSuggesting(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/alerts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertId ? { alertId } : {}),
      });
      const json = await res.json();
      if (json.success && !alertId) {
        const { generated, failed } = json as { generated?: number; failed?: number };
        if (generated !== undefined) {
          setActionStatus(
            generated > 0
              ? `Generated ${generated} suggestion${generated === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}.`
              : "No pending alerts needed a suggestion."
          );
        }
      }
      await refresh();
    } finally {
      setSuggesting(false);
    }
  }

  // Auto-fill suggestions for any pending alerts that don't have one yet.
  // Runs once per page visit, fire-and-forget — user still has "Suggest" buttons if it fails.
  useEffect(() => {
    const needsSuggestion = alerts.some(
      (a) => a.user_response === "pending" && !a.suggested_action
    );
    if (needsSuggestion && !suggesting) {
      runSuggest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.length]);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl text-ink">Alerts</h1>
          <p className="text-[11px] text-ink-faint mt-0.5">
            Price level triggers across your holdings, watchlist, and flagged names.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runSuggest()}
            disabled={suggesting}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50"
            title="Ask Claude to write a recommendation for every pending alert without one"
          >
            {suggesting ? "Thinking..." : "Suggest all"}
          </button>
          <button
            onClick={runDetect}
            disabled={detecting}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50"
          >
            {detecting ? "Scanning..." : "Scan now"}
          </button>
          <div className="flex gap-1 p-1 rounded-lg border border-edge bg-panel">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
                  filter === opt.value
                    ? "bg-gold/15 text-gold"
                    : "text-ink-faint hover:text-ink"
                }`}
              >
                {opt.label}
                {opt.value === "pending" && pendingCount > 0 && (
                  <span className="ml-1.5 font-mono">{pendingCount}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      {actionStatus && (
        <div className="rounded-lg border border-edge bg-panel px-4 py-2.5 text-[11px] text-ink-dim flex items-center justify-between">
          <span>{actionStatus}</span>
          <button
            onClick={() => setActionStatus(null)}
            className="text-ink-faint hover:text-ink text-xs"
            aria-label="Dismiss status"
          >
            ×
          </button>
        </div>
      )}

      {loading && alerts.length === 0 ? (
        <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
      ) : alerts.length === 0 ? (
        <div className="rounded-xl border border-edge bg-panel p-10 text-center">
          <p className="text-sm text-ink-dim">No {filter !== "all" ? filter : ""} alerts.</p>
          <p className="text-[11px] text-ink-faint mt-2">
            Alerts fire when a price crosses a level you've set. Add levels on any{" "}
            <Link href="/dashboard/holdings" className="text-gold underline">
              security detail page
            </Link>.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} onRespond={respond} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertRow({
  alert,
  onRespond,
}: {
  alert: EnrichedAlert;
  onRespond: (id: number, response: AlertResponse, note?: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  const when = new Date(alert.triggered_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let context: { held?: Array<{ account: string; quantity: number }>; onWatchlist?: boolean; watchlistGroup?: string | null } = {};
  try {
    if (alert.position_context) context = JSON.parse(alert.position_context);
  } catch {
    // ignore malformed JSON
  }

  const isPending = alert.user_response === "pending";
  const responseLabel: Record<AlertResponse, { label: string; color: string }> = {
    pending: { label: "Pending", color: "text-gold" },
    acted: { label: "Acted", color: "text-emerald-400" },
    ignored: { label: "Ignored", color: "text-ink-faint" },
    dismissed: { label: "Dismissed", color: "text-ink-faint" },
  };

  return (
    <li className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            {alert.symbol && (
              <Link
                href={`/dashboard/security/${alert.security_id}`}
                className="font-mono text-sm font-medium text-ink hover:text-gold"
              >
                {alert.symbol}
              </Link>
            )}
            {alert.level && (
              <span className="text-[11px] text-ink-dim">
                {alert.level.level_type.replace("_", " ")} @ ${alert.level.price.toFixed(2)}
              </span>
            )}
            <span className="text-[11px] text-ink-faint">
              hit ${alert.triggered_price.toFixed(2)}
            </span>
            <span className="text-[10px] text-ink-faint">{when}</span>
          </div>

          {alert.level?.source_author && (
            <p className="text-[11px] text-ink-dim mt-1">
              <span className="text-ink-faint">Source: </span>
              {alert.level.source_author}
              {alert.level.thesis && <> — {alert.level.thesis}</>}
            </p>
          )}

          {(context.held?.length || context.onWatchlist) && (
            <p className="text-[11px] text-ink-faint mt-1">
              {context.held && context.held.length > 0 && (
                <span>
                  Holding:{" "}
                  {context.held
                    .map((h) => `${h.quantity.toFixed(0)} in ${h.account}`)
                    .join(", ")}
                </span>
              )}
              {context.held && context.held.length > 0 && context.onWatchlist && " · "}
              {context.onWatchlist && (
                <span>
                  On watchlist{context.watchlistGroup && context.watchlistGroup !== "default"
                    ? ` (${context.watchlistGroup.replace(/_/g, " ")})`
                    : ""}
                </span>
              )}
            </p>
          )}

          {alert.suggested_action && (
            <div className="mt-2 px-3 py-1.5 rounded border border-gold/20 bg-gold/5 text-[11px] text-gold">
              {alert.suggested_action}
            </div>
          )}

          {!isPending && alert.user_response_note && (
            <p className="text-[11px] text-ink-faint italic mt-2">
              Note: {alert.user_response_note}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isPending ? (
            <>
              <button
                onClick={() => setNoteOpen(!noteOpen)}
                className="px-2.5 py-1 text-[11px] rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
              >
                Acted
              </button>
              <button
                onClick={() => onRespond(alert.id, "ignored")}
                className="px-2.5 py-1 text-[11px] rounded text-ink-faint hover:text-ink-dim"
              >
                Ignore
              </button>
              <button
                onClick={() => onRespond(alert.id, "dismissed")}
                className="text-ink-faint hover:text-ink text-xs"
                title="Dismiss"
              >
                ×
              </button>
            </>
          ) : (
            <span className={`text-[11px] ${responseLabel[alert.user_response].color}`}>
              {responseLabel[alert.user_response].label}
            </span>
          )}
        </div>
      </div>

      {noteOpen && isPending && (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Bought 50 shares at $175.20"
            className="flex-1 bg-canvas border border-edge rounded px-2 py-1 text-xs"
            autoFocus
          />
          <button
            onClick={() => {
              onRespond(alert.id, "acted", note || undefined);
              setNoteOpen(false);
              setNote("");
            }}
            className="px-3 py-1 text-[11px] rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
          >
            Log
          </button>
          <button
            onClick={() => { setNoteOpen(false); setNote(""); }}
            className="text-ink-faint hover:text-ink text-xs"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}
