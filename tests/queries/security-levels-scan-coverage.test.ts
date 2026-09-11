/**
 * Ledger finding alerts-scan-now-banner--claims-monitoring-while-armed-rows-say-not-scanned:
 * "Scan now" told the user "levels are still active and being monitored" while
 * the SAME page's Armed tab showed most rows flagged "stale price · not
 * scanned". detectAndFireAlerts only reports `scanned` = the levels that
 * SURVIVED findCrossedLevels' price-freshness + price-existence filters
 * (lib/queries/security-levels.ts findCrossedLevels, ~:248-249) — a level
 * skipped for a stale or missing price is invisible in the response.
 *
 * countScanCoverage counts the same armed universe (is_active=1,
 * review_status='auto_approved', unexpired — the exact WHERE clause
 * findCrossedLevels and getArmedLevels share) and splits it into how many
 * have no price at all (`unpriced`) vs. a price older than the scanner's
 * freshness window (`skippedStale`), reusing SCAN_PRICE_IS_FRESH_SQL rather
 * than re-deriving the freshness rule.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { countScanCoverage, findCrossedLevels } from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPriceDaysAgo(securityId: number, price: number, daysAgo: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, date('now', '-' || ? || ' days'), ?, 'manual')`,
  ).run(securityId, daysAgo, price);
}

describe("countScanCoverage", () => {
  it("splits the armed universe into fresh / stale / unpriced", () => {
    const fresh = seedSecurity("QAAAFRESH");
    seedPriceDaysAgo(fresh, 100, 0);
    upsertLevel(db, { security_id: fresh, level_type: "support", price: 90 });

    const stale = seedSecurity("QAAASTALE");
    seedPriceDaysAgo(stale, 100, 30);
    upsertLevel(db, { security_id: stale, level_type: "support", price: 90 });

    const unpriced = seedSecurity("QAAANOPRICE");
    upsertLevel(db, { security_id: unpriced, level_type: "entry", price: 50 });

    expect(countScanCoverage(db)).toEqual({ armed: 3, skippedStale: 1, unpriced: 1 });
  });

  it("agrees with findCrossedLevels on which rows are eligible: armed - skippedStale - unpriced = the eligible count", () => {
    const fresh1 = seedSecurity("QAAAF1");
    seedPriceDaysAgo(fresh1, 100, 0);
    // Support at 110 with price 100 -> condition holds -> would be in `crossed`.
    upsertLevel(db, { security_id: fresh1, level_type: "support", price: 110 });

    const fresh2 = seedSecurity("QAAAF2");
    seedPriceDaysAgo(fresh2, 100, 4); // exactly at the edge — still scanned
    // Support at 90 with price 100 -> condition does NOT hold, so this level
    // is eligible (scanned) but not crossed — still counts toward "evaluated".
    upsertLevel(db, { security_id: fresh2, level_type: "support", price: 90 });

    const stale = seedSecurity("QAAAS1");
    seedPriceDaysAgo(stale, 100, 10);
    upsertLevel(db, { security_id: stale, level_type: "support", price: 110 });

    const coverage = countScanCoverage(db);
    expect(coverage.armed).toBe(3);
    expect(coverage.skippedStale).toBe(1);
    expect(coverage.unpriced).toBe(0);
    const evaluated = coverage.armed - coverage.skippedStale - coverage.unpriced;
    expect(evaluated).toBe(2);
    // findCrossedLevels only returns rows that actually cross (fresh1), but
    // both fresh1 and fresh2 were eligible for evaluation.
    expect(findCrossedLevels(db).map((r) => r.security_id)).toEqual([fresh1]);
  });

  it("excludes non-active / pending_review / expired levels from the armed count, matching findCrossedLevels", () => {
    const inactive = seedSecurity("QAAAINACTIVE");
    seedPriceDaysAgo(inactive, 100, 0);
    const inactiveId = upsertLevel(db, { security_id: inactive, level_type: "support", price: 90 });
    db.prepare("UPDATE security_levels SET is_active = 0 WHERE id = ?").run(inactiveId);

    const pending = seedSecurity("QAAAPENDING");
    seedPriceDaysAgo(pending, 100, 0);
    upsertLevel(db, {
      security_id: pending,
      level_type: "support",
      price: 90,
      review_status: "pending_review",
    });

    const expired = seedSecurity("QAAAEXPIRED");
    seedPriceDaysAgo(expired, 100, 0);
    const expiredId = upsertLevel(db, { security_id: expired, level_type: "support", price: 90 });
    db.prepare("UPDATE security_levels SET expires_at = date('now','-1 day') WHERE id = ?").run(
      expiredId,
    );

    expect(countScanCoverage(db)).toEqual({ armed: 0, skippedStale: 0, unpriced: 0 });
  });

  it("returns all zeros when there are no armed levels", () => {
    expect(countScanCoverage(db)).toEqual({ armed: 0, skippedStale: 0, unpriced: 0 });
  });
});
