"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import type { DataConfidence, DataAction, DimensionScore } from "@/lib/queries/data-confidence";
import { PrivateText } from "@/lib/privacy/components";

const LEVEL_CONFIG = {
  high: { color: "bg-up", label: "Data reliable" },
  medium: { color: "bg-gold", label: "Some data stale" },
  low: { color: "bg-orange-400", label: "Data unreliable" },
  stale: { color: "bg-down", label: "Data very stale" },
} as const;

const SEVERITY_STYLES = {
  critical: "text-down",
  warning: "text-gold",
  info: "text-ink-dim",
} as const;

export function DataConfidenceIndicator() {
  const [confidence, setConfidence] = useState<DataConfidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Ref mirrors `confidence` so the fetch callback can read the latest value
  // without depending on it (which would invalidate the callback on every state
  // change and cause a render/poll loop — previously fired ~300k requests/hr).
  const confidenceRef = useRef<DataConfidence | null>(null);
  useEffect(() => {
    confidenceRef.current = confidence;
  }, [confidence]);

  const fetchConfidence = useCallback(async () => {
    setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch("/api/data-confidence", { signal: controller.signal });
      const json = await res.json();
      if (json.success) {
        setConfidence(json.data);
        setError(null);
        setSyncing(false);
        return;
      }
    } catch {
      // Network error or timeout — fall through to sync check
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }

    // Data-confidence failed — check if TWS is syncing
    try {
      const syncRes = await fetch("/api/tws/sync-status");
      const syncJson = await syncRes.json();
      if (syncJson.status === "syncing") {
        setSyncing(true);
        setError(null);
        return;
      }
    } catch {
      // sync-status also failed
    }

    // Not syncing and data-confidence failed — genuine error.
    // Only flip to error state if we didn't already have a valid read (read via
    // ref so this callback can be stable — see note above).
    if (!confidenceRef.current) {
      setError("Unable to load data");
    }
    setSyncing(false);
  }, []);

  useEffect(() => {
    fetchConfidence();
    // Poll every 15s while syncing (quiet, no flicker), 60s when healthy.
    // Don't auto-poll on error — user clicks retry.
    const interval = setInterval(() => {
      if (syncing) fetchConfidence();
      else if (!error) fetchConfidence();
    }, syncing ? 15_000 : 60_000);
    return () => clearInterval(interval);
  }, [fetchConfidence, syncing, error]);

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showPopover]);

  if (!confidence) {
    if (syncing) {
      return (
        <div className="flex items-center gap-2 text-[11px] text-ink-faint font-mono">
          <span className="w-2 h-2 rounded-full bg-gold animate-pulse" />
          Syncing...
        </div>
      );
    }
    if (error && !loading) {
      return (
        <div className="flex items-center gap-2 text-[11px] text-ink-faint font-mono">
          <span className="w-2 h-2 rounded-full bg-orange-400" />
          <span>Data unavailable</span>
          <button
            onClick={fetchConfidence}
            className="text-blue hover:text-blue/80 underline"
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink-faint font-mono">
        <span className="w-2 h-2 rounded-full bg-ink-faint animate-pulse" />
        {loading ? "Loading..." : "Loading..."}
      </div>
    );
  }

  const config = LEVEL_CONFIG[confidence.overallLevel];

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setShowPopover(!showPopover)}
        className="relative flex items-center gap-2 text-[11px] text-ink-faint font-mono hover:text-ink-dim transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
        title={`Data confidence: ${confidence.overallScore}% — click for details`}
      >
        <span className={`w-2 h-2 rounded-full ${config.color}`} />
        <span>{confidence.overallScore}%</span>
      </button>

      {showPopover && (
        <div
          className="absolute right-0 top-full mt-2 z-50 w-96 rounded-xl border border-edge bg-panel shadow-xl p-4 space-y-3"
          style={{ backgroundColor: "var(--panel)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${config.color}`} />
              <h3 className="text-sm font-medium text-ink">
                Data Confidence: {confidence.overallScore}%
              </h3>
            </div>
            <Link
              href="/dashboard/data-health"
              className="text-[10px] text-blue hover:underline"
              onClick={() => setShowPopover(false)}
            >
              Full audit
            </Link>
          </div>

          {/* Dimension bars */}
          <div className="space-y-2">
            <DimensionBar label="Prices" dim={confidence.priceFreshness} />
            <DimensionBar label="Holdings" dim={confidence.holdingsRecency} />
            <DimensionBar label="Cash" dim={confidence.cashAccuracy} />
            <DimensionBar label="Enrichment" dim={confidence.enrichmentCompleteness} />
            <DimensionBar label="Valuations" dim={confidence.valuationCoverage} />
          </div>

          {/* Actions */}
          {confidence.actions.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-edge">
              <p className="text-[10px] text-ink-faint uppercase tracking-wider">
                Actions
              </p>
              {confidence.actions.slice(0, 4).map((action, i) => (
                <ActionRow
                  key={i}
                  action={action}
                  loading={actionLoading === action.apiEndpoint}
                  onFix={async () => {
                    if (!action.autoFixable || !action.apiEndpoint) return;
                    setActionLoading(action.apiEndpoint);
                    setActionStatus(null);
                    try {
                      const res = await fetch(action.apiEndpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(action.apiBody ?? {}),
                      });
                      if (res.ok) {
                        setActionStatus("Fix triggered — score refreshes as the sync completes (~1-2 min).");
                        // Refresh confidence after action
                        setTimeout(fetchConfidence, 2000);
                      } else {
                        const body = await res.json().catch(() => null);
                        setActionStatus(`Fix failed: ${body?.error ?? `server returned ${res.status}`}.`);
                      }
                    } catch {
                      setActionStatus("Fix failed: could not reach the server.");
                    } finally {
                      setActionLoading(null);
                    }
                  }}
                />
              ))}
              {actionStatus && (
                <p className="text-[10px] text-ink-faint pt-1">{actionStatus}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DimensionBar({ label, dim }: { label: string; dim: DimensionScore }) {
  const [expanded, setExpanded] = useState(false);
  const { score, detail, whyMatters, guidance } = dim;
  const barColor =
    score >= 80 ? "bg-up" :
    score >= 50 ? "bg-gold" :
    score >= 20 ? "bg-orange-400" :
    "bg-down";
  const guidanceColor = score >= 80 ? "text-ink-faint" : "text-gold-ink";

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between hover:opacity-80 transition-opacity"
        aria-expanded={expanded}
      >
        <span className="text-[10px] text-ink-dim font-medium flex items-center gap-1">
          <span className="text-ink-faint text-[8px] w-2 inline-block">{expanded ? "▾" : "▸"}</span>
          {label}
        </span>
        <span className="text-[10px] text-ink-faint font-mono">{score}%</span>
      </button>
      <div className="w-full h-1 rounded-full bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width,background-color] duration-500 ${barColor}`}
          style={{ width: `${score}%` }}
        />
      </div>
      {/* detail is composed from the user's own accounts/dates/dollar deltas
          (e.g. an unexplained cash delta with the account name and amount) —
          portfolio-derived, so it must mask in privacy mode like <Money>/
          <PrivateText> everywhere else. whyMatters is fixed per-dimension
          copy (never data-driven) so it stays plain. */}
      <p className="text-[9px] text-ink-faint"><PrivateText>{detail}</PrivateText></p>
      {expanded && (
        <div className="pt-1 pl-3 space-y-1 border-l border-edge ml-0.5">
          <p className="text-[9px] text-ink-dim leading-snug">
            <span className="text-ink-faint">Why it matters: </span>
            {whyMatters}
          </p>
          <p className={`text-[9px] leading-snug ${guidanceColor}`}>
            <span className="text-ink-faint">What to do: </span>
            <PrivateText>{guidance}</PrivateText>
          </p>
        </div>
      )}
    </div>
  );
}

function ActionRow({
  action,
  loading,
  onFix,
}: {
  action: DataAction;
  loading: boolean;
  onFix: () => void;
}) {
  return (
    <div className="flex items-start gap-2 text-[10px]">
      <span className={`mt-0.5 ${SEVERITY_STYLES[action.severity]}`}>
        {action.severity === "critical" ? "●" : action.severity === "warning" ? "◐" : "○"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-ink-dim">{action.message}</p>
        <p className="text-ink-faint">{action.fix}</p>
      </div>
      {action.autoFixable && (
        <button
          onClick={onFix}
          disabled={loading}
          className="shrink-0 px-2 py-0.5 rounded bg-blue/20 text-blue hover:bg-blue/30 disabled:opacity-50 text-[9px] font-medium transition-colors"
        >
          {loading ? "..." : "Fix"}
        </button>
      )}
    </div>
  );
}
