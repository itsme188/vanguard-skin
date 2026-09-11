/**
 * Ledger finding alerts-scan-now-banner--claims-monitoring-while-armed-rows-say-not-scanned:
 * detectAndFireAlerts' result only reported `scanned` (levels that survived
 * findCrossedLevels' price filters), so a level skipped for a stale/missing
 * price vanished from the response with no trace — the "Scan now" banner then
 * told the user everything was "still active and being monitored" while the
 * Armed tab, on the same page, showed most rows "stale price · not scanned".
 *
 * These tests pin that detectAndFireAlerts now carries countScanCoverage's
 * numbers alongside `scanned`, additively — `scanned`/`fired`/`deduped` keep
 * their exact prior meaning (auto-refresh Step 6 and runLevelScanCycle read
 * only those three and must be unaffected).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { detectAndFireAlerts } from "@/lib/alerts/detect";
import { upsertLevel } from "@/lib/mutations/security-levels";

vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendLevelAlertPush: vi.fn(async () => ({ ok: false, reason: "test" })),
}));

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

describe("detectAndFireAlerts — scan coverage disclosure", () => {
  it("carries armed/skippedStale/unpriced alongside the existing scanned/fired/deduped", () => {
    // Fresh, does not cross and stays within the plausibility band (support
    // below price) — counted as armed + evaluated.
    const fresh = seedSecurity("QAAAFRESH2");
    seedPriceDaysAgo(fresh, 100, 0);
    upsertLevel(db, { security_id: fresh, level_type: "support", price: 80 });

    // Stale price — armed but skipped.
    const stale = seedSecurity("QAAASTALE2");
    seedPriceDaysAgo(stale, 100, 30);
    upsertLevel(db, { security_id: stale, level_type: "support", price: 90 });

    // No price at all — armed but skipped.
    const unpriced = seedSecurity("QAAANOPRICE2");
    upsertLevel(db, { security_id: unpriced, level_type: "entry", price: 50 });

    const result = detectAndFireAlerts(db);

    expect(result.scanned).toBe(0); // nothing crossed
    expect(result.fired).toBe(0);
    expect(result.deduped).toBe(0);
    expect(result.armed).toBe(3);
    expect(result.skippedStale).toBe(1);
    expect(result.unpriced).toBe(1);
  });

  it("keeps scanned/fired/deduped semantics unchanged when a level actually crosses", () => {
    const crossing = seedSecurity("QAAACROSS");
    seedPriceDaysAgo(crossing, 100, 0);
    // Support at 110 with price 100 -> crosses.
    upsertLevel(db, { security_id: crossing, level_type: "support", price: 110 });

    const result = detectAndFireAlerts(db);

    expect(result.scanned).toBe(1);
    expect(result.fired).toBe(1);
    expect(result.deduped).toBe(0);
    expect(result.armed).toBe(1);
    expect(result.skippedStale).toBe(0);
    expect(result.unpriced).toBe(0);
  });

  it("reports zero coverage fields when there are no armed levels at all", () => {
    const result = detectAndFireAlerts(db);
    expect(result).toEqual({
      scanned: 0,
      fired: 0,
      deduped: 0,
      armed: 0,
      skippedStale: 0,
      unpriced: 0,
    });
  });
});
