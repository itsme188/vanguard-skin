import { db } from "@/lib/db";
import { computeTwr } from "@/lib/compute/twr";
import { Pct } from "@/lib/privacy/components";

interface PeriodRow {
  label: string;
  portfolioReturn: number | null;
  benchmarkReturn: number | null;
  alpha: number | null;
}

function computeBenchmarkReturn(
  symbol: string,
  startDate: string | undefined,
  endDate: string
): number | null {
  const startRow = startDate
    ? (db
        .prepare(
          `SELECT date, close_price FROM benchmark_prices
           WHERE symbol = ? AND date >= ?
           ORDER BY date ASC LIMIT 1`
        )
        .get(symbol, startDate) as { date: string; close_price: number } | undefined)
    : (db
        .prepare(
          `SELECT date, close_price FROM benchmark_prices
           WHERE symbol = ?
           ORDER BY date ASC LIMIT 1`
        )
        .get(symbol) as { date: string; close_price: number } | undefined);

  const endRow = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date <= ?
       ORDER BY date DESC LIMIT 1`
    )
    .get(symbol, endDate) as { date: string; close_price: number } | undefined;

  if (!startRow || !endRow || startRow.close_price === 0) return null;
  // Quality gate: same-date match means only 1 data point — unreliable
  if (startRow.date === endRow.date) return null;
  return (endRow.close_price - startRow.close_price) / startRow.close_price;
}

function valueClass(value: number | null): string {
  if (value == null) return "text-ink-faint";
  return value >= 0 ? "text-up" : "text-down";
}

export function PeriodComparisonTable() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);

  const periods: { label: string; startDate: string | undefined }[] = [
    { label: "YTD", startDate: `${year}-01-01` },
    {
      label: "1Y",
      startDate: new Date(Date.now() - 365 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    },
    {
      label: "3Y",
      startDate: new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    },
    {
      label: "5Y",
      startDate: new Date(Date.now() - 5 * 365.25 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    },
    { label: "All", startDate: undefined },
  ];

  let rows: PeriodRow[];
  try {
    // Check if benchmark data exists
    const hasBenchmark = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM benchmark_prices WHERE symbol = 'SPY'"
      )
      .get() as { cnt: number };

    if (hasBenchmark.cnt === 0) {
      return (
        <div className="rounded-xl border border-dashed border-edge bg-panel p-6 text-center">
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-2">
            Performance vs Benchmark
          </h3>
          <p className="text-sm text-ink-faint">
            Sync benchmark prices via the TWS panel or the chart below to compare your portfolio against SPY.
          </p>
        </div>
      );
    }

    rows = periods.map(({ label, startDate }) => {
      const twr = computeTwr(db, { startDate: startDate ?? undefined, endDate: today });
      const portfolioReturn = twr?.totalReturn ?? null;
      const benchmarkReturn = computeBenchmarkReturn("SPY", startDate, today);
      const alpha =
        portfolioReturn != null && benchmarkReturn != null
          ? portfolioReturn - benchmarkReturn
          : null;

      return { label, portfolioReturn, benchmarkReturn, alpha };
    });
  } catch {
    return null;
  }

  // Don't render if no data at all
  if (rows.every((r) => r.portfolioReturn == null)) return null;

  return (
    <div className="rounded-xl border border-edge bg-panel overflow-hidden">
      <div className="px-5 py-3 border-b border-edge">
        <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
          Performance vs Benchmark (SPY)
        </h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-edge text-ink-faint text-xs">
            <th className="text-left px-5 py-2 font-medium">Period</th>
            <th className="text-right px-5 py-2 font-medium">Portfolio</th>
            <th className="text-right px-5 py-2 font-medium">SPY</th>
            <th className="text-right px-5 py-2 font-medium">Alpha</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className="border-b border-edge/50 last:border-0"
            >
              <td className="px-5 py-2.5 font-medium text-ink">
                {row.label}
              </td>
              <td
                className={`px-5 py-2.5 text-right font-mono tabular-nums ${valueClass(row.portfolioReturn)}`}
              >
                <Pct value={row.portfolioReturn != null ? row.portfolioReturn * 100 : null} digits={1} signed />
              </td>
              <td
                className={`px-5 py-2.5 text-right font-mono tabular-nums ${valueClass(row.benchmarkReturn)}`}
              >
                <Pct value={row.benchmarkReturn != null ? row.benchmarkReturn * 100 : null} digits={1} signed />
              </td>
              <td
                className={`px-5 py-2.5 text-right font-mono tabular-nums font-medium ${valueClass(row.alpha)}`}
              >
                <Pct value={row.alpha != null ? row.alpha * 100 : null} digits={1} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
