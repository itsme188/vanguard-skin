import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import {
  computeBenchmarkRegression,
  computeDailyBarRegression,
  computeSecurityRegression,
  DAILY_BAR_MIN_PAIRS,
  DAILY_BAR_WINDOW_DAYS,
  isOutlierReturnPair,
  isUsSessionSecurity,
  MAX_RETURN_GAP_DAYS,
  MIN_SLOPE_T_STAT,
  OUTLIER_RESIDUAL_LOG_BOUND,
  SLOPE_T_STAT_CAP,
  slopeTStatistic,
} from "@/lib/compute/security-regression";

// Gains at risk addendum, Task A1: a regression whose BOTH legs are daily bars
// from ohlcv_bars, with a residual guard and explicit evidence. Synthetic ZZ
// tickers and round numbers only. Fixed clock: 2026-11-10 (Eastern).

const DRIVER_ID = 100;
const ZZA_ID = 1;
const N_BARS = 400;

function weekdaysEnding(last: string, count: number): string[] {
  const out: string[] = [];
  let d = last;
  while (out.length < count) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

/** Driver daily log return at step i (i >= 1): deterministic and varied. */
function driverStep(i: number): number {
  return 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7);
}

function cumulative(steps: (i: number) => number, n: number): number[] {
  const out = [0];
  for (let i = 1; i < n; i++) out.push(out[i - 1] + steps(i));
  return out;
}

