"use client";

import { useEffect, useRef, useState } from "react";
import type { AnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { PrivateText } from "@/lib/privacy/components";

export type DrawerPanel =
  | "factorCoverage"
  | "lastClassify"
  | "performance"
  | "stalePrices"
  | "bondDuration";

interface Props {
  panel: DrawerPanel;
  state: AnalysisTrustState;
  onClose: () => void;
  onRefresh: () => void;
}

// ── Individual panel content ─────────────────────────────────────────

function FactorCoverageContent({
  state,
  onRefresh,
  onClose,
}: {
  state: AnalysisTrustState;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const { factorCoverage } = state;

  async function handleClassify() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/compute/classify-factors", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        // Keep the drawer open — closing immediately hides the outcome and a
        // no-op run reads as a dead button.
        if (json.classified === 0 && json.skipped === 0 && !json.errors?.length) {
          setResult(
            json.candidates === 0
              ? "Nothing needed classification — the remaining symbols are options that inherit factors from underlyings that are already classified, or expired positions awaiting cleanup."
              : "Claude returned no usable classifications for the candidates. Try again — if it persists, check the AI Gateway dashboard."
          );
        } else {
          const created = json.underlyingsCreated > 0 ? `, ${json.underlyingsCreated} option underlying(s) added` : "";
          const errs = json.errors?.length ? `, ${json.errors.length} batch error(s)` : "";
          setResult(`Classified ${json.classified} securities (${json.skipped} skipped${created}${errs}).`);
        }
        onRefresh();
      } else {
        setResult(`Error: ${json.error}`);
      }
    } catch {
      setResult("Network error — classification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-ink">
          <PrivateText>{`${Math.round(factorCoverage.percentage * 100)}%`}</PrivateText>
        </span>
        <span className="text-sm text-ink-faint">
          (<PrivateText>{`${factorCoverage.classified} of ${factorCoverage.totalNames}`}</PrivateText> securities classified)
        </span>
      </div>

      {factorCoverage.missingSymbols.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-2">
            Missing factor data
          </p>
          <div className="flex flex-wrap gap-1.5">
            {factorCoverage.missingSymbols.map((sym) => (
              <span
                key={sym}
                className="px-2 py-0.5 rounded bg-raised border border-edge text-xs font-mono text-ink-dim"
              >
                {sym}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-up">All held securities have factor data.</p>
      )}

      {factorCoverage.missingSymbols.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={handleClassify}
            disabled={busy}
            className="w-full px-4 py-2 rounded-lg bg-amber-400 text-black text-sm font-semibold hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy
              ? "Classifying…"
              : `Classify ${factorCoverage.missingSymbols.length} missing`}
          </button>
          {result && (
            <p className="text-xs text-ink-faint">{result}</p>
          )}
        </div>
      )}
    </div>
  );
}

function LastClassifyContent({ state }: { state: AnalysisTrustState }) {
  const ts = state.lastClassification;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink">
        {ts
          ? `Most recent classification run: ${ts}`
          : "No classification has been run yet."}
      </p>
      <p className="text-xs text-ink-faint">
        Factor data is updated when you run AI classification via the Factor Coverage cell or the Classify button in AnalysisView.
      </p>
    </div>
  );
}

function StalePricesContent({
  state,
  onClose,
}: {
  state: AnalysisTrustState;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const { stalePrices } = state;

  async function handleRefresh() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/tws/auto-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "quick" }),
      });
      const json = await res.json();
      if (res.ok) {
        // Keep the drawer open so the user sees this — the sync itself takes
        // a minute or two and silently no-ops if neither TWS nor the IBKR
        // Web API is reachable.
        setResult(
          "Quick refresh started — prices update in ~1-2 minutes when TWS (or the IBKR Web API fallback) is reachable. If TWS is closed and no fallback is configured, prices stay as-is."
        );
      } else {
        setResult(`Error: ${json.error ?? "Failed to trigger refresh"}`);
      }
    } catch {
      setResult("Network error — could not trigger refresh.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {stalePrices.count === 0 ? (
        <p className="text-sm text-up">All prices are fresh (within 4 days).</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-down">
              <PrivateText>{String(stalePrices.count)}</PrivateText>
            </span>
            <span className="text-sm text-ink-faint">
              {stalePrices.count === 1 ? "security" : "securities"} with prices older than 4 days
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stalePrices.symbols.map((sym) => (
              <span
                key={sym}
                className="px-2 py-0.5 rounded bg-raised border border-edge text-xs font-mono text-ink-dim"
              >
                {sym}
              </span>
            ))}
          </div>
          <button
            onClick={handleRefresh}
            disabled={busy}
            className="w-full px-4 py-2 rounded-lg bg-amber-400 text-black text-sm font-semibold hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "Triggering…" : "Refresh prices (quick sync)"}
          </button>
          {result && <p className="text-xs text-ink-faint">{result}</p>}
        </>
      )}
    </div>
  );
}

