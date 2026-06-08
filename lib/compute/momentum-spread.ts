import type Database from "better-sqlite3";

export type MomentumStatus = "leading" | "neutral" | "weakening" | "sell_off" | "insufficient_data";

/** The lookback window that drove the headline status (priority 1d → 5d → 30d). */
export type MomentumWindow = "1d" | "5d" | "30d";

export interface MomentumSpread {
  return30d: number;
  return5d: number;
  return1d: number;
}

export interface MomentumPulse {
  spreads: {
    mtum_vs_spy: MomentumSpread;
    spmo_vs_spy: MomentumSpread;
    usmv_vs_spy: MomentumSpread;
  };
  status: MomentumStatus;
  /** The window that drove `status` — surfaced as the tile subtitle's frame. */
  trigger: MomentumWindow;
  reason: string;
  asOf: string;
}

const STALE_DAYS = 4;
const MIN_HISTORY_DAYS = 30;

// Classification thresholds for the MTUM-vs-SPY spread. The ladder is evaluated
// shortest window first (1d → 5d → 30d) so a sharp regime flip surfaces as the
// headline instead of being masked by a still-positive 30-day trend; the first
// window to cross its gate wins. Tunable.
const SHOCK_1D = 0.02; // ±2% single-day MTUM-vs-SPY → regime shock
const SELLOFF_5D = -0.025;
const WEAKENING_5D = -0.015;
const LEADING_5D = 0.015;
const SELLOFF_30D = -0.03;
const LEADING_30D = 0.01;

interface PriceRow {
  date: string;
  close_price: number;
}

function loadBenchmark(db: Database.Database, symbol: string): PriceRow[] {
  return db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? ORDER BY date ASC`,
    )
    .all(symbol) as PriceRow[];
}

function priceMap(rows: PriceRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.date, r.close_price);
  return m;
}

function periodReturn(prices: Map<string, number>, days: number, dates: string[]): number | null {
  if (dates.length < days + 1) return null;
  const last = prices.get(dates[dates.length - 1]);
  const start = prices.get(dates[dates.length - 1 - days]);
  if (!last || !start || start <= 0) return null;
  return last / start - 1;
}

function spreadFromPrices(
  numerator: Map<string, number>,
  denominator: Map<string, number>,
  alignedDates: string[],
): MomentumSpread | null {
  const r30Num = periodReturn(numerator, 30, alignedDates);
  const r30Den = periodReturn(denominator, 30, alignedDates);
  const r5Num = periodReturn(numerator, 5, alignedDates);
  const r5Den = periodReturn(denominator, 5, alignedDates);
  const r1Num = periodReturn(numerator, 1, alignedDates);
  const r1Den = periodReturn(denominator, 1, alignedDates);

  if (
    r30Num === null || r30Den === null ||
    r5Num === null || r5Den === null ||
    r1Num === null || r1Den === null
  ) {
    return null;
  }

  return {
    return30d: r30Num - r30Den,
    return5d: r5Num - r5Den,
    return1d: r1Num - r1Den,
  };
}

function isStale(latestDate: string): boolean {
  const latest = new Date(latestDate + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - latest.getTime()) / 86_400_000);
  return days > STALE_DAYS;
}

const TIME_PHRASE: Record<MomentumWindow, string> = {
  "1d": "today",
  "5d": "this week",
  "30d": "over 30d",
};

const WINDOW_KEY: Record<MomentumWindow, keyof MomentumSpread> = {
  "1d": "return1d",
  "5d": "return5d",
  "30d": "return30d",
};

/**
 * Build the headline subtitle, leading with the MTUM-vs-SPY spread for the
 * window that triggered the status. When a short window triggers but the 30-day
 * trend disagrees in sign, append a "30d trend still ±X%" tail so the reader can
 * judge blip vs break. The SPMO confirmation / USMV defensive tell live in the
 * table, so the subtitle stays to one line.
 */
function formatReason(window: MomentumWindow, mtum: MomentumSpread): string {
  const key = WINDOW_KEY[window];
  let reason = `MTUM ${formatPct(mtum[key])} vs SPY ${TIME_PHRASE[window]}`;
  if (
    window !== "30d" &&
    mtum.return30d !== 0 &&
    Math.sign(mtum.return30d) !== Math.sign(mtum[key])
  ) {
    reason += ` · 30d trend still ${formatPct(mtum.return30d)}`;
  }
  return reason;
}

/**
 * Classify the momentum regime, evaluating the shortest window first so a sharp
 * 1-day or 1-week flip drives the headline even when the 30-day trend hasn't
 * turned. First window to cross its gate wins. MTUM-vs-SPY is the sole driver;
 * SPMO/USMV are shown alongside in the table as confirmation/defensive tells.
 */
function classifyStatus(mtum: MomentumSpread): {
  status: MomentumStatus;
  reason: string;
  trigger: MomentumWindow;
} {
  // 1-day shock — highest priority.
  if (mtum.return1d <= -SHOCK_1D) {
    return { status: "sell_off", trigger: "1d", reason: formatReason("1d", mtum) };
  }
  if (mtum.return1d >= SHOCK_1D) {
    return { status: "leading", trigger: "1d", reason: formatReason("1d", mtum) };
  }

  // 5-day short trend.
  if (mtum.return5d <= SELLOFF_5D) {
    return { status: "sell_off", trigger: "5d", reason: formatReason("5d", mtum) };
  }
  if (mtum.return5d <= WEAKENING_5D) {
    return { status: "weakening", trigger: "5d", reason: formatReason("5d", mtum) };
  }
  if (mtum.return5d >= LEADING_5D) {
    return { status: "leading", trigger: "5d", reason: formatReason("5d", mtum) };
  }

  // 30-day structural backdrop.
  if (mtum.return30d <= SELLOFF_30D) {
    return { status: "sell_off", trigger: "30d", reason: formatReason("30d", mtum) };
  }
  if (mtum.return30d >= LEADING_30D) {
    return { status: "leading", trigger: "30d", reason: formatReason("30d", mtum) };
  }
  return { status: "neutral", trigger: "30d", reason: formatReason("30d", mtum) };
}

function formatPct(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${(Math.abs(value) * 100).toFixed(1)}%`;
}

