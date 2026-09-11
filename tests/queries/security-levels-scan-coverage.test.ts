/**
 * Ledger finding alerts-scan-now-banner--claims-monitoring-while-armed-rows-say-not-scanned:
 * "Scan now" told the user "levels are still active and being monitored" while
 * the SAME page's Armed tab showed most rows flagged "stale price · not
 * scanned". detectAndFireAlerts only reports `scanned` = the levels that
 * SURVIVED findCrossedLevels' price-freshness + price-existence filters — a
 * level skipped for a stale or missing price is invisible in the response.
 *
 * countScanCoverage counts the same armed universe (ARMED_UNIVERSE_WHERE_SQL
 * — the exact WHERE clause findCrossedLevels and getArmedLevels now share)
 * and splits it into FOUR mutually exclusive skip buckets, reusing
 * SCAN_PRICE_IS_FRESH_SQL / resolveLevelPrice / isLevelBeyondScanRange rather
 * than re-deriving any of the rules:
 *
 *   unpriced           — no price row at all
 *   skippedStale       — price older than the scanner's freshness window
 *   skippedOutOfBand   — outside the plausibility band (round 2, 2026-09-11)
 *   unresolvedMa       — MA level with too little bar history (round 2)
 *
 * Round 2 exists because the banner reported `armed - skippedStale -
 * unpriced` as "evaluated", which counted a band-skipped or unresolvable-MA
 * level as evaluated — so it could say "evaluated 40 of 40" while the Armed
 * tab flagged rows "outside scan range". `totalSkipped` / `evaluated` are
 * therefore derived HERE and shipped, not re-summed by the UI.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
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

/** N consecutive daily bars ending today, all at `close`. */
function seedDailyBars(securityId: number, count: number, close: number): void {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, date('now', '-' || ? || ' days'), '1 day', ?, ?, ?, ?, 1000)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(securityId, count - 1 - i, close, close + 1, close - 1, close);
  }
}

const ZERO_COVERAGE = {
  armed: 0,
  skippedStale: 0,
  unpriced: 0,
  skippedOutOfBand: 0,
  unresolvedMa: 0,
  totalSkipped: 0,
  evaluated: 0,
};

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

    expect(countScanCoverage(db)).toEqual({
      armed: 3,
      skippedStale: 1,
      unpriced: 1,
      skippedOutOfBand: 0,
      unresolvedMa: 0,
      totalSkipped: 2,
      evaluated: 1,
    });
  });

  it("agrees with findCrossedLevels on which rows are eligible: armed - totalSkipped = the eligible count", () => {
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
    expect(coverage.totalSkipped).toBe(1);
    expect(coverage.evaluated).toBe(2);
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

    expect(countScanCoverage(db)).toEqual(ZERO_COVERAGE);
  });

  it("returns all zeros when there are no armed levels", () => {
    expect(countScanCoverage(db)).toEqual(ZERO_COVERAGE);
  });
});

/**
 * Round 2: the two skips the banner used to count as "evaluated". Both are
 * the scanner's own verdicts — checkLevelTriggerState refuses to judge an
 * out-of-band level and an MA it cannot resolve — so a coverage report that
 * omits them contradicts the very Armed rows that disclose them.
 */