function PerformanceContent({ state }: { state: AnalysisTrustState }) {
  const { performanceReconciledThru, perAccountReconciliation } = state;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink">
        {performanceReconciledThru
          ? `TWR reconciled to statements through ${performanceReconciledThru}.`
          : "One or more accounts have not yet been reconciled to statements."}
      </p>

      {perAccountReconciliation.length > 0 && (
        <ul className="divide-y divide-edge rounded-lg bg-panel">
          {perAccountReconciliation.map((row) => (
            <li
              key={row.accountId}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={
                    "inline-block h-2 w-2 rounded-full shrink-0 " +
                    (row.withinTolerance === true
                      ? "bg-up"
                      : row.withinTolerance === false
                      ? "bg-down"
                      : "bg-ink-faint")
                  }
                  aria-hidden="true"
                />
                <span className="text-ink truncate">{row.accountName}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0 text-xs">
                <span className="text-ink-faint font-mono">
                  {row.latestStmtMonth ?? "—"}
                </span>
                <span
                  className={
                    "font-mono tabular-nums w-16 text-right " +
                    (row.withinTolerance === true
                      ? "text-ink-dim"
                      : row.withinTolerance === false
                      ? "text-down"
                      : "text-ink-faint")
                  }
                >
                  {row.divergenceBp === null
                    ? "n/a"
                    : `${row.divergenceBp >= 0 ? "+" : ""}${row.divergenceBp}bp`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <a
        href="/dashboard/analysis?view=performance"
        className="inline-block text-sm text-warn hover:brightness-110 underline underline-offset-2"
      >
        Open Performance →
      </a>
    </div>
  );
}

function BondDurationContent({ state }: { state: AnalysisTrustState }) {
  const { bondDuration } = state;
  return (
    <div className="space-y-3">
      {bondDuration.totalBonds === 0 ? (
        <p className="text-sm text-ink-dim">No bonds currently held.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-ink">
              <PrivateText>{`${bondDuration.withDuration}/${bondDuration.totalBonds}`}</PrivateText>
            </span>
            <span className="text-sm text-ink-faint">bonds with duration data</span>
          </div>
          {bondDuration.withDuration < bondDuration.totalBonds && (
            <p className="text-xs text-ink-faint">
              Missing bonds can be backfilled by extracting maturity dates from the security name field. Run{" "}
              <code className="font-mono text-amber-400">scripts/backfill-bond-durations.ts</code> after populating{" "}
              <code className="font-mono text-amber-400">maturity_date</code> on the securities.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Panel config ─────────────────────────────────────────────────────

const PANEL_TITLES: Record<DrawerPanel, string> = {
  factorCoverage: "Factor Coverage",
  lastClassify: "Last Classification",
  performance: "Performance Reconciliation",
  stalePrices: "Stale Prices",
  bondDuration: "Bond Duration Coverage",
};

// ── Drawer shell ─────────────────────────────────────────────────────

export function TrustStripDrawer({ panel, state, onClose, onRefresh }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (overlayRef.current && e.target === overlayRef.current) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[55]"
      style={{ backgroundColor: "transparent" }}
    >
      {/* Drawer panel */}
      <div
        className="absolute right-0 top-0 bottom-0 w-80 bg-panel border-l border-edge shadow-2xl flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={PANEL_TITLES[panel]}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <h3 className="text-sm font-semibold text-ink">{PANEL_TITLES[panel]}</h3>
          <button
            onClick={onClose}
            className="text-ink-faint hover:text-ink transition-colors p-1 rounded"
            aria-label="Close drawer"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {panel === "factorCoverage" && (
            <FactorCoverageContent state={state} onRefresh={onRefresh} onClose={onClose} />
          )}
          {panel === "lastClassify" && <LastClassifyContent state={state} />}
          {panel === "performance" && <PerformanceContent state={state} />}
          {panel === "stalePrices" && <StalePricesContent state={state} onClose={onClose} />}
          {panel === "bondDuration" && <BondDurationContent state={state} />}
        </div>
      </div>
    </div>
  );
}
