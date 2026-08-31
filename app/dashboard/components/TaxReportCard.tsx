"use client";

import { useState, useEffect } from "react";
import { PrivateText } from "@/lib/privacy/components";
import { buildTaxReportFilename } from "@/lib/compute/tax-report";

interface TaxReportSummary {
  year: number;
  /** Scope echoed by /api/tax-report — accounts.name, or null for all accounts. */
  accountName: string | null;
  filingReady: boolean;
  washSaleAdvisory: string;
  shortTermTotal: { proceeds: number; costBasis: number; adjustments: number; gainLoss: number };
  longTermTotal: { proceeds: number; costBasis: number; adjustments: number; gainLoss: number };
  shortTermRows: { length: number }[];
  longTermRows: { length: number }[];
  washSaleWarnings: {
    symbol: string;
    saleDate: string;
    purchaseDate: string;
    lossAmount: number;
    description: string;
  }[];
  excludedNonUsdSales?: number;
}

function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

// This card's "Short-Term" figure is the TAXABLE total — economic realized
// gain/loss PLUS the wash-sale disallowed-loss add-back (shortTermTotal.gainLoss
// from /api/tax-report already includes it; see lib/compute/tax-report.ts
// sumRows()). The tax-lots summary strip above shows the economic figure
// without the add-back, so the two cards must each name their own basis or a
// reader sees two different "short-term" numbers with no explanation. These
// pure helpers hold the label/derivation logic so it's testable without a
// rendering harness (see tests/dashboard/tax-report-card-labels.test.ts).
export const SHORT_TERM_LABEL = "Taxable ST (After Wash-Sale Add-Back)";
// Wash-sale rules are term-independent (detectWashSales never checks
// holding period) — the Long-Term tile gets the identical disclosure
// treatment as Short-Term, not a plain "Long-Term" label.
export const LONG_TERM_LABEL = "Taxable LT (After Wash-Sale Add-Back)";

export const FILING_WARNING_COPY =
  "Not ready for filing — a 2026-08-21 audit found Treasury sale proceeds/basis " +
  "stored at 100× economic value and short-sale rows with reversed proceeds/basis " +
  "columns in these exports. Stock gain/loss figures are unaffected, but reconcile " +
  "against broker records before using the CSV/TXF for any filing.";

export function shouldShowWashSaleAddBack(adjustments: number): boolean {
  return adjustments !== 0;
}

// Scope labels. The Tax Lots ?account= filter narrows this card and its
// downloads (QA:
// tax-lots--account-filter-ignored-by-tax-report-card-and-exports), so both
// the heading and the not-ready banner must NAME the account — a partial
// report that reads "Tax Report — 2022" is indistinguishable from the full
// one. Pure helpers so they're testable without a rendering harness.
export function taxReportCardTitle(year: number, accountName?: string | null): string {
  return accountName ? `Tax Report — ${year} · ${accountName}` : `Tax Report — ${year}`;
}

export function filingBannerHeading(accountName?: string | null): string {
  return accountName
    ? `Export not ready for filing — PARTIAL EXPORT: ${accountName} only`
    : "Export not ready for filing";
}

// PR #59 review Finding A (stale-fetch race): a minimal cancellation token
// extracted out of the codebase's own `let cancelled = false` cleanup idiom
// (see PlaidSection.tsx, LevelsPanel.tsx) so the out-of-order-resolution
// guarantee is a reusable, directly-testable primitive instead of only a
// bare closure variable pinned by a source regex. `cancel()` mirrors what
// an effect's cleanup does when a newer run (e.g. an account switch) has
// superseded this one; `isCancelled()` is checked before any state setter
// reachable from a fetch's resolution.
export function createFetchGuard() {
  let cancelled = false;
  return {
    cancel(): void {
      cancelled = true;
    },
    isCancelled(): boolean {
      return cancelled;
    },
  };
}

// PR #59 review Finding A (stale-fetch race), hardened after a Critical
// follow-up finding: the download filename's -NOT-FOR-FILING marker and
// account slug must come from the SAME report snapshot as the downloaded
// CONTENT. The original fix only closed the filename half — `handleDownload`
// still fetched the actual file using the live `accountName`/`year` PROPS,
// so a stale `report` (kept alive on screen by Finding B's fix, across a
// failed refetch, with the download buttons still enabled) could pair
// report A's filingReady/name in the FILENAME with report B's freshly
// fetched CONTENT. This helper takes `report.year` too (not a separate
// `year` param) and the caller (handleDownload) now sources its fetch URL
// from `report` as well — every value in both the request and the filename
// comes from one object, so the two can never describe different accounts.
export function resolveDownloadFilename(
  report: Pick<TaxReportSummary, "filingReady" | "accountName" | "year">,
  format: "csv" | "txf"
): string {
  return buildTaxReportFilename(format, report.year, report.filingReady, report.accountName);
}

