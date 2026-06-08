/**
 * Canonical benchmark ETF universe — single source of truth.
 *
 * Imported by both the TWS historical fetch (`lib/tws/benchmark.ts`) and the
 * TWS-free Yahoo top-off (`lib/benchmark/yahoo-benchmarks.ts`) so the two
 * benchmark-price paths can never drift. Kept in its own lightweight module so
 * the Yahoo path doesn't transitively pull in `@stoqey/ib`.
 */
export const BENCHMARK_SYMBOLS = [
  "SPY",
  "QQQ",
  "DIA",
  "VTI",
  "MTUM",
  "SPMO",
  "USMV",
] as const;
export type BenchmarkSymbol = (typeof BENCHMARK_SYMBOLS)[number];

export const BENCHMARK_LABELS: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  DIA: "Dow Jones",
  VTI: "Total Market",
  MTUM: "MSCI Momentum",
  SPMO: "S&P 500 Momentum",
  USMV: "Min Volatility",
};
