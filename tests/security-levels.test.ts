import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getLevelsForSecurity,
  getActiveLevels,
  getLevelById,
  findCrossedLevels,
  getAlerts,
  getPendingAlertCount,
  hasAlertToday,
} from "@/lib/queries/security-levels";
import {
  upsertLevel,
  deactivateLevel,
  reactivateLevel,
  triggerLevel,
  respondToAlert,
  setAlertSuggestion,
  setLevelReviewStatus,
} from "@/lib/mutations/security-levels";
import {
  getPendingReviewCount,
  getPendingReviewLevels,
} from "@/lib/queries/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, name = `${symbol} Corp`): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name);
  return result.lastInsertRowid as number;
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

describe("security_levels — upsertLevel", () => {
  it("inserts a new level with defaults", () => {
    const secId = seedSecurity("AAPL");
    const id = upsertLevel(db, {
      security_id: secId,
      level_type: "entry",
      price: 180,
    });

    const level = getLevelById(db, id);
    expect(level).not.toBeNull();
    expect(level!.price).toBe(180);
    expect(level!.level_type).toBe("entry");
    expect(level!.source).toBe("user");
    expect(level!.is_active).toBe(1);
  });

  it("persists optional fields (direction, source, thesis, group)", () => {
    const secId = seedSecurity("SPY");
    const id = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 580,
      direction: "bearish",
      source: "newsletter",
      source_author: "Eliant Capital",
      thesis: "Breakdown below 580 signals bearish",
      timeframe: "week",
      group_id: "eliant-2026-04-20",
      action_hint: "trim",
    });

    const level = getLevelById(db, id)!;
    expect(level.direction).toBe("bearish");
    expect(level.source_author).toBe("Eliant Capital");
    expect(level.group_id).toBe("eliant-2026-04-20");
    expect(level.action_hint).toBe("trim");
  });

  it("updates an existing level when id is passed", () => {
    const secId = seedSecurity("TSLA");
    const id = upsertLevel(db, { security_id: secId, level_type: "entry", price: 200 });

    upsertLevel(db, { id, security_id: secId, level_type: "entry", price: 205, thesis: "Revised" });

    const level = getLevelById(db, id)!;
    expect(level.price).toBe(205);
    expect(level.thesis).toBe("Revised");
  });
});

describe("security_levels — queries", () => {
  it("getLevelsForSecurity returns only that security's active levels by default", () => {
    const aapl = seedSecurity("AAPL");
    const tsla = seedSecurity("TSLA");
    upsertLevel(db, { security_id: aapl, level_type: "entry", price: 180 });
    upsertLevel(db, { security_id: aapl, level_type: "stop", price: 170 });
    upsertLevel(db, { security_id: tsla, level_type: "entry", price: 200 });

    const aaplLevels = getLevelsForSecurity(db, aapl);
    expect(aaplLevels).toHaveLength(2);
    expect(aaplLevels.every((l) => l.security_id === aapl)).toBe(true);
  });

  it("getLevelsForSecurity orders by price ascending (useful for chart overlay)", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, { security_id: secId, level_type: "exit", price: 220 });
    upsertLevel(db, { security_id: secId, level_type: "stop", price: 170 });
    upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });

    const levels = getLevelsForSecurity(db, secId);
    expect(levels.map((l) => l.price)).toEqual([170, 180, 220]);
  });

  it("getActiveLevels filters out expired levels by default", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });
    upsertLevel(db, {
      security_id: secId,
      level_type: "entry",
      price: 170,
      expires_at: "2020-01-01", // well in the past
    });

    const active = getActiveLevels(db);
    expect(active).toHaveLength(1);
    expect(active[0].price).toBe(180);
  });

  it("getActiveLevels can include expired when requested", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, { security_id: secId, level_type: "entry", price: 180, expires_at: "2020-01-01" });

    const withExpired = getActiveLevels(db, { includeExpired: true });
    expect(withExpired).toHaveLength(1);
  });

  it("getActiveLevels can filter by source", () => {
    const secId = seedSecurity("SPY");
    upsertLevel(db, { security_id: secId, level_type: "support", price: 580, source: "newsletter" });
    upsertLevel(db, { security_id: secId, level_type: "support", price: 575, source: "user" });

    const newsletterOnly = getActiveLevels(db, { source: "newsletter" });
    expect(newsletterOnly).toHaveLength(1);
    expect(newsletterOnly[0].price).toBe(580);
  });
});

