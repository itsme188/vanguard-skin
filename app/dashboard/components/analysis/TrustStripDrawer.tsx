"use client";

import { useEffect, useRef, useState } from "react";
import type {
  AnalysisTrustState,
  BandHistoryEntry,
  PerAccountReconciliation,
} from "@/lib/queries/analysis-trust-state";
import { DIETZ_CONSISTENT_BP, type DietzBand } from "@/lib/compute/dietz";
import { PrivateText, Pct, Count } from "@/lib/privacy/components";
import { Chip, type ChipTone } from "@/app/dashboard/components/Chip";
import apiFetch from "@/lib/http/apiFetch";

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
      const res = await apiFetch("/api/compute/classify-factors", { method: "POST" });
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
      const res = await apiFetch("/api/tws/auto-refresh", {
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

// Band copy + tone — shared between the per-account headline chip and the
// band-history dots below (the dot map additionally covers "missing": a
// calendar month with no statement row at all, which breaks the chain like
// investigate/insufficient but isn't a Dietz band in its own right).
const BAND_LABEL: Record<DietzBand, string> = {
  consistent: "Consistent — method differences expected",
  investigate: "Investigate",
  not_comparable: "Not comparable",
  insufficient: "Insufficient data",
};

const BAND_TONE: Record<DietzBand, ChipTone> = {
  consistent: "up",
  investigate: "down",
  not_comparable: "info",
  insufficient: "neutral",
};

const BAND_DOT_LABEL: Record<DietzBand | "missing", string> = {
  ...BAND_LABEL,
  missing: "No statement for this month",
};

const BAND_DOT_CLASS: Record<DietzBand | "missing", string> = {
  consistent: "bg-up",
  investigate: "bg-down",
  not_comparable: "bg-blue",
  insufficient: "bg-ink-faint",
  missing: "border border-dashed border-ink-faint",
};

/** Compact last-12-months band strip. Each month is a real (focusable, tap-
 *  sized) button carrying its band in `title`/`aria-label` — no hover-only
 *  affordance; the dot itself is always visible, tapping/focusing it is
 *  enough to read the label via the OS tooltip or a screen reader. */
function BandHistoryStrip({ history }: { history: BandHistoryEntry[] }) {
  const recent = history.slice(-12);
  if (recent.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap" role="list" aria-label="Band history, last 12 months">
      {recent.map((entry) => (
        <button
          key={entry.monthEndDate}
          type="button"
          title={`${entry.monthEndDate}: ${BAND_DOT_LABEL[entry.band]}`}
          aria-label={`${entry.monthEndDate}: ${BAND_DOT_LABEL[entry.band]}`}
          className="h-4 w-4 flex items-center justify-center shrink-0 rounded-full cursor-default focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
        >
          <span
            className={`h-2 w-2 rounded-full ${BAND_DOT_CLASS[entry.band]}`}
            aria-hidden="true"
          />
        </button>
      ))}
    </div>
  );
}

/**
 * Count of DISTINCT calendar months that are "not_comparable" (seam-
 * straddled — pass-through: they neither certify nor break a chain, a
 * deliberate 2026-08-28 decision, see walkAccountChain in
 * lib/queries/analysis-trust-state.ts) at or before `through`, deduped by
 * `monthEndDate` ACROSS every account's own walked bandHistory.
 *
 * Codex finding: this used to sum account-month observations, not distinct
 * months — one seam month straddling three accounts read as "3
 * not-comparable months skipped" in the headline, when it was a single
 * calendar month. Exported for direct unit testing (pure function, no
 * React/DOM dependency).
 *
 * Review finding: the rollup headline below claims a "contiguous chain of
 * consistent months" through the frontier, but a not_comparable month inside
 * that span was never actually cross-checked — it was skipped, not verified.
 * This count powers an honest parenthetical rather than changing what
 * counts as the frontier (no logic change here or in
 * analysis-trust-state.ts — `crossCheckedThru`/`chainBreak` are unchanged).
 */
export function countNotComparableThrough(
  perAccountReconciliation: PerAccountReconciliation[],
  through: string
): number {
  const months = new Set<string>();
  for (const row of perAccountReconciliation) {
    // bandHistory is walked in ascending monthEndDate order (see
    // walkAccountChain), so this can stop at the first month past `through`.
    for (const entry of row.bandHistory) {
      if (entry.monthEndDate > through) break;
      if (entry.band === "not_comparable") months.add(entry.monthEndDate);
    }
  }
  return months.size;
}

function PerformanceContent({ state }: { state: AnalysisTrustState }) {
  const { crossCheckedThru, perAccountReconciliation } = state;
  const skippedNotComparable = crossCheckedThru
    ? countNotComparableThrough(perAccountReconciliation, crossCheckedThru)
    : 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink">
        {crossCheckedThru ? (
          <>
            {`Independently cross-checked (Modified Dietz) through ${crossCheckedThru} — the earliest month every account's contiguous chain of consistent months reaches`}
            {skippedNotComparable > 0 && (
              <>
                {" ("}
                <Count value={skippedNotComparable} />
                {` not-comparable month${
                  skippedNotComparable === 1 ? "" : "s"
                } skipped along the way, not cross-checked)`}
              </>
            )}
            {". Where each chain stopped, and the latest statement month's own band, are below."}
          </>
        ) : (
          "No account has a contiguous independent cross-check yet — see per-account detail below."
        )}
      </p>

      {perAccountReconciliation.length > 0 && (
        <ul className="space-y-3">
          {perAccountReconciliation.map((row) => (
            <li
              key={row.accountId}
              className="rounded-lg bg-panel border border-edge p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink truncate">{row.accountName}</span>
                <div className="flex flex-col items-end gap-0.5">
                  {row.monthEndDate && (
                    <span className="text-[10px] text-ink-faint uppercase tracking-wide">
                      Latest month {row.monthEndDate}
                    </span>
                  )}
                  {row.band ? (
                    <Chip tone={BAND_TONE[row.band]} size="xs" title={BAND_LABEL[row.band]}>
                      {BAND_LABEL[row.band]}
                    </Chip>
                  ) : (
                    <Chip tone="neutral" size="xs" title="No statement on file for this account">
                      No statement
                    </Chip>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
                <div>
                  <div className="text-[10px] text-ink-faint uppercase tracking-wide">
                    Statement TWR
                  </div>
                  <Pct
                    value={row.statementTwr !== null ? row.statementTwr * 100 : null}
                    digits={2}
                    signed
                    className="text-ink"
                  />
                </div>
                <div>
                  <div className="text-[10px] text-ink-faint uppercase tracking-wide">Dietz</div>
                  <Pct
                    value={row.dietzReturn !== null ? row.dietzReturn * 100 : null}
                    digits={2}
                    signed
                    className="text-ink"
                  />
                </div>
                <div>
                  <div className="text-[10px] text-ink-faint uppercase tracking-wide">Gap</div>
                  {/* The gap is a portfolio-derived return figure — it goes
                      through <Pct> like the two return legs above so it's
                      masked in privacy mode (Codex plan review #15 caught
                      the old bp span rendering the raw unmasked number).
                      divergenceBp is basis points; Pct's own formatter
                      always renders a "%" (there's no raw-magnitude mode),
                      so it's shown at its true percentage-point value
                      (divergenceBp/100, 2 digits — exact, since
                      divergenceBp is already an integer bp count) rather
                      than glued to a separate "bp" suffix, which would
                      either read as a misleading 100x-inflated "%" or a
                      confusing double unit. The two sibling figures above
                      are in the same % unit, so the reader can verify the
                      gap by eye. */}
                  <Pct
                    value={row.divergenceBp !== null ? row.divergenceBp / 100 : null}
                    digits={2}
                    signed
                    className={
                      row.band === "investigate"
                        ? "text-down"
                        : row.band === "consistent"
                        ? "text-ink-dim"
                        : "text-ink-faint"
                    }
                  />
                </div>
              </div>
              <p className="text-[11px] text-ink-dim">
                Cross-checked through{" "}
                <span className="font-mono tabular-nums">{row.crossCheckedThru ?? "—"}</span>
                {row.chainBreak && (
                  <>
                    {" "}
                    · chain stopped{" "}
                    <span className="font-mono tabular-nums">
                      {row.chainBreak.monthEndDate}
                    </span>
                    {`: ${BAND_DOT_LABEL[row.chainBreak.band]}`}
                  </>
                )}
                {row.crossCheckedThru === null &&
                  row.monthEndDate !== null &&
                  (row.bandHistory.length === 0 && row.chainBreak === null
                    ? // Review finding: an account with exactly ONE statement
                      // month never had a cross-check attempted at all
                      // (walkAccountChain needs a 2nd statement month to
                      // start walking — see its bandHistory: [] early
                      // return). "no contiguous consistent month yet" reads
                      // as "we checked and it failed", which is false here —
                      // nothing was checked yet.
                      " · needs a second statement month before a cross-check can start"
                    : " · no contiguous consistent month yet")}
              </p>
              {row.bandHistory.length > 0 && <BandHistoryStrip history={row.bandHistory} />}
            </li>
          ))}
        </ul>
      )}

      {perAccountReconciliation.length > 0 && (
        <p className="text-[10px] text-ink-faint">
          Gap is the independently recomputed Modified Dietz return minus the statement-reported TWR, for the same account-month — not a recomputation of the statement&apos;s own figure. ≤{DIETZ_CONSISTENT_BP / 100}% ({DIETZ_CONSISTENT_BP}bp) bands as consistent.
        </p>
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
  performance: "Performance Cross-Check",
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
