"use client";

import { useState, useEffect } from "react";
import { PrivateText } from "@/lib/privacy/components";

interface TaxReportSummary {
  year: number;
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
}

function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function TaxReportCard({ year }: { year: number }) {
  const [report, setReport] = useState<TaxReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadingTxf, setDownloadingTxf] = useState(false);

  useEffect(() => {
    fetch(`/api/tax-report?year=${year}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setReport(json.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [year]);

  async function handleDownload(format: "csv" | "txf") {
    const setter = format === "csv" ? setDownloading : setDownloadingTxf;
    setter(true);
    try {
      const res = await fetch(`/api/tax-report?year=${year}&format=${format}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `form-8949-${year}.${format}`;
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
        <div>
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
            Tax Report — {year}
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

      <div className="p-5 space-y-4">
        {/* Summary grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-raised border border-edge rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">Short-Term</div>
            <div className={`text-base font-mono tabular-nums font-semibold ${report.shortTermTotal.gainLoss >= 0 ? "text-up" : "text-down"}`}>
              <PrivateText>{formatMoney(report.shortTermTotal.gainLoss)}</PrivateText>
            </div>
            <div className="text-[10px] text-ink-faint mt-0.5">{report.shortTermRows?.length ?? 0} sales</div>
          </div>

          <div className="bg-raised border border-edge rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">Long-Term</div>
            <div className={`text-base font-mono tabular-nums font-semibold ${report.longTermTotal.gainLoss >= 0 ? "text-up" : "text-down"}`}>
              <PrivateText>{formatMoney(report.longTermTotal.gainLoss)}</PrivateText>
            </div>
            <div className="text-[10px] text-ink-faint mt-0.5">{report.longTermRows?.length ?? 0} sales</div>
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
              {hasWashSales ? "Losses may be disallowed" : "None detected"}
            </div>
          </div>
        </div>

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
