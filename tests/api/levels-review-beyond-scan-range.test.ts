/**
 * HTTP-boundary pin for Gap 2: PATCH /api/levels/review must refuse a
 * beyond-band arm with 409 + code 'beyond_scan_range' (same envelope shape and
 * same `force` semantics as would_fire_immediately), so an API caller — not
 * just the Review tab — learns that arming this level buys dead coverage.
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

function seedSecurity(symbol: string): number {
  return hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPrice(securityId: number, price: number): void {
  hoisted.db
    .prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, date('now'), ?, 'manual')",
    )
    .run(securityId, price);
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels/review", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function seedMisScaledPending(): number {
  const secId = seedSecurity("SPYQA");
  const levelId = upsertLevel(hoisted.db, {
    security_id: secId,
    level_type: "support",
    price: 7100,
    source: "newsletter",
    review_status: "pending_review",
  });
  seedPrice(secId, 748);
  return levelId;
}

describe("PATCH /api/levels/review — beyond scan range", () => {
  it("returns 409 beyond_scan_range for a mis-scaled level", async () => {
    const levelId = seedMisScaledPending();

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
    expect(body.code).toBe("beyond_scan_range");
    expect(body.currentPrice).toBe(748);
    expect(body.effectivePrice).toBe(7100);
    expect(body.error).toContain("748");
    expect(body.error).toContain("7100");
    // Level prices can be native currency — no hardcoded dollar glyph.
    expect(body.error).not.toContain("$");

    expect(getLevelById(hoisted.db, levelId)!.review_status).toBe("pending_review");
  });

  it("arms with force:true, leaving armed_crossed_at null", async () => {
    const levelId = seedMisScaledPending();

    const mod = await import("@/app/api/levels/review/route");
    const res = await mod.PATCH(
      patchReq({ id: levelId, status: "auto_approved", force: true }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.review_status).toBe("auto_approved");
    expect(level.armed_crossed_at).toBeNull();
  });

  it("still returns 409 would_fire_immediately for an in-band crossed level", async () => {
    const secId = seedSecurity("AAPLQA");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 180,
      source: "newsletter",
      review_status: "pending_review",
    });
    seedPrice(secId, 175);

    const mod = await import("@/app/api/levels/review/route");
    const res = await mod.PATCH(patchReq({ id: levelId, status: "auto_approved" }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("would_fire_immediately");
  });
});
