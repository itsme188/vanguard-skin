import type { ReactNode } from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { dataWindowNotice } from "@/lib/compute/data-window";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { resolveScope } from "@/lib/queries/accounts";
import { todayET } from "@/lib/calendar/date-utils";
import { getDailyValuationsByAccount, getDailyValuationsCombined } from "@/lib/queries/daily-valuations";
import { Money, Pct } from "@/lib/privacy/components";
import { formatPercent } from "@/lib/format";
import {
  interpretSharpe,
  interpretMaxDrawdown,
  interpretTwrVsXirr,
  toneClass,
  type Interpretation,
} from "@/lib/analysis/interpret";
import { PerformanceCurveChart, type PerformanceCurveData } from "./EquityCurveChart";
import { buildEquityCurveData } from "@/lib/compute/equity-curve";
import { PeriodAttributionSection } from "./PeriodAttributionSection";

type Period = "ytd" | "1y" | "3y" | "5y" | "all";

const PERIODS: { key: Period; label: string }[] = [
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1Y" },
  { key: "3y", label: "3Y" },
  { key: "5y", label: "5Y" },
  { key: "all", label: "All" },
];

const SCOPES: { key: string; label: string }[] = [
  { key: "all", label: "All accounts" },
  { key: "vanguard", label: "Vanguard" },
  { key: "ibkr", label: "IBKR" },
  { key: "roth", label: "Roth" },
];

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

