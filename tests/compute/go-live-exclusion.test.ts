/**
 * Go-live exclusion (ruling E2, 2026-11-15/16; built 2026-11-26).
 *
 * The day a live source (tws, plaid) starts on an account that already had
 * statement anchors, the daily series steps from statement-anchored values to
 * a live broker total. That step is a change of measurement, not a market
 * move: volatility, Sharpe and beta leave out the return INTERVAL that holds
 * it. The flow-adjusted index, drawdown and cumulative return keep it.
 *
 * The go-live date is derived from monthly_snapshots on every call: a live
 * source's first anchor on an account, when the account has an earlier anchor
 * of another source. Exclusion is on intervals (previous point, point], so a
 * go-live on a closed day still hits the session it folds into, and a
 * benchmark gap that widens an aligned interval still catches it.
 *
 * Migrated schema; synthetic values; invented dates.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeRiskMetrics,
  dropGoLiveSessions,
  foldReturnsIntoDatedSessions,
  foldReturnsIntoSessions,
} from "@/lib/compute/risk";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import {
  buildFlowAdjustedIndex,
  fetchAnchorSourceSeamDates,
  fetchGoLiveDatesForScope,
  fetchLiveSourceGoLiveDates,
  intervalContainsAnyDate,
} from "@/lib/compute/flow-adjusted";
import { isMarketClosed, nextTradingDay } from "@/lib/calendar/market-holidays";
import { addDays } from "@/lib/calendar/date-utils";

// ─── Fixture helpers ────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.exec(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Acct A'), (2, 'Acct B')`);
  return db;
}

function anchor(db: Database.Database, accountId: number, date: string, source: string | null): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, 100000, ?)`
  ).run(accountId, date, source);
}

function valuation(db: Database.Database, accountId: number, date: string, value: number): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`
  ).run(accountId, date, value, value);
}

function benchmark(db: Database.Database, date: string, close: number): void {
  db.prepare(
    `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'test')`
  ).run(date, close);
}

function tradingDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isMarketClosed(d)) out.push(d);
  return out;
}

/** A deterministic, non-trivial daily log return for index i. */
function baseReturn(i: number): number {
  return Math.sin(i * 1.3) * 0.01;
}

