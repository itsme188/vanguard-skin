/**
 * Editing a level in place (lib/levels/edit-level.ts, PATCH /api/levels with
 * action "edit"). Real mutation, real arm guard and real scan on an in-memory
 * database. Prices are dated far in the future so they always read as fresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findCrossedLevels, getLevelById } from "@/lib/queries/security-levels";
import { deactivateLevel, upsertLevel } from "@/lib/mutations/security-levels";
import { approveLevelGuarded } from "@/lib/alerts/approve";
import { editLevel, mergeLevelEdit } from "@/lib/levels/edit-level";

const PRICE_DATE = "2099-01-02";
const TODAY = "2026-10-07";
let db: Database.Database;
let secId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 1)"
    )
    .run().lastInsertRowid as number;
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'manual')"
  ).run(secId, PRICE_DATE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An armed resistance level at 120 with the price at 100 (not crossed). */
function armedLevel(extra: Record<string, unknown> = {}): number {
  return upsertLevel(db, {
    security_id: secId,
    level_type: "resistance",
    price: 120,
    thesis: "old thesis",
    source_author: "Me",
    ...extra,
  });
}

describe("editLevel — what an edit may and may not change", () => {
  it("changes every form field and keeps the rest of the row", () => {
    const id = armedLevel({ source: "newsletter", group_id: "g1", notes: "n1" });
    const before = getLevelById(db, id)!;
    const result = editLevel(
      db,
      id,
      {
        level_type: "exit",
        price: 130,
        direction: "bullish",
        action_hint: "trim",
        source_author: "  Someone  ",
        thesis: "new thesis",
        timeframe: "week",
        expires_at: "2099-12-31",
      },
      { today: TODAY }
    );
    expect(result).toMatchObject({ ok: true, armed: true, guardRan: true });
    const after = getLevelById(db, id)!;
    expect(after).toMatchObject({
      level_type: "exit",
      price: 130,
      price_source: "static",
      direction: "bullish",
      action_hint: "trim",
      source_author: "Someone",
      thesis: "new thesis",
      timeframe: "week",
      expires_at: "2099-12-31",
      // Untouched.
      security_id: secId,
      source: "newsletter",
      group_id: "g1",
      notes: "n1",
      review_status: "auto_approved",
      is_active: 1,
      created_at: before.created_at,
    });
  });

  it("never approves a pending level, and never re-activates a paused one", () => {
    const pending = armedLevel({ review_status: "pending_review" });
    expect(editLevel(db, pending, { price: 125 }, { today: TODAY })).toMatchObject({
      ok: true,
      armed: false,
      guardRan: false,
    });
    expect(getLevelById(db, pending)!.review_status).toBe("pending_review");

    const rejected = armedLevel({ review_status: "rejected" });
    editLevel(db, rejected, { thesis: "x" }, { today: TODAY });
    expect(getLevelById(db, rejected)!.review_status).toBe("rejected");

    const paused = armedLevel();
    deactivateLevel(db, paused);
    // 90 is already crossed for a resistance level at spot 100, but a paused
    // level is not in front of the scanner, so nothing is refused.
    expect(editLevel(db, paused, { price: 90 }, { today: TODAY })).toMatchObject({
      ok: true,
      armed: false,
    });
    expect(getLevelById(db, paused)!.is_active).toBe(0);
    expect(findCrossedLevels(db).map((l) => l.id)).not.toContain(paused);
  });

  it("a key that is absent keeps the stored value; blank text becomes NULL", () => {
    const id = armedLevel({ timeframe: "month", expires_at: "2099-06-30" });
    editLevel(db, id, { thesis: "   " }, { today: TODAY });
    const after = getLevelById(db, id)!;
    expect(after.thesis).toBeNull();
    expect(after.timeframe).toBe("month");
    expect(after.expires_at).toBe("2099-06-30");
    expect(after.price).toBe(120);
  });

  it("a missing row is not_found and writes nothing", () => {
    expect(editLevel(db, 987654, { price: 5 }, { today: TODAY })).toEqual({
      ok: false,
      code: "not_found",
    });
  });
});

