import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getLevelById } from "@/lib/queries/security-levels";
import { upsertLevel, setLevelReviewStatus } from "@/lib/mutations/security-levels";
import { approveLevelGuarded } from "@/lib/alerts/approve";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, name = `${symbol} Corp`): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name).lastInsertRowid as number;
}

function seedPrice(
  securityId: number,
  price: number,
  date = new Date().toISOString().slice(0, 10)
): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')"
  ).run(securityId, date, price);
}

describe("approveLevelGuarded", () => {
  it("refuses (no write) a support level whose price already dropped through it", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175); // already below the 180 support

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("would_fire_immediately");
    expect(result.currentPrice).toBe(175);
    expect(result.effectivePrice).toBe(180);

    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("pending_review"); // unchanged — no write
    expect(level.armed_crossed_at).toBeNull();
  });

  it("refuses a resistance level whose price already rose through it", () => {
    const secId = seedSecurity("TSLA");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "resistance",
      price: 250,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 255); // already above the 250 resistance

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("would_fire_immediately");
    expect(result.currentPrice).toBe(255);
    expect(result.effectivePrice).toBe(250);
  });

  it("arms normally (no refusal) when the price has NOT crossed the level", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 185); // still above the support — not yet hit

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(true);
    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("clears a stale armed_crossed_at stamp on a clean re-approval", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175); // already past — force-arm first
    approveLevelGuarded(db, levelId, { force: true });
    expect(getLevelById(db, levelId)!.armed_crossed_at).not.toBeNull();

    // Price recovers above the level; re-running the guard (e.g. a second
    // approval pass while the level is already auto_approved) should be a
    // clean arm that clears the stale stamp from the prior force-arm cycle.
    db.prepare("DELETE FROM prices WHERE security_id = ?").run(secId);
    seedPrice(secId, 190);

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(true);
    expect(getLevelById(db, levelId)!.armed_crossed_at).toBeNull();
  });

  it("force-arms and stamps armed_crossed_at when the condition is already satisfied", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175);

    const result = approveLevelGuarded(db, levelId, { force: true });

    expect(result.ok).toBe(true);
    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).not.toBeNull();
  });

  it("arms normally when there is no price at all (unpriceable)", () => {
    const secId = seedSecurity("ZZZZ");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    // No price row seeded at all.

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(true);
    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("arms normally when the only price on file is stale (>4 days)", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    const stale = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    seedPrice(secId, 175, stale); // would satisfy the condition, but it's stale

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(true);
    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).toBeNull();
  });

  // CHANGED 2026-08-20 (Gap 2 of the f7823b6 follow-up): this used to assert
  // that an implausible level "arms normally" — which was the bug. The band
  // guard forces hit:false, so would_fire_immediately could never catch a
  // mis-scaled level, and approving one armed coverage the scanner skips on
  // every pass. It now refuses with its own code (force still overrides);
  // full coverage lives in approve-level-beyond-scan-range.test.ts.
  it("refuses an implausible (mis-scaled) level — the scanner would never evaluate it", () => {
    const secId = seedSecurity("SPY");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 7100,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 748); // >50% away — the plausibility band excludes it

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("beyond_scan_range");
    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("pending_review"); // no write
    expect(level.armed_crossed_at).toBeNull();
  });

  it("rejecting a level nulls a stale armed_crossed_at stamp", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175);
    approveLevelGuarded(db, levelId, { force: true });
    expect(getLevelById(db, levelId)!.armed_crossed_at).not.toBeNull();

    setLevelReviewStatus(db, levelId, "rejected");

    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("rejected");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("accepts approving a level that is currently rejected (any status is arm-eligible)", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "rejected",
    });
    seedPrice(secId, 185); // not past the level

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(true);
    expect(getLevelById(db, levelId)!.review_status).toBe("auto_approved");
  });
});