// Compact month+year window (e.g. "May 2023"), for the per-account coverage
// windows — a full day-level date would be noise there; the point is just
// to make a shorter account history visually distinct from the headline.
function fmtMonthYear(iso: string | undefined): string {
  if (!iso) return "—";
  const [y, m] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

// todayIso must be an ET calendar day (todayET()) — never a local/UTC
// `new Date()` slice. The arithmetic below then runs entirely in UTC (on a
// Date anchored at that ET day's midnight) so it never re-drifts across a
// day boundary depending on the machine's local timezone.
function startDateForPeriod(period: Period, todayIso: string): string | undefined {
  const today = new Date(todayIso + "T00:00:00Z");
  if (period === "ytd") return `${today.getUTCFullYear()}-01-01`;
  if (period === "1y") {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (period === "3y") {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - 3);
    return d.toISOString().slice(0, 10);
  }
  if (period === "5y") {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - 5);
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

interface PerformanceViewProps {
  scope?: string;
  period?: string;
}

const BENCHMARK_SYMBOL = "SPY";

export async function PerformanceView({ scope = "all", period }: PerformanceViewProps) {
  const activePeriod: Period = (PERIODS.find((p) => p.key === period)?.key ?? "ytd") as Period;
  const activeScope = SCOPES.find((s) => s.key === scope)?.key ?? "all";
  // Full scope, not a first-id collapse — resolveScopeToSingleId would
  // silently drop every account past the first from the TWR aggregate
  // chain (the resolveScopeToSingleId violation this fixes; scopes are
  // disjoint but not all 1-account, and must not be treated as if they were).
  const scopeAccountIds = activeScope === "all" ? undefined : resolveScope(db, activeScope);
  // computeXirr/computeRiskMetrics still take a single accountId — their
  // signature is unchanged (out of scope for this fix). Every scope today
  // resolves to exactly one account, so the first id is equivalent; this
  // only diverges once a named scope covers 2+ accounts.
  const accountId = scopeAccountIds?.[0];
  const twrAccountId = scopeAccountIds?.length === 1 ? scopeAccountIds[0] : undefined;
  const twrAccountIds = scopeAccountIds && scopeAccountIds.length > 1 ? scopeAccountIds : undefined;

  const today = todayET();
  const startDate = startDateForPeriod(activePeriod, today);

  let twrResult: ReturnType<typeof computeTwr> | null = null;
  let xirrResult: ReturnType<typeof computeXirr> | null = null;
  let riskResult: ReturnType<typeof computeRiskMetrics> | null = null;
  let computeError: string | null = null;

  try {
    twrResult = computeTwr(db, { startDate, accountId: twrAccountId, accountIds: twrAccountIds });
    xirrResult = computeXirr(db, { startDate, accountId });
    riskResult = computeRiskMetrics(db, { startDate, endDate: today, accountId });
  } catch (err) {
    computeError = err instanceof Error ? err.message : "Unable to compute performance";
  }

  const totalReturnPct = twrResult?.totalReturn ?? null;
  const annualizedTwr = twrResult?.annualizedReturn ?? null;
  const xirrAnnualized = xirrResult?.xirr ?? null;
  const cumulativeGain =
    xirrResult && xirrResult.totalInvested > 0
      ? xirrResult.currentValue + xirrResult.totalWithdrawn - xirrResult.totalInvested
      : null;

  // ── Reconciliation strip ────────────────────────────────────────
  // Use latest month-end we have for the scope's primary account
  let reconciliation: ReturnType<typeof reconcileTwrAgainstStatements> = null;
  if (accountId !== undefined) {
    try {
      const latestSnap = db
        .prepare(
          `SELECT month_end_date FROM monthly_snapshots
           WHERE account_id = ?
             AND source IN ('ibkr-activity', 'canonical', 'vanguard-pdf')
             AND twr IS NOT NULL
           ORDER BY month_end_date DESC LIMIT 1`,
        )
        .get(accountId) as { month_end_date: string } | undefined;
      if (latestSnap) {
        reconciliation = reconcileTwrAgainstStatements(db, accountId, latestSnap.month_end_date);
      }
    } catch {
      // Non-blocking — skip strip if reconciliation fails
    }
  }

  // ── Equity curve data ───────────────────────────────────────────
  const effectiveStart = startDate ?? "2000-01-01";
  // fullCoverageOnly: an indexed-to-100 curve is RETURN math, so the summed
  // multi-account series must not "gain" an appearing account's whole value
  // as a fake day (Apr 6 coverage onset read as +53%, contradicting the TWR
  // on the same screen). Same guard computeRiskMetrics/regression use; the
  // caption below self-adjusts because it reads the curve's own first row.
  const dailyVals = accountId !== undefined
    ? getDailyValuationsByAccount(db, accountId, { startDate: effectiveStart, endDate: today })
    : getDailyValuationsCombined(db, {
        startDate: effectiveStart,
        endDate: today,
        fullCoverageOnly: true,
      });

  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
    )
    .all(BENCHMARK_SYMBOL, effectiveStart, today) as { date: string; close_price: number }[];

  // Both series indexed to 100 at the first PLOTTED date (pure helper —
  // basing the benchmark at the selected-period start let SPY carry
  // pre-window returns and contradict the alpha card on the same page).
  const equityCurveData: PerformanceCurveData[] = buildEquityCurveData(
    dailyVals,
    benchmarkRows,
  );

  // ── Period attribution ──────────────────────────────────────────
  // Pass the FULL scope: resolveScope's id set for a named scope, undefined
  // (= whole portfolio) for "all". computePeriodAttribution aggregates
  // multi-account scopes internally — never hand it a single "first"
  // account (pre-fix, scope=all rendered account 1's beta/alpha labeled
  // "All accounts"; deep-QA finding 2026-06-11).
  let attribution: ReturnType<typeof computePeriodAttribution> | null = null;
  try {
    attribution = computePeriodAttribution(
      db,
      activeScope === "all" ? undefined : resolveScope(db, activeScope),
      effectiveStart,
      today,
      BENCHMARK_SYMBOL,
    );
  } catch {
    // Non-blocking
  }

  const buildHref = (next: { period?: Period; scope?: string }) => {
    const params = new URLSearchParams({
      view: "performance",
      scope: next.scope ?? activeScope,
      period: next.period ?? activePeriod,
    });
    return `/dashboard/analysis?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">Performance</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            Time-weighted (TWR) and money-weighted (XIRR) returns over selectable periods.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 self-start">
          {PERIODS.map((p) => (
            <Link
              key={p.key}
              href={buildHref({ period: p.key })}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activePeriod === p.key
                  ? "bg-panel text-ink shadow-sm"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 self-start w-fit">
        {SCOPES.map((s) => (
          <Link
            key={s.key}
            href={buildHref({ scope: s.key })}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeScope === s.key
                ? "bg-panel text-ink shadow-sm"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {s.label}
          </Link>
        ))}
      </div>

      {computeError ? (
        <section className="rounded-xl bg-panel p-5 card-elev">
          <p className="text-sm text-down">Compute error: {computeError}</p>
        </section>
      ) : (
        <>
          {/* Reconciliation strip */}
          {reconciliation && (
            <section
              className={`rounded-xl p-3 px-4 text-sm flex items-center gap-2 ${
                reconciliation.withinTolerance
                  ? "bg-raised text-ink-dim border border-edge"
                  : "bg-down/10 text-down border border-down/20"
              }`}
            >
              {!reconciliation.withinTolerance && <span className="text-base">⚠</span>}
              <span>
                {reconciliation.withinTolerance ? (
                  <>
                    TWR from {reconciliation.source} statement through{" "}
                    <strong>{reconciliation.periodEnd}</strong>
                    {" · "}
                    statement-reported — not independently verified
                  </>
                ) : (
                  <>
                    TWR reconciled to {reconciliation.source} statement through{" "}
                    <strong>{reconciliation.periodEnd}</strong>
                    {" · "}
                    <strong>{reconciliation.divergenceBp > 0 ? "+" : ""}{reconciliation.divergenceBp} bp</strong>{" "}
                    — outside tolerance · review data integrity · check statement import
                  </>
                )}
              </span>
            </section>
          )}

          {/* KPI strip — 4 cells: TWR · XIRR · Max Drawdown · Sharpe */}
          <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
              <KpiCell
                label={`TWR · ${PERIODS.find((p) => p.key === activePeriod)?.label ?? "period"}`}
                value={totalReturnPct}
                kind="pct"
                title="Time-weighted return over the selected period — manager-skill measure that strips out cash-flow timing."
                subNode={
                  annualizedTwr !== null ? (
                    <>
                      ≈ <Pct value={annualizedTwr * 100} digits={0} signed /> annualized
                    </>
                  ) : null
                }
              />
              <KpiCell
                label="MWR (XIRR) · annualized"
                value={xirrAnnualized}
                kind="pct"
                title="Money-weighted return, annualized by construction — investor-experience measure that includes cash-flow timing."
                sub={interpretTwrVsXirr(annualizedTwr, xirrAnnualized)}
              />
              <KpiCell
                label="Max drawdown"
                value={
                  riskResult?.maxDrawdown != null
                    ? -(riskResult.maxDrawdown.percent) // DrawdownInfo.percent is a decimal fraction (0-1); KpiCell with kind="pct"
                    // multiplies by 100 internally. Negate for display sign (shows as e.g. -12.34%).
                    : null
                }
                kind="pct"
                title="Largest peak-to-trough decline in portfolio value over the period."
                sub={
                  riskResult?.maxDrawdown != null
                    ? interpretMaxDrawdown(riskResult.maxDrawdown.percent)
                    : null
                }
              />
              <KpiCell
                label="Sharpe ratio"
                value={riskResult?.sharpeRatio ?? null}
                kind="ratio"
                title={`Risk-adjusted return. Risk-free rate: ${formatPercent((riskResult?.riskFreeRate ?? 0.045) * 100, 2)}.`}
                sub={
                  riskResult?.sharpeRatio != null
                    ? interpretSharpe(riskResult.sharpeRatio)
                    : null
                }
              />
            </div>
            {/* Aggregate disclosure: mirrors TwrResult.isPartial one level up —
                a statement-lag month got skipped from the headline's chained
                return (see snapshot-coverage.ts). Plain words only, no
                portfolio numbers. */}
            {twrResult?.isPartial && (
              <p className="text-xs text-ink-faint mt-3">
                TWR reflects partial coverage — some months were excluded from the chain.
              </p>
            )}
            {/* Honest labeling: drawdown/Sharpe come from daily_valuations
                (history starts 2026-03; risk further clamped to the
                all-accounts-covered floor), so under 3Y/All they compute
                over a much shorter window than the selected period — say so
                instead of letting the label imply otherwise. TWR/XIRR read
                multi-year monthly_snapshots and are unaffected. */}
            {(() => {
              const notice = dataWindowNotice(
                startDate,
                riskResult?.seriesStart ?? null,
                riskResult?.seriesEnd ?? null,
              );
              return notice ? (
                <p className="text-xs text-ink-faint mt-3">
                  Max drawdown &amp; Sharpe: {notice.charAt(0).toLowerCase() + notice.slice(1)}
                </p>
              ) : null;
            })()}
          </section>

          {/* Window summary */}
          <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
            <h3 className="text-sm font-medium text-ink mb-3">Period window</h3>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm">
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">Start</dt>
                <dd className="text-ink font-mono">{fmtDate(twrResult?.startDate)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">End</dt>
                <dd className="text-ink font-mono">{fmtDate(twrResult?.endDate)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">Days</dt>
                <dd className="text-ink font-mono">{twrResult?.totalDays ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">Cash flows</dt>
                <dd className="text-ink font-mono">{xirrResult?.cashFlowCount ?? "—"}</dd>
              </div>
            </dl>
            {twrResult?.perAccount.some((a) => a.isPartial) && (
              <p className="mt-3 text-[12px] text-ink-faint italic">
                Some months had to be skipped due to gaps in monthly snapshots — the TWR figure
                may understate the full period.
              </p>
            )}
          </section>

          {/* Per-account breakdown */}
          {twrResult && twrResult.perAccount.length > 1 && (
            <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
              <h3 className="text-sm font-medium text-ink mb-3">Per-account breakdown</h3>
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-widest text-ink-faint">
                  <tr className="border-b border-edge">
                    <th className="text-left font-medium pb-2">Account</th>
                    <th className="text-right font-medium pb-2">TWR · annualized</th>
                    <th className="text-right font-medium pb-2">Total return</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {twrResult.perAccount.map((acc) => (
                    <tr key={acc.accountId}>
                      <td className="py-2 text-ink">
                        <div>{acc.accountName}</div>
                        {/* Compact per-account coverage window — a shorter
                            account history next to a longer headline window
                            should be visibly different, not implied equal. */}
                        <div className="text-[11px] text-ink-faint font-mono">
                          {fmtMonthYear(acc.startDate)} – {fmtMonthYear(acc.endDate)}
                        </div>
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        <Pct
                          value={acc.annualizedReturn !== null ? acc.annualizedReturn * 100 : null}
                          digits={2}
                          signed
                        />
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        <Pct value={acc.totalReturn * 100} digits={2} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Equity curve with benchmark overlay */}
          {equityCurveData.length > 0 && (
            <>
              <PerformanceCurveChart data={equityCurveData} benchmarkSymbol={BENCHMARK_SYMBOL} />
              {(() => {
                // Same honesty caption as the KPI strip: the curve plots
                // daily_valuations, which start 2026-03 regardless of the
                // selected period (its floor differs slightly from risk's
                // full-coverage floor, so compute from the curve's own rows).
                const notice = dataWindowNotice(
                  startDate,
                  equityCurveData[0]?.date ?? null,
                  equityCurveData[equityCurveData.length - 1]?.date ?? null,
                );
                return notice ? (
                  <p className="text-xs text-ink-faint -mt-2">{notice}</p>
                ) : null;
              })()}
            </>
          )}

          {attribution && (
            <PeriodAttributionSection
              attribution={attribution}
              benchmarkSymbol={BENCHMARK_SYMBOL}
            />
          )}
        </>
      )}
    </div>
  );
}

function KpiCell({
  label,
  value,
  kind,
  title,
  sub,
  subNode,
}: {
  label: string;
  value: number | null;
  kind: "pct" | "money" | "ratio";
  title?: string;
  sub?: Interpretation | null;
  subNode?: ReactNode;
}) {
  const className =
    value === null
      ? "text-ink-faint"
      : value > 0
        ? "text-up"
        : value < 0
          ? "text-down"
          : "text-ink";

  return (
    <div title={title}>
      <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">{label}</p>
      <p className={`font-mono tabular-nums text-xl ${className}`}>
        {value === null ? (
          "—"
        ) : kind === "pct" ? (
          <Pct value={value * 100} digits={2} signed />
        ) : kind === "ratio" ? (
          value.toFixed(2)
        ) : (
          <Money value={value} signed />
        )}
      </p>
      {subNode && <p className="text-xs mt-1 text-ink-faint">{subNode}</p>}
      {sub && (
        <p className={`text-xs mt-1 ${toneClass(sub.tone)}`}>{sub.text}</p>
      )}
    </div>
  );
}