describe("security_levels — deactivate / reactivate", () => {
  it("deactivateLevel hides from active queries", () => {
    const secId = seedSecurity("AAPL");
    const id = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });

    deactivateLevel(db, id);

    expect(getActiveLevels(db)).toHaveLength(0);
    expect(getLevelById(db, id)!.is_active).toBe(0);
  });

  it("reactivateLevel clears triggered_at and returns to active", () => {
    const secId = seedSecurity("AAPL");
    const id = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });
    seedPrice(secId, 175);

    triggerLevel(db, { levelId: id, securityId: secId, triggeredPrice: 175 });
    expect(getLevelById(db, id)!.is_active).toBe(0);
    expect(getLevelById(db, id)!.triggered_at).not.toBeNull();

    reactivateLevel(db, id);
    const level = getLevelById(db, id)!;
    expect(level.is_active).toBe(1);
    expect(level.triggered_at).toBeNull();
    expect(level.triggered_price).toBeNull();
  });
});

describe("security_levels — findCrossedLevels", () => {
  it("returns entry/support/scale_in/stop levels where price dropped to or below", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 }); // cross @ 175
    upsertLevel(db, { security_id: secId, level_type: "support", price: 170 }); // cross @ 175 (still above)
    upsertLevel(db, { security_id: secId, level_type: "stop", price: 178 });   // cross @ 175
    seedPrice(secId, 175);

    const crossed = findCrossedLevels(db);
    expect(crossed).toHaveLength(2);
    expect(crossed.map((l) => l.level_type).sort()).toEqual(["entry", "stop"]);
  });

  it("returns resistance/exit levels where price rose to or above", () => {
    const secId = seedSecurity("TSLA");
    upsertLevel(db, { security_id: secId, level_type: "resistance", price: 250 }); // cross @ 255
    upsertLevel(db, { security_id: secId, level_type: "exit", price: 260 });       // NOT crossed @ 255
    seedPrice(secId, 255);

    const crossed = findCrossedLevels(db);
    expect(crossed).toHaveLength(1);
    expect(crossed[0].level_type).toBe("resistance");
  });

  it("excludes inactive levels", () => {
    const secId = seedSecurity("AAPL");
    const id = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });
    deactivateLevel(db, id);
    seedPrice(secId, 175);

    expect(findCrossedLevels(db)).toHaveLength(0);
  });

  it("excludes expired levels", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, {
      security_id: secId,
      level_type: "entry",
      price: 180,
      expires_at: "2020-01-01",
    });
    seedPrice(secId, 175);

    expect(findCrossedLevels(db)).toHaveLength(0);
  });

  it("falls back to benchmark_prices for securities without entries in prices", () => {
    // DIA is a benchmark-only security in this setup — no portfolio holdings.
    const secId = seedSecurity("DIA");
    upsertLevel(db, { security_id: secId, level_type: "support", price: 420 });
    // Seed only benchmark_prices; `prices` table has no row for DIA.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'tws')"
    ).run("DIA", today, 418);

    const crossed = findCrossedLevels(db);
    expect(crossed).toHaveLength(1);
    expect(crossed[0].current_price).toBe(418);
  });

  it("skips levels whose latest price is older than 4 days (stale-price guard)", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, { security_id: secId, level_type: "support", price: 180 });
    // Seed a price dated 10 days ago — clearly stale (TWS offline scenario).
    const stale = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    seedPrice(secId, 175, stale);

    expect(findCrossedLevels(db)).toHaveLength(0);
  });

  it("still fires when the latest price is within 4 days (tolerates weekends)", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, { security_id: secId, level_type: "support", price: 180 });
    // 3 days old — covers a typical weekend gap. Should still scan.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    seedPrice(secId, 175, threeDaysAgo);

    expect(findCrossedLevels(db)).toHaveLength(1);
  });

  it("ignores pending_review levels (newsletter extraction review gate)", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175);

    // Price has crossed the level, but the scan should skip it until the user
    // reviews and approves.
    expect(findCrossedLevels(db)).toHaveLength(0);
  });

  it("ignores rejected levels too (kept for audit, never fires)", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "rejected",
    });
    seedPrice(secId, 175);
    expect(findCrossedLevels(db)).toHaveLength(0);
  });
});

