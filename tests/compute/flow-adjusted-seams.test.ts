import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchAnchorSourceSeamDates, buildFlowAdjustedIndex } from "@/lib/compute/flow-adjusted";
import { computeRiskMetrics } from "@/lib/compute/risk";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      month_end_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      source TEXT
    );
  `);
  return db;
}

function insertAnchor(
  db: Database.Database,
  accountId: number,
  date: string,
  source: string | null
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, 100000, ?)`
  ).run(accountId, date, source);
}

describe("fetchAnchorSourceSeamDates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("emits the newer anchor date when source changes between adjacent anchors", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("emits nothing for same-source runs", () => {
    insertAnchor(db, 1, "2026-07-11", "plaid");
    insertAnchor(db, 1, "2026-07-13", "plaid");
    insertAnchor(db, 1, "2026-07-14", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });

  it("never treats an account's first anchor as a seam", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });

  it("detects a transition whose predecessor anchor is before startDate", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    // startDate sits between the two anchors — predecessor is out of window
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-07-05", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("bounds results to (startDate, endDate]", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    insertAnchor(db, 1, "2026-07-31", "canonical");
    // seam ON startDate is excluded (already inside starting value)
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-07-11", "2026-07-31")
    ).toEqual(["2026-07-31"]);
    // seam after endDate is excluded
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-07-15")
    ).toEqual(["2026-07-11"]);
  });

  it("unions, dedupes, and sorts across accounts", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-31", "plaid");
    insertAnchor(db, 2, "2026-06-30", "canonical");
    insertAnchor(db, 2, "2026-07-11", "plaid");
    insertAnchor(db, 2, "2026-07-31", "plaid");
    // account 1 seams: 07-31; account 2 seams: 07-11
    expect(
      fetchAnchorSourceSeamDates(db, [1, 2], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11", "2026-07-31"]);
  });

  it("treats undefined/empty accountIds as all accounts", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, undefined, "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
    expect(
      fetchAnchorSourceSeamDates(db, [], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("treats NULL source as a distinct value (transition to/from it bridges)", () => {
    insertAnchor(db, 1, "2026-05-31", "canonical");
    insertAnchor(db, 1, "2026-06-30", null);
    insertAnchor(db, 1, "2026-07-31", "canonical");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-06-30", "2026-07-31"]);
  });

  it("returns [] when monthly_snapshots does not exist", () => {
    const bare = new Database(":memory:");
    expect(
      fetchAnchorSourceSeamDates(bare, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });
});

describe("buildFlowAdjustedIndex seam bridging", () => {
  const series = [
    { date: "2026-07-09", value: 100_000 },
    { date: "2026-07-10", value: 101_000 },
    { date: "2026-07-11", value: 105_000 }, // fake +4% seam step
    { date: "2026-07-13", value: 104_000 },
  ];

  it("carries the index flat across a seam day and emits no return for it", () => {
    const { index, returns, bridgedDays } = buildFlowAdjustedIndex(
      series,
      [],
      ["2026-07-11"]
    );
    expect(bridgedDays).toBe(1);
    // 07-10 return computed normally
    expect(returns.map((r) => r.date)).toEqual(["2026-07-10", "2026-07-13"]);
    // index flat across the bridge
    const i10 = index.find((p) => p.date === "2026-07-10")!.value;
    const i11 = index.find((p) => p.date === "2026-07-11")!.value;
    expect(i11).toBe(i10);
    // next day's return divides by the RAW 07-11 value (104000/105000), so
    // the index resumes from the bridged level with a real market move
    const i13 = index.find((p) => p.date === "2026-07-13")!.value;
    expect(i13).toBeCloseTo(i10 * (104_000 / 105_000), 10);
  });

  it("is byte-identical to the 2-arg call when seamDates is empty", () => {
    const withFlows = [{ date: "2026-07-10", net: 500 }];
    const a = buildFlowAdjustedIndex(series, withFlows);
    const b = buildFlowAdjustedIndex(series, withFlows, []);
    expect(b.index).toEqual(a.index);
    expect(b.returns).toEqual(a.returns);
    expect(a.bridgedDays).toBe(0);
    expect(b.bridgedDays).toBe(0);
  });

  it("consumes a flow inside a bridged interval without leaking it forward", () => {
    const flows = [{ date: "2026-07-11", net: 2_000 }];
    const { index, returns } = buildFlowAdjustedIndex(series, flows, ["2026-07-11"]);
    // 07-11 bridged: no return; 07-13 growth is 104000/105000 — the 07-11
    // flow must NOT be re-subtracted from 07-13's numerator
    expect(returns.map((r) => r.date)).toEqual(["2026-07-10", "2026-07-13"]);
    const i10 = index.find((p) => p.date === "2026-07-10")!.value;
    const i13 = index.find((p) => p.date === "2026-07-13")!.value;
    expect(i13).toBeCloseTo(i10 * (104_000 / 105_000), 10);
  });

  it("bridges once when multiple seams fall in one interval", () => {
    // weekend: valuation rows only on 07-10 and 07-13; seams 07-11 + 07-12
    const gappy = [
      { date: "2026-07-10", value: 100_000 },
      { date: "2026-07-13", value: 108_000 },
      { date: "2026-07-14", value: 109_000 },
    ];
    const { returns, bridgedDays } = buildFlowAdjustedIndex(
      gappy,
      [],
      ["2026-07-11", "2026-07-12"]
    );
    expect(bridgedDays).toBe(1);
    expect(returns.map((r) => r.date)).toEqual(["2026-07-14"]);
  });

  it("ignores a seam on the series' first date", () => {
    const { returns, bridgedDays } = buildFlowAdjustedIndex(
      series,
      [],
      ["2026-07-09"]
    );
    expect(bridgedDays).toBe(0);
    expect(returns).toHaveLength(3);
  });
});

// ─── Integration: computeRiskMetrics seam awareness ────────────────
//
// Schema copied from tests/compute/risk.test.ts's createTestDb(), plus the
// monthly_snapshots supplement from the task-3 brief. The risk suite's own
// fixture has NO monthly_snapshots table at all, so its seamDates always
// resolve [] via fetchAnchorSourceSeamDates's missing-table guard — that's
// why the existing risk tests stay green unchanged by this feature.

function createRiskSchemaDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

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
      cost_basis REAL,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      UNIQUE(account_id, valuation_date),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      trade_date TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL,
      is_external_flow INTEGER DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      month_end_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      source TEXT
    );
  `);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test Account')");
  return db;
}

/** YYYY-MM-DD offset by `days` from 2025-01-02 — same anchor as
 *  tests/compute/risk.test.ts's makeDate, kept local to avoid a
 *  cross-file import for a one-line date helper. */
function riskDate(days: number): string {
  const y = 2025;
  let d = 2 + days;
  let m = 0;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  while (d > monthDays[m]) {
    d -= monthDays[m];
    m++;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function seedValuations(db: Database.Database, values: number[]): void {
  const stmt = db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)"
  );
  for (let i = 0; i < values.length; i++) {
    stmt.run(riskDate(i), values[i], values[i]);
  }
}

// The 07-11-shape series: rise-with-noise for 30 days, then a +4%
// single-day step at day 30 with NO flow row (the seam — a fake source-
// transition "market move"), then decline. The decline puts the
// CONTAMINATED (non-seam-aware) run's max-drawdown peak exactly on the step
// day and its trough in the days after — the shape the third test exercises.
const SEAM_DATE = riskDate(30);

function buildSeamValues(): number[] {
  const values: number[] = [];
  for (let i = 0; i < 40; i++) {
    if (i < 30) {
      values.push(100_000 + i * 40 + Math.sin(i * 0.9) * 90);
    } else if (i === 30) {
      values.push(values[29] * 1.04);
    } else {
      values.push(values[30] * (1 - (i - 30) * 0.006));
    }
  }
  return values;
}

function makeRiskDb(): Database.Database {
  const db = createRiskSchemaDb();
  seedValuations(db, buildSeamValues());
  // Anchor rows: canonical up to the step date's predecessor era, plaid
  // from the step date — the source transition IS the seam.
  insertAnchor(db, 1, riskDate(29), "canonical");
  insertAnchor(db, 1, SEAM_DATE, "plaid");
  return db;
}

function makeRiskDbWithoutSourceChange(): Database.Database {
  const db = createRiskSchemaDb();
  seedValuations(db, buildSeamValues());
  // Identical values; both anchors stay 'canonical' — no source transition,
  // so the +4% step is NOT bridged and contaminates vol like a real return.
  insertAnchor(db, 1, riskDate(29), "canonical");
  insertAnchor(db, 1, SEAM_DATE, "canonical");
  return db;
}

function makeRiskDbManySeams(): Database.Database {
  const db = createRiskSchemaDb();
  // 31 valuation days (passes the seriesLength >= 30 gate).
  const values = Array.from({ length: 31 }, (_, i) => 100_000 + Math.sin(i * 0.7) * 50);
  seedValuations(db, values);
  // Constant source for days 0-19 (no seams there), then alternate every
  // day from day 20 through day 30 — 11 dates, each differing from its
  // predecessor, so every one of those 11 consecutive-day pairs is a seam.
  // Clean returns = 30 pairs - 11 bridged = 19 < 20.
  for (let i = 0; i <= 19; i++) {
    insertAnchor(db, 1, riskDate(i), "A");
  }
  for (let i = 20; i <= 30; i++) {
    insertAnchor(db, 1, riskDate(i), i % 2 === 0 ? "B" : "A");
  }
  return db;
}

describe("computeRiskMetrics seam awareness (07-11 shape)", () => {
  it("excludes the seam day from vol and reports seamDaysBridged", () => {
    const withSeam = computeRiskMetrics(makeRiskDb());
    expect(withSeam.seamDaysBridged).toBe(1);

    const contaminated = computeRiskMetrics(makeRiskDbWithoutSourceChange());
    expect(contaminated.seamDaysBridged).toBe(0);
    // the fake +4% observation inflates vol in the control only
    expect(withSeam.volatility!).toBeLessThan(contaminated.volatility!);
  });

  it("keeps seam-free series byte-identical (seamDaysBridged 0)", () => {
    const result = computeRiskMetrics(makeRiskDbWithoutSourceChange());
    expect(result.seamDaysBridged).toBe(0);
  });

  it("never places a drawdown peak or trough ON the seam day", () => {
    const m = computeRiskMetrics(makeRiskDb());
    expect(m.maxDrawdown?.peakDate).not.toBe(SEAM_DATE);
    expect(m.maxDrawdown?.troughDate).not.toBe(SEAM_DATE);
  });

  it("returns null vol/Sharpe when bridging drops clean returns below 20", () => {
    const m = computeRiskMetrics(makeRiskDbManySeams());
    expect(m.volatility).toBeNull();
    expect(m.sharpeRatio).toBeNull();
    expect(m.seamDaysBridged).toBe(11);
  });
});
