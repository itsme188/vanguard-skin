import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";
import {
  preflightStatementFile,
  findUnusualAssetCategoryRows,
  countExistingSourceKeys,
  getBatchSanity,
  getClosingCensus,
  ensureBackup,
} from "@/scripts/rebuild-ibkr-ledger";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db); // seeds accounts: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  return db;
}

function getIbkrAccountId(db: Database.Database): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }
  ).id;
}

function ensureSecurity(db: Database.Database, symbol: string): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')"
  ).run(symbol, symbol);
  return (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as {
      id: number;
    }
  ).id;
}

// ─── preflightStatementFile ───────────────────────────────────────

describe("preflightStatementFile", () => {
  it("passes a genuine Activity Statement fixture (Period line + >=1 Trades,Data,Order row)", () => {
    const good =
      'Statement,Header,Field Name,Field Value\n' +
      'Statement,Data,BrokerName,Interactive Brokers LLC\n' +
      'Statement,Data,Title,Activity Statement\n' +
      'Statement,Data,Period,"January 1, 2025 - January 31, 2025"\n' +
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
      'Trades,Data,Order,Stocks,USD,AAPL,"2025-01-10, 10:30:00",100,190,195,-19000,-1,19001,0,0,O\n';

    const result = preflightStatementFile(good);
    expect(result.ok).toBe(true);
    expect(result.period).toBe("January 1, 2025 - January 31, 2025");
    expect(result.tradeRows).toBe(1);
  });

  it("fails a sectionless MTM Summary fixture — Period line present but NO Trades section at all", () => {
    // Mirrors the real ~/Desktop/Trading - Local/IBKR MTM 2024/*.csv files
    // (`Statement,Data,Title,MTM Summary`): these carry a valid Period line
    // but never a Trades section — the exact trap this preflight guards
    // against (a human could otherwise mistake one for a real activity
    // statement and silently import zero trades for a whole month).
    const mtm =
      'Statement,Header,Field Name,Field Value\n' +
      'Statement,Data,BrokerName,Interactive Brokers LLC\n' +
      'Statement,Data,Title,MTM Summary\n' +
      'Statement,Data,Period,"February 1, 2024 - February 29, 2024"\n' +
      "Account Information,Header,Field Name,Field Value\n" +
      "Account Information,Data,Name,Isaac Safier\n" +
      "Mark-to-Market Performance Summary,Header,Asset Category,Symbol,Prior Quantity,Current Quantity,Prior Price,Current Price,Mark-to-Market P/L Position,Mark-to-Market P/L Transaction,Mark-to-Market P/L Commissions,Mark-to-Market P/L Other,Mark-to-Market P/L Total,Code\n" +
      "Mark-to-Market Performance Summary,Data,Stocks,AAPL,100,100,190.00,195.50,550,0,0,0,550,\n";

    const result = preflightStatementFile(mtm);
    expect(result.ok).toBe(false);
    expect(result.period).toBe("February 1, 2024 - February 29, 2024");
    expect(result.tradeRows).toBe(0);
  });

  it("fails when Trades rows exist but there is no Statement,Data,Period line", () => {
    const noPeriod =
      "Statement,Header,Field Name,Field Value\n" +
      "Statement,Data,BrokerName,Interactive Brokers LLC\n" +
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
      'Trades,Data,Order,Stocks,USD,AAPL,"2025-01-10, 10:30:00",100,190,195,-19000,-1,19001,0,0,O\n';

    const result = preflightStatementFile(noPeriod);
    expect(result.ok).toBe(false);
    expect(result.period).toBeNull();
    expect(result.tradeRows).toBe(1);
  });

  it("fails on a completely empty file", () => {
    const result = preflightStatementFile("");
    expect(result.ok).toBe(false);
    expect(result.period).toBeNull();
    expect(result.tradeRows).toBe(0);
  });

  it("counts multiple Trades,Data,Order rows", () => {
    const multi =
      'Statement,Header,Field Name,Field Value\n' +
      'Statement,Data,Period,"March 1, 2026 - March 31, 2026"\n' +
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
      'Trades,Data,Order,Stocks,USD,AAPL,"2026-03-03, 10:00:00",100,200,200,-20000,-1,20001,0,0,O\n' +
      'Trades,Data,Order,Stocks,USD,MSFT,"2026-03-05, 10:00:00",50,400,405,-20000,-1,20001,0,0,O\n' +
      "Trades,Data,Total,,,,,,,,,,-40000,-2,40002,0,0,\n";

    const result = preflightStatementFile(multi);
    expect(result.ok).toBe(true);
    expect(result.tradeRows).toBe(2); // Total row must not count
  });
});

// ─── findUnusualAssetCategoryRows ──────────────────────────────────