describe("security_levels — review workflow", () => {
  it("pending_review counts and listing work end-to-end", () => {
    const aapl = seedSecurity("AAPL");
    const spy = seedSecurity("SPY");
    upsertLevel(db, {
      security_id: aapl,
      level_type: "support",
      price: 180,
      source: "newsletter",
      source_author: "Purple Drink",
      review_status: "pending_review",
    });
    upsertLevel(db, {
      security_id: spy,
      level_type: "resistance",
      price: 585,
      source: "newsletter",
      source_author: "Eliant Capital",
      review_status: "pending_review",
    });
    upsertLevel(db, {
      // user-created — should NOT appear in review inbox
      security_id: aapl,
      level_type: "stop",
      price: 175,
    });

    expect(getPendingReviewCount(db)).toBe(2);
    const pending = getPendingReviewLevels(db);
    expect(pending).toHaveLength(2);
    expect(pending.every((l) => l.review_status === "pending_review")).toBe(true);
  });

  it("approving a pending level arms it for the scanner", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175);

    // Before approval: scan ignores the level.
    expect(findCrossedLevels(db)).toHaveLength(0);

    setLevelReviewStatus(db, levelId, "auto_approved");

    // After approval: scan picks it up and reports the cross.
    const crossed = findCrossedLevels(db);
    expect(crossed).toHaveLength(1);
    expect(crossed[0].id).toBe(levelId);
  });

  it("rejecting a pending level keeps it in DB but excludes from scans + inbox", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175);

    setLevelReviewStatus(db, levelId, "rejected");

    expect(getPendingReviewCount(db)).toBe(0);
    expect(findCrossedLevels(db)).toHaveLength(0);

    // But the row still exists — preserved for audit (user can see which
    // levels they've rejected from a given source).
    const allLevels = db
      .prepare("SELECT id, review_status FROM security_levels WHERE id = ?")
      .get(levelId) as { id: number; review_status: string };
    expect(allLevels.review_status).toBe("rejected");
  });

  it("user-created levels default to auto_approved and bypass the review gate", () => {
    const secId = seedSecurity("AAPL");
    upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 180,
    });

    expect(getPendingReviewCount(db)).toBe(0);

    seedPrice(secId, 175);
    expect(findCrossedLevels(db)).toHaveLength(1);
  });
});

