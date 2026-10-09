"use client";

import { useState, useEffect, type ReactNode } from "react";
import { Count, Pct, PrivateText } from "@/lib/privacy/components";
import type { BondUnmodelledReason, RateDurationSource } from "@/lib/compute/bond-duration";
import { formatCompactUSD } from "@/lib/format";
import { EmptySection } from "./EmptySection";
import { ScrollFade } from "./ScrollFade";
import {
  interpretDuration,
  interpretPortfolioRateSensitivity,
  toneClass,
} from "@/lib/analysis/interpret";

interface BondHolding {
  symbol: string;
  name: string | null;
  marketValue: number;
  /** The duration the scenario rate move uses for this bond; null when it is not modelled. */
  durationYears: number | null;
  durationSource?: RateDurationSource | null;
  unmodelledReason?: BondUnmodelledReason | null;
  creditRating: string | null;
  couponRate: number | null;
  maturityDate: string | null;
}

interface FixedIncomeData {
  bonds: BondHolding[];
  totalBondValue: number;
  measuredBondValue?: number;
  unmeasuredBondValue?: number;
  unmeasuredBondCount?: number;
  portfolioValue: number;
  bondAllocationPct: number;
  weightedAvgDuration: number | null;
  creditBreakdown: { rating: string; weight: number }[];
}

/**
 * Does any bond in the card carry a credit rating? While none does, the
 * Credit Quality readout could only say "Unrated: 100%" — over a sleeve of
 * US Treasuries that reads as a statement about the bonds, when it is only
 * a statement about missing data. Owner ruling (option 3): hide the readout
 * until a rating is stored
 * [qa:analysis-credit-rating--single-unrated-bucket-treasuries-unrated-regression-1].
 */
export function hasRatedBond(
  bonds: ReadonlyArray<{ creditRating: string | null }>,
): boolean {
  return bonds.some((b) => b.creditRating != null && b.creditRating.trim() !== "");
}

/**
 * How one bond's duration reads on the card. The figure is the one the
 * scenario rate move uses (lib/compute/bond-duration.ts), so the card and a
 * scenario can never show two durations for one bond.
 *   - a stored duration: the figure, no mark;
 *   - a duration worked out from the bond's own maturity, coupon and price:
 *     the figure marked "est." with a short note saying what it came from;
 *   - a bond that cannot be modelled: no figure, and the missing input named.
 *     Nothing is ever assumed for it.
 */
export function describeBondDuration(bond: {
  durationYears: number | null;
  durationSource?: RateDurationSource | null;
  unmodelledReason?: BondUnmodelledReason | null;
}): { modelled: boolean; derived: boolean; note: string | null } {
  if (bond.durationYears == null || !Number.isFinite(bond.durationYears)) {
    return { modelled: false, derived: false, note: unmodelledNote(bond.unmodelledReason ?? null) };
  }
  switch (bond.durationSource) {
    case "bill-maturity":
      return { modelled: true, derived: true, note: "pays no coupon: time to maturity" };
    case "single-flow":
      return { modelled: true, derived: true, note: "one payment left: time to maturity" };
    case "coupon-yield":
      return { modelled: true, derived: true, note: "from coupon, maturity and price" };
    case "coupon-yield-name":
      return { modelled: true, derived: true, note: "from price and the coupon in the bond's name" };
    default:
      return { modelled: true, derived: false, note: null };
  }
}