/** Seeded standard normal draws (mulberry32 + Box-Muller). */
function gaussian(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    const u = Math.max(uniform(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function addSecurity(db: Database.Database, id: number, symbol: string, currency = "USD"): void {
  db.prepare(
    "INSERT INTO securities (id, symbol, security_type, currency) VALUES (?, ?, 'Stock', ?)",
  ).run(id, symbol, currency);
}

function insertBars(db: Database.Database, id: number, rows: { date: string; close: number }[]): void {
  const ins = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  for (const r of rows) ins.run(id, r.date, r.close, r.close, r.close, r.close);
}

describe("computeDailyBarRegression", () => {
  let db: Database.Database;
  let dates: string[];
  let driverCum: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    db = makeDb();
    dates = weekdaysEnding("2026-11-09", N_BARS);
    driverCum = cumulative(driverStep, N_BARS);
    addSecurity(db, DRIVER_ID, "ZZQ");
    addSecurity(db, ZZA_ID, "ZZA");
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function seedDriver(cum = driverCum): void {
    insertBars(db, DRIVER_ID, dates.map((date, i) => ({ date, close: 400 * Math.exp(cum[i]) })));
  }

  function seedMultiple(id: number, multiple: number, cum = driverCum): void {
    insertBars(db, id, dates.map((date, i) => ({ date, close: 100 * Math.exp(multiple * cum[i]) })));
  }

  it("exports the ruled constants", () => {
    expect(DAILY_BAR_WINDOW_DAYS).toBe(730);
    expect(DAILY_BAR_MIN_PAIRS).toBe(60);
    expect(MIN_SLOPE_T_STAT).toBe(2);
    expect(SLOPE_T_STAT_CAP).toBe(1e9);
    expect(OUTLIER_RESIDUAL_LOG_BOUND).toBe(0.35);
    expect(MAX_RETURN_GAP_DAYS).toBe(7);
  });

  it("measures bar to bar: ZZA = 1.5x the driver", () => {
    seedDriver();
    seedMultiple(ZZA_ID, 1.5);
    const e = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(e).toMatchObject({
      outcome: "measured",
      beta: expect.closeTo(1.5, 10),
      rSquared: expect.closeTo(1, 10),
      pairs: N_BARS - 1,
      securityBars: N_BARS,
      driverBars: N_BARS,
      droppedOutlierPairs: 0,
      droppedGapPairs: 0,
      firstDate: dates[1],
      lastDate: "2026-11-09",
    });
  });

  it("reads no prices or benchmark_prices row", () => {
    seedDriver();
    seedMultiple(ZZA_ID, 1.5);
    const before = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    // 3x rows in both tables, under the driver's symbol and the security's id.
    const px = db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
    );
    const bp = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'test')",
    );
    const noise = cumulative((i) => 0.03 * Math.cos(i * 2.7), N_BARS);
    for (let i = 0; i < N_BARS; i++) {
      px.run(ZZA_ID, dates[i], 100 * Math.exp(3 * driverCum[i]));
      px.run(DRIVER_ID, dates[i], 400 * Math.exp(noise[i]));
      bp.run("ZZQ", dates[i], 400 * Math.exp(noise[i]));
    }
    const e = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(e.beta).toBeCloseTo(1.5, 10);
    expect(e).toStrictEqual(before);
  });

  it("ignores a bar dated today on either leg", () => {
    seedDriver();
    seedMultiple(ZZA_ID, 1.5);
    insertBars(db, DRIVER_ID, [{ date: "2026-11-10", close: 900 }]);
    insertBars(db, ZZA_ID, [{ date: "2026-11-10", close: 1 }]);
    const e = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(e.lastDate).toBe("2026-11-09");
    expect(e.securityBars).toBe(N_BARS);
    expect(e.driverBars).toBe(N_BARS);
    expect(e.beta).toBeCloseTo(1.5, 10);
    // An injected today moves the window's end with it, on both legs.
    const earlier = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID, { today: "2026-11-09" });
    expect(earlier.lastDate).toBe(dates[N_BARS - 2]);
    expect(earlier.securityBars).toBe(N_BARS - 1);
    expect(earlier.driverBars).toBe(N_BARS - 1);
  });

  it("the window starts 730 days before today", () => {
    seedDriver();
    seedMultiple(ZZA_ID, 1.5);
    // Bars before the window on both legs: wild values that would wreck the beta.
    const old = weekdaysEnding(addDays("2026-11-10", -731), 30);
    insertBars(db, DRIVER_ID, old.map((date, i) => ({ date, close: 400 + 50 * (i % 2) })));
    insertBars(db, ZZA_ID, old.map((date, i) => ({ date, close: 100 + 20 * ((i + 1) % 2) })));
    const e = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(e.securityBars).toBe(N_BARS);
    expect(e.beta).toBeCloseTo(1.5, 10);
    // A shorter window reads fewer bars.
    const short = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID, { days: 100 });
    expect(short.securityBars).toBeLessThan(N_BARS);
    expect(short.firstDate! >= addDays("2026-11-10", -100)).toBe(true);
  });

  it("drops a 3:1 split on a day the driver falls 4%", () => {
    const k = 200;
    const steps = (i: number) => (i === k ? Math.log(0.96) : driverStep(i));
    const cum = cumulative(steps, N_BARS);
    seedDriver(cum);
    // ZZA = 1.5x the driver, with an unrecorded 3:1 split on day k.
    insertBars(
      db,
      ZZA_ID,
      dates.map((date, i) => ({ date, close: (100 * Math.exp(1.5 * cum[i])) / (i >= k ? 3 : 1) })),
    );
    const e = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(e.droppedOutlierPairs).toBe(1);
    expect(e.beta).toBeCloseTo(1.5, 6);
    expect(e.pairs).toBe(N_BARS - 2);
    expect(e.outcome).toBe("measured");
  });

  it("keeps a crash day on which both fall", () => {
    const k = 200;
    const steps = (i: number) => (i === k ? Math.log(0.88) : driverStep(i));
    const cum = cumulative(steps, N_BARS);
    seedDriver(cum);
    // ZZA 1.5x the driver every day except day k, where it falls 25%.
    const zzaSteps = (i: number) => (i === k ? Math.log(0.75) : 1.5 * driverStep(i));
    const zzaCum = cumulative(zzaSteps, N_BARS);
    insertBars(db, ZZA_ID, dates.map((date, i) => ({ date, close: 100 * Math.exp(zzaCum[i]) })));
    const e = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(e.droppedOutlierPairs).toBe(0);
    expect(e.pairs).toBe(N_BARS - 1);
    expect(e.outcome).toBe("measured");
  });

  it("documented limit: a 3:2 split cancelled by a +40% relative move passes the guard", () => {
    expect(isOutlierReturnPair(Math.log(1.4 / 1.5), 0)).toBe(false);
    // Uncancelled, each split shape is caught when nothing else moved.
    expect(isOutlierReturnPair(Math.log(1 / 1.5), 0)).toBe(true);
    expect(isOutlierReturnPair(Math.log(1 / 2), 0)).toBe(true);
    expect(isOutlierReturnPair(Math.log(1 / 3), 0)).toBe(true);
    expect(isOutlierReturnPair(Math.log(1 / 3), Math.log(0.96))).toBe(true);
    // Both fall together: kept.
    expect(isOutlierReturnPair(Math.log(0.75), Math.log(0.88))).toBe(false);
    // The bound itself is kept (strictly greater drops).
    expect(isOutlierReturnPair(0.35, 0)).toBe(false);
    expect(isOutlierReturnPair(-0.36, 0)).toBe(true);
  });

  it("isUsSessionSecurity reads the stored currency", () => {
    expect(isUsSessionSecurity("USD")).toBe(true);
    expect(isUsSessionSecurity(" usd ")).toBe(true);
    expect(isUsSessionSecurity(null)).toBe(true);
    expect(isUsSessionSecurity("ZZC")).toBe(false);
  });

  it("each reason", () => {
    seedDriver();

    // Foreign session: the security's currency is not USD.
    addSecurity(db, 4, "ZZD", "ZZC");
    seedMultiple(4, 1.5);
    const foreign = computeDailyBarRegression(db, 4, DRIVER_ID);
    expect(foreign.outcome).toBe("foreign-session");
    expect(foreign.beta).toBeNull();
    // A foreign-currency driver is foreign too.
    addSecurity(db, 101, "ZZE", "ZZC");
    seedMultiple(101, 1);
    seedMultiple(ZZA_ID, 1.5);
    expect(computeDailyBarRegression(db, ZZA_ID, 101).outcome).toBe("foreign-session");

    // No driver id, or a driver with no bars in the window.
    const noDriver = computeDailyBarRegression(db, ZZA_ID, null);
    expect(noDriver).toMatchObject({ outcome: "driver-bars-missing", beta: null, pairs: 0 });
    addSecurity(db, 102, "ZZF");
    expect(computeDailyBarRegression(db, ZZA_ID, 102)).toMatchObject({
      outcome: "driver-bars-missing",
      driverBars: 0,
    });

    // No security bars.
    addSecurity(db, 5, "ZZG");
    expect(computeDailyBarRegression(db, 5, DRIVER_ID)).toMatchObject({
      outcome: "no-daily-bars",
      securityBars: 0,
      driverBars: N_BARS,
      pairs: 0,
      beta: null,
      rSquared: null,
      firstDate: null,
      lastDate: null,
    });

    // Bars only on dates the driver lacks (weekends): no pairs at all.
    addSecurity(db, 6, "ZZH");
    const saturdays: string[] = [];
    for (let d = "2026-01-03"; d < "2026-11-10"; d = addDays(d, 7)) saturdays.push(d);
    insertBars(db, 6, saturdays.map((date, i) => ({ date, close: 100 + i })));
    expect(computeDailyBarRegression(db, 6, DRIVER_ID)).toMatchObject({
      outcome: "short-history",
      pairs: 0,
      beta: null,
    });

    // 60 bars: 59 pairs.
    addSecurity(db, 7, "ZZI");
    insertBars(
      db,
      7,
      dates.slice(-60).map((date, j) => ({
        date,
        close: 100 * Math.exp(1.5 * driverCum[N_BARS - 60 + j]),
      })),
    );
    const short = computeDailyBarRegression(db, 7, DRIVER_ID);
    expect(short).toMatchObject({ outcome: "short-history", pairs: 59 });
    // OLS could run, so the evidence carries its figures.
    expect(short.beta).toBeCloseTo(1.5, 10);
    expect(short.slopeTStat).toBe(SLOPE_T_STAT_CAP); // the pair count alone decides here
    // 61 bars: 60 pairs is enough.
    insertBars(db, 7, [{ date: dates[N_BARS - 61], close: 100 * Math.exp(1.5 * driverCum[N_BARS - 61]) }]);
    expect(computeDailyBarRegression(db, 7, DRIVER_ID)).toMatchObject({
      outcome: "measured",
      pairs: 60,
    });

    // A constant driver.
    addSecurity(db, 103, "ZZJ");
    insertBars(db, 103, dates.map((date) => ({ date, close: 400 })));
    expect(computeDailyBarRegression(db, ZZA_ID, 103)).toMatchObject({
      outcome: "flat-driver",
      pairs: N_BARS - 1,
      beta: null,
      rSquared: null,
      slopeTStat: null,
    });

    // Noise unrelated to the driver. Updated 2026-11-24 for the slope
    // t-statistic gate (it replaced r-squared >= 0.10): the outcome is low-fit
    // because the slope is not distinguishable from zero, |t| < 2.
    addSecurity(db, 8, "ZZK");
    const rand = gaussian(7);
    const noise = cumulative(() => 0.02 * rand(), N_BARS);
    insertBars(db, 8, dates.map((date, i) => ({ date, close: 100 * Math.exp(noise[i]) })));
    const low = computeDailyBarRegression(db, 8, DRIVER_ID);
    expect(low.outcome).toBe("low-fit");
    expect(low.rSquared).not.toBeNull();
    expect(low.slopeTStat).not.toBeNull();
    expect(Math.abs(low.slopeTStat!)).toBeLessThan(2);
    expect(low.pairs).toBe(N_BARS - 1);
  });

  it("gap guard boundary: 7 calendar days kept, 8 dropped", () => {
    seedDriver();
    seedMultiple(ZZA_ID, 1.5);
    // Remove the four weekdays after a Monday: Monday to the next Monday is 7 days.
    const monIdx = dates.findIndex((d, i) => i > 100 && new Date(`${d}T12:00:00Z`).getUTCDay() === 1);
    const del = db.prepare("DELETE FROM ohlcv_bars WHERE security_id = ? AND bar_date = ?");
    for (let j = 1; j <= 4; j++) del.run(ZZA_ID, dates[monIdx + j]);
    const seven = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(seven.droppedGapPairs).toBe(0);
    expect(seven.pairs).toBe(N_BARS - 5);
    expect(seven.beta).toBeCloseTo(1.5, 10);
    // Remove the next Monday too: Monday to Tuesday is 8 days.
    del.run(ZZA_ID, dates[monIdx + 5]);
    const eight = computeDailyBarRegression(db, ZZA_ID, DRIVER_ID);
    expect(eight.droppedGapPairs).toBe(1);
    expect(eight.pairs).toBe(N_BARS - 7);
  });
});

