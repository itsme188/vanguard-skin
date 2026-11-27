"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import type { AnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { TrustStripDrawer, stalePricesSummary, type DrawerPanel } from "./TrustStripDrawer";
import { PrivateText } from "@/lib/privacy/components";
import { formatEnrichedAtET } from "@/lib/format";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { plaidTrustLines, positionsFreshnessCell } from "@/lib/ui/positions-freshness-label";

type Tone = "good" | "warn" | "bad" | "neutral";

function toneClass(tone: Tone): string {
  switch (tone) {
    case "good": return "text-up";
    case "warn": return "text-warn";
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
  // The loaded state and the error are kept WITH the scope they belong to
  // (handoff bug 16): on a scope change the strip shows the skeleton at once
  // instead of the previous scope's figures, and a late answer for an older
  // request is dropped (only the newest request may write).
  const scopeKey = scope ?? "all";
  const [loaded, setLoaded] = useState<{ scope: string; state: AnalysisTrustState } | null>(null);
  const [errorFor, setErrorFor] = useState<{ scope: string; message: string } | null>(null);
  const [activePanel, setActivePanel] = useState<DrawerPanel | null>(null);
  const requestSeq = useRef(0);

  const state = loaded && loaded.scope === scopeKey ? loaded.state : null;
  const loadError = errorFor && errorFor.scope === scopeKey ? errorFor.message : null;

  // A failed load is shown as a plain line with a retry, never left as a
  // pulsing skeleton. A failed refresh keeps the figures already on screen
  // and says the refresh failed.
  const fetchState = useCallback(() => {
    const seq = ++requestSeq.current;
    const forScope = scope ?? "all";
    const qs = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/analysis/trust-state${qs}`)
      .then((r) => readMutationResult<{ data: AnalysisTrustState }>(r))
      .then((result) => {
        if (seq !== requestSeq.current) return; // a newer request owns the strip
        if (result.ok) {
          setLoaded({ scope: forScope, state: result.data.data });
          setErrorFor(null);
        } else {
          setErrorFor({ scope: forScope, message: `Couldn't load the data checks: ${result.message}` });
        }
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setErrorFor({ scope: forScope, message: networkFailureMessage("load the data checks") });
      });
  }, [scope]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  function togglePanel(panel: DrawerPanel) {
    setActivePanel((prev) => (prev === panel ? null : panel));
  }

  // Clear the error first so a retry shows the skeleton while it loads.
  function retry() {
    setErrorFor(null);
    fetchState();
  }

  if (!state && loadError) {
    return (
      <p className="flex items-center gap-2 mb-2 text-xs text-down">
        <span>{loadError}</span>
        <button onClick={retry} className="underline text-ink focus-ring">
          Retry
        </button>
      </p>
    );
  }

  if (!state) {
    // Skeleton placeholder while loading
    return (
      <div className="flex gap-2 flex-wrap mb-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="h-14 w-36 rounded-lg border border-edge bg-raised/30 animate-pulse"
          />
        ))}
      </div>
    );
  }

  const { factorCoverage, lastClassification, lastSectorClassification, crossCheckedThru, stalePrices, neverPriced, bondDuration, positionsFreshness } = state;

  // The oldest counted live row is shown, not only the newest sync: a
  // position the latest sync left out still counts as held until a
  // tombstone is written (lib/queries/positions-freshness.ts).
  const positionsCell = positionsFreshnessCell(positionsFreshness);
  // Plaid lines (dating state, a held-back account, a repeat read). Silent for
  // a scope with no Plaid-fed account. Words come only from the helper.
  const plaidLines = plaidTrustLines(positionsFreshness);

  const coveragePct = Math.round(factorCoverage.percentage * 100);
  const coverageTone: Tone =
    coveragePct >= 90 ? "good" : coveragePct >= 60 ? "warn" : "bad";

  // A never-priced holding counts toward the tone like a stale one: either
  // way the price cannot be trusted.
  const untrustedPrices = stalePrices.count + neverPriced.count;
  const staleTone: Tone =
    untrustedPrices === 0 ? "good" : untrustedPrices <= 3 ? "warn" : "bad";

  const bondCovTone: Tone =
    bondDuration.totalBonds === 0
      ? "neutral"
      : bondDuration.withDuration === bondDuration.totalBonds
      ? "good"
      : bondDuration.withDuration > 0
      ? "warn"
      : "bad";

  const classifyTone: Tone = lastClassification ? "neutral" : "warn";
  // The time moves on every clean check (each full sync), so "never" means no
  // check has finished since this figure was introduced.
  const sectorClassifyTone: Tone = lastSectorClassification ? "neutral" : "warn";

  const reconTone: Tone = "neutral";

  return (
    <>
      <div className="flex gap-2 flex-wrap mb-2">
        <Cell
          label="Positions as of"
          value={
            positionsCell.countText ? (
              <>
                {`${positionsCell.dateText} · `}
                <PrivateText>{positionsCell.countText}</PrivateText>
              </>
            ) : (
              positionsCell.dateText
            )
          }
          tone={positionsCell.tone}
          hint={positionsCell.hint}
          onClick={() => togglePanel("positionsFreshness")}
          active={activePanel === "positionsFreshness"}
        />
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
          // The date is the newest change to any security's factor ratings —
          // not a "classification run": the sector Auto-Classify button on
          // Diagnostics writes no factor rating and never moves it.
          label="Factors updated"
          value={formatRelative(lastClassification)}
          tone={classifyTone}
          hint={
            lastClassification
              ? `Factor ratings last changed ${formatEnrichedAtET(lastClassification)}`
              : "No security has factor ratings yet"
          }
          onClick={() => togglePanel("lastClassify")}
          active={activePanel === "lastClassify"}
        />
        <Cell
          // The last time option sectors were checked and found in line, or
          // brought in line (a stored time, written by the sector run). A
          // separate figure from "Factors updated": neither run moves the
          // other's date.
          label="Sectors classified"
          value={formatRelative(lastSectorClassification)}
          tone={sectorClassifyTone}
          hint={
            lastSectorClassification
              ? `Sectors last checked ${formatEnrichedAtET(lastSectorClassification)}`
              : "Sectors have not been checked yet"
          }
          onClick={() => togglePanel("sectorClassify")}
          active={activePanel === "sectorClassify"}
        />
        <Cell
          label="Cross-checked (Modified Dietz)"
          value={crossCheckedThru ?? "—"}
          tone={reconTone}
          hint="Latest month with a contiguous independent cross-check (Modified Dietz vs statement TWR)"
          onClick={() => togglePanel("performance")}
          active={activePanel === "performance"}
        />
        <Cell
          label="Stale prices"
          value={
            untrustedPrices === 0
              ? "All fresh"
              : <PrivateText>{stalePricesSummary(stalePrices.count, neverPriced.count)}</PrivateText>
          }
          tone={staleTone}
          hint={
            untrustedPrices > 0
              ? [
                  neverPriced.symbols.length > 0 ? `Never priced: ${neverPriced.symbols.join(", ")}` : null,
                  stalePrices.symbols.length > 0 ? `Stale: ${stalePrices.symbols.join(", ")}` : null,
                ].filter(Boolean).join(" · ")
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
          hint="Held bonds with a duration, stored or estimated. Only a bond that cannot be modelled counts as a gap."
          onClick={() => togglePanel("bondDuration")}
          active={activePanel === "bondDuration"}
        />
      </div>

      {plaidLines.length > 0 && (
        <ul className="mb-2 space-y-0.5">
          {plaidLines.map((line) => (
            <li key={line.key} className="text-xs text-warn">
              {line.text}
            </li>
          ))}
        </ul>
      )}

      {/* A failed refresh keeps the figures and offers the same Retry. */}
      {loadError && (
        <p className="flex items-center gap-2 mb-2 text-xs text-down">
          <span>{loadError}</span>
          <button onClick={retry} className="underline text-ink focus-ring">
            Retry
          </button>
        </p>
      )}

      {activePanel && (
        <TrustStripDrawer
          panel={activePanel}
          state={state}
          scope={scope ?? "all"}
          onClose={() => setActivePanel(null)}
          onRefresh={fetchState}
        />
      )}
    </>
  );
}