// PR #59 review Finding B (silent blanking): a failed refetch (e.g.
// transient SQLITE_BUSY while Recompute writes) must never silently
// unmount a previously-good card — that violates the project's
// no-silent-failure convention. This is the single decision point for what
// the card renders given (loading, report, error):
//   - "loading"  — a fetch is in flight; ignore report/error, show the spinner.
//   - "empty"    — settled, no report, no error: genuinely nothing to show
//                  (e.g. a brand-new account/year with no sales yet).
//   - "error"    — settled, no report AND an error: the FIRST load failed;
//                  explain it, don't blank.
//   - "ready"    — settled, a report exists (possibly from an earlier
//                  successful fetch); `staleError` carries a non-fatal
//                  notice when the MOST RECENT refetch failed but earlier
//                  good data is still on screen.
export type TaxReportCardStatus =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ready"; staleError: string | null };

export function resolveTaxReportCardStatus(
  loading: boolean,
  report: TaxReportSummary | null,
  error: string | null
): TaxReportCardStatus {
  if (loading) return { kind: "loading" };
  if (!report) return error ? { kind: "error", message: error } : { kind: "empty" };
  return { kind: "ready", staleError: error };
}

// Keyed to where the add-back actually landed (shortTermTotal/longTermTotal
// .adjustments from sumRows(), USD rows only per their own term), never to
// washSaleWarnings.length alone: detectWashSales flags losses regardless of
// term or currency, so "a warning exists" does not imply "the ST total was
// adjusted" — a LT-only or non-USD-only wash sale must not claim a ST
// add-back that is provably zero.
export function washSalesCaption(
  shortTermAdjustments: number,
  longTermAdjustments: number,
  warningCount: number
): string {
  const stAddBack = shortTermAdjustments !== 0;
  const ltAddBack = longTermAdjustments !== 0;

  if (stAddBack && ltAddBack) {
    return "Disallowed losses added back into Taxable ST and Taxable LT";
  }
  if (stAddBack) {
    return "Disallowed losses added back into Taxable ST";
  }
  if (ltAddBack) {
    return "Disallowed losses added back into Taxable LT";
  }
  if (warningCount > 0) {
    // Non-USD wash sale: sumRows() excludes non-USD rows from both totals,
    // so the disallowed loss never reaches either .adjustments field.
    return "Disallowed loss not reflected in USD totals (non-USD sale)";
  }
  return "None detected";
}

