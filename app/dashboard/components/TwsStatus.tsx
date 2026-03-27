"use client";

import { useState, useEffect, useCallback } from "react";
import type { TwsStatus as TwsStatusType } from "@/lib/tws/types";
import { useStreamingQuotes } from "@/lib/hooks/useStreamingQuotes";

const STATE_CONFIG = {
  disconnected: { color: "bg-ink-faint", label: "TWS Disconnected" },
  connecting: { color: "bg-gold animate-pulse", label: "Connecting..." },
  connected: { color: "bg-up", label: "TWS Connected" },
  error: { color: "bg-down", label: "TWS Error" },
} as const;

export function TwsStatus() {
  const [status, setStatus] = useState<TwsStatusType | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const streaming = useStreamingQuotes(false);

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
  const quoteCount = streaming.quotes.size;

  return (
    <div className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className="flex items-center gap-1.5 text-[11px] text-ink-faint font-mono hover:text-ink-dim transition-colors"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${config.color}`} />
        {config.label}
        {streaming.isStreaming && (
          <span className="flex items-center gap-1 text-blue">
            <span className="w-1 h-1 rounded-full bg-blue animate-pulse" />
            {quoteCount > 0 ? `${quoteCount} live` : "streaming"}
          </span>
        )}
      </button>

      {showPanel && (
        <TwsPanel
          status={status}
          onClose={() => setShowPanel(false)}
          onStatusChange={(s) => setStatus(s)}
          streaming={streaming}
        />
      )}
    </div>
  );
}

type FetchMode = "snapshot" | "historical";

interface PriceProgress {
  current: number;
  total: number;
  symbol: string;
  status: string;
  waitingSeconds?: number;
  completed: number;
  errors: number;
  mode: FetchMode;
}

function TwsPanel({
  status,
  onClose,
  onStatusChange,
  streaming,
}: {
  status: TwsStatusType;
  onClose: () => void;
  onStatusChange: (s: TwsStatusType) => void;
  streaming: ReturnType<typeof useStreamingQuotes>;
}) {
  const [host, setHost] = useState(status.host);
  const [port, setPort] = useState(String(status.port));
  const [clientId, setClientId] = useState(String(status.clientId));
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [priceProgress, setPriceProgress] = useState<PriceProgress | null>(
    null,
  );
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

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

  async function handleFetchPrices(mode: FetchMode) {
    setLoading(mode === "snapshot" ? "snapshot" : "historical");
    setResult(null);
    setPriceProgress(null);
    let completed = 0;
    let errors = 0;

    try {
      const res = await fetch("/api/tws/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        setResult(`Error: ${data.error || "Failed"}`);
        setLoading(null);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setResult("Error: No response stream");
        setLoading(null);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);

            if (parsed.progress) {
              const p = parsed.progress;
              if (p.status === "done" || p.status === "skipped") completed++;
              if (p.status === "error") errors++;
              setPriceProgress({
                current: p.current,
                total: p.total,
                symbol: p.symbol,
                status: p.status,
                waitingSeconds: p.waitingSeconds,
                completed,
                errors,
                mode,
              });
            }

            if (parsed.complete) {
              const d = parsed.data;
              if (d.mode === "snapshot") {
                const parts = [`Updated ${d.pricesUpdated} of ${d.securities} prices`];
                if (d.errors > 0) parts.push(`${d.errors} errors`);
                if (d.valuationsRecomputed) parts.push("valuations recomputed");
                setResult(parts.join(" · "));
              } else {
                const parts = [`${d.totalPricesInserted} prices inserted for ${d.securities} securities`];
                if (d.errors > 0) parts.push(`${d.errors} errors`);
                if (d.valuationsRecomputed) parts.push("valuations recomputed");
                setResult(parts.join(" · "));
              }
            }

            if (parsed.error) {
              setResult(`Error: ${parsed.error}`);
            }
          } catch {
            /* skip malformed lines */
          }
        }
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setLoading(null);
      setPriceProgress(null);
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

  async function handleSyncPortfolio() {
    setLoading("sync");
    setResult(null);
    setSyncStatus("Connecting...");

    try {
      const res = await fetch("/api/tws/positions", { method: "POST" });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        setResult(`Error: ${data.error || "Failed"}`);
        setLoading(null);
        setSyncStatus(null);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setResult("Error: No response stream");
        setLoading(null);
        setSyncStatus(null);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);

            if (parsed.progress) {
              const p = parsed.progress;
              setSyncStatus(p.message);
            }

            if (parsed.complete) {
              const d = parsed.data;
              const parts = [`Synced ${d.positionsSynced} positions`];
              if (d.netLiquidation != null) {
                parts.push(`NLV $${Math.round(d.netLiquidation).toLocaleString()}`);
              }
              if (d.cashBalance != null) {
                parts.push(`Cash $${Math.round(d.cashBalance).toLocaleString()}`);
              }
              setResult(parts.join(" · "));
            }

            if (parsed.error) {
              setResult(`Error: ${parsed.error}`);
            }
          } catch {
            /* skip malformed lines */
          }
        }
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setLoading(null);
      setSyncStatus(null);
    }
  }

  const isConnected = status.state === "connected";
  const isFetching = loading === "snapshot" || loading === "historical" || loading === "sync";

  // Button labels
  const snapshotLabel =
    loading === "snapshot"
      ? priceProgress
        ? `${priceProgress.completed + priceProgress.errors} / ${priceProgress.total}`
        : "Starting..."
      : "Quick Refresh";

  const historicalLabel =
    loading === "historical"
      ? priceProgress
        ? `${priceProgress.completed + priceProgress.errors} / ${priceProgress.total}`
        : "Starting..."
      : "Full History";

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
              Prices
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => handleFetchPrices("snapshot")}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue/20 text-blue hover:bg-blue/30 disabled:opacity-50 transition-colors"
                title="Get current prices via market data snapshots (~2 min)"
              >
                {snapshotLabel}
              </button>
              <button
                onClick={() => handleFetchPrices("historical")}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-ink-faint/10 text-ink-dim hover:bg-ink-faint/20 disabled:opacity-50 transition-colors"
                title="Fetch daily bar history (incremental, for charts)"
              >
                {historicalLabel}
              </button>
            </div>
            {!isFetching && (
              <p className="text-[9px] text-ink-faint">
                Quick Refresh: ~2 min · Full History: incremental
              </p>
            )}

            {/* Streaming controls */}
            <div className="flex gap-2 pt-1">
              {!streaming.isStreaming ? (
                <button
                  onClick={streaming.start}
                  disabled={loading !== null}
                  className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue/20 text-blue hover:bg-blue/30 disabled:opacity-50 transition-colors"
                  title="Stream live delayed quotes for all holdings"
                >
                  Stream Live
                </button>
              ) : (
                <>
                  <button
                    onClick={streaming.stop}
                    className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-down/20 text-down hover:bg-down/30 transition-colors"
                  >
                    Stop Stream
                  </button>
                  <button
                    onClick={async () => {
                      const saved = await streaming.saveSnapshot();
                      setResult(`Saved ${saved} prices to database`);
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold hover:bg-gold/30 transition-colors"
                    title="Save current streaming prices to database"
                  >
                    Save
                  </button>
                </>
              )}
            </div>
            {streaming.isStreaming && streaming.quotes.size > 0 && (
              <p className="text-[9px] text-ink-faint">
                <span className="w-1 h-1 rounded-full bg-blue inline-block animate-pulse mr-1" />
                Streaming {streaming.quotes.size} quotes (delayed)
              </p>
            )}

            <p className="text-[10px] text-ink-faint uppercase tracking-wider pt-1">
              Portfolio
            </p>
            <button
              onClick={handleSyncPortfolio}
              disabled={loading !== null}
              className="w-full px-3 py-1.5 text-xs font-medium rounded-lg bg-up/20 text-up hover:bg-up/30 disabled:opacity-50 transition-colors"
              title="Fetch live positions and account value from TWS"
            >
              {loading === "sync" ? (syncStatus ?? "Syncing...") : "Sync Portfolio"}
            </button>

            <p className="text-[10px] text-ink-faint uppercase tracking-wider pt-1">
              Other
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleEnrich}
                disabled={loading !== null}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold hover:bg-gold/30 disabled:opacity-50 transition-colors"
              >
                {loading === "enrich" ? "Enriching..." : "Enrich Securities"}
              </button>
            </div>

            {/* Price fetch progress */}
            {priceProgress && (
              <div className="space-y-1.5">
                {/* Progress bar */}
                <div className="w-full h-1 rounded-full bg-raised overflow-hidden">
                  <div
                    className="h-full bg-blue rounded-full transition-all duration-300"
                    style={{
                      width: `${((priceProgress.completed + priceProgress.errors) / priceProgress.total) * 100}%`,
                    }}
                  />
                </div>
                {/* Status text */}
                <p className="text-[10px] text-ink-dim font-mono">
                  {priceProgress.status === "rate_limited"
                    ? `Rate limited — resuming in ~${Math.ceil((priceProgress.waitingSeconds ?? 0) / 60)} min`
                    : priceProgress.status === "fetching"
                      ? `${priceProgress.mode === "snapshot" ? "Snapshot" : "Fetching"} ${priceProgress.symbol}...`
                      : priceProgress.status === "skipped"
                        ? `${priceProgress.symbol} up to date — ${priceProgress.completed} done / ${priceProgress.total} total`
                        : `${priceProgress.completed} done${priceProgress.errors > 0 ? `, ${priceProgress.errors} errors` : ""} / ${priceProgress.total} total`}
                </p>
              </div>
            )}
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
