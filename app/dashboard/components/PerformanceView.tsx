import Link from "next/link";
import { db } from "@/lib/db";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";
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

function startDateForPeriod(period: Period): string | undefined {
  const today = new Date();
  if (period === "ytd") return `${today.getFullYear()}-01-01`;
  if (period === "1y") {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (period === "3y") {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - 3);
    return d.toISOString().slice(0, 10);
  }
  if (period === "5y") {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - 5);
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
  const accountId = activeScope === "all" ? undefined : resolveScopeToSingleId(db, activeScope);

  const startDate = startDateForPeriod(activePeriod);
  const today = new Date().toISOString().slice(0, 10);

  let twrResult: ReturnType<typeof computeTwr> | null = null;
  let xirrResult: ReturnType<typeof computeXirr> | null = null;
  let riskResult: ReturnType<typeof computeRiskMetrics> | null = null;
  let computeError: string | null = null;

  try {
    twrResult = computeTwr(db, { startDate, accountId });
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
  const dailyVals = accountId !== undefined
    ? getDailyValuationsByAccount(db, accountId, { startDate: effectiveStart, endDate: today })
    : getDailyValuationsCombined(db, { startDate: effectiveStart, endDate: today });

  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
    )
    .all(BENCHMARK_SYMBOL, effectiveStart, today) as { date: string; close_price: number }[];

  // Normalize both series to 100 at their respective first data point
  let equityCurveData: PerformanceCurveData[] = [];
  if (dailyVals.length >= 2 && benchmarkRows.length >= 2) {
    const portBase = dailyVals[0].total_value;
    const benchBase = benchmarkRows[0].close_price;
    const benchByDate = new Map(benchmarkRows.map((b) => [b.date, b.close_price]));

    equityCurveData = dailyVals
      .map((v) => {
        const benchPrice = benchByDate.get(v.valuation_date);
        if (benchPrice == null || portBase <= 0 || benchBase <= 0) return null;
        return {
          date: v.valuation_date,
          portfolio: (v.total_value / portBase) * 100,
          benchmark: (benchPrice / benchBase) * 100,
        };
      })
      .filter((d): d is PerformanceCurveData => d !== null);
  }

  // ── Period attribution ──────────────────────────────────────────
  // Use the first account in scope for attribution (position-level data).
  // When scope=all, resolveScope returns undefined (meaning "no filter"), so
  // we can't use it to pick an account. Instead, query directly for the first
  // account by ID as a stable fallback.
  const attrAccountId: number | undefined =
    accountId ??
    (() => {
      const row = db
        .prepare("SELECT id FROM accounts ORDER BY id LIMIT 1")
        .get() as { id: number } | undefined;
      return row?.id;
    })();

  let attribution: ReturnType<typeof computePeriodAttribution> | null = null;
  if (attrAccountId !== undefined) {
    try {
      attribution = computePeriodAttribution(
        db,
        attrAccountId,
        effectiveStart,
        today,
        BENCHMARK_SYMBOL,
      );
    } catch {
      // Non-blocking
    }
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
                  ? "bg-up/10 text-up border border-up/20"
                  : "bg-down/10 text-down border border-down/20"
              }`}
            >
              <span className="text-base">{reconciliation.withinTolerance ? "✓" : "⚠"}</span>
              <span>
                TWR reconciled to {reconciliation.source} statement through{" "}
                <strong>{reconciliation.periodEnd}</strong>
                {" · "}
                {reconciliation.withinTolerance ? (
                  <>
                    <strong>{reconciliation.divergenceBp > 0 ? "+" : ""}{reconciliation.divergenceBp} bp</strong>{" "}
                    within tolerance
                  </>
                ) : (
                  <>
                    <strong>{reconciliation.divergenceBp > 0 ? "+" : ""}{reconciliation.divergenceBp} bp</strong>{" "}
                    — outside tolerance · review data integrity
                  </>
                )}
              </span>
            </section>
          )}

          {/* KPI strip — 4 cells: TWR · XIRR · Max Drawdown · Sharpe */}
          <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
              <KpiCell
                label="TWR · annualized"
                value={annualizedTwr}
                kind="pct"
                title="Time-weighted return — manager-skill measure that strips out cash-flow timing."
              />
              <KpiCell
                label="MWR (XIRR)"
                value={xirrAnnualized}
                kind="pct"
                title="Money-weighted return — investor-experience measure that includes cash-flow timing."
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
                      <td className="py-2 text-ink">{acc.accountName}</td>
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
            <PerformanceCurveChart data={equityCurveData} benchmarkSymbol={BENCHMARK_SYMBOL} />
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
}: {
  label: string;
  value: number | null;
  kind: "pct" | "money" | "ratio";
  title?: string;
  sub?: Interpretation | null;
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
      {sub && (
        <p className={`text-xs mt-1 ${toneClass(sub.tone)}`}>{sub.text}</p>
      )}
    </div>
  );
}
