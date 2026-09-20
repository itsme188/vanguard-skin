import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence } from "@/lib/queries/data-confidence";

/**
 * Regression coverage for qa:header-dataconfidence--guidance-contradicts-
 * detail-and-actions: the popover's "What to do" (guidance) line was a
 * score-threshold ladder that ignored the same counts the detail line right
 * above it already displays. A rounded score could clear the old threshold
 * (e.g. 39/40 = 98%) while the detail line still names a real gap (1 of 40
 * missing/stale) — so the guidance read "nothing to do" directly under a
 * detail line naming something to do. Each dimension below reproduces that
 * exact shape (score rounds to >= the old threshold, one item still
 * missing/stale) and asserts the reassurance phrase is gone and the gap is
 * named, plus a fully-clean case that still gets the reassurance.
 */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  opts: { ibConId?: number | null } = {}
): number {
  db.prepare(`INSERT INTO securities (symbol, ib_con_id) VALUES (?, ?)`).run(
    symbol,
    opts.ibConId ?? null
  );
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  asOfDate: string,
  sourceKey: string
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 10, ?, ?)`
  ).run(accountId, securityId, asOfDate, sourceKey);
}

function insertPrice(db: Database.Database, securityId: number, date: string, closePrice: number): void {
  db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`).run(
    securityId,
    date,
    closePrice
  );
}

function insertDailyValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  holdingsCount: number,
  pricedCount: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
     VALUES (?, ?, 0, 0, 0, ?, ?)`
  ).run(accountId, date, holdingsCount, pricedCount);
}

const NOW = new Date("2026-08-21T16:00:00Z"); // 2026-08-21 in ET, well within the trading day
const TODAY = "2026-08-21";

describe("data-confidence guidance — derived from counts, not score thresholds", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("prices", () => {
    it("39/40 fresh (score 98) still names the 1 stale security — no false 'nothing to do', singular 'has'", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `PQ${i}`;
        const sec = insertSecurity(db, sym);
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
        if (i < 39) insertPrice(db, sec, TODAY, 100); // last one gets no price row at all
      }

      const { priceFreshness } = getDataConfidence(db, NOW);
      expect(priceFreshness.totalHeld).toBe(40);
      expect(priceFreshness.pricedRecent).toBe(39);
      expect(priceFreshness.score).toBe(98);
      expect(priceFreshness.guidance).not.toContain("nothing to do");
      expect(priceFreshness.guidance).toBe(
        "1 of 40 held securities has no recent price — run Quick Refresh, or connect TWS for live quotes."
      );
    });

    it("38/40 fresh (score 95) names the 2 stale securities with plural 'have'", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `PP${i}`;
        const sec = insertSecurity(db, sym);
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
        if (i < 38) insertPrice(db, sec, TODAY, 100); // last two get no price row at all
      }

      const { priceFreshness } = getDataConfidence(db, NOW);
      expect(priceFreshness.totalHeld).toBe(40);
      expect(priceFreshness.pricedRecent).toBe(38);
      expect(priceFreshness.score).toBe(95);
      expect(priceFreshness.guidance).toBe(
        "2 of 40 held securities have no recent price — run Quick Refresh, or connect TWS for live quotes."
      );
    });

    it("40/40 fresh still gets the reassurance", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `PC${i}`;
        const sec = insertSecurity(db, sym);
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
        insertPrice(db, sec, TODAY, 100);
      }

      const { priceFreshness } = getDataConfidence(db, NOW);
      expect(priceFreshness.score).toBe(100);
      expect(priceFreshness.guidance).toBe("Prices are fresh — nothing to do.");
    });
  });

  describe("holdings", () => {
    it("worst account 7 days stale (score 80) still names the gap — no false 'current across accounts'", () => {
      const a = insertSecurity(db, "HQA");
      const b = insertSecurity(db, "HQB");
      const c = insertSecurity(db, "HQC");
      insertHolding(db, 1, a, "2026-08-21", "canonical:hold:TAX:HQA:2026-08-21"); // 0 days
      insertHolding(db, 2, b, "2026-08-18", "canonical:hold:ROTH:HQB:2026-08-18"); // 3 days
      insertHolding(db, 3, c, "2026-08-14", "tws-3-hqc-2026-08-14"); // 7 days — worst

      const { holdingsRecency } = getDataConfidence(db, NOW);
      expect(holdingsRecency.score).toBe(80);
      expect(holdingsRecency.guidance).not.toContain("current across accounts");
      expect(holdingsRecency.guidance).toContain("HQC");
      expect(holdingsRecency.guidance).toContain("IBKR");
    });

    it("every account <=1 day old still gets the reassurance", () => {
      const a = insertSecurity(db, "HCA");
      const b = insertSecurity(db, "HCB");
      const c = insertSecurity(db, "HCC");
      insertHolding(db, 1, a, "2026-08-21", "canonical:hold:TAX:HCA:2026-08-21"); // 0 days
      insertHolding(db, 2, b, "2026-08-20", "canonical:hold:ROTH:HCB:2026-08-20"); // 1 day
      insertHolding(db, 3, c, "2026-08-21", "tws-3-hcc-2026-08-21"); // 0 days

      const { holdingsRecency } = getDataConfidence(db, NOW);
      expect(holdingsRecency.score).toBe(100);
      expect(holdingsRecency.guidance).toBe("Holdings are current across accounts.");
    });
  });

  describe("enrichment", () => {
    it("39/40 enriched (score 98) still names the 1 missing conId — no false 'all enrichable', singular 'security is'", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `EQ${i}`;
        const sec = insertSecurity(db, sym, { ibConId: i < 39 ? 1000 + i : null });
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
      }

      const { enrichmentCompleteness } = getDataConfidence(db, NOW);
      expect(enrichmentCompleteness.total).toBe(40);
      expect(enrichmentCompleteness.missing.length).toBe(1);
      expect(enrichmentCompleteness.score).toBe(98);
      expect(enrichmentCompleteness.guidance).not.toContain("All enrichable securities have contract IDs.");
      expect(enrichmentCompleteness.guidance).toBe(
        "1 security is missing a TWS contract ID — click Enrich (requires TWS running)."
      );
    });

    it("38/40 enriched (score 95) names the 2 missing conIds with plural 'securities are'", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `EP${i}`;
        const sec = insertSecurity(db, sym, { ibConId: i < 38 ? 3000 + i : null });
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
      }

      const { enrichmentCompleteness } = getDataConfidence(db, NOW);
      expect(enrichmentCompleteness.missing.length).toBe(2);
      expect(enrichmentCompleteness.score).toBe(95);
      expect(enrichmentCompleteness.guidance).toBe(
        "2 securities are missing TWS contract IDs — click Enrich (requires TWS running)."
      );
    });

    it("40/40 enriched still gets the reassurance", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `EC${i}`;
        const sec = insertSecurity(db, sym, { ibConId: 2000 + i });
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
      }

      const { enrichmentCompleteness } = getDataConfidence(db, NOW);
      expect(enrichmentCompleteness.score).toBe(100);
      expect(enrichmentCompleteness.guidance).toBe("All enrichable securities have contract IDs.");
    });
  });

  describe("valuation coverage", () => {
    it("39/40 priced (score 98) still names the 1 unpriced holding — no false 'full coverage'", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `VQ${i}`;
        const sec = insertSecurity(db, sym);
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
      }
      insertDailyValuation(db, 1, TODAY, 40, 39);

      const { valuationCoverage } = getDataConfidence(db, NOW);
      expect(valuationCoverage.totalCount).toBe(40);
      expect(valuationCoverage.pricedCount).toBe(39);
      expect(valuationCoverage.score).toBe(98);
      expect(valuationCoverage.guidance).not.toContain("Full coverage in the latest valuation.");
      expect(valuationCoverage.guidance).toBe("Run Quick Refresh to price the remaining 1 holding.");
    });

    it("40/40 priced still gets the reassurance", () => {
      for (let i = 0; i < 40; i++) {
        const sym = `VC${i}`;
        const sec = insertSecurity(db, sym);
        insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:${sym}:${TODAY}`);
      }
      insertDailyValuation(db, 1, TODAY, 40, 40);

      const { valuationCoverage } = getDataConfidence(db, NOW);
      expect(valuationCoverage.score).toBe(100);
      expect(valuationCoverage.guidance).toBe("Full coverage in the latest valuation.");
    });
  });
});