/** Sample standard deviation x sqrt(252), the engine's formula. */
function annualVol(rs: number[]): number {
  const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
  const variance = rs.reduce((s, r) => s + (r - mean) ** 2, 0) / (rs.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

const FROM = "2026-03-02";
const TO = "2026-08-31";
const DAYS = tradingDays(FROM, TO);
const STATEMENTS = ["2026-03-31", "2026-04-30", "2026-05-29", "2026-06-30", "2026-07-31", "2026-08-31"];
const JUMP = Math.log(0.92); // a -8% one-off step on the go-live day

/**
 * Write a trading-day series for one account from per-day log returns
 * (`returnOn(date, i)`), starting at 100,000. Returns the log returns used,
 * keyed by date (the first day has none).
 */
function writeSeries(
  db: Database.Database,
  accountId: number,
  returnOn: (date: string, i: number) => number,
  days: string[] = DAYS
): Map<string, number> {
  const used = new Map<string, number>();
  let v = 100_000;
  valuation(db, accountId, days[0], v);
  for (let i = 1; i < days.length; i++) {
    const r = returnOn(days[i], i);
    used.set(days[i], r);
    v *= Math.exp(r);
    valuation(db, accountId, days[i], v);
  }
  return used;
}

function statementAnchors(db: Database.Database, accountId: number, dates = STATEMENTS): void {
  for (const d of dates) anchor(db, accountId, d, "canonical");
}

/** Plaid anchors on every trading day from `from` up to (not including) `before`. */
function plaidAnchors(db: Database.Database, accountId: number, from: string, before: string): void {
  for (const d of DAYS) if (d >= from && d < before) anchor(db, accountId, d, "plaid");
}

const OPTS = { startDate: FROM, endDate: TO, riskFreeRate: 0.04, coverageFloor: "scope" as const };

// ─── fetchLiveSourceGoLiveDates ─────────────────────────────────

describe("fetchLiveSourceGoLiveDates", () => {
  it("is the first Plaid anchor after earlier statement anchors", () => {
    const db = makeDb();
    statementAnchors(db, 1);
    plaidAnchors(db, 1, "2026-07-15", "2026-07-31");
    expect(fetchLiveSourceGoLiveDates(db, [1])).toEqual(new Map([[1, ["2026-07-15"]]]));
  });

  it("an account that starts on a live source has no go-live", () => {
    const db = makeDb();
    plaidAnchors(db, 1, "2026-03-02", "2026-03-31");
    statementAnchors(db, 1);
    expect(fetchLiveSourceGoLiveDates(db, [1]).size).toBe(0);
  });

  it("each live source has its own go-live; the other live source counts as an earlier anchor", () => {
    const db = makeDb();
    anchor(db, 1, "2026-03-31", "ibkr-activity");
    anchor(db, 1, "2026-04-06", "tws");
    anchor(db, 1, "2026-04-07", "tws");
    anchor(db, 1, "2026-04-30", "ibkr-activity");
    anchor(db, 1, "2026-05-04", "plaid");
    expect(fetchLiveSourceGoLiveDates(db, [1]).get(1)).toEqual(["2026-04-06", "2026-05-04"]);
  });

  it("a NULL-source anchor is an earlier anchor of another source", () => {
    const db = makeDb();
    anchor(db, 1, "2026-03-31", null);
    anchor(db, 1, "2026-04-06", "tws");
    expect(fetchLiveSourceGoLiveDates(db, [1]).get(1)).toEqual(["2026-04-06"]);
  });

  it("follows the scope rule: undefined is every account, [] is none", () => {
    const db = makeDb();
    statementAnchors(db, 1);
    plaidAnchors(db, 1, "2026-07-15", "2026-07-20");
    statementAnchors(db, 2);
    plaidAnchors(db, 2, "2026-07-20", "2026-07-24");
    expect([...fetchLiveSourceGoLiveDates(db, undefined).keys()].sort()).toEqual([1, 2]);
    expect(fetchLiveSourceGoLiveDates(db, []).size).toBe(0);
    expect(fetchLiveSourceGoLiveDates(db, [2]).get(2)).toEqual(["2026-07-20"]);
    expect(fetchGoLiveDatesForScope(db, undefined)).toEqual(["2026-07-15", "2026-07-20"]);
    expect(fetchGoLiveDatesForScope(db, [])).toEqual([]);
  });

  it("moves with the data: a repaired first anchor one session earlier is the new go-live", () => {
    const db = makeDb();
    statementAnchors(db, 1);
    anchor(db, 1, "2026-07-11", "plaid"); // Saturday, before a repair
    anchor(db, 1, "2026-07-13", "plaid");
    expect(fetchGoLiveDatesForScope(db, [1])).toEqual(["2026-07-11"]);
    db.prepare(
      "UPDATE monthly_snapshots SET month_end_date = '2026-07-10' WHERE month_end_date = '2026-07-11'"
    ).run();
    expect(fetchGoLiveDatesForScope(db, [1])).toEqual(["2026-07-10"]);
  });
});

describe("intervalContainsAnyDate", () => {
  it("is half-open: the start is outside, the end is inside", () => {
    expect(intervalContainsAnyDate("2026-07-10", "2026-07-13", ["2026-07-10"])).toBe(false);
    expect(intervalContainsAnyDate("2026-07-10", "2026-07-13", ["2026-07-11"])).toBe(true);
    expect(intervalContainsAnyDate("2026-07-10", "2026-07-13", ["2026-07-13"])).toBe(true);
    expect(intervalContainsAnyDate("2026-07-10", "2026-07-13", ["2026-07-14"])).toBe(false);
    expect(intervalContainsAnyDate(null, "2026-07-13", ["2026-01-01"])).toBe(true);
  });
});

// ─── The dated fold ─────────────────────────────────────────────

/** The fold as it was before 2026-11-26, kept here as the reference. */
function originalFold(returns: { date: string; logReturn: number }[]): number[] {
  const bySession = new Map<string, number>();
  for (const r of returns) {
    const session = isMarketClosed(r.date) ? nextTradingDay(r.date) : r.date;
    bySession.set(session, (bySession.get(session) ?? 0) + r.logReturn);
  }
  return [...bySession.values()];
}

describe("foldReturnsIntoDatedSessions", () => {
  it("foldReturnsIntoSessions output is byte-identical to the original fold", () => {
    const input: { date: string; logReturn: number }[] = [];
    let i = 0;
    for (let d = "2026-03-01"; d <= "2026-08-31"; d = addDays(d, 1)) {
      if (i % 7 !== 3) input.push({ date: d, logReturn: Math.sin(i * 0.77) * 0.013 - 0.0001 });
      i++;
    }
    const a = foldReturnsIntoSessions(input);
    const b = originalFold(input);
    expect(a.length).toBe(b.length);
    for (let k = 0; k < a.length; k++) expect(Object.is(a[k], b[k])).toBe(true);
  });

  it("dates each session with the interval it covers", () => {
    const folded = foldReturnsIntoDatedSessions([
      { date: "2026-07-09", logReturn: 0.01, prevDate: "2026-07-08" },
      { date: "2026-07-10", logReturn: 0.02, prevDate: "2026-07-09" },
      { date: "2026-07-11", logReturn: 0.005, prevDate: "2026-07-10" }, // Sat -> Mon
      { date: "2026-07-13", logReturn: -0.01, prevDate: "2026-07-11" },
    ]);
    expect(folded.map((o) => [o.sessionStart, o.session])).toEqual([
      ["2026-07-08", "2026-07-09"],
      ["2026-07-09", "2026-07-10"],
      ["2026-07-10", "2026-07-13"],
    ]);
    expect(folded[2].logReturn).toBeCloseTo(-0.005, 15);
  });

  it("without prevDate the start is the previous return's date (null for the first)", () => {
    const folded = foldReturnsIntoDatedSessions([
      { date: "2026-07-09", logReturn: 0.01 },
      { date: "2026-07-13", logReturn: 0.02 },
    ]);
    expect(folded.map((o) => o.sessionStart)).toEqual([null, "2026-07-09"]);
  });

  it("a go-live on a Saturday drops the Monday it folds into; Friday's go-live drops Friday", () => {
    const rows = [
      { date: "2026-07-09", logReturn: 0.01, prevDate: "2026-07-08" },
      { date: "2026-07-10", logReturn: 0.02, prevDate: "2026-07-09" },
      { date: "2026-07-11", logReturn: JUMP, prevDate: "2026-07-10" },
      { date: "2026-07-13", logReturn: -0.01, prevDate: "2026-07-11" },
      { date: "2026-07-14", logReturn: 0.004, prevDate: "2026-07-13" },
    ];
    const folded = foldReturnsIntoDatedSessions(rows);
    expect(dropGoLiveSessions(folded, ["2026-07-11"]).map((o) => o.session)).toEqual([
      "2026-07-09",
      "2026-07-10",
      "2026-07-14",
    ]);
    expect(dropGoLiveSessions(folded, ["2026-07-10"]).map((o) => o.session)).toEqual([
      "2026-07-09",
      "2026-07-13",
      "2026-07-14",
    ]);
    expect(dropGoLiveSessions(folded, [])).toBe(folded);
  });
});

// ─── Volatility and Sharpe ──────────────────────────────────────

describe("computeRiskMetrics: the go-live step is out of volatility, in the index", () => {
  const GO_LIVE = "2026-07-15"; // Wednesday

  function seed(withPlaid: boolean): { db: Database.Database; used: Map<string, number> } {
    const db = makeDb();
    const used = writeSeries(db, 1, (d, i) => (d === GO_LIVE ? JUMP : baseReturn(i)));
    statementAnchors(db, 1);
    if (withPlaid) plaidAnchors(db, 1, GO_LIVE, "2026-07-31");
    return { db, used };
  }

  it("excludes the go-live interval from volatility and Sharpe", () => {
    const { db, used } = seed(true);
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    const kept = [...used].filter(([d]) => d !== GO_LIVE).map(([, r]) => r);
    expect(m.volatility).toBeCloseTo(annualVol(kept), 12);
    const mean = kept.reduce((s, r) => s + r, 0) / kept.length;
    expect(m.sharpeRatio).toBeCloseTo((mean * 252 - 0.04) / annualVol(kept), 10);
    expect(m.seamDaysBridged).toBe(0); // bracketed by statements: not a seam
  });

  it("keeps the step in the index: drawdown still sees it", () => {
    const { db } = seed(true);
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    expect(m.maxDrawdown!.percent).toBeGreaterThanOrEqual(0.08);

    const points = (
      db
        .prepare(
          "SELECT valuation_date AS date, total_value AS value FROM daily_valuations WHERE account_id = 1 ORDER BY valuation_date"
        )
        .all() as { date: string; value: number }[]
    );
    const seams = fetchAnchorSourceSeamDates(db, [1], points[0].date, points[points.length - 1].date);
    const { index, returns } = buildFlowAdjustedIndex(points, [], seams);
    const at = (d: string) => index.find((p) => p.date === d)!.value;
    expect(at(GO_LIVE) / at("2026-07-14")).toBeCloseTo(0.92, 12);
    expect(returns.find((r) => r.date === GO_LIVE)!.logReturn).toBeCloseTo(JUMP, 12);
  });

  it("the same series with no live source counts the step (control)", () => {
    const { db, used } = seed(false);
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    expect(m.volatility).toBeCloseTo(annualVol([...used.values()]), 12);
    const { db: withPlaid } = seed(true);
    expect(m.volatility!).toBeGreaterThan(
      computeRiskMetrics(withPlaid, { ...OPTS, accountIds: [1] }).volatility!
    );
  });

  it("an account that starts on Plaid has nothing excluded", () => {
    const db = makeDb();
    const used = writeSeries(db, 1, (d, i) => (d === GO_LIVE ? JUMP : baseReturn(i)));
    plaidAnchors(db, 1, FROM, "2026-03-31");
    statementAnchors(db, 1, STATEMENTS.slice(1));
    plaidAnchors(db, 1, GO_LIVE, "2026-07-31");
    expect(fetchGoLiveDatesForScope(db, [1])).toEqual([]);
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    // The head hand-off (first statement after leading live rows) is a seam
    // and is bridged as before; nothing else is left out.
    const seams = fetchAnchorSourceSeamDates(db, [1], FROM, TO);
    expect(seams).toEqual(["2026-04-30"]);
    const kept = [...used].filter(([d]) => !seams.includes(d)).map(([, r]) => r);
    expect(m.volatility).toBeCloseTo(annualVol(kept), 12);
  });

  it("a go-live that is still a seam (no later statement) drops only the bridged step", () => {
    // The bridged step emits no return; the next session's return covers
    // (go-live, next] and is kept, because each return is dated with the
    // series point before it.
    const db = makeDb();
    const used = writeSeries(db, 1, (d, i) => (d === GO_LIVE ? JUMP : baseReturn(i)));
    statementAnchors(db, 1, STATEMENTS.slice(0, 4)); // last statement 06-30
    plaidAnchors(db, 1, GO_LIVE, "2026-09-01");
    expect(fetchAnchorSourceSeamDates(db, [1], FROM, TO)).toEqual([GO_LIVE]);
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    const kept = [...used].filter(([d]) => d !== GO_LIVE).map(([, r]) => r);
    expect(m.seamDaysBridged).toBe(1);
    expect(m.volatility).toBeCloseTo(annualVol(kept), 12);
  });
});

describe("computeRiskMetrics: a go-live on a closed day", () => {
  const SAT = "2026-07-11";
  const FRI = "2026-07-10";
  const MON = "2026-07-13";

  it("a Saturday go-live row folds into Monday, and Monday is excluded", () => {
    const db = makeDb();
    const used = writeSeries(db, 1, (_d, i) => baseReturn(i));
    // The Saturday row carries the jump; Monday moves on from it.
    const friValue = (db.prepare("SELECT total_value AS v FROM daily_valuations WHERE valuation_date = ?").get(FRI) as { v: number }).v;
    valuation(db, 1, SAT, friValue * Math.exp(JUMP));
    db.prepare("UPDATE daily_valuations SET total_value = total_value * ? WHERE valuation_date >= ?").run(
      Math.exp(JUMP),
      MON
    );
    statementAnchors(db, 1);
    anchor(db, 1, SAT, "plaid");
    plaidAnchors(db, 1, MON, "2026-07-31");
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    const kept = [...used].filter(([d]) => d !== MON).map(([, r]) => r);
    expect(m.volatility).toBeCloseTo(annualVol(kept), 12);
  });

  it("a Saturday go-live with no Saturday row still hits the Friday-to-Monday interval", () => {
    const db = makeDb();
    const used = writeSeries(db, 1, (d, i) => (d === MON ? JUMP : baseReturn(i)));
    statementAnchors(db, 1);
    anchor(db, 1, SAT, "plaid");
    plaidAnchors(db, 1, MON, "2026-07-31");
    const m = computeRiskMetrics(db, { ...OPTS, accountIds: [1] });
    const kept = [...used].filter(([d]) => d !== MON).map(([, r]) => r);
    expect(m.volatility).toBeCloseTo(annualVol(kept), 12);
  });

  it("gives the same result whether the first anchor sits on the Saturday or on the Friday before", () => {
    // Real moves on Friday and Monday are equal, so the two datings leave the
    // same set of returns after the one interval holding the step is out.
    const REAL = 0.003;
    const realOn = (d: string, i: number) => (d === FRI || d === MON ? REAL : baseReturn(i));

    // Before the repair: the step lands on the Saturday row.
    const before = makeDb();
    writeSeries(before, 1, realOn);
    const fri = (before.prepare("SELECT total_value AS v FROM daily_valuations WHERE valuation_date = ?").get(FRI) as { v: number }).v;
    valuation(before, 1, SAT, fri * Math.exp(JUMP));
    before
      .prepare("UPDATE daily_valuations SET total_value = total_value * ? WHERE valuation_date >= ?")
      .run(Math.exp(JUMP), MON);
    statementAnchors(before, 1);
    anchor(before, 1, SAT, "plaid");
    plaidAnchors(before, 1, MON, "2026-07-31");

    // After the repair: the step lands on Friday; Saturday carries Friday.
    const after = makeDb();
    writeSeries(after, 1, (d, i) => (d === FRI ? REAL + JUMP : realOn(d, i)));
    const fri2 = (after.prepare("SELECT total_value AS v FROM daily_valuations WHERE valuation_date = ?").get(FRI) as { v: number }).v;
    valuation(after, 1, SAT, fri2);
    statementAnchors(after, 1);
    plaidAnchors(after, 1, FRI, "2026-07-31");

    expect(fetchGoLiveDatesForScope(before, [1])).toEqual([SAT]);
    expect(fetchGoLiveDatesForScope(after, [1])).toEqual([FRI]);
    const a = computeRiskMetrics(before, { ...OPTS, accountIds: [1] });
    const b = computeRiskMetrics(after, { ...OPTS, accountIds: [1] });
    expect(a.volatility).not.toBeNull();
    expect(a.volatility).toBeCloseTo(b.volatility!, 12);
    expect(a.sharpeRatio).toBeCloseTo(b.sharpeRatio!, 12);
  });
});

describe("computeRiskMetrics: two-account scope", () => {
  const GO_LIVE = "2026-07-15";

  it("a go-live on one account drops that interval from the summed series; the other account alone keeps it", () => {
    const db = makeDb();
    writeSeries(db, 1, (d, i) => (d === GO_LIVE ? JUMP : baseReturn(i)));
    const usedB = writeSeries(db, 2, (_d, i) => baseReturn(i + 5) * 0.5);
    statementAnchors(db, 1);
    plaidAnchors(db, 1, GO_LIVE, "2026-07-31");
    statementAnchors(db, 2);

    const rows = db
      .prepare(
        "SELECT valuation_date AS d, SUM(total_value) AS v FROM daily_valuations GROUP BY valuation_date ORDER BY valuation_date"
      )
      .all() as { d: string; v: number }[];
    const combined: [string, number][] = [];
    for (let i = 1; i < rows.length; i++) combined.push([rows[i].d, Math.log(rows[i].v / rows[i - 1].v)]);

    const both = computeRiskMetrics(db, { ...OPTS, accountIds: [1, 2] });
    expect(both.volatility).toBeCloseTo(
      annualVol(combined.filter(([d]) => d !== GO_LIVE).map(([, r]) => r)),
      12
    );
    const all = computeRiskMetrics(db, { ...OPTS, accountIds: undefined });
    expect(all.volatility).toBeCloseTo(both.volatility!, 12);

    const onlyB = computeRiskMetrics(db, { ...OPTS, accountIds: [2] });
    expect(onlyB.volatility).toBeCloseTo(annualVol([...usedB.values()]), 12);
  });
});

// ─── Beta ───────────────────────────────────────────────────────

describe("beta: the go-live interval is out of the market regression", () => {
  const GO_LIVE = "2026-07-15";
  const BENCH_CYCLE = [0.01, -0.006, 0.008, 0.003, -0.004, 0.007, 0.002, -0.005, 0.009, -0.002];

  /** Portfolio = 1,000 x SPY exactly, times a one-off 1.08 step from the go-live on. */
  function seed(opts: { withPlaid: boolean; missingBenchmark?: string }): Database.Database {
    const db = makeDb();
    let close = 400;
    for (let i = 0; i < DAYS.length; i++) {
      const d = DAYS[i];
      if (i > 0) close *= 1 + BENCH_CYCLE[i % BENCH_CYCLE.length];
      if (d !== opts.missingBenchmark) benchmark(db, d, close);
      valuation(db, 1, d, close * 1000 * (d >= GO_LIVE ? 1.08 : 1));
    }
    statementAnchors(db, 1);
    if (opts.withPlaid) plaidAnchors(db, 1, GO_LIVE, "2026-07-31");
    return db;
  }

  it("an aligned interval spanning the go-live over a missing benchmark date is excluded", () => {
    const db = seed({ withPlaid: true, missingBenchmark: GO_LIVE });
    const reg = computeFactorAnalysis(db, { accountIds: [1] }).marketRegression!;
    expect(reg).not.toBeNull();
    expect(reg.beta).toBeCloseTo(1, 10);
    expect(reg.rSquared).toBeCloseTo(1, 10);
    // One aligned interval fewer than the benchmark-aligned pairs.
    expect(reg.dataPoints).toBe(DAYS.length - 1 - 1 - 1);
  });

  it("a go-live on a benchmark date is excluded the same way", () => {
    const reg = computeFactorAnalysis(seed({ withPlaid: true }), { accountIds: [1] }).marketRegression!;
    expect(reg.beta).toBeCloseTo(1, 10);
    expect(reg.dataPoints).toBe(DAYS.length - 1 - 1);
  });

  it("with no live source the step is in the regression (control)", () => {
    const reg = computeFactorAnalysis(seed({ withPlaid: false, missingBenchmark: GO_LIVE }), {
      accountIds: [1],
    }).marketRegression!;
    expect(reg.rSquared).toBeLessThan(0.99);
    expect(reg.dataPoints).toBe(DAYS.length - 1 - 1);
  });

  it("period attribution: beta leaves the step out, the decomposed return keeps it", () => {
    const db = seed({ withPlaid: true });
    const r = computePeriodAttribution(db, [1], "2026-07-01", "2026-07-31", "SPY");
    expect(r.decomposedReturn).not.toBeNull();
    const closes = db
      .prepare("SELECT date, close_price AS c FROM benchmark_prices WHERE date BETWEEN '2026-07-01' AND '2026-07-31' ORDER BY date")
      .all() as { date: string; c: number }[];
    const benchReturn = closes[closes.length - 1].c / closes[0].c - 1;
    // Beta 1 exactly: beta contribution is the benchmark's own return.
    expect(r.betaVsAlpha.betaContribution).toBeCloseTo(benchReturn, 10);
    // The decomposed return still carries the 1.08 step; alpha holds it.
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo((1 + benchReturn) * 1.08 - 1, 10);
    expect(r.betaVsAlpha.alphaContribution).toBeCloseTo((1 + benchReturn) * 0.08, 10);
  });
});