/** Same wording as the scenario card's list of bonds it left out. */
function unmodelledNote(reason: BondUnmodelledReason | null): string {
  switch (reason) {
    case "no-maturity":
      return "no maturity date";
    case "matured":
      return "past its maturity date";
    case "no-coupon":
      return "no coupon from the broker, and none readable in the bond's name";
    case "unusable-coupon":
      return "the stored coupon is not a usable figure";
    case "no-price":
      return "no price";
    case "no-yield":
      return "price gives no usable yield";
    default:
      return "no duration data";
  }
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
        hint="Bond duration, credit quality, and rate-sensitivity metrics appear once you hold treasuries, corporates, or municipals. Bond ETFs (AGG, BND, etc.) classify as ETFs by default, so they are not counted here."
      />
    );
  }

  // The weighted average covers only bonds with duration data; the rate
  // sensitivity therefore weights by the MEASURED sleeve's portfolio share
  // (duration × measured/portfolio), never the full bond allocation — the
  // unmeasured bonds' contribution is unknown, not zero.
  const measuredValue = data.measuredBondValue ?? data.totalBondValue;
  const unmeasuredValue = data.unmeasuredBondValue ?? 0;
  const unmeasuredPct =
    data.totalBondValue > 0 ? (unmeasuredValue / data.totalBondValue) * 100 : 0;
  const unmeasuredCount =
    data.unmeasuredBondCount ?? data.bonds.filter((b) => !describeBondDuration(b).modelled).length;
  const anyDerived = data.bonds.some((b) => describeBondDuration(b).derived);
  const rateSensitivity =
    data.weightedAvgDuration != null && data.portfolioValue > 0
      ? data.weightedAvgDuration * (measuredValue / data.portfolioValue)
      : null;

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
              {`${formatCompactUSD(data.totalBondValue)} of ${formatCompactUSD(data.portfolioValue)}`}
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
              <>
                <span className={toneClass(interpretDuration(data.weightedAvgDuration).tone)}>
                  {interpretDuration(data.weightedAvgDuration).text}
                </span>
                {unmeasuredCount > 0 && (
                  <span className="block text-warn">
                    leaves out <Count value={unmeasuredCount} />{" "}
                    {unmeasuredCount === 1 ? "bond" : "bonds"} not modelled (
                    <Pct value={unmeasuredPct} digits={0} /> of bond value)
                  </span>
                )}
              </>
            ) : (
              "No bond could be modelled"
            )
          }
        />
        <MetricCell
          label="Positions"
          value={<Count value={data.bonds.length} />}
          subtext={
            unmeasuredCount > 0 ? (
              <>
                bond holdings, <Count value={unmeasuredCount} /> not modelled
              </>
            ) : (
              "bond holdings"
            )
          }
        />
        <MetricCell
          label="Rate Sensitivity"
          value={rateSensitivity != null ? `${rateSensitivity.toFixed(2)} yr` : "N/A"}
          subtext={
            rateSensitivity != null ? (
              <span
                className={toneClass(
                  interpretPortfolioRateSensitivity(rateSensitivity).tone,
                )}
              >
                {interpretPortfolioRateSensitivity(rateSensitivity).text}
              </span>
            ) : (
              "portfolio duration contribution"
            )
          }
        />
      </div>

      {/* Credit quality breakdown — only once some bond carries a rating */}
      {hasRatedBond(data.bonds) && data.creditBreakdown.length > 0 && (
        <div>
          <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-2">
            Credit Quality
          </h4>
          <div className="flex gap-1 h-3 rounded-full overflow-hidden">
            {data.creditBreakdown.map((bucket) => (
              <div
                key={bucket.rating}
                className="h-full transition-[width,background-color]"
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
      <ScrollFade>
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
            {data.bonds.map((bond) => {
              const duration = describeBondDuration(bond);
              return (
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
                <td className="py-1.5 pr-3 text-right text-ink-dim">
                  {duration.modelled && bond.durationYears != null ? (
                    <>
                      <span className="font-mono tabular-nums whitespace-nowrap">
                        {`${bond.durationYears.toFixed(1)} yr`}
                        {duration.derived && <span className="font-sans text-ink-dim"> est.</span>}
                      </span>
                      {duration.note && (
                        <span className="block text-[10px] text-ink-dim">{duration.note}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-warn whitespace-nowrap">not modelled</span>
                      {duration.note && (
                        <span className="block text-[10px] text-ink-dim">{duration.note}</span>
                      )}
                    </>
                  )}
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
              );
            })}
          </tbody>
        </table>
      </ScrollFade>

      {(anyDerived || unmeasuredCount > 0) && (
        <p className="text-[11px] text-ink-dim leading-relaxed">
          {anyDerived &&
            "A duration marked est. is worked out from the bond's own maturity, coupon and price. It is the same figure the scenario rate move uses. "}
          {unmeasuredCount > 0 &&
            "A bond marked not modelled is missing an input; no duration is assumed for it, and it is left out of the average and of rate sensitivity."}
        </p>
      )}
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