export function TaxReportCard({
  year,
  accountName,
}: {
  year: number;
  /** Tax Lots ?account= filter. Undefined/empty = all accounts. */
  accountName?: string;
}) {
  const [report, setReport] = useState<TaxReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadingTxf, setDownloadingTxf] = useState(false);

  // Same query string for the card fetch and both downloads — the card can
  // never display one account's totals while handing over another's file.
  const accountParam = accountName ? `&account=${encodeURIComponent(accountName)}` : "";

  useEffect(() => {
    // PR #59 review Finding A: this effect re-fires on every `?account=`
    // soft navigation (deps [year, accountParam]) but the component itself
    // persists across the switch — an in-flight fetch for the PREVIOUS
    // account can resolve after the new account's fetch and overwrite
    // `report` with stale data. `createFetchGuard()` is the codebase's own
    // cancelled-flag cleanup pattern (see PlaidSection.tsx, LevelsPanel.tsx)
    // extracted so it's directly testable: every state setter reachable
    // from this fetch's resolution is gated on `guard.isCancelled()`, and
    // the cleanup below cancels this run's guard when a newer run starts.
    const guard = createFetchGuard();
    setLoading(true);
    fetch(`/api/tax-report?year=${year}${accountParam}`)
      .then((r) => r.json())
      .then((json) => {
        if (guard.isCancelled()) return;
        if (json.success) {
          setReport(json.data);
          setError(null);
        } else {
          // PR #59 review Finding B: never null the report here — a
          // transient failure (e.g. SQLITE_BUSY while Recompute writes)
          // must not silently unmount a previously-good card. Surface the
          // failure in domain language instead; resolveTaxReportCardStatus
          // decides whether that's a hard error state (no report yet) or a
          // stale/error notice over the last-good report.
          setError(json.error || "Failed to load the tax report.");
        }
      })
      .catch((err) => {
        if (!guard.isCancelled()) {
          setError(err instanceof Error ? err.message : "Failed to load the tax report.");
        }
      })
      .finally(() => {
        if (!guard.isCancelled()) setLoading(false);
      });
    return () => {
      guard.cancel();
    };
  }, [year, accountParam]);

  async function handleDownload(format: "csv" | "txf") {
    if (!report) return;
    const setter = format === "csv" ? setDownloading : setDownloadingTxf;
    setter(true);
    try {
      // PR #59 review Finding A (Critical follow-up): both the fetched
      // CONTENT's scope and the FILENAME must derive from the same
      // `report` snapshot — never the live `year`/`accountName` props.
      // Finding B deliberately keeps a stale `report` on screen (with the
      // download buttons still enabled) across a failed refetch; if this
      // fetch used the live props while the filename used `report`, an
      // account switch racing a failed refetch could still download
      // account B's content under account A's filingReady/name.
      const reportAccountParam = report.accountName
        ? `&account=${encodeURIComponent(report.accountName)}`
        : "";
      const res = await fetch(
        `/api/tax-report?year=${report.year}&format=${format}${reportAccountParam}`
      );
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Filename: buildTaxReportFilename appends "-NOT-FOR-FILING" unless
      // report.filingReady (broker-acceptance marker covers this account and
      // year) and carries the account slug when scoped — single-sourced with
      // the API route's Content-Disposition (lib/compute/tax-report.ts).
      a.download = resolveDownloadFilename(report, format);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently fail
    } finally {
      setter(false);
    }
  }

  const status = resolveTaxReportCardStatus(loading, report, error);

  if (status.kind === "loading") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-4">
        <div className="text-sm text-ink-faint animate-pulse">Loading tax report...</div>
      </div>
    );
  }

  if (status.kind === "empty") return null;

  if (status.kind === "error") {
    // PR #59 review Finding B: the first fetch for this scope failed and
    // there is no earlier good report to fall back on — explain the
    // failure instead of returning null (which would render nothing at
    // all, indistinguishable from "no tax report needed this year").
    return (
      <div className="rounded-xl border border-down/40 bg-down/20 p-4">
        <div className="text-sm text-down">Unable to load tax report: {status.message}</div>
      </div>
    );
  }

  // status.kind === "ready" — resolveTaxReportCardStatus only returns
  // "ready" when `report` is non-null; this check just satisfies TS
  // narrowing (report's type is TaxReportSummary | null).
  if (!report) return null;

  const totalSales =
    (report.shortTermRows?.length ?? 0) + (report.longTermRows?.length ?? 0);
  if (totalSales === 0) return null;

  const totalGainLoss = report.shortTermTotal.gainLoss + report.longTermTotal.gainLoss;
  const hasWashSales = report.washSaleWarnings.length > 0;
  // PR #59 review minor: this was computed three times (title x2 + banner
  // heading) — derive once and reuse.
  const scopeAccountName = report.accountName ?? accountName ?? null;

  return (
    <div className="rounded-xl border border-edge bg-panel overflow-hidden">
      <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
        <div className="min-w-0">
          {/* truncate (not wrap) keeps the scope on one line next to the
              download buttons; the full name stays available on hover. */}
          <h3
            className="text-xs font-medium text-ink-faint uppercase tracking-wider truncate"
            title={taxReportCardTitle(year, scopeAccountName)}
          >
            {taxReportCardTitle(year, scopeAccountName)}
          </h3>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleDownload("csv")}
            disabled={downloading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gold/10 text-gold-ink hover:bg-gold/20 border border-gold/20 transition-colors disabled:opacity-50"
          >
            {downloading ? "Generating..." : "CSV"}
          </button>
          <button
            onClick={() => handleDownload("txf")}
            disabled={downloadingTxf}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gold/10 text-gold-ink hover:bg-gold/20 border border-gold/20 transition-colors disabled:opacity-50"
          >
            {downloadingTxf ? "Generating..." : "TXF (TurboTax)"}
          </button>
        </div>
      </div>

      {/* PR #59 review Finding B: the report on screen may be stale — the
          MOST RECENT refetch (e.g. after switching accounts) failed and we
          kept showing the last-good data rather than blanking the card.
          Say so explicitly instead of silently letting the figures go
          out of sync with the current scope. */}
      {status.staleError && (
        <div className="px-5 pt-4">
          <div className="border border-down/40 bg-down/20 rounded-lg p-3">
            <h4 className="text-xs font-medium text-down">
              &#x26A0; Showing last-loaded data — refresh failed
            </h4>
            <p className="text-[10px] text-ink-faint mt-1">{status.staleError}</p>
          </div>
        </div>
      )}

      {/* Marker-gated: the containment banner only applies while filingReady
          is false (no broker-acceptance stamp covering this year yet) —
          see lib/compute/tax-report.ts generateTaxReport. */}
      {!report.filingReady && (
        <div className="px-5 pt-4">
          <div className="border border-amber-400/20 bg-amber-400/5 rounded-lg p-3">
            <h4 className="text-xs font-medium text-amber-400">
              &#x26A0; {filingBannerHeading(scopeAccountName)}
            </h4>
            <p className="text-[10px] text-ink-faint mt-1">{FILING_WARNING_COPY}</p>
          </div>
        </div>
      )}

      <div className="p-5 space-y-4">
        {/* Wash-sale methodology disclosure — always shown, independent of
            whether any wash sale was actually detected below. */}
        <p className="text-[10px] text-ink-faint">{report.washSaleAdvisory}</p>

        {/* Summary grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-raised border border-edge rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">{SHORT_TERM_LABEL}</div>
            <div className={`text-base font-mono tabular-nums font-semibold ${report.shortTermTotal.gainLoss >= 0 ? "text-up" : "text-down"}`}>
              <PrivateText>{formatMoney(report.shortTermTotal.gainLoss)}</PrivateText>
            </div>
            <div className="text-[10px] text-ink-faint mt-0.5">{report.shortTermRows?.length ?? 0} sales</div>
            {shouldShowWashSaleAddBack(report.shortTermTotal.adjustments) && (
              <div className="text-[10px] text-ink-faint mt-0.5">
                Wash-sale add-back: <PrivateText>{formatMoney(report.shortTermTotal.adjustments)}</PrivateText>
              </div>
            )}
          </div>

          <div className="bg-raised border border-edge rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">{LONG_TERM_LABEL}</div>
            <div className={`text-base font-mono tabular-nums font-semibold ${report.longTermTotal.gainLoss >= 0 ? "text-up" : "text-down"}`}>
              <PrivateText>{formatMoney(report.longTermTotal.gainLoss)}</PrivateText>
            </div>
            <div className="text-[10px] text-ink-faint mt-0.5">{report.longTermRows?.length ?? 0} sales</div>
            {shouldShowWashSaleAddBack(report.longTermTotal.adjustments) && (
              <div className="text-[10px] text-ink-faint mt-0.5">
                Wash-sale add-back: <PrivateText>{formatMoney(report.longTermTotal.adjustments)}</PrivateText>
              </div>
            )}
          </div>

          <div className="bg-raised border border-edge rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">Net Gain/Loss</div>
            <div className={`text-base font-mono tabular-nums font-semibold ${totalGainLoss >= 0 ? "text-up" : "text-down"}`}>
              <PrivateText>{formatMoney(totalGainLoss)}</PrivateText>
            </div>
            <div className="text-[10px] text-ink-faint mt-0.5">{totalSales} total sales</div>
          </div>

          <div className="bg-raised border border-edge rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">Wash Sales</div>
            <div className={`text-base font-mono tabular-nums font-semibold ${hasWashSales ? "text-amber-400" : "text-ink"}`}>
              {report.washSaleWarnings.length}
            </div>
            <div className="text-[10px] text-ink-faint mt-0.5">
              {washSalesCaption(
                report.shortTermTotal.adjustments,
                report.longTermTotal.adjustments,
                report.washSaleWarnings.length
              )}
            </div>
          </div>
        </div>

        {(report.excludedNonUsdSales ?? 0) > 0 && (
          <p className="text-[10px] text-ink-faint italic">
            USD totals exclude {report.excludedNonUsdSales} non-USD sale
            {report.excludedNonUsdSales === 1 ? "" : "s"} (realized figures are
            native per security; the CSV/TXF exports keep the raw rows).
          </p>
        )}

        {/* Wash sale warnings */}
        {hasWashSales && (
          <div className="border border-amber-400/20 bg-amber-400/5 rounded-lg p-3">
            <h4 className="text-xs font-medium text-amber-400 mb-2 flex items-center gap-1.5">
              <span>&#x26A0;</span> Potential Wash Sales
            </h4>
            <div className="space-y-1.5">
              {report.washSaleWarnings.map((w, i) => (
                <div key={i} className="text-xs text-ink-dim">
                  <span className="font-mono font-medium text-ink">{w.symbol}</span>
                  {" \u2014 "}Sold {w.saleDate} (loss <PrivateText>{formatMoney(w.lossAmount)}</PrivateText>), repurchased {w.purchaseDate}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-ink-faint mt-2">
              Under IRS wash sale rules, losses from sales where substantially identical securities
              were purchased within 30 days may be disallowed. The CSV export marks these with adjustment code &ldquo;W&rdquo;.
              Consult your tax advisor.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