describe("computeDailyBarRegression: slope t-statistic gate (2026-11-24 ruling)", () => {
  let db: Database.Database;
  const SEC = 11;
  const DRV = 111;
  const PAIRS = 499;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    db = makeDb();
    addSecurity(db, DRV, "ZZQ");
    addSecurity(db, SEC, "ZZS");
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  /** Store bars whose daily log returns are exactly these (one more bar than returns). */
  function seedReturns(sRet: number[], bRet: number[]): void {
    const dates = weekdaysEnding("2026-11-09", sRet.length + 1);
    let s = 100;
    let b = 400;
    const sRows = [{ date: dates[0], close: s }];
    const bRows = [{ date: dates[0], close: b }];
    for (let i = 0; i < sRet.length; i++) {
      s *= Math.exp(sRet[i]);
      b *= Math.exp(bRet[i]);
      sRows.push({ date: dates[i + 1], close: s });
      bRows.push({ date: dates[i + 1], close: b });
    }
    insertBars(db, SEC, sRows);
    insertBars(db, DRV, bRows);
  }

  /**
   * Returns with an OLS slope of exactly `beta` and a slope t-statistic of
   * exactly `t`: the noise is centred and made orthogonal to the centred
   * driver, then scaled so that beta / se(beta) = t.
   */
  function constructedReturns(beta: number, t: number, seed: number) {
    const randB = gaussian(seed);
    const randE = gaussian(seed + 1000);
    const b = Array.from({ length: PAIRS }, () => 0.01 * randB());
    const e = Array.from({ length: PAIRS }, () => randE());
    const mean = (x: number[]) => x.reduce((a, v) => a + v, 0) / x.length;
    const mb = mean(b);
    const bc = b.map((v) => v - mb);
    const me = mean(e);
    let ec = e.map((v) => v - me);
    const proj = ec.reduce((a, v, i) => a + v * bc[i], 0) / bc.reduce((a, v) => a + v * v, 0);
    ec = ec.map((v, i) => v - proj * bc[i]);
    const sbb = bc.reduce((a, v) => a + v * v, 0);
    const ee = Math.sqrt(ec.reduce((a, v) => a + v * v, 0));
    const k = (Math.abs(beta) * Math.sqrt(sbb) * Math.sqrt(PAIRS - 2)) / (ee * Math.abs(t));
    return { b, s: b.map((v, i) => beta * v + k * ec[i]) };
  }

  it("beta 0.59 with r-squared about 0.06 over 499 pairs is measured", () => {
    const randB = gaussian(11);
    const randE = gaussian(12);
    const b = Array.from({ length: PAIRS }, () => 0.01 * randB());
    // Noise sized for r-squared 0.06: sigma_e^2 = 0.59^2 * sigma_b^2 * (1/0.06 - 1).
    const sigmaE = 0.01 * 0.59 * Math.sqrt(1 / 0.06 - 1);
    const s = b.map((v) => 0.59 * v + sigmaE * randE());
    seedReturns(s, b);
    const e = computeDailyBarRegression(db, SEC, DRV);
    expect(e.pairs).toBe(PAIRS);
    expect(e.droppedOutlierPairs).toBe(0);
    expect(e.rSquared!).toBeGreaterThan(0.03);
    expect(e.rSquared!).toBeLessThan(0.1); // would have failed the old r-squared gate
    expect(e.beta!).toBeGreaterThan(0.4);
    expect(e.beta!).toBeLessThan(0.8);
    expect(e.slopeTStat!).toBeGreaterThan(MIN_SLOPE_T_STAT);
    expect(e.outcome).toBe("measured");
  });

  it("pure noise unrelated to the driver over 499 pairs is low-fit", () => {
    const randB = gaussian(21);
    const randS = gaussian(22);
    const b = Array.from({ length: PAIRS }, () => 0.01 * randB());
    const s = Array.from({ length: PAIRS }, () => 0.02 * randS());
    seedReturns(s, b);
    const e = computeDailyBarRegression(db, SEC, DRV);
    expect(e.pairs).toBe(PAIRS);
    expect(Math.abs(e.slopeTStat!)).toBeLessThan(2);
    expect(e.outcome).toBe("low-fit");
    expect(e.beta).not.toBeNull();
    expect(e.rSquared).not.toBeNull();
  });

  it("a t-statistic just under 2.0 is low-fit, just over is measured", () => {
    const under = constructedReturns(0.5, 1.99, 31);
    seedReturns(under.s, under.b);
    const u = computeDailyBarRegression(db, SEC, DRV);
    expect(u.droppedOutlierPairs).toBe(0);
    expect(u.beta!).toBeCloseTo(0.5, 8);
    expect(u.slopeTStat!).toBeCloseTo(1.99, 6);
    expect(u.outcome).toBe("low-fit");

    db.prepare("DELETE FROM ohlcv_bars").run();
    const over = constructedReturns(0.5, 2.01, 31);
    seedReturns(over.s, over.b);
    const o = computeDailyBarRegression(db, SEC, DRV);
    expect(o.droppedOutlierPairs).toBe(0);
    expect(o.slopeTStat!).toBeCloseTo(2.01, 6);
    expect(o.outcome).toBe("measured");
  });

  it("a negative beta with |t| >= 2 is measured, sign kept", () => {
    const neg = constructedReturns(-0.8, -3, 41);
    seedReturns(neg.s, neg.b);
    const e = computeDailyBarRegression(db, SEC, DRV);
    expect(e.beta!).toBeCloseTo(-0.8, 8);
    expect(e.slopeTStat!).toBeCloseTo(-3, 6);
    expect(e.outcome).toBe("measured");
  });

  it("the perfect-fit case is measured with a finite capped t that survives JSON", () => {
    const randB = gaussian(51);
    const b = Array.from({ length: PAIRS }, () => 0.01 * randB());
    seedReturns(b.map((v) => 1.5 * v), b);
    const e = computeDailyBarRegression(db, SEC, DRV);
    expect(e.outcome).toBe("measured");
    expect(e.slopeTStat).toBe(SLOPE_T_STAT_CAP);
    expect(Number.isFinite(e.slopeTStat!)).toBe(true);
    expect(JSON.parse(JSON.stringify(e)).slopeTStat).toBe(SLOPE_T_STAT_CAP);
  });

  it("slopeTStatistic: exact zero residual, sign, flat security, too few pairs", () => {
    expect(slopeTStatistic([2, 4, 6, 8], [1, 2, 3, 4])).toBe(SLOPE_T_STAT_CAP);
    expect(slopeTStatistic([-2, -4, -6, -8], [1, 2, 3, 4])).toBe(-SLOPE_T_STAT_CAP);
    // A flat security has slope 0 and no residual: t is 0, not a perfect fit.
    expect(slopeTStatistic([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
    // Hand check: s = [1, 3, 2, 5], b = [1, 2, 3, 4] -> beta 1.1, SSR 2.7, Sbb 5,
    // se = sqrt(2.7 / 2 / 5), t = 1.1 / se.
    expect(slopeTStatistic([1, 3, 2, 5], [1, 2, 3, 4])!).toBeCloseTo(1.1 / Math.sqrt(0.27), 12);
    expect(slopeTStatistic([1, 2], [1, 2])).toBeNull(); // n - 2 = 0
    expect(slopeTStatistic([1, 2, 3], [4, 4, 4])).toBeNull(); // flat driver
  });

  it("evidence carries slopeTStat null when OLS cannot run", () => {
    expect(computeDailyBarRegression(db, SEC, null).slopeTStat).toBeNull();
    seedReturns([0.01, -0.01, 0.02], [0, 0, 0]);
    expect(computeDailyBarRegression(db, SEC, DRV)).toMatchObject({
      outcome: "short-history",
      slopeTStat: null,
    });
  });
});

// The existing regressions keep their exact results. Values were captured by
// running this fixture against HEAD's lib/compute/security-regression.ts before
// the pair builder was split out (2026-11-24). The fixture exercises the gap
// guard, the split-shape guard, the option exemption, the source filter, the
// MIN_DATA_POINTS floor and the benchmark-to-benchmark path.
function seedPinFixture(db: Database.Database): void {
  db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (1, 'ZZA', 'Stock')").run();
  db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (2, 'ZZO', 'Option')").run();
  const dates = weekdaysEnding("2026-11-09", 80);
  const bench = db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'test')",
  );
  const px = db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
  );
  let spy = 400;
  let qqq = 300;
  let zza = 100;
  let zzo = 5;
  for (let i = 0; i < dates.length; i++) {
    const r = 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7);
    spy *= Math.exp(r);
    qqq *= Math.exp(1.2 * r + 0.001 * Math.sin(i * 2.1));
    zza *= Math.exp(1.4 * r + 0.004 * Math.cos(i * 1.9));
    zzo *= Math.exp(3 * r);
    if (i !== 70) bench.run("SPY", dates[i], spy);
    bench.run("QQQ", dates[i], qqq);
    // A 10-day hole in the security (gap guard), a 2:1 split-shaped day at 50.
    if (i >= 20 && i < 28) continue;
    const zzaClose = i >= 50 ? zza / 2 : zza;
    const source = i % 7 === 0 ? null : i % 5 === 0 ? "plaid" : "tws";
    px.run(1, dates[i], zzaClose, source);
    px.run(2, dates[i], i >= 60 ? zzo * 2 : zzo, "tws");
  }
}

