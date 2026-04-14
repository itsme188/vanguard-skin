"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import type { DataConfidence, DataAction } from "@/lib/queries/data-confidence";

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
  const [showPopover, setShowPopover] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const fetchConfidence = useCallback(async () => {
    try {
      const res = await fetch("/api/data-confidence");
      const json = await res.json();
      if (json.success) setConfidence(json.data);
    } catch {
      // Leave as-is
    }
  }, []);

  useEffect(() => {
    fetchConfidence();
    const interval = setInterval(fetchConfidence, 60_000);
    return () => clearInterval(interval);
  }, [fetchConfidence]);

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
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink-faint font-mono">
        <span className="w-2 h-2 rounded-full bg-ink-faint animate-pulse" />
        Loading...
      </div>
    );
  }

  const config = LEVEL_CONFIG[confidence.overallLevel];

  // Build one-line summary
  const summary = buildSummary(confidence);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setShowPopover(!showPopover)}
        className="flex items-center gap-2 text-[11px] text-ink-faint font-mono hover:text-ink-dim transition-colors"
        title={`Data confidence: ${confidence.overallScore}% — click for details`}
      >
        <span className={`w-2 h-2 rounded-full ${config.color}`} />
        <span>{confidence.overallScore}%</span>
        <span className="hidden lg:inline">{summary}</span>
      </button>

      {showPopover && (
        <div className="absolute right-0 top-full mt-2 z-50 w-96 rounded-xl border border-edge bg-panel shadow-xl p-4 space-y-3">
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
            <DimensionBar label="Prices" score={confidence.priceFreshness.score} detail={confidence.priceFreshness.detail} />
            <DimensionBar label="Holdings" score={confidence.holdingsRecency.score} detail={confidence.holdingsRecency.detail} />
            <DimensionBar label="Cash" score={confidence.cashAccuracy.score} detail={confidence.cashAccuracy.detail} />
            <DimensionBar label="Enrichment" score={confidence.enrichmentCompleteness.score} detail={confidence.enrichmentCompleteness.detail} />
            <DimensionBar label="Valuations" score={confidence.valuationCoverage.score} detail={confidence.valuationCoverage.detail} />
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
                    try {
                      await fetch(action.apiEndpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(action.apiBody ?? {}),
                      });
                      // Refresh confidence after action
                      setTimeout(fetchConfidence, 2000);
                    } catch {
                      // Ignore — sync-status will show errors
                    } finally {
                      setActionLoading(null);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DimensionBar({ label, score, detail }: { label: string; score: number; detail: string }) {
  const barColor =
    score >= 80 ? "bg-up" :
    score >= 50 ? "bg-gold" :
    score >= 20 ? "bg-orange-400" :
    "bg-down";

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-ink-dim font-medium">{label}</span>
        <span className="text-[10px] text-ink-faint font-mono">{score}%</span>
      </div>
      <div className="w-full h-1 rounded-full bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <p className="text-[9px] text-ink-faint">{detail}</p>
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

function buildSummary(c: DataConfidence): string {
  const parts: string[] = [];

  // Price status
  if (c.priceFreshness.score >= 90) {
    parts.push("prices fresh");
  } else if (c.priceFreshness.stalestDays != null) {
    parts.push(`${c.priceFreshness.stalestSymbol} ${c.priceFreshness.stalestDays}d stale`);
  }

  // Holdings status — show per-account
  const ibkr = c.holdingsRecency.perAccount.find(a => a.name.toLowerCase().includes("ibkr"));
  const vanguard = c.holdingsRecency.perAccount.find(a =>
    a.name.toLowerCase().includes("vanguard") && !a.name.toLowerCase().includes("roth")
  );

  if (ibkr?.daysOld != null && ibkr.daysOld <= 1) {
    parts.push("IBKR live");
  }
  if (vanguard?.daysOld != null && vanguard.daysOld > 7) {
    parts.push(`Vanguard ${vanguard.daysOld}d old`);
  }

  return parts.length > 0 ? `— ${parts.join(", ")}` : "";
}
