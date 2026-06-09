"use client";

import { useState, useEffect, type ReactNode } from "react";
import { Pct, PrivateText } from "@/lib/privacy/components";
import { EmptySection } from "./EmptySection";
import {
  interpretDuration,
  interpretPortfolioRateSensitivity,
  toneClass,
} from "@/lib/analysis/interpret";

interface BondHolding {
  symbol: string;
  name: string | null;
  marketValue: number;
  durationYears: number | null;
  creditRating: string | null;
  couponRate: number | null;
  maturityDate: string | null;
}

interface FixedIncomeData {
  bonds: BondHolding[];
  totalBondValue: number;
  portfolioValue: number;
  bondAllocationPct: number;
  weightedAvgDuration: number | null;
  creditBreakdown: { rating: string; weight: number }[];
}

/**
 * Fixed Income Exposure card — shows bond allocation, weighted average duration,
 * credit quality breakdown, and individual bond positions.
 * Only renders if portfolio has bond positions.
 */
export function FixedIncomeCard({ scope }: { scope?: string }) {
  const [data, setData] = useState<FixedIncomeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/compute/fixed-income${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data.bonds.length > 0) setData(json.data);
        else setData(null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) return null;
  if (!data) {
    return (
      <EmptySection
        title="Fixed Income Exposure"
        reason="No bond positions in this scope."
        hint="Bond duration, credit quality, and rate-sensitivity metrics appear once you hold treasuries, corporates, or municipals. Bond ETFs (AGG, BND, etc.) classify as ETFs by default — see Bond duration backfill in Stream D4 for held bonds with missing duration data."
      />
    );
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
      <h3 className="text-sm font-medium text-ink">Fixed Income Exposure</h3>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCell
          label="Bond Allocation"
          value={<Pct value={data.bondAllocationPct} digits={1} />}
          subtext={
            <PrivateText>
              {`$${(data.totalBondValue / 1000).toFixed(0)}K of $${(data.portfolioValue / 1000).toFixed(0)}K`}
            </PrivateText>
          }
        />
        <MetricCell
          label="Weighted Avg Duration"
          value={
            data.weightedAvgDuration != null
              ? `${data.weightedAvgDuration.toFixed(1)} yr`
              : "N/A"
          }
          subtext={
            data.weightedAvgDuration != null ? (
              <span className={toneClass(interpretDuration(data.weightedAvgDuration).tone)}>
                {interpretDuration(data.weightedAvgDuration).text}
              </span>
            ) : (
              "No duration data"
            )
          }
        />
        <MetricCell
          label="Positions"
          value={String(data.bonds.length)}
          subtext="bond holdings"
        />
        <MetricCell
          label="Rate Sensitivity"
          value={
            data.weightedAvgDuration != null
              ? `${(data.weightedAvgDuration * data.bondAllocationPct / 100).toFixed(2)} yr`
              : "N/A"
          }
          subtext={
            data.weightedAvgDuration != null ? (
              <span
                className={toneClass(
                  interpretPortfolioRateSensitivity(
                    (data.weightedAvgDuration * data.bondAllocationPct) / 100,
                  ).tone,
                )}
              >
                {
                  interpretPortfolioRateSensitivity(
                    (data.weightedAvgDuration * data.bondAllocationPct) / 100,
                  ).text
                }
              </span>
            ) : (
              "portfolio duration contribution"
            )
          }
        />
      </div>

      {/* Credit quality breakdown */}
      {data.creditBreakdown.length > 0 && (
        <div>
          <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-2">
            Credit Quality
          </h4>
          <div className="flex gap-1 h-3 rounded-full overflow-hidden">
            {data.creditBreakdown.map((bucket) => (
              <div
                key={bucket.rating}
                className="h-full transition-all"
                style={{
                  width: `${bucket.weight * 100}%`,
                  backgroundColor: creditColor(bucket.rating),
                }}
                title={`${bucket.rating}: ${(bucket.weight * 100).toFixed(0)}%`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {data.creditBreakdown.map((bucket) => (
              <div key={bucket.rating} className="flex items-center gap-1.5 text-xs">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: creditColor(bucket.rating) }}
                />
                <span className="text-ink-dim">
                  {bucket.rating}: <Pct value={bucket.weight * 100} digits={0} className="font-mono text-ink" />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bond positions table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-edge text-ink-faint">
              <th className="text-left py-1.5 pr-3 font-medium">Symbol</th>
              <th className="text-right py-1.5 pr-3 font-medium">Value</th>
              <th className="text-right py-1.5 pr-3 font-medium">Duration</th>
              <th className="text-center py-1.5 pr-3 font-medium">Rating</th>
              <th className="text-right py-1.5 font-medium">Maturity</th>
            </tr>
          </thead>
          <tbody>
            {data.bonds.map((bond) => (
              <tr key={bond.symbol} className="border-b border-edge/50 last:border-0">
                <td className="py-1.5 pr-3">
                  <span className="font-mono font-medium text-ink">{bond.symbol}</span>
                  {bond.name && (
                    <span className="text-ink-faint ml-1.5">{bond.name}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-ink tabular-nums">
                  <PrivateText>{`$${(bond.marketValue / 1000).toFixed(0)}K`}</PrivateText>
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-ink-dim tabular-nums">
                  {bond.durationYears != null ? `${bond.durationYears.toFixed(1)} yr` : "—"}
                </td>
                <td className="py-1.5 pr-3 text-center">
                  {bond.creditRating ? (
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: creditColor(bond.creditRating) + "20",
                        color: creditColor(bond.creditRating),
                      }}
                    >
                      {bond.creditRating}
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="py-1.5 text-right font-mono text-ink-faint tabular-nums">
                  {bond.maturityDate ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  subtext,
}: {
  label: string;
  value: ReactNode;
  subtext: ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-0.5">
        {label}
      </div>
      <div className="text-sm font-mono font-medium text-ink tabular-nums">
        {value}
      </div>
      <div className="text-[10px] text-ink-faint">{subtext}</div>
    </div>
  );
}

function creditColor(rating: string): string {
  if (rating.startsWith("AAA")) return "#34D399"; // emerald
  if (rating.startsWith("AA")) return "#60A5FA";  // blue
  if (rating.startsWith("A")) return "#C9A44E";   // gold
  if (rating.startsWith("BBB")) return "#FB923C"; // orange
  return "#F87171"; // rose (below investment grade)
}