describe("findUnusualAssetCategoryRows", () => {
  const HEADER =
    'Statement,Header,Field Name,Field Value\n' +
    'Statement,Data,Period,"February 1, 2025 - February 28, 2025"\n';

  it("flags Forex and ForecastEx rows but not ordinary stock trades", () => {
    const trades =
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
      'Trades,Data,Order,Forex,USD,EUR.USD,"2025-02-01, 09:00:00",1000,1.05,1.06,-1050,-1,1051,0,0,O\n' +
      'Trades,Data,Order,Forecast Contracts by ForecastEx,USD,ELECTION-2028,"2025-02-02, 09:00:00",10,0.5,0.6,-5,-0.1,5.1,0,0,O\n' +
      'Trades,Data,Order,Stocks,USD,AAPL,"2025-02-03, 09:00:00",50,190,195,-9500,-1,9501,0,0,O\n';

    const parsed = parseIbkrActivity(HEADER + trades, "test.csv");
    const unusual = findUnusualAssetCategoryRows(parsed);

    expect(unusual).toHaveLength(2);
    const symbols = unusual.map((u) => u.symbol).sort();
    expect(symbols).toEqual(["ELECTION-2028", "EUR.USD"]);

    const forex = unusual.find((u) => u.symbol === "EUR.USD")!;
    expect(forex.securityType).toBe("Forex");
    expect(forex.transactionCount).toBe(1);

    const forecast = unusual.find((u) => u.symbol === "ELECTION-2028")!;
    expect(forecast.securityType).toBe("Forecast Contracts by ForecastEx");
    expect(forecast.transactionCount).toBe(1);

    // AAPL must not appear
    expect(unusual.some((u) => u.symbol === "AAPL")).toBe(false);
  });

  it("returns an empty array when every row is an ordinary stock/option trade", () => {
    const trades =
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
      'Trades,Data,Order,Stocks,USD,AAPL,"2025-02-03, 09:00:00",50,190,195,-9500,-1,9501,0,0,O\n';
    const parsed = parseIbkrActivity(HEADER + trades, "test.csv");
    expect(findUnusualAssetCategoryRows(parsed)).toHaveLength(0);
  });
});

// ─── countExistingSourceKeys ────────────────────────────────────────

