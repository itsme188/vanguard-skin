"use client";

import { useState, useEffect, useCallback } from "react";
import type { TwsStatus as TwsStatusType } from "@/lib/tws/types";

const STATE_CONFIG = {
  disconnected: { color: "bg-ink-faint", label: "TWS Disconnected" },
  connecting: { color: "bg-gold animate-pulse", label: "Connecting..." },
  connected: { color: "bg-up", label: "TWS Connected" },
  error: { color: "bg-down", label: "TWS Error" },
} as const;

export function TwsStatus() {
  const [status, setStatus] = useState<TwsStatusType | null>(null);
  const [showPanel, setShowPanel] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/tws/status");
      const json = await res.json();
      if (json.success) setStatus(json.data);
    } catch {
      // API not reachable — leave status as-is
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (!status) return null;

  const config = STATE_CONFIG[status.state];

  return (
    <div className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className="flex items-center gap-1.5 text-[11px] text-ink-faint font-mono hover:text-ink-dim transition-colors"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${config.color}`} />
        {config.label}
      </button>

      {showPanel && (
        <TwsPanel
          status={status}
          onClose={() => setShowPanel(false)}
          onStatusChange={(s) => setStatus(s)}
        />
      )}
    </div>
  );
}

function TwsPanel({
  status,
  onClose,
  onStatusChange,
}: {
  status: TwsStatusType;
  onClose: () => void;
  onStatusChange: (s: TwsStatusType) => void;
}) {
  const [host, setHost] = useState(status.host);
  const [port, setPort] = useState(String(status.port));
  const [clientId, setClientId] = useState(String(status.clientId));
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function handleConnect() {
    setLoading("connect");
    setResult(null);
    try {
      const res = await fetch("/api/tws/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host,
          port: Number(port),
          clientId: Number(clientId),
        }),
      });
      const json = await res.json();
      if (json.success) {
        onStatusChange(json.data);
        if (json.data.state === "connected") {
          setResult("Connected successfully");
        } else if (json.data.error) {
          setResult(`Error: ${json.data.error}`);
        }
      } else {
        setResult(`Error: ${json.error}`);
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleDisconnect() {
    setLoading("disconnect");
    setResult(null);
    try {
      const res = await fetch("/api/tws/disconnect", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        onStatusChange(json.data);
        setResult("Disconnected");
      }
    } catch {
      setResult("Error disconnecting");
    } finally {
      setLoading(null);
    }
  }

  async function handleFetchPrices() {
    setLoading("prices");
    setResult(null);
    try {
      const res = await fetch("/api/tws/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (json.success) {
        const d = json.data;
        setResult(
          `Fetched prices for ${d.securities} securities: ${d.totalPricesInserted} prices inserted, ${d.errors} errors`,
        );
      } else {
        setResult(`Error: ${json.error}`);
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setLoading(null);
    }
  }

  async function handleEnrich() {
    setLoading("enrich");
    setResult(null);
    try {
      const res = await fetch("/api/tws/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (json.success) {
        const d = json.data;
        setResult(
          `Enriched ${d.enriched} of ${d.securities} securities, ${d.errors} errors`,
        );
      } else {
        setResult(`Error: ${json.error}`);
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setLoading(null);
    }
  }

  const isConnected = status.state === "connected";

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="absolute right-0 top-full mt-2 z-50 w-80 rounded-xl border border-edge bg-panel shadow-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">TWS Connection</h3>
          <button
            onClick={onClose}
            className="text-ink-faint hover:text-ink text-xs"
          >
            Close
          </button>
        </div>

        {/* Connection settings */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[10px] text-ink-faint uppercase tracking-wider">
                Host
              </span>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full mt-0.5 px-2 py-1 text-xs font-mono bg-raised border border-edge rounded text-ink"
                disabled={isConnected}
              />
            </label>
            <label className="w-20">
              <span className="text-[10px] text-ink-faint uppercase tracking-wider">
                Port
              </span>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full mt-0.5 px-2 py-1 text-xs font-mono bg-raised border border-edge rounded text-ink"
                disabled={isConnected}
              />
            </label>
            <label className="w-14">
              <span className="text-[10px] text-ink-faint uppercase tracking-wider">
                ID
              </span>
              <input
                type="number"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full mt-0.5 px-2 py-1 text-xs font-mono bg-raised border border-edge rounded text-ink"
                disabled={isConnected}
              />
            </label>
          </div>

          <div className="flex gap-2">
            {!isConnected ? (
              <button
                onClick={handleConnect}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-up/20 text-up hover:bg-up/30 disabled:opacity-50 transition-colors"
              >
                {loading === "connect" ? "Connecting..." : "Connect"}
              </button>
            ) : (
              <button
                onClick={handleDisconnect}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-down/20 text-down hover:bg-down/30 disabled:opacity-50 transition-colors"
              >
                {loading === "disconnect" ? "Disconnecting..." : "Disconnect"}
              </button>
            )}
          </div>
        </div>

        {/* Connected actions */}
        {isConnected && (
          <div className="space-y-2 pt-2 border-t border-edge">
            <p className="text-[10px] text-ink-faint uppercase tracking-wider">
              Data Actions
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleFetchPrices}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue/20 text-blue hover:bg-blue/30 disabled:opacity-50 transition-colors"
              >
                {loading === "prices" ? "Fetching..." : "Fetch Prices"}
              </button>
              <button
                onClick={handleEnrich}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold hover:bg-gold/30 disabled:opacity-50 transition-colors"
              >
                {loading === "enrich" ? "Enriching..." : "Enrich Securities"}
              </button>
            </div>
          </div>
        )}

        {/* Status info */}
        {status.connectedAt && (
          <p className="text-[10px] text-ink-faint">
            Connected since {status.connectedAt.replace("T", " ").slice(0, 19)}
          </p>
        )}

        {/* Result message */}
        {result && (
          <p
            className={`text-xs p-2 rounded-lg ${
              result.startsWith("Error")
                ? "bg-down/10 text-down"
                : "bg-up/10 text-up"
            }`}
          >
            {result}
          </p>
        )}
      </div>
    </>
  );
}
