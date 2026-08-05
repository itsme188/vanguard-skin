import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { computePositionRisk, isSplitSignatureReturnPair } from "@/lib/compute/risk";

function createTestDb(): Database.Database {
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
  `);

  db.prepare("INSERT INTO accounts (id, name) VALUES (1, 'Test Account')").run();
  return db;
}

/** Insert consecutive weekday-ish daily closes starting at a base date. */
function insertDailySeries(
  db: Database.Database,
  securityId: number,
  closes: number[],
): void {
  const stmt = db.prepare(
    "INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)",
  );
  const start = new Date("2026-01-05T00:00:00Z");
  let offset = 0;
  for (const close of closes) {
    const d = new Date(start.getTime() + offset * 86_400_000);
    // Skip weekends so consecutive rows stay within the 7-day gap guard.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      offset += 1;
      d.setTime(start.getTime() + offset * 86_400_000);
    }
    stmt.run(securityId, d.toISOString().slice(0, 10), close);
    offset += 1;
  }
}

describe("isSplitSignatureReturnPair", () => {
  it("flags an 8:1 forward split (the VGT signature)", () => {
    expect(isSplitSignatureReturnPair(809.96, 101.57)).toBe(true);
  });

  it("flags a reverse split (price jumps up by an integer multiple)", () => {
    expect(isSplitSignatureReturnPair(10.02, 100.1)).toBe(true);
  });

  it("keeps a genuine -30% crash day (ratio not near an integer >= 2)", () => {
    expect(isSplitSignatureReturnPair(100, 70)).toBe(false);
  });

  it("keeps ordinary daily moves", () => {
    expect(isSplitSignatureReturnPair(100, 98)).toBe(false);
    expect(isSplitSignatureReturnPair(100, 103)).toBe(false);
  });

  it("does not flag a 3:2 split-sized move (below the 2x magnitude floor)", () => {
    expect(isSplitSignatureReturnPair(100, 66.7)).toBe(false);
  });

  it("rejects non-positive inputs", () => {
    expect(isSplitSignatureReturnPair(0, 100)).toBe(false);
    expect(isSplitSignatureReturnPair(100, 0)).toBe(false);
  });
});

describe("computePositionRisk split-signature guard", () => {
  it("excludes an unadjusted 8:1 split day from volatility", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO securities (id, symbol, name) VALUES (1, 'VGT', 'Vanguard IT ETF')",
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, '2026-06-01', 100)",
    ).run();

    // ~1% alternating daily moves, then an unadjusted 8:1 split cliff,
    // then more mild moves at the post-split scale.
    const closes: number[] = [];
    let p = 800;
    for (let i = 0; i < 60; i++) {
      p = p * (i % 2 === 0 ? 1.01 : 0.99);
      closes.push(Number(p.toFixed(2)));
    }
    const preSplit = closes[closes.length - 1];
    let q = preSplit / 8; // split day: exact 8:1 discontinuity
    closes.push(Number(q.toFixed(2)));
    for (let i = 0; i < 60; i++) {
      q = q * (i % 2 === 0 ? 1.01 : 0.99);
      closes.push(Number(q.toFixed(2)));
    }
    insertDailySeries(db, 1, closes);

    const result = computePositionRisk(db, { topN: 5 });
    const vgt = result.positions.find((pos) => pos.symbol === "VGT");
    expect(vgt).toBeDefined();
    expect(vgt!.annualizedVol).not.toBeNull();
    // Unguarded, the single log(1/8) return annualizes to ~200%+ vol.
    // With the split pair dropped, the mild series sits well under 50%.
    expect(vgt!.annualizedVol!).toBeLessThan(0.5);
  });

  it("exempts options: a premium that exactly halves stays in the series", () => {
    // Option premiums legitimately double/halve day-over-day (ratio 2.0 sits
    // dead-center in the guard's band) and options never split in-series —
    // the guard must not silently understate option risk.
    const db = createTestDb();
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, multiplier) VALUES (3, 'INTC  260717C00030000', 'INTC call', 'Option', 100)",
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 3, '2026-06-01', 10)",
    ).run();

    const closes: number[] = [];
    let p = 15.6;
    for (let i = 0; i < 60; i++) {
      p = p * (i % 2 === 0 ? 1.01 : 0.99);
      closes.push(Number(p.toFixed(2)));
    }
    const preDrop = closes[closes.length - 1];
    let q = preDrop / 2; // exact 2.0 ratio — split-shaped, but a real premium move
    closes.push(Number(q.toFixed(2)));
    for (let i = 0; i < 60; i++) {
      q = q * (i % 2 === 0 ? 1.01 : 0.99);
      closes.push(Number(q.toFixed(2)));
    }
    insertDailySeries(db, 3, closes);

    const result = computePositionRisk(db, { topN: 5 });
    const opt = result.positions.find((pos) => pos.symbol.startsWith("INTC "));
    expect(opt).toBeDefined();
    expect(opt!.annualizedVol).not.toBeNull();
    // With the halving day KEPT, vol is far above the mild-series baseline.
    // (If the split guard wrongly applied, this sits under 0.5.)
    expect(opt!.annualizedVol!).toBeGreaterThan(0.5);
  });

  it("keeps a genuine large one-day move in the volatility", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO securities (id, symbol, name) VALUES (2, 'INTC', 'Intel')",
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, '2026-06-01', 100)",
    ).run();

    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 60; i++) {
      p = p * (i % 2 === 0 ? 1.005 : 0.995);
      closes.push(Number(p.toFixed(2)));
    }
    const preCrash = closes[closes.length - 1];
    let q = preCrash * 0.7; // real -30% day, not split-shaped
    closes.push(Number(q.toFixed(2)));
    for (let i = 0; i < 60; i++) {
      q = q * (i % 2 === 0 ? 1.005 : 0.995);
      closes.push(Number(q.toFixed(2)));
    }
    insertDailySeries(db, 2, closes);

    const result = computePositionRisk(db, { topN: 5 });
    const intc = result.positions.find((pos) => pos.symbol === "INTC");
    expect(intc).toBeDefined();
    expect(intc!.annualizedVol).not.toBeNull();
    // The -30% day must remain in the series: vol should be well above the
    // ~8% the mild moves alone would produce.
    expect(intc!.annualizedVol!).toBeGreaterThan(0.3);
  });
});
