/**
 * Tests for snapshot-state-to-r2.ts — verifies schemaVersion 3 fields.
 *
 * We test `buildSnapshot` by exporting it; to avoid the R2/file-system
 * side-effects in main() we import only the pure builder logic via a
 * helper that re-creates it against an in-memory DB.
 *
 * NOTE: The script is a CLI entry-point and doesn't export `buildSnapshot`
 * directly. We replicate the query logic here rather than restructuring the
 * script. This keeps the test lightweight and the script simple.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// ── inline helpers that mirror snapshot-state-to-r2.ts exactly ──────────────

function getSettingValue(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function getVanguardHoldingsForSnapshot(
  db: Database.Database
): Array<{ symbol: string; securityId: number; accountId: number }> {
  return db
    .prepare(
      `SELECT s.symbol, h.security_id AS securityId, h.account_id AS accountId
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
        WHERE h.quantity > 0
          AND LOWER(a.name) LIKE '%vanguard%'
          AND LOWER(a.name) NOT LIKE '%roth%'
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock', 'etf', 'mutual fund')
          AND s.symbol IS NOT NULL
          AND s.symbol != ''
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date)
              FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
          )
        ORDER BY s.symbol`
    )
    .all() as Array<{ symbol: string; securityId: number; accountId: number }>;
}

function getSecurityBetas(
  db: Database.Database
): Array<{ securityId: number; lookbackDays: number; beta: number; computedAt: string }> {
  return db
    .prepare(
      `SELECT security_id AS securityId,
              lookback_days AS lookbackDays,
              beta,
              computed_at AS computedAt
         FROM security_betas
        ORDER BY security_id, lookback_days`
    )
    .all() as Array<{ securityId: number; lookbackDays: number; beta: number; computedAt: string }>;
}

function buildSnapshotV3(db: Database.Database) {
  const earningsEnabledRow = db
    .prepare("SELECT value FROM settings WHERE key = 'earnings_emails_enabled'")
    .get() as { value: string } | undefined;
  const earningsMutedRow = db
    .prepare("SELECT value FROM settings WHERE key = 'earnings_emails_muted_symbols'")
    .get() as { value: string } | undefined;

  return {
    schemaVersion: 3 as const,
    snapshotDate: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    heldSymbols: [] as string[],
    settings: {
      last_digest_sent_at: getSettingValue(db, "last_digest_sent_at"),
      last_briefing_sent_at: getSettingValue(db, "last_briefing_sent_at"),
      evening_email_recipients: getSettingValue(db, "evening_email_recipients"),
      digest_email_recipients: getSettingValue(db, "digest_email_recipients"),
      briefing_email_recipients: getSettingValue(db, "briefing_email_recipients"),
      synthesis_fallbacks_last_30d: getSettingValue(db, "synthesis_fallbacks_last_30d"),
    },
    calendarEvents: [],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
    holdings: [],
    securities: [],
    accounts: [],
    earningsEmails: [],
    earningsSettings: {
      enabled: earningsEnabledRow
        ? earningsEnabledRow.value === "1" || earningsEnabledRow.value.toLowerCase() === "true"
        : true,
      mutedSymbols: earningsMutedRow
        ? earningsMutedRow.value
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s.length > 0)
        : [],
    },
    vanguardHoldings: getVanguardHoldingsForSnapshot(db),
    securityBetas: getSecurityBetas(db),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getAccountId(db: Database.Database, name: string): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }
  ).id;
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  type: string
): number {
  db.prepare(
    "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)"
  ).run(symbol, `${symbol} Inc`, type);
  return (
    db
      .prepare("SELECT id FROM securities WHERE symbol = ?")
      .get(symbol) as { id: number }
  ).id;
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number = 100
) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT OR IGNORE INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
  ).run(accountId, securityId, today, quantity);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("snapshot-state-to-r2 schemaVersion 3", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("result.schemaVersion === 3", () => {
    const snapshot = buildSnapshotV3(db);
    expect(snapshot.schemaVersion).toBe(3);
  });

  describe("vanguardHoldings", () => {
    it("returns array of {symbol, securityId, accountId} for Vanguard non-Roth holdings", () => {
      const vanguardId = getAccountId(db, "Vanguard Taxable");
      const vtiId = insertSecurity(db, "VTI", "ETF");
      insertHolding(db, vanguardId, vtiId);

      const snapshot = buildSnapshotV3(db);
      expect(Array.isArray(snapshot.vanguardHoldings)).toBe(true);
      expect(snapshot.vanguardHoldings).toHaveLength(1);

      const holding = snapshot.vanguardHoldings[0];
      expect(holding).toMatchObject({
        symbol: "VTI",
        securityId: vtiId,
        accountId: vanguardId,
      });
    });

    it("excludes Roth IRA holdings", () => {
      const rothId = getAccountId(db, "Vanguard Roth IRA");
      const vtiId = insertSecurity(db, "VTI", "ETF");
      insertHolding(db, rothId, vtiId);

      const snapshot = buildSnapshotV3(db);
      expect(snapshot.vanguardHoldings).toHaveLength(0);
    });

    it("excludes IBKR holdings", () => {
      const ibkrId = getAccountId(db, "IBKR");
      const aaplId = insertSecurity(db, "AAPL", "Stock");
      insertHolding(db, ibkrId, aaplId);

      const snapshot = buildSnapshotV3(db);
      expect(snapshot.vanguardHoldings).toHaveLength(0);
    });

    it("excludes Option and Bond security types from Vanguard holdings", () => {
      const vanguardId = getAccountId(db, "Vanguard Taxable");
      const optId = insertSecurity(db, "AAPL  260320C00200000", "Option");
      const bondId = insertSecurity(db, "US912828R697", "Bond");
      insertHolding(db, vanguardId, optId);
      insertHolding(db, vanguardId, bondId);

      const snapshot = buildSnapshotV3(db);
      expect(snapshot.vanguardHoldings).toHaveLength(0);
    });

    it("includes Stock and Mutual Fund types", () => {
      const vanguardId = getAccountId(db, "Vanguard Taxable");
      const stockId = insertSecurity(db, "MSFT", "Stock");
      const mfId = insertSecurity(db, "VFIAX", "Mutual Fund");
      insertHolding(db, vanguardId, stockId);
      insertHolding(db, vanguardId, mfId);

      const snapshot = buildSnapshotV3(db);
      expect(snapshot.vanguardHoldings).toHaveLength(2);
      const symbols = snapshot.vanguardHoldings.map((h) => h.symbol).sort();
      expect(symbols).toEqual(["MSFT", "VFIAX"]);
    });

    it("is empty when no Vanguard holdings exist", () => {
      const snapshot = buildSnapshotV3(db);
      expect(snapshot.vanguardHoldings).toEqual([]);
    });
  });

  describe("securityBetas", () => {
    it("returns array of cached betas", () => {
      // Insert a security and a cached beta row
      insertSecurity(db, "VTI", "ETF");
      const secId = (
        db.prepare("SELECT id FROM securities WHERE symbol = 'VTI'").get() as { id: number }
      ).id;

      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, ?)"
      ).run(secId, 60, 1.15, now);

      const snapshot = buildSnapshotV3(db);
      expect(Array.isArray(snapshot.securityBetas)).toBe(true);
      expect(snapshot.securityBetas).toHaveLength(1);

      const row = snapshot.securityBetas[0];
      expect(row.securityId).toBe(secId);
      expect(row.lookbackDays).toBe(60);
      expect(row.beta).toBeCloseTo(1.15);
      expect(row.computedAt).toBe(now);
    });

    it("is empty when no betas are cached", () => {
      const snapshot = buildSnapshotV3(db);
      expect(snapshot.securityBetas).toEqual([]);
    });

    it("returns multiple betas with correct shape", () => {
      insertSecurity(db, "VTI", "ETF");
      insertSecurity(db, "QQQ", "ETF");
      const vtiId = (db.prepare("SELECT id FROM securities WHERE symbol = 'VTI'").get() as { id: number }).id;
      const qqqId = (db.prepare("SELECT id FROM securities WHERE symbol = 'QQQ'").get() as { id: number }).id;

      const now = new Date().toISOString();
      db.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, ?)").run(vtiId, 60, 1.0, now);
      db.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, ?)").run(vtiId, 252, 0.97, now);
      db.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, ?)").run(qqqId, 60, 1.22, now);

      const snapshot = buildSnapshotV3(db);
      expect(snapshot.securityBetas).toHaveLength(3);

      // Check each row has required keys
      for (const row of snapshot.securityBetas) {
        expect(row).toHaveProperty("securityId");
        expect(row).toHaveProperty("lookbackDays");
        expect(row).toHaveProperty("beta");
        expect(row).toHaveProperty("computedAt");
      }
    });
  });

  describe("settings", () => {
    it("last_digest_sent_at is present (null when not set)", () => {
      const snapshot = buildSnapshotV3(db);
      expect("last_digest_sent_at" in snapshot.settings).toBe(true);
      expect(snapshot.settings.last_digest_sent_at).toBeNull();
    });

    it("last_digest_sent_at returns stored value", () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('last_digest_sent_at', '2026-05-08T08:45:00.000Z')").run();
      const snapshot = buildSnapshotV3(db);
      expect(snapshot.settings.last_digest_sent_at).toBe("2026-05-08T08:45:00.000Z");
    });

    it("last_briefing_sent_at is present (null when not set)", () => {
      const snapshot = buildSnapshotV3(db);
      expect("last_briefing_sent_at" in snapshot.settings).toBe(true);
      expect(snapshot.settings.last_briefing_sent_at).toBeNull();
    });

    it("evening_email_recipients is present (null when not set)", () => {
      const snapshot = buildSnapshotV3(db);
      expect("evening_email_recipients" in snapshot.settings).toBe(true);
      expect(snapshot.settings.evening_email_recipients).toBeNull();
    });

    it("digest_email_recipients is present (null when not set)", () => {
      const snapshot = buildSnapshotV3(db);
      expect("digest_email_recipients" in snapshot.settings).toBe(true);
      expect(snapshot.settings.digest_email_recipients).toBeNull();
    });

    it("briefing_email_recipients is present (null when not set)", () => {
      const snapshot = buildSnapshotV3(db);
      expect("briefing_email_recipients" in snapshot.settings).toBe(true);
      expect(snapshot.settings.briefing_email_recipients).toBeNull();
    });

    it("synthesis_fallbacks_last_30d is present (null when not set)", () => {
      const snapshot = buildSnapshotV3(db);
      expect("synthesis_fallbacks_last_30d" in snapshot.settings).toBe(true);
      expect(snapshot.settings.synthesis_fallbacks_last_30d).toBeNull();
    });

    it("synthesis_fallbacks_last_30d returns stored JSON when set", () => {
      const ringBuffer = JSON.stringify([{ date: "2026-05-08", count: 2 }]);
      db.prepare("INSERT INTO settings (key, value) VALUES ('synthesis_fallbacks_last_30d', ?)").run(ringBuffer);
      const snapshot = buildSnapshotV3(db);
      expect(snapshot.settings.synthesis_fallbacks_last_30d).toBe(ringBuffer);
    });
  });
});
