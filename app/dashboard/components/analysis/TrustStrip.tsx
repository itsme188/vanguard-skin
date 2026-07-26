"use client";

import React, { useEffect, useState, useCallback } from "react";
import type { AnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { TrustStripDrawer, type DrawerPanel } from "./TrustStripDrawer";
import { PrivateText } from "@/lib/privacy/components";

type Tone = "good" | "warn" | "bad" | "neutral";

function toneClass(tone: Tone): string {
  switch (tone) {
    case "good": return "text-up";
    case "warn": return "text-amber-400";
    case "bad": return "text-down";
    default: return "text-ink";
  }
}

function Cell({
  label,
  value,
  tone,
  hint,
  onClick,
  active,
}: {
  label: string;
  value: React.ReactNode;
  tone: Tone;
  hint?: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={[
        "flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border transition-colors text-left",
        active
          ? "border-amber-400/60 bg-amber-400/5"
          : "border-edge hover:border-edge-strong hover:bg-raised/50",
      ].join(" ")}
    >
      <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wide leading-none">
        {label}
      </span>
      <span className={`text-sm font-semibold leading-tight ${toneClass(tone)}`}>
        {value}
      </span>
    </button>
  );
}

function formatRelative(timestamp: string | null): string {
  if (!timestamp) return "never";
  const normalized = timestamp.replace(" ", "T");
  // Only append Z when no timezone marker is already present (Z, +HH:MM, or -HH:MM after the date portion)
  const hasTimezone = /[Z+]|[-]\d{2}:\d{2}$/.test(normalized.slice(10));
  const iso = hasTimezone ? normalized : normalized + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return timestamp;
  // Bucket by local calendar day, not 24h floors — a Thursday-noon run viewed
  // Saturday 3am is ~39h elapsed (floor 1) but is two calendar days back.
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(d)) / (1000 * 60 * 60 * 24)
  );
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

interface TrustStripProps {
  scope?: string;
}

export function TrustStrip({ scope }: TrustStripProps) {
  const [state, setState] = useState<AnalysisTrustState | null>(null);
  const [activePanel, setActivePanel] = useState<DrawerPanel | null>(null);

  const fetchState = useCallback(() => {
    const qs = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/analysis/trust-state${qs}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setState(json.data as AnalysisTrustState);
      })
      .catch(() => {/* graceful no-op */});
  }, [scope]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  function togglePanel(panel: DrawerPanel) {
    setActivePanel((prev) => (prev === panel ? null : panel));
  }

  if (!state) {
    // Skeleton placeholder while loading
    return (
      <div className="flex gap-2 flex-wrap mb-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-14 w-36 rounded-lg border border-edge bg-raised/30 animate-pulse"
          />
        ))}
      </div>
    );
  }

  const { factorCoverage, lastClassification, performanceReconciledThru, stalePrices, bondDuration } = state;

  const coveragePct = Math.round(factorCoverage.percentage * 100);
  const coverageTone: Tone =
    coveragePct >= 90 ? "good" : coveragePct >= 60 ? "warn" : "bad";

  const staleTone: Tone =
    stalePrices.count === 0 ? "good" : stalePrices.count <= 3 ? "warn" : "bad";

  const bondCovTone: Tone =
    bondDuration.totalBonds === 0
      ? "neutral"
      : bondDuration.withDuration === bondDuration.totalBonds
      ? "good"
      : bondDuration.withDuration > 0
      ? "warn"
      : "bad";

  const classifyTone: Tone = lastClassification ? "neutral" : "warn";

  const reconTone: Tone = performanceReconciledThru ? "good" : "neutral";

  return (
    <>
      <div className="flex gap-2 flex-wrap mb-2">
        <Cell
          label="Factor coverage"
          value={
            <PrivateText>{`${coveragePct}% (${factorCoverage.classified}/${factorCoverage.totalNames})`}</PrivateText>
          }
          tone={coverageTone}
          hint={
            factorCoverage.missingSymbols.length > 0
              ? `Missing: ${factorCoverage.missingSymbols.join(", ")}`
              : "All held securities classified"
          }
          onClick={() => togglePanel("factorCoverage")}
          active={activePanel === "factorCoverage"}
        />
        <Cell
          label="Last classify"
          value={formatRelative(lastClassification)}
          tone={classifyTone}
          hint={lastClassification ?? "No classification run yet"}
          onClick={() => togglePanel("lastClassify")}
          active={activePanel === "lastClassify"}
        />
        <Cell
          label="Perf reconciled"
          value={performanceReconciledThru ?? "—"}
          tone={reconTone}
          hint="Performance reconciliation through date"
          onClick={() => togglePanel("performance")}
          active={activePanel === "performance"}
        />
        <Cell
          label="Stale prices"
          value={
            stalePrices.count === 0
              ? "All fresh"
              : <PrivateText>{`${stalePrices.count} stale`}</PrivateText>
          }
          tone={staleTone}
          hint={
            stalePrices.symbols.length > 0
              ? `Stale: ${stalePrices.symbols.join(", ")}`
              : "All prices up to date"
          }
          onClick={() => togglePanel("stalePrices")}
          active={activePanel === "stalePrices"}
        />
        <Cell
          label="Bond duration"
          value={
            bondDuration.totalBonds === 0
              ? "No bonds"
              : <PrivateText>{`${bondDuration.withDuration}/${bondDuration.totalBonds}`}</PrivateText>
          }
          tone={bondCovTone}
          hint="Held bonds with duration_years populated"
          onClick={() => togglePanel("bondDuration")}
          active={activePanel === "bondDuration"}
        />
      </div>

      {activePanel && (
        <TrustStripDrawer
          panel={activePanel}
          state={state}
          onClose={() => setActivePanel(null)}
          onRefresh={fetchState}
        />
      )}
    </>
  );
}
