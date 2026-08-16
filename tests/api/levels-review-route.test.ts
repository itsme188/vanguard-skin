/**
 * HTTP-boundary tests for PATCH /api/levels/review — specifically the
 * approve-fires-instant-false-hit guard (approveLevelGuarded): approving a
 * level whose trigger condition is already satisfied must refuse with 409
 * unless `force: true` is passed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { getLevelById } from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPrice(db: Database.Database, securityId: number, price: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, date('now'), ?, 'manual')"
  ).run(securityId, price);
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels/review", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/levels/review", () => {
  it("returns 409 would_fire_immediately when approving a level already past its threshold", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(hoisted.db, secId, 175);

    const mod = await import("@/app/api/levels/review/route");
    const res = await mod.PATCH(patchReq({ id: levelId, status: "auto_approved" }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      currentPrice: number;
      effectivePrice: number;
      error: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("would_fire_immediately");
    expect(body.currentPrice).toBe(175);
    expect(body.effectivePrice).toBe(180);
    expect(body.error).toContain("175");
    expect(body.error).toContain("180");

    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.review_status).toBe("pending_review");
  });

  it("arms with force:true and stamps armed_crossed_at", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(hoisted.db, secId, 175);

    const mod = await import("@/app/api/levels/review/route");
    const res = await mod.PATCH(
      patchReq({ id: levelId, status: "auto_approved", force: true })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).not.toBeNull();
  });

  it("approves normally (200) when the level has not been crossed", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(hoisted.db, secId, 190);

    const mod = await import("@/app/api/levels/review/route");
    const res = await mod.PATCH(patchReq({ id: levelId, status: "auto_approved" }));

    expect(res.status).toBe(200);
    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("rejecting a level still works directly (200) and nulls armed_crossed_at", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(hoisted.db, secId, 175);

    const mod = await import("@/app/api/levels/review/route");
    await mod.PATCH(patchReq({ id: levelId, status: "auto_approved", force: true }));
    expect(getLevelById(hoisted.db, levelId)!.armed_crossed_at).not.toBeNull();

    const res = await mod.PATCH(patchReq({ id: levelId, status: "rejected" }));
    expect(res.status).toBe(200);
    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.review_status).toBe("rejected");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("re-queues a rejected level back to pending_review — the LevelsPanel 'Re-queue' action (Codex advisory #49)", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(hoisted.db, secId, 175);

    const mod = await import("@/app/api/levels/review/route");
    await mod.PATCH(patchReq({ id: levelId, status: "rejected" }));
    expect(getLevelById(hoisted.db, levelId)!.review_status).toBe("rejected");

    const res = await mod.PATCH(patchReq({ id: levelId, status: "pending_review" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Back in the review inbox, not approved/armed.
    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.review_status).toBe("pending_review");
    expect(level.armed_crossed_at).toBeNull();

    const listRes = await mod.GET(
      new NextRequest("http://test/api/levels/review")
    );
    const listBody = (await listRes.json()) as {
      success: boolean;
      levels: Array<{ id: number; review_status: string }>;
    };
    expect(listBody.success).toBe(true);
    expect(listBody.levels.some((l) => l.id === levelId && l.review_status === "pending_review")).toBe(
      true
    );
  });
});
