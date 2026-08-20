/**
 * Gap 2 pin (follow-up to f7823b6): the beyond-band disclosure only rendered on
 * already-armed rows, and approveLevelGuarded's only refusal was
 * would_fire_immediately — which a beyond-band level by definition never trips
 * (the band guard forces hit=false). So a mis-scaled extracted level arriving
 * pending_review approved silently and armed dead coverage, and API callers got
 * no signal at all.
 *
 * approveLevelGuarded now refuses a beyond-band arm with its own code, honoring
 * `force` exactly like would_fire_immediately does.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getLevelById } from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";
import { approveLevelGuarded } from "@/lib/alerts/approve";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, securityType = "stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`, securityType).lastInsertRowid as number;
}

function seedPrice(securityId: number, price: number, daysAgo = 0): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, date('now', '-' || ? || ' days'), ?, 'manual')`,
  ).run(securityId, daysAgo, price);
}

function pendingLevel(
  securityId: number,
  levelType: "support" | "resistance",
  price: number,
): number {
  return upsertLevel(db, {
    security_id: securityId,
    level_type: levelType,
    price,
    source: "newsletter",
    review_status: "pending_review",
  });
}

describe("approveLevelGuarded — beyond-scan-range refusal", () => {
  it("refuses (no write) a mis-scaled level the scanner would never evaluate", () => {
    const secId = seedSecurity("SPYQA");
    const levelId = pendingLevel(secId, "support", 7100); // SPX level on SPY
    seedPrice(secId, 748);

    const result = approveLevelGuarded(db, levelId);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("beyond_scan_range");
    expect(result.currentPrice).toBe(748);
    expect(result.effectivePrice).toBe(7100);

    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("pending_review"); // unchanged — no write
    expect(level.armed_crossed_at).toBeNull();
  });

  it("refuses a level far ABOVE the band as well (resistance at 5x spot)", () => {
    const secId = seedSecurity("HIQA");
    const levelId = pendingLevel(secId, "resistance", 500);
    seedPrice(secId, 100);

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("beyond_scan_range");
  });

  it("arms with force:true and does NOT stamp armed_crossed_at (nothing was crossed)", () => {
    const secId = seedSecurity("SPYQA");
    const levelId = pendingLevel(secId, "support", 7100);
    seedPrice(secId, 748);

    const result = approveLevelGuarded(db, levelId, { force: true });

    expect(result.ok).toBe(true);
    const level = getLevelById(db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("does not refuse an in-band level", () => {
    const secId = seedSecurity("OKQA");
    const levelId = pendingLevel(secId, "support", 90);
    seedPrice(secId, 100);

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(true);
    expect(result.code).toBeUndefined();
    expect(getLevelById(db, levelId)!.review_status).toBe("auto_approved");
  });

  it("never refuses an option level — the band exempts them", () => {
    const secId = seedSecurity("OPTQA", "option");
    const levelId = pendingLevel(secId, "resistance", 500);
    seedPrice(secId, 100);

    const result = approveLevelGuarded(db, levelId, {});
    expect(result.ok).toBe(true);
    expect(getLevelById(db, levelId)!.review_status).toBe("auto_approved");
  });

  it("arms normally when the price is stale — the band can't be judged from a skipped price", () => {
    const secId = seedSecurity("STALEQA");
    const levelId = pendingLevel(secId, "support", 7100);
    seedPrice(secId, 748, 30);

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(true);
    expect(getLevelById(db, levelId)!.review_status).toBe("auto_approved");
  });

  it("arms normally when there is no price at all", () => {
    const secId = seedSecurity("NOPRICEQA");
    const levelId = pendingLevel(secId, "support", 7100);

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(true);
    expect(getLevelById(db, levelId)!.review_status).toBe("auto_approved");
  });
});

describe("approveLevelGuarded — would_fire_immediately unchanged", () => {
  it("still refuses an in-band level whose condition already holds", () => {
    const secId = seedSecurity("AAPLQA");
    const levelId = pendingLevel(secId, "support", 180);
    seedPrice(secId, 175);

    const result = approveLevelGuarded(db, levelId);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("would_fire_immediately");
    expect(getLevelById(db, levelId)!.review_status).toBe("pending_review");
  });

  it("still force-arms AND stamps armed_crossed_at for an already-crossed level", () => {
    const secId = seedSecurity("AAPLQA");
    const levelId = pendingLevel(secId, "support", 180);
    seedPrice(secId, 175);

    const result = approveLevelGuarded(db, levelId, { force: true });
    expect(result.ok).toBe(true);
    expect(getLevelById(db, levelId)!.armed_crossed_at).not.toBeNull();
  });
});
