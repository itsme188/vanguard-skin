import type { ReactNode } from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { dataWindowNotice } from "@/lib/compute/data-window";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";
import type { DietzBand } from "@/lib/compute/dietz";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { resolveScope } from "@/lib/queries/accounts";
import { todayET } from "@/lib/calendar/date-utils";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { fetchNetFlowsByDate, fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";
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
import { curveFloorDate, firstStatementAnchorForCurve } from "@/lib/compute/equity-curve-floor";
import { PeriodAttributionSection } from "./PeriodAttributionSection";
import {
  resolvePerformanceWindow,
  latestStatementAnchor,
  newestStatementInScope,
  type PerformancePeriod,
} from "@/lib/compute/performance-window";
import {
  equityCurveOvershootClause,
  performanceCaptionMeasuredFrom,
} from "@/lib/compute/performance-window-caption";

// Same four band labels as TrustStripDrawer's chips — duplicated locally
// rather than imported (TrustStripDrawer is a "use client" module; this
// component is a server component, and the touch-list for this task doesn't
// include a shared non-client module to hoist these into). Keep in sync.
const BAND_LABEL: Record<DietzBand, string> = {
  consistent: "Consistent — method differences expected",
  investigate: "Investigate",
  not_comparable: "Not comparable",
  insufficient: "Insufficient data",
};

type Period = PerformancePeriod;

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
  // Every figure on this page takes the WHOLE scope (scopeAccountIds): the
  // TWR, the money-weighted return, the risk tiles, the curve and the
  // attribution. Nothing reads "the first account" of a scope. The one
  // per-account surface, the cross-check strip, shows only when the scope IS
  // one account (twrAccountId).
  const twrAccountId = scopeAccountIds?.length === 1 ? scopeAccountIds[0] : undefined;
  const twrAccountIds = scopeAccountIds && scopeAccountIds.length > 1 ? scopeAccountIds : undefined;

  const today = todayET();
  // ONE window for the whole page (lib/compute/performance-window.ts). A
  // fixed period (1Y / 3Y / 5Y) is the full span ending at the scope's last
  // statement anchor; YTD and All still run to today. The anchor is looked up
  // over the FULL scope (full coverage for a multi-account scope), never a
  // first-id collapse.
  const perfWindow = resolvePerformanceWindow(activePeriod, {
    today,
    lastStatementAnchor: latestStatementAnchor(db, scopeAccountIds, today),
    // Lets the caption say why a multi-account period ends early (an account
    // in the scope has no later statement).
    newestScopeStatement: newestStatementInScope(db, scopeAccountIds, today),
  });
  // The window's opening date: what the daily series (risk, curve, benchmark,
  // attribution) start on and what the "shorter than the selected period"
  // notices compare against.
  const startDate = perfWindow.startDate;
  // computeTwr / computeXirr read their start as the first day INSIDE the
  // window and open on the last statement strictly before it — see
  // PerformanceWindow.chainStartDate. Their end is bounded only for a
  // statement-anchored period; YTD / All keep the compute layer's own default.
  const chainStart = perfWindow.chainStartDate;
  const chainEnd = perfWindow.endsAtStatement ? perfWindow.endDate : undefined;
  // End of every daily series: the statement anchor for a fixed period, today
  // otherwise — so drawdown, Sharpe, the curve, the benchmark and the
  // attribution describe the same window as the TWR beside them.
  const dailyEnd = perfWindow.endDate;

  let twrResult: ReturnType<typeof computeTwr> | null = null;
  let xirrResult: ReturnType<typeof computeXirr> | null = null;
  let riskResult: ReturnType<typeof computeRiskMetrics> | null = null;
  let computeError: string | null = null;

  try {
    twrResult = computeTwr(db, {
      startDate: chainStart,
      endDate: chainEnd,
      accountId: twrAccountId,
      accountIds: twrAccountIds,
    });
    // One money-weighted return over the summed cash flows of every account
    // in the scope (undefined = all accounts), never the first account alone.
    xirrResult = computeXirr(db, { startDate: chainStart, endDate: chainEnd, accountIds: scopeAccountIds });
    // coverageFloor "scope", not the default "common" (2026-09-14 ruling,
    // docs/DECISIONS.md): this page shows ONE scope's tiles at a time and
    // never compares scopes against each other, so the cross-account floor
    // from 2026-08-19 — which belongs to the diagnostics comparison surface —
    // only threw away this scope's own earlier daily history and made the
    // risk caption below name a different account's start date than the
    // equity curve rendered beside it. Both captions read their own series'
    // first row, and those two series now share one coverage start.
    riskResult = computeRiskMetrics(db, {
      startDate,
      endDate: dailyEnd,
      // The whole scope. computeRiskMetrics sums the scope's accounts on
      // full-coverage days before any return math; for a one-account scope
      // this is the same series the single id gave.
      accountIds: scopeAccountIds,
      coverageFloor: "scope",
    });
  } catch (err) {
    computeError = err instanceof Error ? err.message : "Unable to compute performance";
  }

  // Built AFTER the return so it can name the date the return is actually
  // measured from: the same date the Period window card prints as Start. A
  // chain of stored monthly returns opens on the first day of its first
  // month, one day after the opening statement the window rule names; the
  // caption used to print the statement date beside a card printing the day
  // after. Caption only: no return figure changes.
  const windowCaption = performanceCaptionMeasuredFrom(
    activePeriod,
    perfWindow,
    twrResult?.measurementStartDate ?? null,
  );

  const totalReturnPct = twrResult?.totalReturn ?? null;
  const annualizedTwr = twrResult?.annualizedReturn ?? null;
  const xirrAnnualized = xirrResult?.xirr ?? null;

  // ── Reconciliation strip ────────────────────────────────────────
  // The cross-check is per account, so the strip shows only when the scope
  // is exactly one account: a check of one member is not a claim about a
  // wider scope.
  const accountId = twrAccountId;
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
  //
  // FLOOR (ruling 2026-09-02): the curve starts at the scope's first
  // statement anchor. A daily value dated before an account's first statement
  // is an estimate, and as the base day it put a fake step on the statement
  // day. The floor is looked up over the full scope.
  const curveFloor = firstStatementAnchorForCurve(db, scopeAccountIds, effectiveStart, dailyEnd);
  const curveSeriesStart = curveFloorDate(effectiveStart, curveFloor);
  // The WHOLE scope, summed (an empty id list = every account), for a named
  // scope of one account this is that account's own series.
  const dailyVals = getDailyValuationsForAccounts(db, scopeAccountIds ?? [], {
    startDate: curveSeriesStart,
    endDate: dailyEnd,
    fullCoverageOnly: true,
  });

  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
    )
    .all(BENCHMARK_SYMBOL, effectiveStart, dailyEnd) as { date: string; close_price: number }[];

  // Flow-adjusted, seam-bridged inputs for the portfolio leg of the curve —
  // same accountIds scope as the daily-valuation load above (scopeAccountIds:
  // undefined for "all", the resolved id list for a named scope), mirroring
  // computeRiskMetrics' pattern (lib/compute/risk.ts) exactly. Without this,
  // the curve plots raw total_value: a deposit/withdrawal reads as a market
  // move and an anchor-source handoff (statement<->Plaid<->TWS) reads as a
  // fake step (CLAUDE.md: "a metric must be invariant to depositing $1M and
  // buying nothing").
  // The flow/seam scope is the SERIES' scope: dailyVals sums every account
  // in scopeAccountIds, so the flows netted out of it are those accounts'.
  const flows =
    dailyVals.length >= 2
      ? fetchNetFlowsByDate(
          db,
          scopeAccountIds,
          dailyVals[0].valuation_date,
          dailyVals[dailyVals.length - 1].valuation_date,
        )
      : [];
  const seamDates =
    dailyVals.length >= 2
      ? fetchAnchorSourceSeamDates(
          db,
          scopeAccountIds,
          dailyVals[0].valuation_date,
          dailyVals[dailyVals.length - 1].valuation_date,
        )
      : [];

  // Both series indexed to 100 at the first PLOTTED date (pure helper —
  // basing the benchmark at the selected-period start let SPY carry
  // pre-window returns and contradict the alpha card on the same page).
  const equityCurveData: PerformanceCurveData[] = buildEquityCurveData(
    dailyVals,
    benchmarkRows,
    flows,
    seamDates,
    curveFloor,
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
      dailyEnd,
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
          {/* Names a fixed period's end date: 1Y / 3Y / 5Y end at the last
              statement, not today (dates only, no portfolio figure). */}
          {windowCaption && (
            <p className="text-xs text-ink-dim mt-1">{windowCaption}</p>
          )}
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
            aria-current={activeScope === s.key ? "true" : undefined}
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
          {/* Cross-check disclosure strip — the detailed per-month banding
              (consistent / investigate / not_comparable / insufficient)
              lives in the trust drawer (TrustStripDrawer's Performance
              panel), which is on the Workspace view and NOT on this one; this
              strip is a lightweight pointer there, not a duplicate of the
              band logic, so its copy names the Workspace view and the strip
              cell that opens the drawer. divergenceBp is a portfolio-
              derived return figure, so it's masked through <Pct> like
              statementTwr/dietzReturn are everywhere else — never a raw
              unmasked bp span (see TrustStripDrawer for why it's shown at
              its %-point value rather than glued to a "bp" suffix).
              "Cross-checked through {month}" is a TRUST CLAIM about that
              month specifically — it may only be made when that month's own
              band is "consistent". A month that came back investigate/
              insufficient/not_comparable renders a band-neutral line naming
              its actual band instead (never silently implying agreement on
              a month that failed the check). */}
          {reconciliation && (
            <section className="rounded-xl p-3 px-4 text-sm flex items-center gap-2 flex-wrap bg-raised text-ink-dim border border-edge">
              <span>
                {reconciliation.band === "consistent" ? (
                  <>
                    Independently cross-checked (Modified Dietz) through{" "}
                    <strong className="text-ink">{reconciliation.monthEndDate}</strong> — bands shown per month in the trust drawer on the Workspace view (open its “Cross-checked (Modified Dietz)” cell).
                  </>
                ) : (
                  <>
                    Latest independent check for <strong className="text-ink">{reconciliation.monthEndDate}</strong>: {BAND_LABEL[reconciliation.band]} — bands shown per month in the trust drawer on the Workspace view (open its “Cross-checked (Modified Dietz)” cell).
                  </>
                )}
              </span>
              {reconciliation.divergenceBp !== null && (
                <span className="font-mono tabular-nums text-xs text-ink-faint">
                  (gap <Pct value={reconciliation.divergenceBp / 100} digits={2} signed />)
                </span>
              )}
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
                      ≈ <Pct value={annualizedTwr * 100} digits={2} signed /> annualized
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
            {/* Honest labeling: drawdown/Sharpe come from daily_valuations,
                whose history is shorter than the longest selectable period,
                so under 3Y/All they compute over a shorter window than the
                label implies — say so instead of letting the label imply
                otherwise. The window is this SCOPE's own coverage
                (coverageFloor "scope" above), which is the same coverage the
                equity curve below plots, so the two captions agree. TWR/XIRR
                read multi-year monthly_snapshots and are unaffected. */}
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
                {/* measurementStartDate, not startDate: the chained return
                    opens at the prior month-end close, so that — not the
                    first in-window snapshot — is the date this card, its
                    Days cell and the annualized figures above all share.
                    Pairing startDate with an annualized figure is the
                    2026-09-02 QA defect (card 181 days, figure implied 211). */}
                <dd className="text-ink font-mono">{fmtDate(twrResult?.measurementStartDate)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">End</dt>
                <dd className="text-ink font-mono">{fmtDate(twrResult?.endDate)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">Days</dt>
                {/* totalDays = Start (the measurement anchor) → End, and the
                    denominator annualize() divides by. One window across all
                    three cells and the annualized figures. */}
                <dd className="text-ink font-mono">{twrResult?.totalDays ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-widest text-ink-faint">Cash flows</dt>
                <dd className="text-ink font-mono">{xirrResult?.cashFlowCount ?? "—"}</dd>
              </div>
            </dl>
            {/* Only when the chain really does open before the first
                in-window snapshot — when the requested start already lands
                on an anchor (e.g. 5Y) the two dates coincide and the
                caption would be noise. */}
            {twrResult && twrResult.measurementStartDate !== twrResult.startDate && (
              <p className="mt-3 text-xs text-ink-faint">
                Chained from the prior month-end anchor — Start, Days and the annualized figures
                all describe that window.
              </p>
            )}
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
                            should be visibly different, not implied equal.
                            Anchored the same way as the Period window card,
                            because it labels the annualized column beside it. */}
                        <div className="text-[11px] text-ink-faint font-mono">
                          {fmtMonthYear(acc.measurementStartDate)} – {fmtMonthYear(acc.endDate)}
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
                // daily_valuations, whose coverage starts well after the
                // longest selectable period regardless of the selection.
                // Computed from the curve's own rows — the same scope
                // coverage the risk caption above now reports.
                // The two windows can still differ honestly: the risk tiles
                // read every daily valuation, the curve plots only the days
                // that ALSO have a benchmark close (buildEquityCurveData), so
                // it can open later or stop earlier. The caption therefore
                // names its metric, and when its window is not the risk
                // tiles' window it says why and names theirs — never two
                // identically worded captions with different dates.
                const curveStart = equityCurveData[0]?.date ?? null;
                const curveEnd = equityCurveData[equityCurveData.length - 1]?.date ?? null;
                const notice = dataWindowNotice(startDate, curveStart, curveEnd);
                const riskStart = riskResult?.seriesStart ?? null;
                const riskEnd = riskResult?.seriesEnd ?? null;
                const curveWindowDiffers =
                  riskStart !== null &&
                  riskEnd !== null &&
                  (riskStart !== curveStart || riskEnd !== curveEnd);
                // The curve is floored at the first statement; the risk tiles
                // are not (their series is untouched). When daily values
                // exist before that statement, that is why the two windows
                // differ, and the caption must not blame the benchmark.
                const flooredAtStatement =
                  curveFloor !== null && riskStart !== null && riskStart < curveFloor;
                // The END side: the curve keeps every daily point the book
                // has, so it can run past the Period window card's End (the
                // last month-end anchor the TWR chain reaches). Say so rather
                // than leave two end dates for one window on the same page.
                const windowEnd = twrResult?.endDate ?? null;
                const runsPastWindow = curveEnd !== null && windowEnd !== null && curveEnd > windowEnd;
                return notice || runsPastWindow ? (
                  <p className="text-xs text-ink-faint -mt-2">
                    {notice && (
                      <>
                        Equity curve: {notice.charAt(0).toLowerCase() + notice.slice(1)}
                        {curveWindowDiffers && (
                          <>
                            {flooredAtStatement ? (
                              <>
                                . It starts at this scope’s first statement ({fmtDate(curveFloor ?? undefined)}):
                                daily values before a first statement are estimates and are not
                                plotted. It also plots only days that have a {BENCHMARK_SYMBOL} close
                              </>
                            ) : (
                              <>. It plots only days that also have a {BENCHMARK_SYMBOL} close</>
                            )}
                            ; the daily valuations behind Max drawdown &amp; Sharpe run{" "}
                            {fmtDate(riskStart ?? undefined)} – {fmtDate(riskEnd ?? undefined)}
                          </>
                        )}
                      </>
                    )}
                    {runsPastWindow &&
                      curveStart !== null &&
                      equityCurveOvershootClause({
                        afterNotice: notice !== null,
                        curveStart,
                        curveEnd,
                        windowEnd,
                      })}
                  </p>
                ) : null;
              })()}
            </>
          )}

          {attribution && (
            <PeriodAttributionSection
              attribution={attribution}
              benchmarkSymbol={BENCHMARK_SYMBOL}
              requestedStart={startDate}
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