describe("editLevel — the arm guard", () => {
  it("refuses an armed edit the price has already crossed, and writes nothing", () => {
    const id = armedLevel();
    const result = editLevel(db, id, { price: 90, thesis: "moved" }, { today: TODAY });
    expect(result).toMatchObject({
      ok: false,
      code: "would_fire_immediately",
      currentPrice: 100,
      effectivePrice: 90,
    });
    const after = getLevelById(db, id)!;
    expect(after.price).toBe(120);
    expect(after.thesis).toBe("old thesis");
    expect(findCrossedLevels(db)).toHaveLength(0);
  });

  it("a type change that flips the trigger side is refused the same way", () => {
    const id = armedLevel();
    // Support at 120 with spot 100: the price is at or below the level.
    expect(editLevel(db, id, { level_type: "support" }, { today: TODAY })).toMatchObject({
      ok: false,
      code: "would_fire_immediately",
    });
    expect(getLevelById(db, id)!.level_type).toBe("resistance");
  });

  it("force saves the crossed edit and stamps armed_crossed_at, as a forced approval does", () => {
    const id = armedLevel();
    expect(editLevel(db, id, { price: 90 }, { force: true, today: TODAY })).toMatchObject({
      ok: true,
      armed: true,
    });
    expect(getLevelById(db, id)!.price).toBe(90);
    expect(getLevelById(db, id)!.armed_crossed_at).not.toBeNull();

    const other = armedLevel({ price: 90, review_status: "pending_review" });
    expect(approveLevelGuarded(db, other, { force: true }).ok).toBe(true);
    expect(getLevelById(db, other)!.armed_crossed_at).not.toBeNull();
  });

  it("refuses an armed edit outside the scan range; force saves it without a stamp", () => {
    const id = armedLevel();
    expect(editLevel(db, id, { price: 1200 }, { today: TODAY })).toMatchObject({
      ok: false,
      code: "beyond_scan_range",
    });
    expect(getLevelById(db, id)!.price).toBe(120);
    expect(editLevel(db, id, { price: 1200 }, { force: true, today: TODAY }).ok).toBe(true);
    expect(getLevelById(db, id)!.price).toBe(1200);
    expect(getLevelById(db, id)!.armed_crossed_at).toBeNull();
  });

  it("a clean price edit clears a stale stamp; a wording-only edit leaves it", () => {
    const id = armedLevel();
    editLevel(db, id, { price: 90 }, { force: true, today: TODAY });
    expect(getLevelById(db, id)!.armed_crossed_at).not.toBeNull();

    expect(editLevel(db, id, { thesis: "reworded" }, { today: TODAY })).toMatchObject({
      ok: true,
      guardRan: false,
    });
    expect(getLevelById(db, id)!.armed_crossed_at).not.toBeNull();

    expect(editLevel(db, id, { price: 125 }, { today: TODAY })).toMatchObject({
      ok: true,
      guardRan: true,
    });
    expect(getLevelById(db, id)!.armed_crossed_at).toBeNull();
  });

  it("a later expiry that brings an expired, crossed level back is guarded", () => {
    const id = armedLevel({ price: 90, expires_at: "2000-01-01" });
    expect(findCrossedLevels(db)).toHaveLength(0);
    expect(editLevel(db, id, { expires_at: "2099-12-31" }, { today: TODAY })).toMatchObject({
      ok: false,
      code: "would_fire_immediately",
    });
    expect(getLevelById(db, id)!.expires_at).toBe("2000-01-01");
    expect(findCrossedLevels(db)).toHaveLength(0);
  });
});

describe("mergeLevelEdit — validation", () => {
  const current = () => {
    const id = armedLevel({ expires_at: "2026-01-31" });
    return getLevelById(db, id)!;
  };

  it("refuses a non-positive or non-finite static price", () => {
    for (const price of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
      expect(mergeLevelEdit(current(), { price }, TODAY).ok).toBe(false);
    }
  });

  it("allows a zero reference price only on a moving-average level", () => {
    expect(mergeLevelEdit(current(), { price: 0, price_source: "sma_50" }, TODAY).ok).toBe(true);
  });

  it("refuses unknown enum values", () => {
    const row = current();
    expect(mergeLevelEdit(row, { level_type: "magic" }, TODAY).ok).toBe(false);
    expect(mergeLevelEdit(row, { price_source: "sma_7" }, TODAY).ok).toBe(false);
    expect(mergeLevelEdit(row, { direction: "sideways" }, TODAY).ok).toBe(false);
    expect(mergeLevelEdit(row, { action_hint: "yolo" }, TODAY).ok).toBe(false);
    expect(mergeLevelEdit(row, { timeframe: "year" }, TODAY).ok).toBe(false);
  });

  it("keeps an unchanged past expiry, refuses a new past one, allows clearing it", () => {
    const row = current();
    expect(mergeLevelEdit(row, { expires_at: "2026-01-31", thesis: "t" }, TODAY).ok).toBe(true);
    expect(mergeLevelEdit(row, { expires_at: "2026-02-28" }, TODAY).ok).toBe(false);
    expect(mergeLevelEdit(row, { expires_at: TODAY }, TODAY).ok).toBe(true);
    expect(mergeLevelEdit(row, { expires_at: "next week" }, TODAY).ok).toBe(false);
    const cleared = mergeLevelEdit(row, { expires_at: "" }, TODAY);
    expect(cleared.ok && cleared.fields.expires_at).toBeNull();
  });
});