describe("countExistingSourceKeys", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("counts only the keys that already exist in transactions", () => {
    const ibkrId = getIbkrAccountId(db);
    const secId = ensureSecurity(db, "AAPL");
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, '2025-01-10', 'BUY', 100, -19000, 'ibkr:trade:2025-01-10:AAPL:100:-19000')`
    ).run(ibkrId, secId);

    const count = countExistingSourceKeys(db, [
      "ibkr:trade:2025-01-10:AAPL:100:-19000", // exists
      "ibkr:trade:2025-01-11:MSFT:50:-20000", // does not exist
      "ibkr:trade:2025-01-12:GOOG:10:-1000", // does not exist
    ]);
    expect(count).toBe(1);
  });

  it("returns 0 for an empty key list", () => {
    expect(countExistingSourceKeys(db, [])).toBe(0);
  });
});

// ─── getBatchSanity ─────────────────────────────────────────────────

describe("getBatchSanity", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("counts transactions and reports the date span for a given batch id", () => {
    const ibkrId = getIbkrAccountId(db);
    const secId = ensureSecurity(db, "AAPL");
    db.prepare(
      "INSERT INTO import_batches (id, source_type) VALUES (17, 'canonical-csv')"
    ).run();
    const insert = db.prepare(
      `INSERT INTO transactions (account_id, security_id, import_batch_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, 17, ?, 'BUY', 10, -1000, ?)`
    );
    insert.run(ibkrId, secId, "2024-03-01", "canonical:txn:1");
    insert.run(ibkrId, secId, "2025-06-15", "canonical:txn:2");
    insert.run(ibkrId, secId, "2024-12-31", "canonical:txn:3");

    const sanity = getBatchSanity(db, 17);
    expect(sanity.count).toBe(3);
    expect(sanity.minDate).toBe("2024-03-01");
    expect(sanity.maxDate).toBe("2025-06-15");
  });

  it("reports zero/null for a batch with no rows", () => {
    const sanity = getBatchSanity(db, 999);
    expect(sanity.count).toBe(0);
    expect(sanity.minDate).toBeNull();
    expect(sanity.maxDate).toBeNull();
  });
});

// ─── getClosingCensus ───────────────────────────────────────────────

describe("getClosingCensus", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("breaks down IBKR transactions by type and reports negative-hpd + RECONCILE_CLOSE counts", () => {
    const ibkrId = getIbkrAccountId(db);
    const secId = ensureSecurity(db, "AAPL");
    const insert = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, ?, ?, 10, -1000, ?)`
    );
    insert.run(ibkrId, secId, "2025-01-01", "BUY", "k1");
    insert.run(ibkrId, secId, "2025-01-05", "BUY", "k2");
    insert.run(ibkrId, secId, "2025-01-10", "SELL", "k3");
    insert.run(ibkrId, secId, "2025-02-01", "RECONCILE_CLOSE", "k4");

    // A negative-holding-period tax_lot_sales row (short round-trip) —
    // needs a matching tax_lots + transactions row to satisfy FKs.
    const lotTxnId = (
      db
        .prepare(
          `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
           VALUES (?, ?, '2025-01-15', 'SELL_TO_OPEN', 10, 1000, 'k5')`
        )
        .run(ibkrId, secId) as { lastInsertRowid: number }
    ).lastInsertRowid;
    const lotId = (
      db
        .prepare(
          `INSERT INTO tax_lots
             (security_id, account_id, acquisition_transaction_id, acquisition_date,
              acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
           VALUES (?, ?, ?, '2025-01-15', 100, 10, 0, 1000, 1)`
        )
        .run(secId, ibkrId, lotTxnId) as { lastInsertRowid: number }
    ).lastInsertRowid;
    const saleTxnId = (
      db
        .prepare(
          `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
           VALUES (?, ?, '2025-01-12', 'BUY_TO_COVER', 10, -900, 'k6')`
        )
        .run(ibkrId, secId) as { lastInsertRowid: number }
    ).lastInsertRowid;
    db.prepare(
      `INSERT INTO tax_lot_sales
         (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, 10, 90, 900, 1000, -100, 0, -3, '2025-01-12')`
    ).run(lotId, saleTxnId);

    const census = getClosingCensus(db);

    const byType = Object.fromEntries(census.byType.map((r) => [r.type, r.count]));
    expect(byType["BUY"]).toBe(2);
    expect(byType["SELL"]).toBe(1);
    expect(byType["RECONCILE_CLOSE"]).toBe(1);
    // the two synthetic lot-forming rows (SELL_TO_OPEN + BUY_TO_COVER) also count
    expect(byType["SELL_TO_OPEN"]).toBe(1);
    expect(byType["BUY_TO_COVER"]).toBe(1);

    expect(census.negativeHpdCount).toBe(1);
    expect(census.reconcileCloseCount).toBe(1);
  });

  it("reports all zeros on an empty ledger", () => {
    const census = getClosingCensus(db);
    expect(census.byType).toHaveLength(0);
    expect(census.negativeHpdCount).toBe(0);
    expect(census.reconcileCloseCount).toBe(0);
  });
});

// ─── ensureBackup ───────────────────────────────────────────────────

describe("ensureBackup", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-rebuild-backup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the backup file (and its parent directory) on first call", () => {
    const backupPath = path.join(tmpDir, "backups", "pre-ibkr-rebuild-2026-08-03.db");
    expect(fs.existsSync(backupPath)).toBe(false);

    const result = ensureBackup(db, backupPath);
    expect(result.created).toBe(true);
    expect(result.path).toBe(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sizeBytes).toBe(fs.statSync(backupPath).size);
  });

  it("treats an already-existing VALID backup file as satisfied instead of failing", () => {
    // VACUUM INTO throws "output file already exists" on a second write to
    // the same path — this is exactly the same-ET-day dry-run-then-apply
    // scenario Task 7's runbook produces.
    const backupPath = path.join(tmpDir, "backups", "pre-ibkr-rebuild-2026-08-03.db");
    const first = ensureBackup(db, backupPath);
    expect(first.created).toBe(true);

    const second = ensureBackup(db, backupPath);
    expect(second.created).toBe(false);
    expect(second.path).toBe(backupPath);
    expect(second.sizeBytes).toBe(first.sizeBytes);
  });

  it("throws instead of trusting a 0-byte existing backup file (interrupted prior write)", () => {
    // A 0-byte file opens fine as a valid *empty* SQLite database and
    // PRAGMA integrity_check reports "ok" on it (verified live) — the
    // explicit size check is what catches this case; integrity_check
    // alone would not.
    const backupPath = path.join(tmpDir, "backups", "pre-ibkr-rebuild-2026-08-03.db");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, "");

    expect(() => ensureBackup(db, backupPath)).toThrow(/0 bytes/i);
  });

  it("throws instead of trusting a corrupted (non-empty, non-SQLite) existing backup file", () => {
    const backupPath = path.join(tmpDir, "backups", "pre-ibkr-rebuild-2026-08-03.db");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(
      backupPath,
      "this is not a sqlite database, just garbage bytes padding the file to nonzero size"
    );

    expect(() => ensureBackup(db, backupPath)).toThrow(/not a database|integrity_check/i);
  });
});
