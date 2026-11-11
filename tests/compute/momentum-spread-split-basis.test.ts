import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeMomentumPulse } from "@/lib/compute/momentum-spread";
import { splitAdjustCloses } from "@/lib/compute/split-adjust-series";

/**
 * QA finding: a 4:1 benchmark split inside the 30-session window read as a
 * -75% move because benchmark_prices keeps pre-split rows on the old share
 * basis (the incremental fetch never rewrites them). The pulse must read the
 * series on one basis. Synthetic figures throughout.
 */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'test',
      UNIQUE(symbol, date)
    );
  `);
  return db;
}

function dateDaysAgo(i: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - i);
  return d.toISOString().slice(0, 10);
}

/** Seed `days` closes ending today; `basis(i)` scales the stored row (1 = as is). */
function seed(
  db: Database.Database,
  symbol: string,
  start: number,
  dailyReturn: number,
  basis: (daysAgo: number) => number = () => 1,
  days = 35,
): void {
  const stmt = db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)",
  );
  for (let i = days; i >= 0; i--) {
    const trueClose = start * Math.pow(1 + dailyReturn, days - i);
    stmt.run(symbol, dateDaysAgo(i), trueClose * basis(i));
  }
}

describe("momentum pulse across a benchmark split", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("reads a 4:1 split inside the 30-session window on one share basis", () => {
    // Every series drifts +0.05%/day; MTUM's rows older than 12 days are
    // stored on the pre-split basis (4x the true close).
    seed(db, "SPY", 500, 0.0005);
    seed(db, "MTUM", 80, 0.0005, (i) => (i >= 12 ? 4 : 1));
    seed(db, "SPMO", 100, 0.0005);
    seed(db, "USMV", 90, 0.0005);

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    // Same drift as SPY → spread ≈ 0 on every window, not -75%.
    expect(Math.abs(result!.spreads.mtum_vs_spy.return30d)).toBeLessThan(0.001);
    expect(Math.abs(result!.spreads.mtum_vs_spy.return5d)).toBeLessThan(0.001);
    expect(result!.status).toBe("neutral");
  });

  it("leaves a genuine large move alone when the ratio is not an integer", () => {
    // A real -40% day on the benchmark (ratio 0.6) is a move, not a split.
    seed(db, "SPY", 500, 0.0005);
    seed(db, "MTUM", 80, 0.0005, (i) => (i >= 12 ? 1 / 0.6 : 1));
    seed(db, "SPMO", 100, 0.0005);
    seed(db, "USMV", 90, 0.0005);

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.spreads.mtum_vs_spy.return30d).toBeLessThan(-0.3);
  });
});

describe("splitAdjustCloses", () => {
  const rows = (closes: number[]) =>
    closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, close_price: c }));

  it("divides every close before a forward split by the integer ratio", () => {
    const out = splitAdjustCloses(rows([400, 404, 101, 102]));
    expect(out.map((r) => r.close_price)).toEqual([100, 101, 101, 102]);
    expect(out.map((r) => r.date)).toEqual(rows([0, 0, 0, 0]).map((r) => r.date));
  });

  it("multiplies every close before a reverse split by the integer ratio", () => {
    const out = splitAdjustCloses(rows([10, 10.1, 30.3, 30.6]));
    expect(out.map((r) => Number(r.close_price.toFixed(6)))).toEqual([30, 30.3, 30.3, 30.6]);
  });

  it("tolerates a same-day move of up to 1.5% around the integer ratio", () => {
    // 4:1 split on a day the fund also fell 1%: 400 → 99.
    const out = splitAdjustCloses(rows([400, 99]));
    expect(out[0].close_price).toBe(100);
  });

  it("does not treat a 1.5x gap or a 3.41x gap as a split", () => {
    expect(splitAdjustCloses(rows([150, 100])).map((r) => r.close_price)).toEqual([150, 100]);
    expect(splitAdjustCloses(rows([450.41, 131.9])).map((r) => r.close_price)).toEqual([450.41, 131.9]);
  });

  it("handles two splits in one series and an empty series", () => {
    const out = splitAdjustCloses(rows([800, 400, 100]));
    expect(out.map((r) => r.close_price)).toEqual([100, 100, 100]);
    expect(splitAdjustCloses([])).toEqual([]);
  });
});