describe("countScanCoverage — the plausibility-band and unresolvable-MA skips", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("counts a level outside the plausibility band as skippedOutOfBand, not evaluated", () => {
    const inBand = seedSecurity("QBANDOK");
    seedPriceDaysAgo(inBand, 100, 0);
    upsertLevel(db, { security_id: inBand, level_type: "support", price: 90 });

    // Level at 10 vs a price of 100: |100 - 10| / 10 = 900% away, far past
    // LEVEL_PLAUSIBILITY_MAX_DISTANCE (50%) — the classic mis-scaled level.
    const outOfBand = seedSecurity("QBANDBAD");
    seedPriceDaysAgo(outOfBand, 100, 0);
    upsertLevel(db, { security_id: outOfBand, level_type: "support", price: 10 });

    const coverage = countScanCoverage(db);
    expect(coverage).toEqual({
      armed: 2,
      skippedStale: 0,
      unpriced: 0,
      skippedOutOfBand: 1,
      unresolvedMa: 0,
      totalSkipped: 1,
      evaluated: 1,
    });
    // The scanner really does skip it — it never appears in `crossed`, even
    // though `support @ 10` with price 100 is "above the level".
    expect(findCrossedLevels(db).map((r) => r.security_id)).toEqual([]);
  });

  it("counting does not re-emit the scanner's out-of-band console warnings", () => {
    const outOfBand = seedSecurity("QBANDQUIET");
    seedPriceDaysAgo(outOfBand, 100, 0);
    upsertLevel(db, { security_id: outOfBand, level_type: "support", price: 10 });

    warn.mockClear();
    countScanCoverage(db);
    expect(warn).not.toHaveBeenCalled();
  });

  it("counts an MA level with too little bar history as unresolvedMa, not evaluated", () => {
    // sma_50 with only 10 daily bars — resolveLevelPrice returns null, so the
    // scanner has no threshold to compare against and skips the row.
    const thin = seedSecurity("QMATHIN");
    seedPriceDaysAgo(thin, 100, 0);
    seedDailyBars(thin, 10, 100);
    upsertLevel(db, {
      security_id: thin,
      level_type: "support",
      price: 100,
      price_source: "sma_50",
    });

    const coverage = countScanCoverage(db);
    expect(coverage).toEqual({
      armed: 1,
      skippedStale: 0,
      unpriced: 0,
      skippedOutOfBand: 0,
      unresolvedMa: 1,
      totalSkipped: 1,
      evaluated: 0,
    });
    expect(findCrossedLevels(db)).toEqual([]);
  });

  it("an MA level WITH enough history is evaluated, not counted as a skip", () => {
    const rich = seedSecurity("QMARICH");
    seedPriceDaysAgo(rich, 100, 0);
    seedDailyBars(rich, 60, 100); // 60 daily bars -> sma_50 resolves to 100
    upsertLevel(db, {
      security_id: rich,
      level_type: "support",
      price: 100,
      price_source: "sma_50",
    });

    const coverage = countScanCoverage(db);
    expect(coverage.unresolvedMa).toBe(0);
    expect(coverage.skippedOutOfBand).toBe(0);
    expect(coverage.totalSkipped).toBe(0);
    expect(coverage.evaluated).toBe(1);
  });

  it("keeps the four buckets mutually exclusive: a stale price wins over a band verdict", () => {
    // Stale AND mis-scaled. The scanner drops it on freshness before it ever
    // resolves a price, so it must be counted once, as skippedStale.
    const both = seedSecurity("QBOTH");
    seedPriceDaysAgo(both, 100, 30);
    upsertLevel(db, { security_id: both, level_type: "support", price: 10 });

    const coverage = countScanCoverage(db);
    expect(coverage.skippedStale).toBe(1);
    expect(coverage.skippedOutOfBand).toBe(0);
    expect(coverage.totalSkipped).toBe(1);
    expect(coverage.evaluated).toBe(0);
  });

  it("exempts options from the band, matching isLevelBeyondScanRange", () => {
    const opt = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'option', 'equity', 100)",
      )
      .run("QOPT  260918C00100000", "QOPT option").lastInsertRowid as number;
    seedPriceDaysAgo(opt, 8, 0);
    // 8 vs a level of 1 is 700% away — an equity would be out of band.
    upsertLevel(db, { security_id: opt, level_type: "support", price: 1 });

    const coverage = countScanCoverage(db);
    expect(coverage.skippedOutOfBand).toBe(0);
    expect(coverage.evaluated).toBe(1);
  });

  it("totalSkipped/evaluated stay consistent when all four buckets are populated at once", () => {
    const ok = seedSecurity("QALL1");
    seedPriceDaysAgo(ok, 100, 0);
    upsertLevel(db, { security_id: ok, level_type: "support", price: 90 });

    const stale = seedSecurity("QALL2");
    seedPriceDaysAgo(stale, 100, 30);
    upsertLevel(db, { security_id: stale, level_type: "support", price: 90 });

    const unpriced = seedSecurity("QALL3");
    upsertLevel(db, { security_id: unpriced, level_type: "support", price: 90 });

    const band = seedSecurity("QALL4");
    seedPriceDaysAgo(band, 100, 0);
    upsertLevel(db, { security_id: band, level_type: "support", price: 10 });

    const ma = seedSecurity("QALL5");
    seedPriceDaysAgo(ma, 100, 0);
    upsertLevel(db, {
      security_id: ma,
      level_type: "support",
      price: 100,
      price_source: "ema_21",
    });

    expect(countScanCoverage(db)).toEqual({
      armed: 5,
      skippedStale: 1,
      unpriced: 1,
      skippedOutOfBand: 1,
      unresolvedMa: 1,
      totalSkipped: 4,
      evaluated: 1,
    });
  });
});