export function computeMomentumPulse(db: Database.Database): MomentumPulse | null {
  const spy = loadBenchmark(db, "SPY");
  const mtum = loadBenchmark(db, "MTUM");
  const spmo = loadBenchmark(db, "SPMO");
  const usmv = loadBenchmark(db, "USMV");

  if (
    spy.length < MIN_HISTORY_DAYS + 1 ||
    mtum.length < MIN_HISTORY_DAYS + 1 ||
    spmo.length < MIN_HISTORY_DAYS + 1 ||
    usmv.length < MIN_HISTORY_DAYS + 1
  ) {
    return null;
  }

  const spyMap = priceMap(spy);
  const mtumMap = priceMap(mtum);
  const spmoMap = priceMap(spmo);
  const usmvMap = priceMap(usmv);

  const alignedDates = spy
    .map((r) => r.date)
    .filter((d) => mtumMap.has(d) && spmoMap.has(d) && usmvMap.has(d))
    .sort();

  if (alignedDates.length < MIN_HISTORY_DAYS + 1) return null;

  const latestDate = alignedDates[alignedDates.length - 1];
  if (isStale(latestDate)) return null;

  const mtumSpread = spreadFromPrices(mtumMap, spyMap, alignedDates);
  const spmoSpread = spreadFromPrices(spmoMap, spyMap, alignedDates);
  const usmvSpread = spreadFromPrices(usmvMap, spyMap, alignedDates);

  if (!mtumSpread || !spmoSpread || !usmvSpread) return null;

  const { status, reason, trigger } = classifyStatus(mtumSpread);

  return {
    spreads: {
      mtum_vs_spy: mtumSpread,
      spmo_vs_spy: spmoSpread,
      usmv_vs_spy: usmvSpread,
    },
    status,
    trigger,
    reason,
    asOf: latestDate,
  };
}
