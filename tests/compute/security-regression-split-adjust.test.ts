import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { computeSecurityRegression } from "@/lib/compute/security-regression";

// qa: security hub QUANTITATIVE REGRESSION card read an absurd volatility and
// withheld beta for a security whose price series carries an unadjusted
// forward split. Synthetic symbol and round-number prices only.

const SEC_ID = 1;
const BENCH = "SPY";
const DAYS = 70;
const SPLIT_INDEX = 35;

/** The last DAYS weekdays ending yesterday (Eastern), oldest first. */
function tradingDates(): string[] {
  const out: string[] = [];
  let d = addDays(todayET(), -1);
  while (out.length < DAYS) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

/** Deterministic benchmark returns and a security that moves 1.2x plus noise. */
function series(): { bench: number[]; sec: number[] } {
  const bench = [400];
  const sec = [100];
  for (let i = 1; i < DAYS; i++) {
    const rb = (i % 3 === 0 ? -0.01 : 0.008) + (i % 7 === 0 ? 0.004 : 0);
    const rs = 1.2 * rb + (i % 5 === 0 ? 0.002 : -0.0005);
    bench.push(bench[i - 1] * (1 + rb));
    sec.push(sec[i - 1] * (1 + rs));
  }
  return { bench, sec };
}

describe("computeSecurityRegression — split-adjusted closes", () => {
  let db: Database.Database;
  let dates: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      "INSERT INTO securities (id, symbol, security_type) VALUES (?, 'AAA', 'Stock')"
    ).run(SEC_ID);
    dates = tradingDates();
  });

  function seed(opts: {
    rawPreSplitMultiple: number; // 4 = unadjusted series, 1 = already adjusted
    action?: { source: string };
    crashIndex?: number;
    /** Omit the benchmark row on this index (a market holiday for the benchmark). */
    benchHolidayIndex?: number;
    /** Multiply closes from this index on (a real move, not split-shaped). */
    bump?: { index: number; factor: number };
    /** Store no rows at all for these indexes (a sync outage). */
    missing?: Set<number>;
  }): void {
    const { bench, sec } = series();
    const insP = db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
    );
    const insB = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'test')"
    );
    for (let i = 0; i < DAYS; i++) {
      let close = sec[i] * (i < SPLIT_INDEX ? opts.rawPreSplitMultiple : 1);
      if (opts.crashIndex !== undefined && i >= opts.crashIndex) close *= 0.7;
      if (opts.bump && i >= opts.bump.index) close *= opts.bump.factor;
      if (opts.missing?.has(i)) continue;
      insP.run(SEC_ID, dates[i], close);
      if (i !== opts.benchHolidayIndex) insB.run(BENCH, dates[i], bench[i]);
    }
    // The effective date is the LAST pre-split session: its close is still a
    // pre-split print (end-of-day rule, as the lot engine replays it).
    if (opts.action) {
      db.prepare(
        `INSERT INTO corporate_actions
           (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, source)
         VALUES (?, 'SPLIT', ?, 4, 1, ?)`
      ).run(SEC_ID, dates[SPLIT_INDEX - 1], opts.action.source);
    }
  }

  it("adjusts closes before an import-mode 4:1 split so the split day is not a -75% return", () => {
    seed({ rawPreSplitMultiple: 4, action: { source: "import" } });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r).not.toBeNull();
    // A single -75% day (log -1.386) alone would push annualized vol past 250%.
    expect(r.vol).toBeLessThan(1.0);
    // Every day is kept: the split day becomes an ordinary return.
    expect(r.dataPoints).toBe(DAYS - 1);
    expect(r.beta).toBeGreaterThan(1.0);
    expect(r.beta).toBeLessThan(1.4);
    expect(r.rSquared).toBeGreaterThan(0.5);
  });

  it("a split-sized jump with no action row is dropped as a non-return day", () => {
    seed({ rawPreSplitMultiple: 4 });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r.vol).toBeLessThan(1.0);
    expect(r.dataPoints).toBe(DAYS - 2);
    expect(r.rSquared).toBeGreaterThan(0.5);
  });

  it("a manual (legacy rewrite-mode) row is not replayed; the guard still drops the jump", () => {
    seed({ rawPreSplitMultiple: 4, action: { source: "manual" } });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r.vol).toBeLessThan(1.0);
    expect(r.dataPoints).toBe(DAYS - 2);
  });

  it("an already-adjusted series with an import row is left alone (no day dropped)", () => {
    seed({ rawPreSplitMultiple: 1, action: { source: "import" } });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r.vol).toBeLessThan(1.0);
    expect(r.rSquared).toBeGreaterThan(0.5);
    // The split is detected as absorbed, so no fake 4x step is created and
    // the guard has nothing to drop.
    expect(r.dataPoints).toBe(DAYS - 1);
  });

  it("effective-date close is pre-split and the next day is a benchmark holiday: no fake return", () => {
    // The aligned pair spans the split AND a real two-session move, so its
    // raw ratio (4 / 1.06) is not split-shaped and the guard would not catch it.
    seed({
      rawPreSplitMultiple: 4,
      action: { source: "import" },
      benchHolidayIndex: SPLIT_INDEX,
      bump: { index: SPLIT_INDEX, factor: 1.06 },
    });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r.vol).toBeLessThan(1.0);
    // One aligned date fewer (the holiday); no pair dropped.
    expect(r.dataPoints).toBe(DAYS - 2);
    expect(r.rSquared).toBeGreaterThan(0.3);
  });

  it("a pair spanning a multi-week hole is dropped, not treated as one daily return", () => {
    const missing = new Set<number>();
    for (let i = 40; i < 50; i++) missing.add(i); // two trading weeks
    seed({ rawPreSplitMultiple: 1, missing, bump: { index: 50, factor: 0.6 } });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r.vol).toBeLessThan(1.0);
    // DAYS - 10 rows -> DAYS - 11 pairs, minus the gap pair.
    expect(r.dataPoints).toBe(DAYS - 12);
  });

  it("a genuine -30% day is kept as a real return", () => {
    seed({ rawPreSplitMultiple: 1, crashIndex: 50 });
    const r = computeSecurityRegression(db, SEC_ID, BENCH, 252)!;
    expect(r.dataPoints).toBe(DAYS - 1);
    expect(r.vol).toBeGreaterThan(0.5);
  });
});
