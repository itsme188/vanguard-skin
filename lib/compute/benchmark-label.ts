/**
 * What the Performance view's benchmark is, in the owner's words: the ONE
 * copy of that label text (owner ruling 2026-11-15).
 *
 * The stored SPY series is a PRICE return: `benchmark_prices` holds TWS
 * TRADES bar closes (lib/tws/benchmark.ts) and the Yahoo quote close, not
 * the adjusted close (lib/benchmark/yahoo-benchmarks.ts). The portfolio's
 * return includes the dividends it was paid, so the benchmark line lags by
 * SPY's dividends and the alpha measured against it is overstated by about
 * beta times SPY's dividend yield per year. Until a total-return series is
 * stored (the later, real fix), every place the Performance view names the
 * benchmark says so. Switching to a total-return series is a change here.
 *
 * A plain module, never a client-component file: the server page and the client
 * chart both read it.
 */

/** The symbol whose stored closes the Performance view reads. */
export const BENCHMARK_SYMBOL = "SPY";

/** Short name for the benchmark series: legends, card headings, tooltips. */
export const BENCHMARK_RETURN_LABEL = `${BENCHMARK_SYMBOL} price return`;

/** Long name, where there is room to say what "price return" leaves out. */
export const BENCHMARK_RETURN_LABEL_LONG = `${BENCHMARK_SYMBOL}, price return, dividends not included`;

/** The one sentence shown beside alpha. No yield figure is hard-coded. */
export const ALPHA_PRICE_RETURN_NOTE =
  `Alpha is measured against ${BENCHMARK_SYMBOL}'s price return, which leaves out its dividends, ` +
  `so it is overstated by about the benchmark's dividend yield.`;
