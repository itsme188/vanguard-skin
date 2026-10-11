/**
 * POST /api/levels (create) asks the shared arm guard, as the Edit and
 * Reactivate paths do. A create lands armed (auto_approved), so a level the
 * current price is already past would fire on the next scan from a stale
 * close. The route answers 409 with the arm guard's code and writes nothing
 * unless the body carries `force: true`; a forced create stamps
 * `armed_crossed_at` by the same rule as an edit.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { getLevelById } from "@/lib/queries/security-levels";
import { createLevelGuarded } from "@/lib/levels/create-level";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let secId: number;
let unpricedId: number;

function levelCount(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM security_levels").get() as { n: number }).n;
}

function crossedAt(id: number): string | null {
  return (
    hoisted.db.prepare("SELECT armed_crossed_at FROM security_levels WHERE id = ?").get(id) as {
      armed_crossed_at: string | null;
    }
  ).armed_crossed_at;
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  secId = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 1)"
    )
    .run().lastInsertRowid as number;
  hoisted.db
    .prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2099-01-02', 100, 'manual')")
    .run(secId);
  unpricedId = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('ZZZ', 'ZZZ Corp', 'stock', 'equity', 1)"
    )
    .run().lastInsertRowid as number;
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/levels create runs the arm guard", () => {
  it("409 would_fire_immediately for a resistance already below the price; nothing written", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(postReq({ security_id: secId, level_type: "resistance", price: 90 }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({
      success: false,
      code: "would_fire_immediately",
      currentPrice: 100,
      effectivePrice: 90,
      alertedToday: false,
    });
    expect(json.error).toMatch(/Nothing was saved/);
    expect(levelCount()).toBe(0);
  });

  it("409 beyond_scan_range for a mis-scaled level; nothing written", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(postReq({ security_id: secId, level_type: "resistance", price: 10000 }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ success: false, code: "beyond_scan_range", alertedToday: false });
    expect(levelCount()).toBe(0);
  });

  it("force: true creates the level and stamps armed_crossed_at", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(
      postReq({ security_id: secId, level_type: "resistance", price: 90, force: true })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(getLevelById(hoisted.db, json.id)).toMatchObject({ price: 90, review_status: "auto_approved" });
    expect(crossedAt(json.id)).not.toBeNull();
  });

  it("a forced beyond-range create is saved with the non-blocking warning and no stamp", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(
      postReq({ security_id: secId, level_type: "resistance", price: 10000, force: true })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.warning).toContain("scanner");
    expect(crossedAt(json.id)).toBeNull();
  });

  it("a level not yet crossed is created with no stamp", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(postReq({ security_id: secId, level_type: "resistance", price: 110 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.warning).toBeUndefined();
    expect(crossedAt(json.id)).toBeNull();
  });

  it("no fresh price: created without the guard, as before", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(postReq({ security_id: unpricedId, level_type: "resistance", price: 90 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(crossedAt(json.id)).toBeNull();
  });

  it("a level created outside the armed universe (pending review) skips the guard", () => {
    const result = createLevelGuarded(hoisted.db, {
      security_id: secId,
      level_type: "resistance",
      price: 90,
      review_status: "pending_review",
    });
    expect(result.ok).toBe(true);
    expect(levelCount()).toBe(1);
  });
});
