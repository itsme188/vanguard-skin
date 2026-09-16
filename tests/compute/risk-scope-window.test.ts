import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { commonCoverageStart } from "@/lib/queries/daily-valuations";

/**
 * Risk window: two modes, one per surface.
 *
 * Deep-QA finding (2026-08-19): on /dashboard/analysis?view=diagnostics the
 * All-Accounts volatility rendered LOWER than every single constituent
 * account's, which reads as mathematically impossible. Root cause: the
 * full-coverage predicate self-calibrates its start date PER SCOPE, so each
 * scope started at its own coverage onset — three different windows behind
 * one card. The fix floored every scope's window at commonCoverageStart(db):
 * the earliest date from which ALL accounts have coverage (= the latest
 * per-account coverage start).
 *
 * Deep-QA finding + user ruling (2026-09-14, docs/DECISIONS.md): that floor
 * is right for the CROSS-SCOPE COMPARISON surface only. On Performance
 * (/dashboard/analysis?view=performance) nothing is compared across scopes —
 * one scope's tiles are read on their own — so flooring there silently threw
 * away a long-history account's real drawdown/Sharpe/volatility and made the
 * risk caption name a DIFFERENT account's start than the equity curve beside
 * it. Ruling: "Performance risk tiles use the scope's own daily history; the
 * cross-scope common floor from 2026-08-19 applies only to the diagnostics
 * comparison surface."
 *
 * So `RiskOptions.coverageFloor` splits the two: `"common"` (the DEFAULT —
 * diagnostics, the narratives) keeps the floor; `"scope"` (Performance) lets
 * the scope's own full-coverage history stand. An explicit startDate applies
 * in both modes. All synthetic dates/values below.
 */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date)
    );

    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      UNIQUE(account_id, valuation_date)
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      trade_date TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL,
      is_external_flow INTEGER DEFAULT 0
    );
  `);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'IBKR'), (2, 'Vanguard Taxable'), (3, 'Vanguard Roth IRA')");
  return db;
}

/** N consecutive YYYY-MM-DD dates starting at 2025-06-02. */
function makeDates(n: number): string[] {
  const out: string[] = [];
  const d = new Date("2025-06-02T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function seedValuations(
  db: Database.Database,
  accountId: number,
  dates: string[],
  value: (i: number) => number
) {
  const stmt = db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
  );
  for (let i = 0; i < dates.length; i++) {
    stmt.run(accountId, dates[i], value(i), value(i));
  }
}

// ── Staggered coverage: the live shape (IBKR long, Vanguard short) ────

const DATES = makeDates(120);
const VANGUARD_START = 60;
const ROTH_START = 70; // latest per-account start → the common floor

function seedStaggeredDb(): Database.Database {
  const db = createTestDb();
  // Account 1 (IBKR): full 120-day history, choppy.
  seedValuations(db, 1, DATES, (i) => 100_000 + Math.sin(i * 0.7) * 12_000);
  // Account 2 (Vanguard Taxable): last 60 days, gently rising.
  seedValuations(db, 2, DATES.slice(VANGUARD_START), (i) => 200_000 + i * 400);
  // Account 3 (Roth): last 50 days, gently rising.
  seedValuations(db, 3, DATES.slice(ROTH_START), (i) => 50_000 + i * 120);
  return db;
}

describe("scope-invariant risk window", () => {
  it("every scope measures the same window start when accounts begin on different dates", () => {
    const db = seedStaggeredDb();
    const floor = DATES[ROTH_START];
    expect(commonCoverageStart(db)).toBe(floor);

    const all = computeRiskMetrics(db);
    const ibkr = computeRiskMetrics(db, { accountIds: [1] });
    const vanguard = computeRiskMetrics(db, { accountIds: [2] });
    const roth = computeRiskMetrics(db, { accountId: 3 });

    // Pre-fix: ibkr started at DATES[0], vanguard at DATES[60], all at
    // DATES[70] — three windows, one card.
    expect(all.seriesStart).toBe(floor);
    expect(ibkr.seriesStart).toBe(floor);
    expect(vanguard.seriesStart).toBe(floor);
    expect(roth.seriesStart).toBe(floor);

    const lastDate = DATES[DATES.length - 1];
    for (const m of [all, ibkr, vanguard, roth]) {
      expect(m.seriesEnd).toBe(lastDate);
      expect(m.dataPoints).toBe(DATES.length - ROTH_START);
    }
  });

  it("all-scope volatility is measured over the same observations as each constituent", () => {
    const db = seedStaggeredDb();
    const all = computeRiskMetrics(db);
    const ibkr = computeRiskMetrics(db, { accountIds: [1] });

    expect(all.volatility).not.toBeNull();
    expect(ibkr.volatility).not.toBeNull();
    // Same window ⇒ same observation count feeding the vol estimate.
    expect(all.dataPoints).toBe(ibkr.dataPoints);
  });

  it("an explicit startDate later than the floor still wins (the floor never widens the window)", () => {
    const db = seedStaggeredDb();
    const requested = DATES[90];
    const result = computeRiskMetrics(db, { accountIds: [1], startDate: requested });

    expect(result.seriesStart).toBe(requested);
    expect(result.dataPoints).toBe(DATES.length - 90);
  });

  it("an explicit startDate earlier than the floor is raised to the floor", () => {
    const db = seedStaggeredDb();
    const result = computeRiskMetrics(db, { accountIds: [1], startDate: DATES[0] });

    expect(result.seriesStart).toBe(DATES[ROTH_START]);
  });

  it('coverageFloor: "common" is the explicit spelling of the default', () => {
    const db = seedStaggeredDb();
    const floor = DATES[ROTH_START];

    for (const scope of [undefined, { accountIds: [1] }, { accountIds: [2] }, { accountId: 3 }]) {
      const explicit = computeRiskMetrics(db, { ...scope, coverageFloor: "common" });
      expect(explicit.seriesStart).toBe(floor);
      expect(explicit.dataPoints).toBe(DATES.length - ROTH_START);
    }
  });
});

// ── The 2026-09-14 split: coverageFloor: "scope" ──────────────────────

describe('coverageFloor: "scope" measures the scope\'s own daily history', () => {
  it("a single-account scope keeps its own (longer) coverage start", () => {
    const db = seedStaggeredDb();

    const long = computeRiskMetrics(db, { accountIds: [1], coverageFloor: "scope" });
    const mid = computeRiskMetrics(db, { accountIds: [2], coverageFloor: "scope" });
    const short = computeRiskMetrics(db, { accountId: 3, coverageFloor: "scope" });

    // Each scope now opens at its OWN first covered date, not the latest
    // per-account start across the whole book.
    expect(long.seriesStart).toBe(DATES[0]);
    expect(mid.seriesStart).toBe(DATES[VANGUARD_START]);
    expect(short.seriesStart).toBe(DATES[ROTH_START]);

    expect(long.dataPoints).toBe(DATES.length);
    expect(mid.dataPoints).toBe(DATES.length - VANGUARD_START);
    expect(short.dataPoints).toBe(DATES.length - ROTH_START);

    const lastDate = DATES[DATES.length - 1];
    for (const m of [long, mid, short]) expect(m.seriesEnd).toBe(lastDate);
  });

  it("the longer-history scope's risk metrics are computed from its whole series", () => {
    // Local seed: account 1 carries a deep trough BEFORE the common floor and
    // a merely choppy tail after it, so the floored window demonstrably
    // understates the account's own max drawdown.
    const db = createTestDb();
    const deepThenChoppy = (i: number) =>
      i < 40 ? 100_000 - i * 1_000 : 60_000 + (i - 40) * 200 + Math.sin(i * 0.7) * 3_000;
    seedValuations(db, 1, DATES, deepThenChoppy);
    seedValuations(db, 2, DATES.slice(VANGUARD_START), (i) => 200_000 + i * 400);
    seedValuations(db, 3, DATES.slice(ROTH_START), (i) => 50_000 + i * 120);

    const floored = computeRiskMetrics(db, { accountIds: [1], coverageFloor: "common" });
    const own = computeRiskMetrics(db, { accountIds: [1], coverageFloor: "scope" });

    // Same account, strictly more observations behind the vol/Sharpe estimate.
    expect(own.dataPoints).toBeGreaterThan(floored.dataPoints);
    expect(own.volatility).not.toBeNull();
    expect(own.maxDrawdown).not.toBeNull();
    expect(floored.maxDrawdown).not.toBeNull();
    // The floored window starts after the trough, so it misses the real fall.
    expect(own.maxDrawdown!.percent).toBeGreaterThan(floored.maxDrawdown!.percent);
    expect(own.maxDrawdown!.peakDate < DATES[ROTH_START]).toBe(true);
  });

  it("scope=all is identical in both modes (its own coverage start IS the common floor)", () => {
    const db = seedStaggeredDb();

    const common = computeRiskMetrics(db, { coverageFloor: "common" });
    const own = computeRiskMetrics(db, { coverageFloor: "scope" });

    expect(own.seriesStart).toBe(common.seriesStart);
    expect(own.seriesStart).toBe(DATES[ROTH_START]);
    expect(own.seriesEnd).toBe(common.seriesEnd);
    expect(own.dataPoints).toBe(common.dataPoints);
    expect(own.volatility).toBe(common.volatility);
    expect(own.sharpeRatio).toBe(common.sharpeRatio);
  });

  it("an explicit startDate still applies in scope mode", () => {
    const db = seedStaggeredDb();
    const requested = DATES[30];

    const result = computeRiskMetrics(db, {
      accountIds: [1],
      startDate: requested,
      coverageFloor: "scope",
    });

    // Later than the scope's own coverage start, earlier than the common
    // floor: scope mode honours it verbatim instead of raising it.
    expect(result.seriesStart).toBe(requested);
    expect(result.dataPoints).toBe(DATES.length - 30);
  });

  it("a startDate before the scope's own coverage cannot invent history", () => {
    const db = seedStaggeredDb();

    const result = computeRiskMetrics(db, {
      accountId: 3,
      startDate: DATES[0],
      coverageFloor: "scope",
    });

    expect(result.seriesStart).toBe(DATES[ROTH_START]);
    expect(result.dataPoints).toBe(DATES.length - ROTH_START);
  });
});

describe("risk window unchanged when every account starts on the same date", () => {
  it("keeps the full series (no floor truncation) and the same metrics", () => {
    const db = createTestDb();
    const dates = DATES.slice(0, 60);
    seedValuations(db, 1, dates, (i) => 100_000 + Math.sin(i * 0.7) * 12_000);
    seedValuations(db, 2, dates, (i) => 200_000 + i * 400);

    expect(commonCoverageStart(db)).toBe(dates[0]);

    const all = computeRiskMetrics(db);
    const acct1 = computeRiskMetrics(db, { accountId: 1 });

    expect(all.seriesStart).toBe(dates[0]);
    expect(all.seriesEnd).toBe(dates[dates.length - 1]);
    expect(all.dataPoints).toBe(60);
    expect(acct1.seriesStart).toBe(dates[0]);
    expect(acct1.dataPoints).toBe(60);
    expect(all.volatility).not.toBeNull();
    expect(acct1.volatility).not.toBeNull();
  });

  it("a single-account database is unaffected by the floor", () => {
    const db = createTestDb();
    const dates = DATES.slice(0, 45);
    seedValuations(db, 1, dates, (i) => 100_000 + Math.sin(i * 0.5) * 5_000);

    const result = computeRiskMetrics(db, { accountId: 1 });
    expect(result.seriesStart).toBe(dates[0]);
    expect(result.seriesEnd).toBe(dates[dates.length - 1]);
    expect(result.dataPoints).toBe(45);
  });
});
