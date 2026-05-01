import type Database from "better-sqlite3";

export type MomentumStatus = "leading" | "neutral" | "weakening" | "sell_off" | "insufficient_data";

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
  reason: string;
  asOf: string;
}

const STALE_DAYS = 4;
const MIN_HISTORY_DAYS = 30;

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

function classifyStatus(
  mtum: MomentumSpread,
  spmo: MomentumSpread,
  usmv: MomentumSpread,
): { status: MomentumStatus; reason: string } {
  const sellOffByMonth = mtum.return30d < -0.03;
  const sellOffByWeekWithDefensiveBid = mtum.return5d < -0.025 && usmv.return5d > 0.01;

  if (sellOffByMonth || sellOffByWeekWithDefensiveBid) {
    const parts: string[] = [`MTUM ${formatPct(mtum.return30d)} vs SPY · 30d`];
    if (spmo.return30d < -0.01) parts.push(`SPMO ${formatPct(spmo.return30d)} confirms`);
    if (usmv.return30d > 0.005) parts.push(`USMV ${formatPct(usmv.return30d)} (defensive bid)`);
    return { status: "sell_off", reason: parts.join(" · ") };
  }

  if (mtum.return5d < -0.015 && mtum.return30d > 0) {
    return {
      status: "weakening",
      reason: `MTUM ${formatPct(mtum.return5d)} vs SPY · 5d (30d still positive)`,
    };
  }

  if (mtum.return30d > 0.01) {
    const parts: string[] = [`MTUM ${formatPct(mtum.return30d)} vs SPY · 30d`];
    if (spmo.return30d > 0.005) parts.push(`SPMO ${formatPct(spmo.return30d)} confirms`);
    return { status: "leading", reason: parts.join(" · ") };
  }

  return {
    status: "neutral",
    reason: `MTUM ${formatPct(mtum.return30d)} vs SPY · 30d`,
  };
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

  const { status, reason } = classifyStatus(mtumSpread, spmoSpread, usmvSpread);

  return {
    spreads: {
      mtum_vs_spy: mtumSpread,
      spmo_vs_spy: spmoSpread,
      usmv_vs_spy: usmvSpread,
    },
    status,
    reason,
    asOf: latestDate,
  };
}
