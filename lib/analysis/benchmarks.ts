/**
 * Per-scope default benchmark mapping — single source of truth.
 *
 * Vanguard accounts target VTI (total market), IBKR targets QQQ (active /
 * tech-heavy), Roth targets SPY (balanced), all targets SPY. Locked in the
 * Phase 5 IA decision; reused by FactorAnalysis card + Cash-Deploy solver.
 */
export const DEFAULT_BENCHMARK_BY_SCOPE: Record<string, string> = {
  vanguard: "VTI",
  ibkr: "QQQ",
  roth: "SPY",
  all: "SPY",
};

export const BENCHMARK_OPTIONS: { value: string; label: string }[] = [
  { value: "SPY", label: "SPY · S&P 500" },
  { value: "QQQ", label: "QQQ · Nasdaq 100" },
  { value: "VTI", label: "VTI · Total Market" },
  { value: "DIA", label: "DIA · Dow Jones" },
];

export function getDefaultBenchmark(scope: string | null | undefined): string {
  if (!scope) return "SPY";
  return DEFAULT_BENCHMARK_BY_SCOPE[scope] ?? "SPY";
}