describe("the existing regressions are unchanged", () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    db = makeDb();
    seedPinFixture(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("the existing regressions are unchanged", () => {
    expect(computeSecurityRegression(db, 1, "SPY")).toStrictEqual({
      beta: 1.3762061147171074,
      vol: 0.16672459005844656,
      correlation: 0.9639408076474486,
      rSquared: 0.9291818806480155,
      dataPoints: 68,
    });
    expect(computeSecurityRegression(db, 1, "QQQ", 100)).toStrictEqual({
      beta: 1.1486499011918438,
      vol: 0.16682865424528928,
      correlation: 0.9648946278004394,
      rSquared: 0.9310216427581486,
      dataPoints: 60,
    });
    expect(
      computeSecurityRegression(db, 1, "SPY", 252, { excludePriceSources: ["plaid"] }),
    ).toStrictEqual({
      beta: 1.3785638044650568,
      vol: 0.1828906368584407,
      correlation: 0.9771359450553475,
      rSquared: 0.9547946551192071,
      dataPoints: 57,
    });
    expect(computeSecurityRegression(db, 2, "SPY")).toStrictEqual({
      beta: 3.7940992382002316,
      vol: 1.393456055750994,
      correlation: 0.31738019121444666,
      rSquared: 0.10073018577531873,
      dataPoints: 69,
    });
    expect(computeSecurityRegression(db, 1, "SPY", 20)).toStrictEqual({
      beta: 1.3892054683747366,
      vol: 0.1790024379590778,
      correlation: 0.9686945987702359,
      rSquared: 0.9383692256866283,
      dataPoints: 12,
    });
    expect(computeBenchmarkRegression(db, "qqq ", "SPY")).toStrictEqual({
      beta: 1.1997766561063983,
      vol: 0.1409478966332035,
      correlation: 0.996839648491652,
      rSquared: 0.9936892848049602,
      dataPoints: 78,
    });
    expect(computeBenchmarkRegression(db, "QQQ", "SPY", 10)).toBeNull();
  });
});
