import Link from "next/link";
import { db } from "@/lib/db";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";
import { Money, Pct } from "@/lib/privacy/components";

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

export async function PerformanceView({ scope = "all", period }: PerformanceViewProps) {
  const activePeriod: Period = (PERIODS.find((p) => p.key === period)?.key ?? "ytd") as Period;
  const activeScope = SCOPES.find((s) => s.key === scope)?.key ?? "all";
  const accountId = activeScope === "all" ? undefined : resolveScopeToSingleId(db, activeScope);

  const startDate = startDateForPeriod(activePeriod);

  let twrResult: ReturnType<typeof computeTwr> | null = null;
  let xirrResult: ReturnType<typeof computeXirr> | null = null;
  let computeError: string | null = null;

  try {
    twrResult = computeTwr(db, { startDate, accountId });
    xirrResult = computeXirr(db, { startDate, accountId });
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
          {/* KPI strip */}
          <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
              <KpiCell
                label="TWR · annualized"
                value={annualizedTwr}
                kind="pct"
                title="Time-weighted return — manager-skill measure that strips out cash-flow timing."
              />
              <KpiCell
                label="XIRR · annualized"
                value={xirrAnnualized}
                kind="pct"
                title="Money-weighted return — investor-experience measure that includes cash-flow timing."
              />
              <KpiCell
                label="Total return"
                value={totalReturnPct}
                kind="pct"
                title="Cumulative TWR over the selected period (not annualized)."
              />
              <KpiCell
                label="Cumulative gain"
                value={cumulativeGain}
                kind="money"
                title="Net of deposits and withdrawals over the period."
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
}: {
  label: string;
  value: number | null;
  kind: "pct" | "money";
  title?: string;
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
        ) : (
          <Money value={value} signed />
        )}
      </p>
    </div>
  );
}
