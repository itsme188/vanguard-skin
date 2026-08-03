import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { repairAcatsOpeningLots } from "@/scripts/repair-acats-opening-lots";

/** The 4 auto rows the Jan-2024 ACATS import creates (Task 1's parser). */
const AUTO_ROWS = [
  { symbol: "SQQQ", qty: 2500, amount: 37100.0 },
  { symbol: "TQQQ", qty: 150, amount: 6871.5 },
  { symbol: "TTD", qty: 150, amount: 9450.0 },
  { symbol: "UCO", qty: 350, amount: 12250.0 },
];

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db); // seeds accounts: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  return db;
}

function getIbkrAccountId(db: Database.Database): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
}

function ensureSecurity(db: Database.Database, symbol: string): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')"
  ).run(symbol, symbol);
  return (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number }).id;
}

/** Seeds the 4 auto ibkr:xfer:2024-01-05:* rows the parser produces. */
function seedAutoAcatsRows(db: Database.Database, rows: typeof AUTO_ROWS = AUTO_ROWS): void {
  const ibkrId = getIbkrAccountId(db);
  for (const row of rows) {
    const secId = ensureSecurity(db, row.symbol);
    db.prepare(
      `INSERT INTO transactions
         (account_id, security_id, trade_date, type, quantity, amount, price_per_share,
          is_external_flow, source_key)
       VALUES (?, ?, '2024-01-05', 'TRANSFER_IN', ?, ?, ?, 1, ?)`
    ).run(ibkrId, secId, row.qty, row.amount, row.amount / row.qty, `ibkr:xfer:2024-01-05:${row.symbol}:${row.qty}:In`);
  }
}

function transferInRows(db: Database.Database) {
  return db
    .prepare(
      "SELECT trade_date, quantity, amount, source_key, notes FROM transactions WHERE type='TRANSFER_IN' ORDER BY trade_date, quantity"
    )
    .all() as Array<{ trade_date: string; quantity: number; amount: number; source_key: string; notes: string | null }>;
}

describe("repairAcatsOpeningLots", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("replaces the 4 auto ACATS rows with 9 worksheet lots (idempotent)", () => {
    seedAutoAcatsRows(db);
    const r1 = repairAcatsOpeningLots(db, { apply: true });
    expect(r1.deleted).toBe(4);
    expect(r1.inserted).toBe(9);
    expect(r1.skipped).toHaveLength(0);

    const lots = transferInRows(db);
    expect(lots).toHaveLength(9);

    // spot-check one: SQQQ 500 @ 2023-12-22, basis 8873.79
    const sqqq500 = lots.find((l) => l.trade_date === "2023-12-22" && l.quantity === 500);
    expect(sqqq500).toBeTruthy();
    expect(sqqq500!.amount).toBeCloseTo(8873.79, 2);
    expect(sqqq500!.source_key).toBe("ibkr:xferlot:2023-12-22:SQQQ:500");
    expect(sqqq500!.notes).toBe(
      "ACATS from Robinhood 2024-01-05; basis per IBKR Form 8949 worksheet 2024"
    );

    // spot-check the two same-day TTD lots stay distinct
    const ttdLots = lots.filter((l) => l.source_key.includes("TTD"));
    expect(ttdLots).toHaveLength(2);
    expect(ttdLots.some((l) => l.quantity === 50 && Math.abs(l.amount - 3762.5) < 0.01)).toBe(true);
    expect(ttdLots.some((l) => l.quantity === 100 && Math.abs(l.amount - 7525.0) < 0.01)).toBe(true);

    // the 4 auto rows are gone
    const autoRemaining = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE source_key LIKE 'ibkr:xfer:2024-01-05:%:In'")
      .get() as { n: number };
    expect(autoRemaining.n).toBe(0);

    // idempotent: second run is a no-op
    const r2 = repairAcatsOpeningLots(db, { apply: true });
    expect(r2.deleted).toBe(0);
    expect(r2.inserted).toBe(0);
    expect(transferInRows(db)).toHaveLength(9);
  });

  it("computes price_per_share as basis/qty for every inserted lot", () => {
    seedAutoAcatsRows(db);
    repairAcatsOpeningLots(db, { apply: true });
    const rows = db
      .prepare("SELECT quantity, amount, price_per_share FROM transactions WHERE type='TRANSFER_IN'")
      .all() as Array<{ quantity: number; amount: number; price_per_share: number }>;
    for (const r of rows) {
      expect(r.price_per_share).toBeCloseTo(r.amount / r.quantity, 6);
    }
  });

  it("dry-run (apply:false) reports the plan without writing", () => {
    seedAutoAcatsRows(db);
    const result = repairAcatsOpeningLots(db, { apply: false });
    expect(result.deleted).toBe(4);
    expect(result.inserted).toBe(9);
    expect(result.skipped).toHaveLength(0);

    // Nothing actually changed
    const autoRows = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE source_key LIKE 'ibkr:xfer:2024-01-05:%:In'")
      .get() as { n: number };
    expect(autoRows.n).toBe(4);
    expect(transferInRows(db)).toHaveLength(4); // still just the 4 auto rows (they're TRANSFER_IN too)

    const curatedRows = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE source_key LIKE 'ibkr:xferlot:%'")
      .get() as { n: number };
    expect(curatedRows.n).toBe(0);
  });

  it("never touches a same-symbol row for a different direction (LIKE anchors on the :In suffix)", () => {
    seedAutoAcatsRows(db);
    // A hypothetical outbound leg on the same date/symbol that must survive.
    const ibkrId = getIbkrAccountId(db);
    const secId = ensureSecurity(db, "SQQQ");
    db.prepare(
      `INSERT INTO transactions
         (account_id, security_id, trade_date, type, quantity, amount, price_per_share,
          is_external_flow, source_key)
       VALUES (?, ?, '2024-01-05', 'TRANSFER_OUT', 10, -148.40, 14.84, 1, ?)`
    ).run(ibkrId, secId, "ibkr:xfer:2024-01-05:SQQQ:10:Out");

    repairAcatsOpeningLots(db, { apply: true });

    const survivor = db
      .prepare("SELECT 1 FROM transactions WHERE source_key = ?")
      .get("ibkr:xfer:2024-01-05:SQQQ:10:Out");
    expect(survivor).toBeTruthy();
  });

  it("skips a symbol whose security is missing, without throwing, and still repairs the rest", () => {
    // Seed auto rows only for SQQQ, TTD, UCO — never create TQQQ at all.
    seedAutoAcatsRows(db, AUTO_ROWS.filter((r) => r.symbol !== "TQQQ"));

    const result = repairAcatsOpeningLots(db, { apply: true });

    expect(result.skipped.some((s) => s.includes("TQQQ"))).toBe(true);
    // 3 auto rows deleted (SQQQ/TTD/UCO); 8 curated lots inserted (4+2+2)
    expect(result.deleted).toBe(3);
    expect(result.inserted).toBe(8);

    const lots = transferInRows(db);
    expect(lots.every((l) => !l.source_key.includes("TQQQ"))).toBe(true);
  });

  it("reports a missing IBKR account gracefully instead of throwing", () => {
    db.prepare("DELETE FROM accounts WHERE name = 'IBKR'").run();
    const result = repairAcatsOpeningLots(db, { apply: true });
    expect(result.deleted).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});
