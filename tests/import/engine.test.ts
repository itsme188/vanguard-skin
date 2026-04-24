import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";

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
});