describe("security_levels — triggerLevel + alerts", () => {
  it("inserts alert and flips level to inactive", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });

    const { alertId, deduped } = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 175,
    });

    expect(deduped).toBe(false);
    expect(alertId).not.toBeNull();

    const level = getLevelById(db, levelId)!;
    expect(level.is_active).toBe(0);
    expect(level.triggered_price).toBe(175);

    const alerts = getAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level_id).toBe(levelId);
    expect(alerts[0].triggered_price).toBe(175);
    expect(alerts[0].user_response).toBe("pending");
  });

  it("deduplicates if a level already has a same-day alert (secondary safety net)", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });

    const first = triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 175 });
    expect(first.deduped).toBe(false);

    // Reactivate the level to simulate a bug path where it re-becomes active today
    reactivateLevel(db, levelId);

    const second = triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 174 });
    expect(second.deduped).toBe(true);
    expect(second.alertId).toBeNull();
    expect(getAlerts(db)).toHaveLength(1);
  });

  it("hasAlertToday correctly identifies same-day alerts", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });

    expect(hasAlertToday(db, levelId)).toBe(false);
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 175 });
    expect(hasAlertToday(db, levelId)).toBe(true);
  });

  it("stores position_context and suggested_action on the alert", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });

    const { alertId } = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 175,
      positionContext: JSON.stringify({ held: false, onWatchlist: true }),
      suggestedAction: "Consider entry — matches Purple Drink's thesis",
    });

    const alert = getAlerts(db).find((a) => a.id === alertId)!;
    expect(alert.position_context).toContain('"onWatchlist":true');
    expect(alert.suggested_action).toContain("Purple Drink");
  });
});

describe("security_levels — alert response", () => {
  it("respondToAlert updates response + timestamp", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });
    const { alertId } = triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 175 });

    expect(getPendingAlertCount(db)).toBe(1);

    respondToAlert(db, alertId!, "acted", "Bought 50 shares");

    const alert = getAlerts(db, { securityId: secId })[0];
    expect(alert.user_response).toBe("acted");
    expect(alert.user_response_note).toBe("Bought 50 shares");
    expect(alert.user_response_at).not.toBeNull();

    expect(getPendingAlertCount(db)).toBe(0);
  });

  it("getAlerts filters by response state", () => {
    const secId = seedSecurity("AAPL");
    const lvl1 = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });
    const lvl2 = upsertLevel(db, { security_id: secId, level_type: "stop", price: 175 });

    const { alertId: a1 } = triggerLevel(db, { levelId: lvl1, securityId: secId, triggeredPrice: 179 });
    triggerLevel(db, { levelId: lvl2, securityId: secId, triggeredPrice: 174 });
    respondToAlert(db, a1!, "ignored");

    expect(getAlerts(db, { response: "pending" })).toHaveLength(1);
    expect(getAlerts(db, { response: "ignored" })).toHaveLength(1);
  });

  it("setAlertSuggestion updates only suggested_action", () => {
    const secId = seedSecurity("AAPL");
    const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 180 });
    const { alertId } = triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 175 });

    setAlertSuggestion(db, alertId!, "Reconsider — breakdown without volume");

    const alert = getAlerts(db)[0];
    expect(alert.suggested_action).toBe("Reconsider — breakdown without volume");
    expect(alert.user_response).toBe("pending");
  });
});

describe("security_levels — watchlist grouping", () => {
  it("new watchlist rows default to group 'default'", () => {
    const secId = seedSecurity("AAPL");
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(secId);
    const row = db.prepare("SELECT group_name FROM watchlist WHERE security_id = ?").get(secId) as { group_name: string };
    expect(row.group_name).toBe("default");
  });

  it("can store and query by custom group_name", () => {
    const a = seedSecurity("AAPL");
    const b = seedSecurity("MSFT");
    const c = seedSecurity("TSLA");
    db.prepare("INSERT INTO watchlist (security_id, group_name) VALUES (?, 'vanguard_buy')").run(a);
    db.prepare("INSERT INTO watchlist (security_id, group_name) VALUES (?, 'vanguard_buy')").run(b);
    db.prepare("INSERT INTO watchlist (security_id, group_name) VALUES (?, 'ibkr_buy_next')").run(c);

    const vanguard = db
      .prepare("SELECT security_id FROM watchlist WHERE group_name = 'vanguard_buy' AND is_active = 1")
      .all() as { security_id: number }[];
    expect(vanguard.map((r) => r.security_id).sort()).toEqual([a, b].sort());
  });
});
