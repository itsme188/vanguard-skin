import { db } from "@/lib/db";

interface MonthlyIncome {
  year: number;
  month: number;
  dividends: number;
  interest: number;
  total: number;
}

interface YearSummary {
  year: number;
  dividends: number;
  interest: number;
  total: number;
  months: MonthlyIncome[];
}

function getIncomeSummary(): YearSummary[] {
  const rows = db
    .prepare(
      `SELECT
        CAST(strftime('%Y', trade_date) AS INTEGER) AS year,
        CAST(strftime('%m', trade_date) AS INTEGER) AS month,
        COALESCE(SUM(CASE WHEN type = 'DIVIDEND' THEN ABS(amount) ELSE 0 END), 0) AS dividends,
        COALESCE(SUM(CASE WHEN type = 'INTEREST' THEN ABS(amount) ELSE 0 END), 0) AS interest
      FROM transactions
      WHERE type IN ('DIVIDEND', 'INTEREST')
        AND trade_date IS NOT NULL
        AND strftime('%Y', trade_date) >= '2020'
      GROUP BY year, month
      ORDER BY year DESC, month ASC`
    )
    .all() as { year: number; month: number; dividends: number; interest: number }[];

  // Group by year
  const yearMap = new Map<number, YearSummary>();
  for (const row of rows) {
    let summary = yearMap.get(row.year);
    if (!summary) {
      summary = { year: row.year, dividends: 0, interest: 0, total: 0, months: [] };
      yearMap.set(row.year, summary);
    }
    const monthly: MonthlyIncome = {
      year: row.year,
      month: row.month,
      dividends: row.dividends,
      interest: row.interest,
      total: row.dividends + row.interest,
    };
    summary.months.push(monthly);
    summary.dividends += row.dividends;
    summary.interest += row.interest;
    summary.total += monthly.total;
  }

  return Array.from(yearMap.values()).sort((a, b) => b.year - a.year);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

const MONTH_LABELS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

export function IncomeCard() {
  let years: YearSummary[];
  try {
    years = getIncomeSummary();
  } catch {
    return null;
  }

  if (years.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel p-5">
        <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
          Income
        </h3>
        <p className="text-sm text-ink-faint mt-2">
          No dividend or interest income recorded yet.
        </p>
      </div>
    );
  }

  const currentYear = years[0];
  const prevYear = years.find((y) => y.year === currentYear.year - 1);

  // Build a 12-month array for the current year mini-chart
  const monthlyData = Array.from({ length: 12 }, (_, i) => {
    const month = currentYear.months.find((m) => m.month === i + 1);
    return month?.total ?? 0;
  });
  const maxMonthly = Math.max(...monthlyData, 1);

  // YTD-over-YTD comparison (same months only)
  const currentMonth = new Date().getMonth() + 1; // 1-12
  const currentYtd = currentYear.months
    .filter((m) => m.month <= currentMonth)
    .reduce((sum, m) => sum + m.total, 0);
  const prevYtd = prevYear
    ? prevYear.months
        .filter((m) => m.month <= currentMonth)
        .reduce((sum, m) => sum + m.total, 0)
    : null;
  const yoyChange =
    prevYtd != null && prevYtd > 0
      ? ((currentYtd - prevYtd) / prevYtd) * 100
      : null;

  return (
    <div className="rounded-xl border border-edge bg-panel p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
            Income ({currentYear.year})
          </h3>
          <div className="text-2xl font-mono font-bold text-ink mt-1">
            {formatCurrency(currentYear.total)}
          </div>
        </div>
        {yoyChange !== null && (
          <span
            className={`text-xs font-mono font-medium px-2 py-1 rounded-lg ${
              yoyChange >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"
            }`}
          >
            {yoyChange >= 0 ? "+" : ""}
            {yoyChange.toFixed(1)}% vs {MONTH_LABELS[0]}-{MONTH_LABELS[currentMonth - 1]} {currentYear.year - 1}
          </span>
        )}
      </div>

      {/* Breakdown */}
      <div className="flex gap-6 text-xs">
        <div>
          <span className="text-ink-faint">Dividends</span>
          <div className="font-mono font-medium text-gold mt-0.5">
            {formatCurrency(currentYear.dividends)}
          </div>
        </div>
        <div>
          <span className="text-ink-faint">Interest</span>
          <div className="font-mono font-medium text-blue mt-0.5">
            {formatCurrency(currentYear.interest)}
          </div>
        </div>
        {prevYear && prevYtd != null && (
          <div>
            <span className="text-ink-faint">
              {MONTH_LABELS[0]}-{MONTH_LABELS[currentMonth - 1]} {prevYear.year}
            </span>
            <div className="font-mono font-medium text-ink-dim mt-0.5">
              {formatCurrency(prevYtd)}
            </div>
          </div>
        )}
      </div>

      {/* Monthly mini-chart */}
      <div className="flex items-end gap-1 h-12">
        {monthlyData.map((value, i) => {
          const currentMonth = new Date().getMonth();
          const isFuture = i > currentMonth && currentYear.year === new Date().getFullYear();
          const height = maxMonthly > 0 ? (value / maxMonthly) * 100 : 0;

          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div
                className={`w-full rounded-t-sm transition-all ${
                  isFuture
                    ? "bg-muted"
                    : value > 0
                      ? "bg-gold/60"
                      : "bg-muted/40"
                }`}
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${MONTH_LABELS[i]}: ${formatCurrency(value)}`}
              />
              <span className="text-[9px] text-ink-faint font-mono">
                {MONTH_LABELS[i]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
