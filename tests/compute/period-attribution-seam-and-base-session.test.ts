import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";

// Two fixes to the beta / alpha walk (computePeriodAttribution), tested
// together because both live in the same session walk:
//
//  FIX 14 — base session. A window that opens on a closed day (YTD opens on
//  Jan 1) starts the walk at the last benchmark close on or before it, so the
//  first session's move is kept (before: the walk began at Jan 2 and lost it).
//
//  FIX 10 — seams. A session pair whose (prev, curr] holds a measurement-
//  source seam (fetchAnchorSourceSeamDates, the 2026-11-15 rule) is bridged:
//  dropped from the regression and from both compounded returns, as the risk
//  tiles and the curve already do. Before, a +10% basis step on the first
//  live day read as market return and pushed beta far above 1.
//
// Every value is synthetic.

const BENCH_CYCLE = [0.01, -0.006, 0.008, 0.003, -0.004, 0.007, 0.002, -0.005, 0.009, -0.002];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function* calendarDays(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield iso(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
/** Market holidays inside the fixtures' ranges (no benchmark close). */
const HOLIDAYS = new Set(["2025-12-25", "2026-01-01", "2026-01-19", "2026-09-07"]);
function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(date);
}

interface SeedOpts {
  accountId?: number;
  from: string;
  to: string;
  /** Benchmark close on the first session; later sessions follow BENCH_CYCLE. */
  firstClose?: number;
  /** Explicit closes that override the cycle on those dates. */
  closes?: Record<string, number>;
  /** Portfolio value = scale × benchmark close (exact tracking). */
  scale?: number;
  /** From this calendar date on, the portfolio is multiplied by `step`. */
  stepFrom?: string;
  step?: number;
  /** Skip the benchmark (used for a second account). */
  noBenchmark?: boolean;
  /** Calendar dates with no valuation row for this account. */
  skipValuation?: Set<string>;
}

/** Benchmark sessions on weekdays; a valuation row every calendar day. */
function seed(db: Database.Database, o: SeedOpts): Map<string, number> {
  const closes = new Map<string, number>();
  let close = o.firstClose ?? 400;
  let k = 0;
  let seen = false;
  let lastClose = close;
  for (const date of calendarDays(o.from, o.to)) {
    if (isWeekday(date)) {
      if (seen) {
        close = close * (1 + BENCH_CYCLE[k % BENCH_CYCLE.length]);
        k++;
      }
      seen = true;
      if (o.closes?.[date] !== undefined) close = o.closes[date];
      closes.set(date, close);
      lastClose = close;
      if (!o.noBenchmark) {
        db.prepare(
          `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
        ).run(date, close);
      }
    }
    if (o.skipValuation?.has(date)) continue;
    const stepped = o.stepFrom !== undefined && date >= o.stepFrom ? (o.step ?? 1) : 1;
    const value = (o.scale ?? 250) * lastClose * stepped;
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(o.accountId ?? 1, date, value, value);
  }
  return closes;
}

function snapshot(db: Database.Database, accountId: number, date: string, total: number, source: string): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, ?)`,
  ).run(accountId, date, total, source);
}

function compoundedBenchmark(closes: Map<string, number>, from: string, to: string, skipPairEnding?: string[]): number {
  const dates = [...closes.keys()].filter((d) => d >= from && d <= to).sort();
  let p = 1;
  for (let i = 1; i < dates.length; i++) {
    if (skipPairEnding?.includes(dates[i])) continue;
    p *= closes.get(dates[i])! / closes.get(dates[i - 1])!;
  }
  return p - 1;
}

describe("FIX 10: attribution bridges measurement-source seams", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("a +10% basis step on the first live anchor is not return: beta 1, alpha 0", () => {
    // Statements Aug 31 and Sep 30; the first live (TWS) anchor is Fri Oct 30
    // and the daily values step up 10% that day. Otherwise the book tracks
    // the benchmark exactly.
    const closes = seed(db, { from: "2026-08-31", to: "2026-11-20", stepFrom: "2026-10-30", step: 1.1 });
    snapshot(db, 1, "2026-08-31", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2026-09-30", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2026-10-30", 110_000, "tws");
    expect(fetchAnchorSourceSeamDates(db, [1], "2026-10-01", "2026-11-20")).toEqual(["2026-10-30"]);

    const r = computePeriodAttribution(db, 1, "2026-10-01", "2026-11-20", "SPY");
    const bench = compoundedBenchmark(closes, "2026-10-01", "2026-11-20", ["2026-10-30"]);
    expect(r.decomposedReturn).not.toBeNull();
    // Before the fix: decomposed +18.73%, beta contribution +11.95%, alpha
    // +6.77% (the step read as return; 36 pairs, none bridged).
    expect(r.decomposedReturn!.seamDaysBridged).toBe(1);
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(bench, 10);
    expect(r.betaVsAlpha.betaContribution).toBeCloseTo(bench, 10); // beta 1
    expect(r.betaVsAlpha.alphaContribution).toBeCloseTo(0, 10);
    // The parts still add up to the decomposed return.
    expect(r.betaVsAlpha.betaContribution + r.betaVsAlpha.alphaContribution).toBeCloseTo(
      r.decomposedReturn!.portfolioReturn,
      12,
    );
  });

  it("a seam on a weekend month-end is caught by the half-open rule (Fri -> Mon pair)", () => {
    // The first live anchor is dated Sat Oct 31; the step shows from that day.
    const closes = seed(db, { from: "2026-08-31", to: "2026-11-20", stepFrom: "2026-10-31", step: 1.1 });
    snapshot(db, 1, "2026-08-31", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2026-09-30", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2026-10-31", 110_000, "tws");

    const r = computePeriodAttribution(db, 1, "2026-10-01", "2026-11-20", "SPY");
    // The Fri Oct 30 -> Mon Nov 2 pair holds Oct 31.
    const bench = compoundedBenchmark(closes, "2026-10-01", "2026-11-20", ["2026-11-02"]);
    // Before the fix: beta contribution +8.52%, alpha +10.21%.
    expect(r.decomposedReturn!.seamDaysBridged).toBe(1);
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(bench, 10);
    expect(r.betaVsAlpha.alphaContribution).toBeCloseTo(0, 10);
  });

  it("a window with no seam and opening on a trading day is unchanged to the last digit", () => {
    // Pinned from the code before both fixes. Flows included; the book does
    // not track the benchmark exactly (a 0.1% daily drift on Wednesdays).
    seed(db, { from: "2026-03-02", to: "2026-04-17" });
    db.prepare(
      `UPDATE daily_valuations SET total_value = total_value * 1.001, holdings_value = holdings_value * 1.001
       WHERE strftime('%w', valuation_date) = '3'`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (1, '2026-03-14', 'DEPOSIT', 5000, 1, 'pin-flow-1')`,
    ).run();
    snapshot(db, 1, "2026-02-28", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2026-03-31", 100_000, "vanguard-pdf");

    const r = computePeriodAttribution(db, 1, "2026-03-02", "2026-04-17", "SPY");
    expect(r.decomposedReturn!.seamDaysBridged).toBe(0);
    const decomposed = { portfolioReturn: r.decomposedReturn!.portfolioReturn, observations: r.decomposedReturn!.observations };
    expect(JSON.stringify({ ...r, decomposedReturn: decomposed })).toBe(PINNED_NO_SEAM);
  });
});

describe("FIX 14: attribution keeps the first session when the window opens on a closed day", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  /** Dec 31 close 100, a +5% Jan 2 session, Feb 13 close 112.11. */
  const YTD_CLOSES = { "2025-12-31": 100, "2026-01-02": 105, "2026-02-13": 112.11 };

  it("YTD from Jan 1 walks from the Dec 31 close and keeps the Jan 2 session", () => {
    seed(db, { from: "2025-12-31", to: "2026-02-13", firstClose: 100, closes: YTD_CLOSES, scale: 1000 });

    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-02-13", "SPY");
    // Before the fix: decomposed +6.77% (112.11 / 105 - 1), 29 pairs, window
    // from Jan 2.
    expect(r.betaWindow).toEqual({ start: "2025-12-31", end: "2026-02-13" });
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(0.1211, 10);
    expect(r.betaVsAlpha.betaContribution).toBeCloseTo(0.1211, 10);
    expect(r.betaVsAlpha.alphaContribution).toBeCloseTo(0, 10);
  });

  it("a seam on the base -> first-session pair is bridged (both fixes together)", () => {
    // Statements Nov 30 and Dec 31; the first live anchor is Fri Jan 2 with a
    // +10% basis step that day.
    seed(db, {
      from: "2025-12-31",
      to: "2026-02-13",
      firstClose: 100,
      closes: YTD_CLOSES,
      scale: 1000,
      stepFrom: "2026-01-02",
      step: 1.1,
    });
    snapshot(db, 1, "2025-11-30", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2025-12-31", 100_000, "vanguard-pdf");
    snapshot(db, 1, "2026-01-02", 115_500, "tws");

    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-02-13", "SPY");
    expect(r.decomposedReturn!.seamDaysBridged).toBe(1);
    // The walk now opens on the base session, but its first pair is bridged,
    // so the regression's first kept pair starts Jan 2.
    expect(r.betaWindow).toEqual({ start: "2026-01-02", end: "2026-02-13" });
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(112.11 / 105 - 1, 10);
    expect(r.betaVsAlpha.alphaContribution).toBeCloseTo(0, 10);
  });

  it("fullCoverageOnly: with no full-coverage value on the base day, the walk opens inside the window as before", () => {
    seed(db, { from: "2025-12-31", to: "2026-02-13", firstClose: 100, closes: YTD_CLOSES, scale: 1000 });
    // A second account with no Dec 31 value.
    seed(db, {
      accountId: 2,
      from: "2025-12-31",
      to: "2026-02-13",
      firstClose: 100,
      closes: YTD_CLOSES,
      scale: 500,
      noBenchmark: true,
      skipValuation: new Set(["2025-12-31"]),
    });

    const r = computePeriodAttribution(db, [1, 2], "2026-01-01", "2026-02-13", "SPY");
    expect(r.betaWindow).toEqual({ start: "2026-01-02", end: "2026-02-13" });
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(112.11 / 105 - 1, 10);
  });

  it("fullCoverageOnly: a base day that would change which window days survive is not used", () => {
    // Account 2 has a value ONLY on Dec 31 (closed the day after). Reading
    // from Dec 31 would raise the full-coverage count to two accounts and
    // drop every window day; the window's own rows are kept instead.
    seed(db, { from: "2025-12-31", to: "2026-02-13", firstClose: 100, closes: YTD_CLOSES, scale: 1000 });
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (2, '2025-12-31', 0, 50000, 50000)`,
    ).run();

    const r = computePeriodAttribution(db, [1, 2], "2026-01-01", "2026-02-13", "SPY");
    expect(r.betaWindow).toEqual({ start: "2026-01-02", end: "2026-02-13" });
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(112.11 / 105 - 1, 10);
  });
});

// computePeriodAttribution's output (decomposedReturn without the new
// seamDaysBridged field), captured from the code before both fixes.
const PINNED_NO_SEAM =
  '{"topContributors":[],"topDetractors":[],"sectorContribution":[],"betaVsAlpha":{"betaContribution":0.09630632227726156,"alphaContribution":-0.06568949449127205},"betaWindow":{"start":"2026-03-02","end":"2026-04-17"},"decomposedReturn":{"portfolioReturn":0.03061682778598951,"observations":34},"positionsBasis":{"asOf":null,"emptyReason":"accounts_missing_at_start","missingAccounts":["Vanguard Taxable"]}}';
