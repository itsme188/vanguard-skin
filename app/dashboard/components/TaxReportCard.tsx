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
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadingTxf, setDownloadingTxf] = useState(false);

  // Same query string for the card fetch and both downloads — the card can
  // never display one account's totals while handing over another's file.
  const accountParam = accountName ? `&account=${encodeURIComponent(accountName)}` : "";

  useEffect(() => {
    setLoading(true);
    fetch(`/api/tax-report?year=${year}${accountParam}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setReport(json.data);
        else setReport(null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [year, accountParam]);

  async function handleDownload(format: "csv" | "txf") {
    if (!report) return;
    const setter = format === "csv" ? setDownloading : setDownloadingTxf;
    setter(true);
    try {
      const res = await fetch(`/api/tax-report?year=${year}&format=${format}${accountParam}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Filename: buildTaxReportFilename appends "-NOT-FOR-FILING" unless
      // report.filingReady (broker-acceptance marker covers this account and
      // year) and carries the account slug when scoped — single-sourced with
      // the API route's Content-Disposition (lib/compute/tax-report.ts).
      a.download = buildTaxReportFilename(format, year, report.filingReady, accountName);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently fail
    } finally {
      setter(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-edge bg-panel p-4">
        <div className="text-sm text-ink-faint animate-pulse">Loading tax report...</div>
      </div>
    );
  }

  if (!report) return null;

  const totalSales =
    (report.shortTermRows?.length ?? 0) + (report.longTermRows?.length ?? 0);
  if (totalSales === 0) return null;

  const totalGainLoss = report.shortTermTotal.gainLoss + report.longTermTotal.gainLoss;
  const hasWashSales = report.washSaleWarnings.length > 0;

  return (
    <div className="rounded-xl border border-edge bg-panel overflow-hidden">
      <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
        <div className="min-w-0">
          {/* truncate (not wrap) keeps the scope on one line next to the
              download buttons; the full name stays available on hover. */}
          <h3
            className="text-xs font-medium text-ink-faint uppercase tracking-wider truncate"
            title={taxReportCardTitle(year, report.accountName ?? accountName)}
          >
            {taxReportCardTitle(year, report.accountName ?? accountName)}
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

      {/* Marker-gated: the containment banner only applies while filingReady
          is false (no broker-acceptance stamp covering this year yet) —
          see lib/compute/tax-report.ts generateTaxReport. */}
      {!report.filingReady && (
        <div className="px-5 pt-4">
          <div className="border border-amber-400/20 bg-amber-400/5 rounded-lg p-3">
            <h4 className="text-xs font-medium text-amber-400">
              &#x26A0; {filingBannerHeading(report.accountName ?? accountName)}
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
