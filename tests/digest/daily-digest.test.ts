import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  generateDigestSince,
  formatTriggeredAlertsSection,
} from "@/lib/digest/daily-digest";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

function seedArticle(sourceName: string, subject: string, receivedAt: string) {
  const source = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)"
    )
    .run(sourceName, `${sourceName.toLowerCase()}@example.com`);
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
     VALUES (?, ?, ?, ?, ?, 'Summary text', 'neutral', datetime('now'))`
  ).run(
    source.lastInsertRowid as number,
    subject,
    `${sourceName.toLowerCase()}@example.com`,
    receivedAt,
    "Article body"
  );
}

describe("daily-digest — formatTriggeredAlertsSection", () => {
  it("accepts a full ISO timestamp (since_last mode) without silently dropping rows", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "entry",
      price: 180,
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 179 });

    // Simulate the since_last mode: sinceDate arrives as a full ISO timestamp
    // from a prior setLastDigestSentAt call. Before the fix this
    // string-concat'd "T00:00:00" → "...ZT00:00:00" → zero rows matched.
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const block = formatTriggeredAlertsSection(db, sinceIso);
    expect(block).toContain("AAPL");
    expect(block).toContain("Price Levels Triggered");
  });

  it("accepts a YYYY-MM-DD string (today/since_date modes)", () => {
    const secId = seedSecurity("NVDA");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 500,
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 499 });

    const today = new Date().toISOString().slice(0, 10);
    const block = formatTriggeredAlertsSection(db, today);
    expect(block).toContain("NVDA");
  });

  it("returns empty string when no alerts fired in the window", () => {
    const future = "2099-01-01";
    const block = formatTriggeredAlertsSection(db, future);
    expect(block).toBe("");
  });
});

describe("daily-digest — generateDigestSince", () => {
  it("returns non-null when alerts fired but zero articles (regression)", () => {
    const secId = seedSecurity("SPY");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "resistance",
      price: 585,
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 586 });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const digest = generateDigestSince(db, yesterday);

    expect(digest).not.toBeNull();
    expect(digest).toContain("price levels fired");
    expect(digest).toContain("SPY");
  });

  it("returns non-null when only articles exist, no alerts", () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    seedArticle("Vital Knowledge", "Morning note", now);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const digest = generateDigestSince(db, yesterday);

    expect(digest).not.toBeNull();
    expect(digest).toContain("Morning note");
  });

  it("returns null only when both articles AND alerts are empty", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const digest = generateDigestSince(db, yesterday);
    expect(digest).toBeNull();
  });
});
