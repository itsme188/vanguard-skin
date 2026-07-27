import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { upsertSecurity } from "@/lib/mutations/securities";
import { parseVanguardCostBasis } from "@/lib/import/parsers/vanguard-cost-basis";

// Load test fixtures
const fixturesDir = path.join(__dirname, "..", "fixtures");
const ibkrActivityCsv = fs.readFileSync(
  path.join(fixturesDir, "ibkr-activity-sample.csv"),
  "utf-8"
);
const ibkrHoldingsCsv = fs.readFileSync(
  path.join(fixturesDir, "ibkr-holdings-sample.csv"),
  "utf-8"
);
const vanguardHoldingsCsv = fs.readFileSync(
  path.join(fixturesDir, "vanguard-holdings-sample.csv"),
  "utf-8"
);
const monthlyValuesCsv = fs.readFileSync(
  path.join(fixturesDir, "monthly-values-sample.csv"),
  "utf-8"
);

describe("import engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("parseImport", () => {
    it("detects and parses IBKR activity CSV", async () => {
      const result = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );
      expect(result.sourceType).toBe("ibkr-activity");
      expect(result.transactions.length).toBeGreaterThan(0);
      expect(result.snapshots.length).toBe(1);
    });

    it("detects and parses IBKR holdings CSV", async () => {
      const result = await parseImport(
        ibkrHoldingsCsv,
        "ibkr-holdings.csv"
      );
      expect(result.sourceType).toBe("ibkr-holdings");
      expect(result.holdings.length).toBeGreaterThan(0);
    });

    it("detects and parses Vanguard holdings CSV", async () => {
      const result = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );
      expect(result.sourceType).toBe("vanguard-holdings");
      expect(result.holdings.length).toBeGreaterThan(0);
      expect(result.securities.length).toBeGreaterThan(0);
    });

    it("detects and parses monthly values CSV", async () => {
      const result = await parseImport(
        monthlyValuesCsv,
        "monthly-values.csv"
      );
      expect(result.sourceType).toBe("monthly-values");
      expect(result.snapshots.length).toBeGreaterThan(0);
    });

    it("returns error for unknown format", async () => {
      const result = await parseImport("random,data\n1,2", "unknown.csv");
      expect(result.sourceType).toBe("unknown");
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("commitImport", () => {
    it("commits IBKR activity to database", async () => {
      const parsed = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );
      const result = commitImport(db, parsed);

      expect(result.batchId).toBeGreaterThan(0);
      expect(result.newTransactions).toBeGreaterThan(0);
      expect(result.newSnapshots).toBe(1);
      expect(result.recordCount).toBeGreaterThan(0);

      // Verify data in DB
      const txnCount = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      expect(txnCount).toBe(result.newTransactions);

      // Verify import batch was created
      const batch = db
        .prepare("SELECT * FROM import_batches WHERE id = ?")
        .get(result.batchId) as { status: string; record_count: number };
      expect(batch.status).toBe("completed");
      expect(batch.record_count).toBe(result.recordCount);
    });

    it("commits Vanguard holdings to database", async () => {
      const parsed = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );
      const result = commitImport(db, parsed);

      expect(result.newHoldings).toBeGreaterThan(0);
      expect(result.newSecurities).toBeGreaterThan(0);
      expect(result.newPrices).toBeGreaterThan(0);

      // Verify securities in DB
      const secCount = (
        db.prepare("SELECT COUNT(*) as c FROM securities").get() as {
          c: number;
        }
      ).c;
      expect(secCount).toBeGreaterThanOrEqual(result.newSecurities);
    });

    it("commits monthly snapshots to database", async () => {
      const parsed = await parseImport(
        monthlyValuesCsv,
        "monthly-values.csv"
      );
      const result = commitImport(db, parsed);

      expect(result.newSnapshots).toBeGreaterThan(0);

      const snapCount = (
        db.prepare("SELECT COUNT(*) as c FROM monthly_snapshots").get() as {
          c: number;
        }
      ).c;
      expect(snapCount).toBe(result.newSnapshots);
    });

    it("stores raw import data", async () => {
      const parsed = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );
      const result = commitImport(db, parsed);

      const rawCount = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM raw_imports WHERE import_batch_id = ?"
          )
          .get(result.batchId) as { c: number }
      ).c;
      expect(rawCount).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("re-importing same data creates no duplicates", async () => {
      const parsed = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );

      const first = commitImport(db, parsed);
      const second = commitImport(db, parsed);

      // Second import should skip all records as duplicates
      expect(second.newTransactions).toBe(0);
      expect(second.newSnapshots).toBe(0);
      expect(second.skippedDuplicates).toBeGreaterThan(0);

      // DB should have same count as first import
      const txnCount = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      expect(txnCount).toBe(first.newTransactions);
    });

    it("re-importing holdings skips duplicates", async () => {
      const parsed = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );

      commitImport(db, parsed);
      const second = commitImport(db, parsed);

      expect(second.newHoldings).toBe(0);
      expect(second.skippedDuplicates).toBeGreaterThan(0);
    });
  });

  describe("undoImport", () => {
    it("removes all records from a batch", async () => {
      const parsed = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );
      const result = commitImport(db, parsed);

      // Verify data exists
      const txnsBefore = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      expect(txnsBefore).toBeGreaterThan(0);

      // Undo
      undoImport(db, result.batchId);

      // Verify data is gone
      const txnsAfter = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      expect(txnsAfter).toBe(0);

      const batchGone = db
        .prepare("SELECT * FROM import_batches WHERE id = ?")
        .get(result.batchId);
      expect(batchGone).toBeUndefined();
    });

    it("only removes records from the specified batch", async () => {
      // Import two different files
      const parsed1 = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );
      const parsed2 = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );

      const result1 = commitImport(db, parsed1);
      const result2 = commitImport(db, parsed2);

      // Undo only the first import
      undoImport(db, result1.batchId);

      // First batch's transactions should be gone
      const txns = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      expect(txns).toBe(0);

      // Second batch's holdings should remain
      const holdings = (
        db.prepare("SELECT COUNT(*) as c FROM holdings").get() as {
          c: number;
        }
      ).c;
      expect(holdings).toBe(result2.newHoldings);
    });

    it("regenerates tax lots and valuations after undo instead of leaving the derived layer wiped", async () => {
      const parsed1 = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );
      const parsed2 = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );
      commitImport(db, parsed1);
      const result2 = commitImport(db, parsed2);

      computeTaxLots(db);
      const lotsBefore = (
        db.prepare("SELECT COUNT(*) as c FROM tax_lots").get() as { c: number }
      ).c;
      expect(lotsBefore).toBeGreaterThan(0);

      // Undo the holdings batch — unrelated to the transactions that back the lots
      undoImport(db, result2.batchId);

      // deleteImportBatch wipes tax_lots wholesale; undoImport must regenerate
      // them from the surviving transactions
      const lotsAfter = (
        db.prepare("SELECT COUNT(*) as c FROM tax_lots").get() as { c: number }
      ).c;
      expect(lotsAfter).toBe(lotsBefore);
    });
  });

  describe("price source priority", () => {
    it("higher-priority source overwrites lower-priority price", () => {
      // First insert a vanguard price
      const secId = db.prepare(
        "INSERT INTO securities (symbol, name) VALUES ('TEST', 'Test Inc') RETURNING id",
      ).get() as { id: number };

      const batch1 = db.prepare(
        "INSERT INTO import_batches (source_type, filename, status, record_count) VALUES ('vanguard-holdings', 'test.csv', 'completed', 1) RETURNING id",
      ).get() as { id: number };

      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source, import_batch_id) VALUES (?, '2025-03-15', 100.0, 'vanguard-holdings', ?)",
      ).run(secId.id, batch1.id);

      // Now import via engine with ibkr-activity source (higher priority)
      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "ibkr-activity",
        sourceName: "test-priority.csv",
        transactions: [],
        securities: [{ symbol: "TEST", name: "Test Inc" }],
        holdings: [],
        prices: [
          { symbol: "TEST", date: "2025-03-15", closePrice: 105.0, source: "ibkr-activity" },
        ],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);
      expect(result.newPrices).toBe(1);

      const price = db.prepare(
        "SELECT close_price, source FROM prices WHERE security_id = ? AND date = '2025-03-15'",
      ).get(secId.id) as { close_price: number; source: string };

      expect(price.close_price).toBe(105.0);  // ibkr overwrote vanguard
      expect(price.source).toBe("ibkr-activity");
    });

    it("lower-priority source does NOT overwrite higher-priority price", () => {
      // First insert a TWS price (highest priority)
      const secId = db.prepare(
        "INSERT INTO securities (symbol, name) VALUES ('TEST2', 'Test2 Inc') RETURNING id",
      ).get() as { id: number };

      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-03-15', 110.0, 'tws')",
      ).run(secId.id);

      // Now try to import a vanguard price (lower priority)
      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "vanguard-holdings",
        sourceName: "test-priority.csv",
        transactions: [],
        securities: [{ symbol: "TEST2", name: "Test2 Inc" }],
        holdings: [],
        prices: [
          { symbol: "TEST2", date: "2025-03-15", closePrice: 100.0, source: "vanguard-holdings" },
        ],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);
      // The price should be "skipped" because TWS has higher priority
      expect(result.newPrices).toBe(0);

      const price = db.prepare(
        "SELECT close_price, source FROM prices WHERE security_id = ? AND date = '2025-03-15'",
      ).get(secId.id) as { close_price: number; source: string };

      expect(price.close_price).toBe(110.0);  // TWS price unchanged
      expect(price.source).toBe("tws");
    });

    it("derived prices inherit the parser sourceType (not hardcoded 'canonical')", () => {
      // Regression: engine.ts used to emit `source: "canonical"` (priority 4)
      // for every holding-derived price, regardless of the parser. A stale
      // "manual" price (also priority 4) would then survive a fresh Vanguard
      // PDF import because both rows had equal priority. Now derived prices
      // inherit the sourceType so vanguard-pdf → priority 3, ibkr-* → 2, etc.
      const secId = db.prepare(
        "INSERT INTO securities (symbol, name) VALUES ('DERIV', 'Derived Inc') RETURNING id",
      ).get() as { id: number };

      db.prepare(
        "INSERT INTO accounts (name) VALUES ('Roth')",
      ).run();

      // Seed a stale "manual" (priority 4) price.
      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-03-15', 50.0, 'manual')",
      ).run(secId.id);

      // Import a Vanguard PDF whose holding has marketValue → the engine
      // derives a price. vanguard-pdf is priority 3, which must beat manual (4).
      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "vanguard-pdf",
        sourceName: "vanguard-derived.pdf",
        transactions: [],
        securities: [{ symbol: "DERIV", name: "Derived Inc" }],
        holdings: [
          {
            accountName: "Roth",
            symbol: "DERIV",
            quantity: 10,
            marketValue: 600,
            asOfDate: "2025-03-15",
            sourceKey: "deriv:2025-03-15",
          },
        ],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      commitImport(db, parsed);

      const price = db.prepare(
        "SELECT close_price, source FROM prices WHERE security_id = ? AND date = '2025-03-15'",
      ).get(secId.id) as { close_price: number; source: string };

      expect(price.source).toBe("vanguard-pdf");
      expect(price.close_price).toBe(60.0);
    });

    it("derives option prices from market value without double-counting the multiplier", () => {
      db.prepare("INSERT INTO accounts (name) VALUES ('Roth')").run();

      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "vanguard-pdf",
        sourceName: "vanguard-options.pdf",
        transactions: [],
        securities: [
          {
            symbol: "AAPL  260619C00180000",
            name: "AAPL Jun 2026 180 Call",
            securityType: "Option",
            multiplier: 100,
          },
        ],
        holdings: [
          {
            accountName: "Roth",
            symbol: "AAPL  260619C00180000",
            quantity: 5,
            marketValue: 1750,
            asOfDate: "2025-03-15",
            sourceKey: "option:2025-03-15",
          },
        ],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      commitImport(db, parsed);

      const price = db
        .prepare(
          `SELECT p.close_price
           FROM prices p
           JOIN securities s ON s.id = p.security_id
           WHERE s.symbol = 'AAPL  260619C00180000'`,
        )
        .get() as { close_price: number };

      expect(price.close_price).toBe(3.5);
    });

    it("derives bond prices using percent-of-par pricing", () => {
      db.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run();

      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "vanguard-pdf",
        sourceName: "vanguard-bonds.pdf",
        transactions: [],
        securities: [
          {
            symbol: "9128285M8",
            name: "US Treasury",
            securityType: "Bond",
          },
        ],
        holdings: [
          {
            accountName: "Taxable",
            symbol: "9128285M8",
            quantity: 10000,
            marketValue: 9850,
            asOfDate: "2025-03-15",
            sourceKey: "bond:2025-03-15",
          },
        ],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      commitImport(db, parsed);

      const price = db
        .prepare(
          `SELECT p.close_price
           FROM prices p
           JOIN securities s ON s.id = p.security_id
           WHERE s.symbol = '9128285M8'`,
        )
        .get() as { close_price: number };

      expect(price.close_price).toBe(98.5);
    });

    it("does not let a holding-derived price replace an explicit same-import price", () => {
      db.prepare("INSERT INTO accounts (name) VALUES ('Roth')").run();

      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "vanguard-pdf",
        sourceName: "vanguard-explicit-price.pdf",
        transactions: [],
        securities: [
          {
            symbol: "AAPL  260619C00180000",
            name: "AAPL Jun 2026 180 Call",
            securityType: "Option",
            multiplier: 100,
          },
        ],
        holdings: [
          {
            accountName: "Roth",
            symbol: "AAPL  260619C00180000",
            quantity: 5,
            marketValue: 1750,
            asOfDate: "2025-03-15",
            sourceKey: "option-explicit:2025-03-15",
          },
        ],
        prices: [
          {
            symbol: "AAPL  260619C00180000",
            date: "2025-03-15",
            closePrice: 3.6,
            source: "vanguard-pdf",
          },
        ],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);

      const price = db
        .prepare(
          `SELECT p.close_price
           FROM prices p
           JOIN securities s ON s.id = p.security_id
           WHERE s.symbol = 'AAPL  260619C00180000'`,
        )
        .get() as { close_price: number };

      expect(result.newPrices).toBe(1);
      expect(price.close_price).toBe(3.6);
    });

    it("same-source re-import updates price (idempotent)", () => {
      // Insert a vanguard price
      const secId = db.prepare(
        "INSERT INTO securities (symbol, name) VALUES ('TEST3', 'Test3 Inc') RETURNING id",
      ).get() as { id: number };

      const batch1 = db.prepare(
        "INSERT INTO import_batches (source_type, filename, status, record_count) VALUES ('vanguard-holdings', 'test.csv', 'completed', 1) RETURNING id",
      ).get() as { id: number };

      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source, import_batch_id) VALUES (?, '2025-03-15', 100.0, 'vanguard-holdings', ?)",
      ).run(secId.id, batch1.id);

      // Re-import with same source but different price
      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "vanguard-holdings",
        sourceName: "test-reissue.csv",
        transactions: [],
        securities: [{ symbol: "TEST3", name: "Test3 Inc" }],
        holdings: [],
        prices: [
          { symbol: "TEST3", date: "2025-03-15", closePrice: 102.0, source: "vanguard-holdings" },
        ],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);
      expect(result.newPrices).toBe(1); // should overwrite same-source

      const price = db.prepare(
        "SELECT close_price FROM prices WHERE security_id = ? AND date = '2025-03-15'",
      ).get(secId.id) as { close_price: number };

      expect(price.close_price).toBe(102.0);
    });
  });

  describe("statement-wins-over-tws upserts (regression for 2026-05-04 IBKR April bug)", () => {
    it("statement holdings overwrite earlier TWS-source rows on conflict", () => {
      // Pre-2026-05-04: holdings UPSERT used INSERT OR IGNORE, so a TWS intra-day
      // row written before the statement import (e.g., AMZN 100 at noon) would
      // silently block the statement's end-of-day row (AMZN 160). On April 2026
      // import, 18 of 19 IBKR statement holdings were lost this way.
      db.prepare(
        "INSERT OR IGNORE INTO accounts (id, name) VALUES (3, 'IBKR')"
      ).run();
      db.prepare(
        "INSERT INTO securities (id, symbol, security_type) VALUES (1000, 'AMZN', 'Stock')"
      ).run();

      // 1) TWS sync writes intra-day (e.g., 100 shares at noon)
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
         VALUES (3, 1000, 100, 26000, '2026-04-30', 'tws-3-1000-2026-04-30')`
      ).run();

      // 2) Simulate statement import writing the EOD row (160 shares)
      const insertHolding = db.prepare(`
        INSERT INTO holdings
          (account_id, security_id, quantity, cost_basis, as_of_date, import_batch_id, source_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
          quantity = excluded.quantity,
          cost_basis = excluded.cost_basis,
          import_batch_id = excluded.import_batch_id,
          source_key = excluded.source_key
        WHERE holdings.source_key LIKE 'tws-%'
      `);
      insertHolding.run(3, 1000, 160, 41659.8, "2026-04-30", null, "ibkr:pos:2026-04-30:AMZN");

      const row = db
        .prepare(
          `SELECT quantity, cost_basis, source_key
             FROM holdings
            WHERE account_id = 3 AND security_id = 1000 AND as_of_date = '2026-04-30'`
        )
        .get() as { quantity: number; cost_basis: number; source_key: string };

      expect(row.quantity).toBe(160);
      expect(row.cost_basis).toBe(41659.8);
      expect(row.source_key).toBe("ibkr:pos:2026-04-30:AMZN");
    });

    it("statement holdings re-import is idempotent (statement-vs-statement preserved)", () => {
      // Re-importing the same statement should NOT clobber the existing
      // statement row. The WHERE source_key LIKE 'tws-%' clause means only
      // TWS rows get overwritten; statement rows are preserved.
      db.prepare(
        "INSERT OR IGNORE INTO accounts (id, name) VALUES (3, 'IBKR')"
      ).run();
      db.prepare(
        "INSERT INTO securities (id, symbol, security_type) VALUES (1000, 'AMZN', 'Stock')"
      ).run();

      const insertHolding = db.prepare(`
        INSERT INTO holdings
          (account_id, security_id, quantity, cost_basis, as_of_date, import_batch_id, source_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
          quantity = excluded.quantity,
          cost_basis = excluded.cost_basis,
          import_batch_id = excluded.import_batch_id,
          source_key = excluded.source_key
        WHERE holdings.source_key LIKE 'tws-%'
      `);
      // First statement import
      insertHolding.run(3, 1000, 160, 41659.8, "2026-04-30", null, "ibkr:pos:2026-04-30:AMZN");
      // Pretend a tampered re-import tries to overwrite with different values
      insertHolding.run(3, 1000, 999, 99999, "2026-04-30", null, "ibkr:pos:2026-04-30:AMZN");

      const row = db
        .prepare(
          `SELECT quantity, cost_basis FROM holdings
            WHERE account_id = 3 AND security_id = 1000 AND as_of_date = '2026-04-30'`
        )
        .get() as { quantity: number; cost_basis: number };

      // Original statement values preserved (UPDATE only fires for tws-* source_keys)
      expect(row.quantity).toBe(160);
      expect(row.cost_basis).toBe(41659.8);
    });

    it("statement snapshot overwrites earlier tws-source snapshot row", () => {
      // Same pattern as holdings — engine.ts snapshot upsert uses
      // ON CONFLICT DO UPDATE WHERE source IN ('tws','manual').
      db.prepare(
        "INSERT OR IGNORE INTO accounts (id, name) VALUES (3, 'IBKR')"
      ).run();

      // 1) TWS writes a sparse snapshot (just total_value, no period summary)
      db.prepare(
        `INSERT INTO monthly_snapshots
           (account_id, month_end_date, total_value, source)
         VALUES (3, '2026-04-30', 448941.47, 'tws')`
      ).run();

      // 2) Statement import writes the rich snapshot
      const insertSnapshot = db.prepare(`
        INSERT INTO monthly_snapshots
          (account_id, month_end_date, total_value, source, starting_value,
           mark_to_market, deposits_withdrawals, dividends, interest,
           commissions, fees, other_pnl, twr, investment_gain, import_batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, month_end_date) DO UPDATE SET
          total_value = excluded.total_value,
          source = excluded.source,
          starting_value = excluded.starting_value,
          mark_to_market = excluded.mark_to_market,
          deposits_withdrawals = excluded.deposits_withdrawals,
          dividends = excluded.dividends,
          interest = excluded.interest,
          commissions = excluded.commissions,
          fees = excluded.fees,
          other_pnl = excluded.other_pnl,
          twr = excluded.twr,
          investment_gain = excluded.investment_gain,
          import_batch_id = excluded.import_batch_id
        WHERE monthly_snapshots.source IN ('tws', 'manual')
      `);
      insertSnapshot.run(
        3,
        "2026-04-30",
        449764.24,
        "ibkr-activity",
        525103.95,
        24709.98,
        -100000,
        179.7,
        656.94,
        -323.97,
        -131.36,
        null,
        5.239,
        null,
        null
      );

      const row = db
        .prepare(
          `SELECT source, total_value, starting_value, deposits_withdrawals, twr
             FROM monthly_snapshots
            WHERE account_id = 3 AND month_end_date = '2026-04-30'`
        )
        .get() as {
          source: string;
          total_value: number;
          starting_value: number;
          deposits_withdrawals: number;
          twr: number;
        };

      expect(row.source).toBe("ibkr-activity");
      expect(row.total_value).toBe(449764.24);
      expect(row.starting_value).toBe(525103.95);
      expect(row.deposits_withdrawals).toBe(-100000);
      expect(row.twr).toBe(5.239);
    });
  });

  describe("multi-format import", () => {
    it("imports multiple file types into the same database", async () => {
      // Import IBKR activity (transactions + snapshot)
      const ibkrParsed = await parseImport(
        ibkrActivityCsv,
        "IBKR 2025-01 activity.csv"
      );
      const ibkrResult = commitImport(db, ibkrParsed);

      // Import Vanguard holdings
      const vgParsed = await parseImport(
        vanguardHoldingsCsv,
        "vanguard-holdings.csv"
      );
      const vgResult = commitImport(db, vgParsed);

      // Import monthly values
      const mvParsed = await parseImport(
        monthlyValuesCsv,
        "monthly-values.csv"
      );
      const mvResult = commitImport(db, mvParsed);

      // Verify all imports are in the database
      const batches = db
        .prepare("SELECT COUNT(*) as c FROM import_batches")
        .get() as { c: number };
      expect(batches.c).toBe(3);

      // Check that different data types are present
      const txns = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      expect(txns).toBe(ibkrResult.newTransactions);

      const holdings = (
        db.prepare("SELECT COUNT(*) as c FROM holdings").get() as {
          c: number;
        }
      ).c;
      expect(holdings).toBe(ibkrResult.newHoldings + vgResult.newHoldings);

      // Monthly snapshots from both IBKR activity and monthly values
      const snaps = (
        db.prepare("SELECT COUNT(*) as c FROM monthly_snapshots").get() as {
          c: number;
        }
      ).c;
      expect(snaps).toBe(
        ibkrResult.newSnapshots + mvResult.newSnapshots
      );
    });
  });

  describe("post-commit purge for holdings-snapshot imports", () => {
    it("purges pre-existing expired options when a Vanguard PDF lands", async () => {
      // Seed an account + an expired option in holdings BEFORE the import.
      // Simulates the real scenario: previous month's option position
      // disappeared from this month's Vanguard snapshot.
      const accountId = (
        db.prepare("INSERT INTO accounts (name) VALUES ('vanguard taxable') RETURNING id").get() as { id: number }
      ).id;
      const expiredSecId = (
        db.prepare(
          `INSERT INTO securities (symbol, security_type, expiration_date)
           VALUES ('AAPL  240119C00200000', 'option', '2024-01-19') RETURNING id`,
        ).get() as { id: number }
      ).id;
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
         VALUES (?, ?, 5, '2024-01-15')`,
      ).run(accountId, expiredSecId);

      // Sanity: row is there before import.
      const before = db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number };
      expect(before.c).toBe(1);

      // Import a Vanguard holdings CSV (a holdings-snapshot source type).
      const parsed = await parseImport(vanguardHoldingsCsv, "vanguard-holdings.csv");
      commitImport(db, parsed);

      // Post-commit hook should have purged the pre-existing expired option.
      const expiredStill = db
        .prepare("SELECT COUNT(*) as c FROM holdings WHERE security_id = ?")
        .get(expiredSecId) as { c: number };
      expect(expiredStill.c).toBe(0);
    });

    it("purges pre-existing matured bonds when an ibkr-activity statement lands", async () => {
      const accountId = (
        db.prepare("INSERT INTO accounts (name) VALUES ('ibkr') RETURNING id").get() as { id: number }
      ).id;
      const maturedBondId = (
        db.prepare(
          `INSERT INTO securities (symbol, security_type, maturity_date)
           VALUES ('912797TH0', 'bond', '2026-04-14') RETURNING id`,
        ).get() as { id: number }
      ).id;
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
         VALUES (?, ?, 1000, '2026-04-30')`,
      ).run(accountId, maturedBondId);

      const before = db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number };
      expect(before.c).toBe(1);

      const parsed = await parseImport(ibkrActivityCsv, "IBKR 2026-04 activity.csv");
      commitImport(db, parsed);

      const maturedStill = db
        .prepare("SELECT COUNT(*) as c FROM holdings WHERE security_id = ?")
        .get(maturedBondId) as { c: number };
      expect(maturedStill.c).toBe(0);
    });

    it("does NOT purge when a transaction-only source type (monthly-values) imports", async () => {
      const accountId = (
        db.prepare("INSERT INTO accounts (name) VALUES ('any') RETURNING id").get() as { id: number }
      ).id;
      const expiredSecId = (
        db.prepare(
          `INSERT INTO securities (symbol, security_type, expiration_date)
           VALUES ('XYZ  240119C00050000', 'option', '2024-01-19') RETURNING id`,
        ).get() as { id: number }
      ).id;
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
         VALUES (?, ?, 1, '2024-01-15')`,
      ).run(accountId, expiredSecId);

      const parsed = await parseImport(monthlyValuesCsv, "monthly-values.csv");
      commitImport(db, parsed);

      // monthly-values is NOT in HOLDINGS_SNAPSHOT_SOURCES — purge should not run.
      const expiredStill = db
        .prepare("SELECT COUNT(*) as c FROM holdings WHERE security_id = ?")
        .get(expiredSecId) as { c: number };
      expect(expiredStill.c).toBe(1);
    });
  });

  describe("ibkr-activity exchange-suffixed symbol resolution (2026-07-05 Korea dup bug)", () => {
    it("resolves a known exchange-suffixed symbol to an existing base-symbol security (no duplicate row)", () => {
      // Seed the base-symbol security the way TWS/Web-API sync would have
      // created it: bare "402340", currency KRW.
      const baseSecId = (
        db
          .prepare(
            `INSERT INTO securities (symbol, security_type, currency)
             VALUES ('402340', 'Stock', 'KRW') RETURNING id`,
          )
          .get() as { id: number }
      ).id;
      // "IBKR" account already exists via migration 002_seed_accounts.sql.

      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "ibkr-activity",
        sourceName: "IBKR 2026-06 activity.csv",
        transactions: [
          {
            accountName: "IBKR",
            tradeDate: "2026-06-15",
            type: "BUY",
            symbol: "402340.KS",
            quantity: 10,
            amount: -500000,
            pricePerShare: 50000,
            sourceKey: "ibkr:trade:2026-06-15:402340.KS:10:-500000",
          },
        ],
        securities: [{ symbol: "402340.KS", securityType: "Stock" }],
        holdings: [
          {
            accountName: "IBKR",
            symbol: "402340.KS",
            quantity: 10,
            asOfDate: "2026-06-30",
            sourceKey: "ibkr:pos:2026-06-30:402340.KS",
          },
        ],
        prices: [
          {
            symbol: "402340.KS",
            date: "2026-06-30",
            closePrice: 50000,
            source: "ibkr-activity",
          },
        ],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);

      // No new securities row was created for the suffixed symbol.
      expect(result.newSecurities).toBe(0);
      const allSecurities = db
        .prepare("SELECT COUNT(*) as c FROM securities")
        .get() as { c: number };
      expect(allSecurities.c).toBe(1);
      const suffixedRow = db
        .prepare("SELECT COUNT(*) as c FROM securities WHERE symbol = '402340.KS'")
        .get() as { c: number };
      expect(suffixedRow.c).toBe(0);

      // Currency was never clobbered back to USD.
      const currency = db
        .prepare("SELECT currency FROM securities WHERE id = ?")
        .get(baseSecId) as { currency: string };
      expect(currency.currency).toBe("KRW");

      // The transaction, holding, and price all landed on the existing base security.
      const txn = db
        .prepare("SELECT security_id FROM transactions WHERE source_key = ?")
        .get("ibkr:trade:2026-06-15:402340.KS:10:-500000") as
        | { security_id: number }
        | undefined;
      expect(txn?.security_id).toBe(baseSecId);

      const holding = db
        .prepare(
          "SELECT security_id FROM holdings WHERE source_key = 'ibkr:pos:2026-06-30:402340.KS'",
        )
        .get() as { security_id: number } | undefined;
      expect(holding?.security_id).toBe(baseSecId);

      const price = db
        .prepare(
          "SELECT security_id FROM prices WHERE security_id = ? AND date = '2026-06-30'",
        )
        .get(baseSecId) as { security_id: number } | undefined;
      expect(price?.security_id).toBe(baseSecId);
    });

    it("normalizes a suffixed symbol to its bare form even when no base-symbol security exists yet (2026-07-05 review redesign: pure/unconditional, not DB-existence-gated)", () => {
      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "ibkr-activity",
        sourceName: "IBKR 2026-06 activity.csv",
        transactions: [],
        securities: [{ symbol: "FAKE.KS", securityType: "Stock" }],
        holdings: [
          {
            accountName: "IBKR",
            symbol: "FAKE.KS",
            quantity: 3,
            asOfDate: "2026-06-30",
            sourceKey: "ibkr:pos:2026-06-30:FAKE.KS",
          },
        ],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);

      // A bare-symbol security is created — never one under the suffixed form.
      expect(result.newSecurities).toBe(1);
      const row = db
        .prepare("SELECT id, symbol, currency FROM securities WHERE symbol = 'FAKE'")
        .get() as { id: number; symbol: string; currency: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.symbol).toBe("FAKE");
      // Defaults to USD (self-heals to the real currency on the next sync
      // upsert, via the COALESCE(NULLIF(...,'USD'),...) preservation pattern).
      expect(row?.currency).toBe("USD");

      const suffixedRow = db
        .prepare("SELECT COUNT(*) as c FROM securities WHERE symbol = 'FAKE.KS'")
        .get() as { c: number };
      expect(suffixedRow.c).toBe(0);

      // The holding's source_key retains the ORIGINAL suffixed statement
      // symbol — normalization never rewrites source_key, only .symbol.
      const holding = db
        .prepare(
          "SELECT security_id FROM holdings WHERE source_key = 'ibkr:pos:2026-06-30:FAKE.KS'",
        )
        .get() as { security_id: number } | undefined;
      expect(holding?.security_id).toBe(row?.id);
    });

    it("never rewrites a dual-class US ticker suffix (HEI.A) even when the base symbol exists", () => {
      const heiId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('HEI', 'Stock') RETURNING id",
          )
          .get() as { id: number }
      ).id;

      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "ibkr-activity",
        sourceName: "IBKR 2026-06 activity.csv",
        transactions: [],
        securities: [{ symbol: "HEI.A", securityType: "Stock" }],
        holdings: [
          {
            accountName: "IBKR",
            symbol: "HEI.A",
            quantity: 4,
            asOfDate: "2026-06-30",
            sourceKey: "ibkr:pos:2026-06-30:HEI.A",
          },
        ],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      const result = commitImport(db, parsed);

      // A NEW security row for "HEI.A" is created — never merged into "HEI".
      expect(result.newSecurities).toBe(1);
      const heiARow = db
        .prepare("SELECT id FROM securities WHERE symbol = 'HEI.A'")
        .get() as { id: number } | undefined;
      expect(heiARow).toBeDefined();
      expect(heiARow?.id).not.toBe(heiId);

      const holding = db
        .prepare(
          "SELECT security_id FROM holdings WHERE source_key = 'ibkr:pos:2026-06-30:HEI.A'",
        )
        .get() as { security_id: number } | undefined;
      expect(holding?.security_id).toBe(heiARow?.id);
    });

    it("re-importing the same statement after the base-symbol security is later created by a sync does not throw a source_key UNIQUE violation (2026-07-05 review redesign — idempotency regression)", () => {
      // A fresh ParsedImportResult per commit — mirrors re-parsing the SAME
      // statement file twice, since the real parser is pure and produces a
      // brand-new object each call. Reusing one mutated object reference
      // across two commitImport calls would not faithfully reproduce the
      // scenario (normalization mutates parsed records in place).
      function buildBatch(): import("@/lib/import/types").ParsedImportResult {
        return {
          sourceType: "ibkr-activity",
          sourceName: "IBKR 2026-06 activity.csv",
          transactions: [
            {
              accountName: "IBKR",
              tradeDate: "2026-06-15",
              type: "BUY",
              symbol: "402340.KS",
              quantity: 10,
              amount: -500000,
              pricePerShare: 50000,
              sourceKey: "ibkr:trade:2026-06-15:402340.KS:10:-500000",
            },
          ],
          securities: [{ symbol: "402340.KS", securityType: "Stock" }],
          holdings: [
            {
              accountName: "IBKR",
              symbol: "402340.KS",
              quantity: 10,
              asOfDate: "2026-06-30",
              sourceKey: "ibkr:pos:2026-06-30:402340.KS",
            },
          ],
          prices: [
            {
              symbol: "402340.KS",
              date: "2026-06-30",
              closePrice: 50000,
              source: "ibkr-activity",
            },
          ],
          snapshots: [],
          errors: [],
          warnings: [],
        };
      }

      // First commit — NO base-symbol ("402340") row exists yet.
      commitImport(db, buildBatch());

      const ibkrAccountId = (
        db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as {
          id: number;
        }
      ).id;
      const beforeTxnCount = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      const beforeHoldingCount = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM holdings WHERE account_id = ?",
          )
          .get(ibkrAccountId) as { c: number }
      ).c;

      // Simulate the TWS/Web-API sync later creating the bare-symbol
      // security row (currency resolved from the live contract, e.g. KRW).
      upsertSecurity(db, {
        symbol: "402340",
        securityType: "Stock",
        currency: "KRW",
      });

      // Re-commit the SAME statement (a legitimate duplicate/re-run import).
      // Under the pre-redesign DB-existence-gated resolver this throws a
      // "UNIQUE constraint failed: holdings.source_key" error and rolls back
      // the whole batch, because the second commit resolves "402340.KS" to
      // the NOW-existing base row's security_id while the first commit's
      // holding row is still keyed to the suffixed-symbol security_id — same
      // source_key, different (account_id, security_id, as_of_date), so the
      // upsert's ON CONFLICT target misses and the column-level UNIQUE on
      // source_key fires instead.
      expect(() => commitImport(db, buildBatch())).not.toThrow();

      const afterTxnCount = (
        db.prepare("SELECT COUNT(*) as c FROM transactions").get() as {
          c: number;
        }
      ).c;
      const afterHoldingCount = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM holdings WHERE account_id = ?",
          )
          .get(ibkrAccountId) as { c: number }
      ).c;

      // INSERT OR IGNORE on the unchanged source_key — no new transaction row.
      expect(afterTxnCount).toBe(beforeTxnCount);
      // ON CONFLICT(account_id, security_id, as_of_date) matches the SAME
      // row both times — no new/duplicate holding row.
      expect(afterHoldingCount).toBe(beforeHoldingCount);

      // Exactly one securities row for the whole "402340" family — never a
      // second row under the suffixed "402340.KS" form.
      const securitiesForFamily = db
        .prepare(
          "SELECT symbol FROM securities WHERE symbol IN ('402340', '402340.KS')",
        )
        .all() as { symbol: string }[];
      expect(securitiesForFamily).toHaveLength(1);
      expect(securitiesForFamily[0].symbol).toBe("402340");

      // Currency was never clobbered back to USD by the re-import.
      const currency = db
        .prepare("SELECT currency FROM securities WHERE symbol = '402340'")
        .get() as { currency: string };
      expect(currency.currency).toBe("KRW");
    });
  });

  describe("canonical-csv holdings imports trigger closed-position sweeps (evidence-gated, 2026-07-05)", () => {
    it("triggers reconcileClosedEquityHoldings when the canonical-csv batch includes holdings", () => {
      const accountId = (
        db.prepare("INSERT INTO accounts (name) VALUES ('roth') RETURNING id").get() as {
          id: number;
        }
      ).id;
      const acwvId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('ACWV', 'ETF') RETURNING id",
          )
          .get() as { id: number }
      ).id;
      const eemvId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('EEMV', 'ETF') RETURNING id",
          )
          .get() as { id: number }
      ).id;
      const vtiId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('VTI', 'ETF') RETURNING id",
          )
          .get() as { id: number }
      ).id;
      const spyId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('SPY', 'ETF') RETURNING id",
          )
          .get() as { id: number }
      ).id;

      // Prior full snapshot: 4 positions.
      const priorDate = "2026-05-31";
      for (const [secId, qty] of [
        [acwvId, 10],
        [eemvId, 20],
        [vtiId, 5],
        [spyId, 8],
      ] as const) {
        db.prepare(
          `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(accountId, secId, qty, priorDate, `seed:${secId}:${priorDate}`);
      }

      // New canonical-csv holdings import: ACWV + EEMV sold, only VTI/SPY remain
      // (2 of 4 = exactly the shrink floor, so the guard should NOT trip).
      const newDate = "2026-06-30";
      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "canonical-csv",
        sourceName: "canonical-2026-06.csv",
        transactions: [],
        securities: [
          { symbol: "VTI", securityType: "ETF" },
          { symbol: "SPY", securityType: "ETF" },
        ],
        holdings: [
          {
            accountName: "roth",
            symbol: "VTI",
            quantity: 5,
            asOfDate: newDate,
            sourceKey: `canonical:hold:${newDate}:VTI`,
          },
          {
            accountName: "roth",
            symbol: "SPY",
            quantity: 8,
            asOfDate: newDate,
            sourceKey: `canonical:hold:${newDate}:SPY`,
          },
        ],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      commitImport(db, parsed);

      const acwvZero = db
        .prepare(
          "SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?",
        )
        .get(accountId, acwvId, newDate) as { quantity: number } | undefined;
      const eemvZero = db
        .prepare(
          "SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?",
        )
        .get(accountId, eemvId, newDate) as { quantity: number } | undefined;

      expect(acwvZero?.quantity).toBe(0);
      expect(eemvZero?.quantity).toBe(0);
    });

    it("does NOT trigger the closed-equity sweep for a transactions-only canonical-csv import", () => {
      const accountId = (
        db.prepare("INSERT INTO accounts (name) VALUES ('roth2') RETURNING id").get() as {
          id: number;
        }
      ).id;
      const acwvId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('ACWV2', 'ETF') RETURNING id",
          )
          .get() as { id: number }
      ).id;
      const vtiId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('VTI2', 'ETF') RETURNING id",
          )
          .get() as { id: number }
      ).id;

      // Two PRE-EXISTING snapshots already on the books: an older one with both
      // positions, and a newer "latest" one where ACWV2 already disappeared —
      // i.e. conditions that WOULD produce a zero-row if the sweep ran.
      const olderDate = "2026-05-31";
      const latestDate = "2026-06-30";
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
         VALUES (?, ?, 10, ?, ?)`,
      ).run(accountId, acwvId, olderDate, `seed:acwv:${olderDate}`);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
         VALUES (?, ?, 5, ?, ?)`,
      ).run(accountId, vtiId, olderDate, `seed:vti:${olderDate}`);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
         VALUES (?, ?, 5, ?, ?)`,
      ).run(accountId, vtiId, latestDate, `seed:vti:${latestDate}`);

      const beforeCount = (
        db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number }
      ).c;

      const parsed: import("@/lib/import/types").ParsedImportResult = {
        sourceType: "canonical-csv",
        sourceName: "canonical-txns-2026-07.csv",
        transactions: [
          {
            accountName: "roth2",
            tradeDate: "2026-07-01",
            type: "DIVIDEND",
            symbol: "VTI2",
            amount: 12.34,
            sourceKey: "canonical:txn:roth2:VTI2:2026-07-01:DIVIDEND:1234",
          },
        ],
        securities: [{ symbol: "VTI2", securityType: "ETF" }],
        holdings: [],
        prices: [],
        snapshots: [],
        errors: [],
        warnings: [],
      };

      commitImport(db, parsed);

      const afterCount = (
        db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number }
      ).c;
      expect(afterCount).toBe(beforeCount); // sweep did not add a zero-row

      const acwvAtLatest = db
        .prepare(
          "SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?",
        )
        .get(accountId, acwvId, latestDate) as { quantity: number } | undefined;
      expect(acwvAtLatest).toBeUndefined();
    });

    it("does NOT trigger the closed-equity sweep for a legacy vanguard-cost-basis import even though it carries holdings rows (2026-07-05 review redesign — scope narrowed to canonical-csv only)", () => {
      // "Vanguard Taxable" is already seeded by migration 002 — the
      // cost-basis fixture's "Brokerage" account maps to it via ACCOUNT_MAP.
      const accountId = (
        db
          .prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'")
          .get() as { id: number }
      ).id;
      const staleId = (
        db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES ('STALECB', 'Stock') RETURNING id",
          )
          .get() as { id: number }
      ).id;

      // A pre-existing snapshot that WOULD produce a zero-row for STALECB if
      // the closed-equity sweep ran (it's absent from the cost-basis import
      // below, which is itself a different-shaped/legacy snapshot).
      const latestDate = "2026-06-30";
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
         VALUES (?, ?, 10, ?, ?)`,
      ).run(accountId, staleId, latestDate, `seed:stalecb:${latestDate}`);

      const beforeCount = (
        db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number }
      ).c;

      // The legacy (original-format) vanguard-cost-basis branch still emits
      // ParsedHolding rows — confirm via the real parser + fixture, not a
      // hand-built ParsedImportResult, so the test can't drift from the
      // parser's actual behavior.
      const costBasisFixture = fs.readFileSync(
        path.join(fixturesDir, "vanguard-cost-basis-sample.csv"),
        "utf-8",
      );
      const parsed = parseVanguardCostBasis(
        costBasisFixture,
        "vanguard_cost_basis.csv",
      );
      expect(parsed.sourceType).toBe("vanguard-cost-basis");
      expect(parsed.holdings.length).toBeGreaterThan(0);

      commitImport(db, parsed);

      const afterCount = (
        db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number }
      ).c;
      // The import's OWN holdings rows are written unconditionally (that's
      // the primary write path, not gated) — only the post-commit SWEEP is
      // gated. So the expected delta is exactly the fixture's own holdings
      // count; anything more would mean the sweep fired and inserted an
      // extra zero-row for STALECB.
      expect(afterCount).toBe(beforeCount + parsed.holdings.length);

      const staleAtLatest = db
        .prepare(
          "SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?",
        )
        .get(accountId, staleId, latestDate) as { quantity: number } | undefined;
      expect(staleAtLatest?.quantity).toBe(10); // untouched, not zeroed
    });
  });
});
