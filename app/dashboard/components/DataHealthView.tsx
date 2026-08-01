"use client";

import { useState, useEffect } from "react";
import type {
  PriceFreshness,
  AccountCoverage,
  DataGaps,
  CrossSourceDiscrepancy,
  SnapshotReconciliation,
  DataHealthSummary,
} from "@/lib/queries/data-health";
import { Money } from "@/lib/privacy/components";

interface DataHealthResponse {
  success: boolean;
  summary: DataHealthSummary;
  priceFreshness: PriceFreshness[];
  accountCoverage: AccountCoverage[];
  gaps: DataGaps;
  discrepancies: CrossSourceDiscrepancy[];
  reconciliation: SnapshotReconciliation[];
}

function StaleBadge({ days }: { days: number | null }) {
  if (days === null)
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-down/15 text-down font-medium">
        No prices
      </span>
    );
  if (days <= 3)
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-up/15 text-up font-medium">
        {days}d
      </span>
    );
  if (days <= 14)
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-gold/15 text-gold-ink font-medium">
        {days}d
      </span>
    );
  if (days <= 45)
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-[#f97316]/15 text-[#f97316] font-medium">
        {days}d
      </span>
    );
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-down/15 text-down font-medium">
      {days}d
    </span>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: "up" | "down" | "gold" | "default";
}) {
  const colorClass =
    color === "up"
      ? "text-up"
      : color === "down"
        ? "text-down"
        : color === "gold"
          ? "text-gold"
          : "text-ink";
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <div className="text-xs text-ink-faint mb-1">{label}</div>
      <div className={`text-2xl font-mono font-semibold tabular-nums ${colorClass}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ink-faint mt-1">{sub}</div>}
    </div>
  );
}

export function DataHealthView() {
  const [data, setData] = useState<DataHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data-health")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setData(d);
        else setError(d.error);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-down/30 bg-down-tint p-6 text-center">
        <p className="text-down text-sm">{error ?? "Failed to load data health"}</p>
      </div>
    );
  }

  const { summary, priceFreshness, accountCoverage, gaps, discrepancies, reconciliation } = data;

  const reconFlags = reconciliation.filter(
    (r) => r.diffPct !== null && Math.abs(r.diffPct) > 2,
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl text-gold font-medium">Data Health</h2>
        <p className="text-sm text-ink-dim mt-1">
          Overview of data completeness, freshness, and accuracy
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard
          label="Price Coverage"
          value={`${summary.overallCoveragePct}%`}
          sub={`${summary.securitiesWithPrices}/${summary.totalSecurities} securities`}
          color={summary.overallCoveragePct >= 90 ? "up" : summary.overallCoveragePct >= 70 ? "gold" : "down"}
        />
        <SummaryCard
          label="Max Stale"
          value={summary.maxStaleDays !== null ? `${summary.maxStaleDays}d` : "—"}
          sub={summary.worstStaleSymbol ?? undefined}
          color={
            summary.maxStaleDays === null
              ? "default"
              : summary.maxStaleDays <= 7
                ? "up"
                : summary.maxStaleDays <= 30
                  ? "gold"
                  : "down"
          }
        />
        <SummaryCard
          label="Data Gaps"
          value={summary.totalGaps}
          color={summary.totalGaps === 0 ? "up" : "gold"}
        />
        <SummaryCard
          label="Recon Flags"
          value={summary.totalReconciliationFlags}
          sub={reconFlags.length > 0 ? `${reconFlags.length} snapshots >2% off` : undefined}
          color={summary.totalReconciliationFlags === 0 ? "up" : "down"}
        />
      </div>

      {/* Account Coverage */}
      <section className="rounded-xl border border-edge bg-panel">
        <div className="px-5 py-3 border-b border-edge">
          <h3 className="text-sm font-medium text-ink">Account Coverage</h3>
        </div>
        <div className="p-5 space-y-3">
          {accountCoverage.map((ac) => (
            <div key={ac.accountId} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink">{ac.accountName}</span>
                <span className="text-ink-dim font-mono tabular-nums">
                  {ac.pricedHoldings}/{ac.totalHoldings} priced
                  {ac.totalHoldings > 0 && (
                    <span className="ml-2 text-ink-faint">
                      ({ac.coveragePct}%)
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 rounded-full bg-raised overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] ${
                    ac.coveragePct >= 90
                      ? "bg-up"
                      : ac.coveragePct >= 70
                        ? "bg-gold"
                        : "bg-down"
                  }`}
                  style={{ width: `${Math.min(ac.coveragePct, 100)}%` }}
                />
              </div>
              <div className="flex gap-4 text-xs text-ink-faint">
                <span>Cost basis: {ac.holdingsWithCostBasis}/{ac.totalHoldings}</span>
                {ac.latestSnapshotDate && (
                  <span>Last snapshot: {ac.latestSnapshotDate}</span>
                )}
                {ac.latestHoldingsDate && (
                  <span>Last holdings: {ac.latestHoldingsDate}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Price Freshness Table */}
      <section className="rounded-xl border border-edge bg-panel">
        <div className="px-5 py-3 border-b border-edge">
          <h3 className="text-sm font-medium text-ink">
            Price Freshness
            <span className="text-ink-faint font-normal ml-2">
              {priceFreshness.filter((p) => p.hasHoldings).length > 50
                ? `(50 stalest of ${priceFreshness.filter((p) => p.hasHoldings).length} held securities)`
                : `(${priceFreshness.filter((p) => p.hasHoldings).length} held securities)`}
            </span>
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-faint border-b border-edge">
                <th className="text-left px-5 py-2 font-medium">Symbol</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-right px-3 py-2 font-medium">Last Price</th>
                <th className="text-left px-3 py-2 font-medium">Source</th>
                <th className="text-right px-3 py-2 font-medium">Staleness</th>
                <th className="text-right px-5 py-2 font-medium">Prices</th>
              </tr>
            </thead>
            <tbody>
              {priceFreshness
                .filter((p) => p.hasHoldings)
                .slice(0, 50)
                .map((p) => (
                  <tr
                    key={p.securityId}
                    className="border-b border-edge/50 hover:bg-raised/50 transition-colors"
                  >
                    <td className="px-5 py-2">
                      <a
                        href={`/dashboard/security/${p.securityId}`}
                        className="text-blue hover:underline font-mono"
                      >
                        {p.symbol}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-ink-faint">{p.securityType ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-ink-dim font-mono tabular-nums">
                      {p.latestPriceDate ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-ink-faint text-xs font-mono">
                      {p.priceSource ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <StaleBadge days={p.daysStalePrices} />
                    </td>
                    <td className="px-5 py-2 text-right text-ink-dim font-mono tabular-nums">
                      {p.priceCount}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {priceFreshness.filter((p) => p.hasHoldings).length > 50 && (
          <div className="px-5 py-2 border-t border-edge text-xs text-ink-faint">
            Showing the 50 stalest rows —{" "}
            {priceFreshness.filter((p) => p.hasHoldings).length - 50} fresher securities
            hidden.
          </div>
        )}
      </section>

      {/* Data Gaps */}
      {(gaps.securitiesNoPrices.length > 0 ||
        gaps.securitiesNoTransactions.length > 0 ||
        gaps.accountsNoSnapshots.length > 0 ||
        gaps.staleHoldings.length > 0) && (
        <section className="rounded-xl border border-edge bg-panel">
          <div className="px-5 py-3 border-b border-edge">
            <h3 className="text-sm font-medium text-ink">Data Gaps</h3>
          </div>
          <div className="p-5 space-y-4">
            {gaps.securitiesNoPrices.length > 0 && (
              <details>
                <summary className="text-sm text-down cursor-pointer hover:text-down/80">
                  {gaps.securitiesNoPrices.length} securities with no prices
                </summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  {gaps.securitiesNoPrices.map((s) => (
                    <a
                      key={s.id}
                      href={`/dashboard/security/${s.id}`}
                      className="text-xs font-mono px-2 py-1 rounded bg-raised text-ink-dim hover:text-ink"
                    >
                      {s.symbol}
                    </a>
                  ))}
                </div>
              </details>
            )}
            {gaps.securitiesNoTransactions.length > 0 && (
              <details>
                <summary className="text-sm text-gold-ink cursor-pointer hover:text-gold/80">
                  {gaps.securitiesNoTransactions.length} securities with no transactions
                </summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  {gaps.securitiesNoTransactions.map((s) => (
                    <a
                      key={s.id}
                      href={`/dashboard/security/${s.id}`}
                      className="text-xs font-mono px-2 py-1 rounded bg-raised text-ink-dim hover:text-ink"
                    >
                      {s.symbol}
                    </a>
                  ))}
                </div>
              </details>
            )}
            {gaps.staleHoldings.length > 0 && (
              <details>
                <summary className="text-sm text-[#f97316] cursor-pointer hover:text-[#f97316]/80">
                  {gaps.staleHoldings.length} stale holdings (&gt;90 days)
                </summary>
                <div className="mt-2 space-y-1">
                  {gaps.staleHoldings.map((h, i) => (
                    <p key={i} className="text-xs text-ink-dim font-mono">
                      {h.symbol} ({h.accountName}) — {h.daysSince}d since {h.asOfDate}
                    </p>
                  ))}
                </div>
              </details>
            )}
            {gaps.accountsNoSnapshots.length > 0 && (
              <details>
                <summary className="text-sm text-ink-dim cursor-pointer">
                  {gaps.accountsNoSnapshots.length} accounts with no snapshots
                </summary>
                <div className="mt-2 space-y-1">
                  {gaps.accountsNoSnapshots.map((a) => (
                    <p key={a.id} className="text-xs text-ink-faint">
                      {a.name}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </div>
        </section>
      )}

      {/* Cross-Source Discrepancies */}
      {discrepancies.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel">
          <div className="px-5 py-3 border-b border-edge">
            <h3 className="text-sm font-medium text-ink">
              Cross-Source Discrepancies
              <span className="text-ink-faint font-normal ml-2">
                (prices vs OHLCV bars &gt;2% diff)
              </span>
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-ink-faint border-b border-edge">
                  <th className="text-left px-5 py-2 font-medium">Symbol</th>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-right px-3 py-2 font-medium">Import Price</th>
                  <th className="text-right px-3 py-2 font-medium">OHLCV Close</th>
                  <th className="text-right px-5 py-2 font-medium">Diff %</th>
                </tr>
              </thead>
              <tbody>
                {discrepancies.slice(0, 20).map((d, i) => (
                  <tr key={i} className="border-b border-edge/50">
                    <td className="px-5 py-2 font-mono text-ink">{d.symbol}</td>
                    <td className="px-3 py-2 text-ink-dim font-mono tabular-nums">{d.date}</td>
                    <td className="px-3 py-2 text-right text-ink-dim font-mono tabular-nums">
                      <Money value={d.priceA} precise />
                    </td>
                    <td className="px-3 py-2 text-right text-ink-dim font-mono tabular-nums">
                      <Money value={d.priceB} precise />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <span className={`font-mono tabular-nums ${d.diffPct > 5 ? "text-down" : "text-gold-ink"}`}>
                        {d.diffPct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Snapshot Reconciliation */}
      {reconciliation.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel">
          <div className="px-5 py-3 border-b border-edge">
            <h3 className="text-sm font-medium text-ink">
              Snapshot Reconciliation
              <span className="text-ink-faint font-normal ml-2">
                (statement total vs computed)
              </span>
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-ink-faint border-b border-edge">
                  <th className="text-left px-5 py-2 font-medium">Account</th>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-right px-3 py-2 font-medium">Statement</th>
                  <th className="text-right px-3 py-2 font-medium">Computed</th>
                  <th className="text-right px-3 py-2 font-medium">Diff %</th>
                  <th className="text-right px-5 py-2 font-medium">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.slice(0, 30).map((r, i) => {
                  const flagged = r.diffPct !== null && Math.abs(r.diffPct) > 2;
                  return (
                    <tr
                      key={i}
                      className={`border-b border-edge/50 ${flagged ? "bg-down/5" : ""}`}
                    >
                      <td className="px-5 py-2 text-ink">{r.accountName}</td>
                      <td className="px-3 py-2 text-ink-dim font-mono tabular-nums">
                        {r.snapshotDate}
                      </td>
                      <td className="px-3 py-2 text-right text-ink-dim font-mono tabular-nums">
                        <Money value={r.snapshotTotal} />
                      </td>
                      <td className="px-3 py-2 text-right text-ink-dim font-mono tabular-nums">
                        <Money value={r.computedTotal} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.diffPct !== null ? (
                          <span
                            className={`font-mono tabular-nums ${
                              flagged ? "text-down font-medium" : "text-ink-dim"
                            }`}
                          >
                            {r.diffPct > 0 ? "+" : ""}
                            {r.diffPct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-right text-xs text-ink-faint font-mono tabular-nums">
                        {r.pricedCount !== null && r.holdingsCount !== null
                          ? `${r.pricedCount}/${r.holdingsCount}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
