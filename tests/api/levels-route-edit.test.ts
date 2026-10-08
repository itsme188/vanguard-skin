/**
 * PATCH /api/levels with action "edit" — the row's Edit control.
 * The rules themselves are covered in tests/levels/edit-level.test.ts; this
 * pins the route's status codes and envelope.
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

let secId: number;
let levelId: number;

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
  levelId = upsertLevel(hoisted.db, {
    security_id: secId,
    level_type: "resistance",
    price: 120,
    review_status: "pending_review",
    source: "newsletter",
  });
});

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels", { method: "PATCH", body: JSON.stringify(body) });
}

describe("PATCH /api/levels action=edit", () => {
  it("200: saves the form fields and keeps review status and provenance", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.PATCH(
      patchReq({ id: levelId, action: "edit", price: 125, thesis: "why", timeframe: "week" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.armed).toBe(false);
    expect(json.level).toMatchObject({
      price: 125,
      thesis: "why",
      timeframe: "week",
      review_status: "pending_review",
      source: "newsletter",
    });
  });

  it("400: an invalid field, nothing written", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.PATCH(patchReq({ id: levelId, action: "edit", price: -1 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(typeof json.error).toBe("string");
    expect(getLevelById(hoisted.db, levelId)!.price).toBe(120);
  });

  it("404: a missing row", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.PATCH(patchReq({ id: 987654, action: "edit", price: 5 }));
    expect(res.status).toBe(404);
  });

  it("409 with the arm guard's code on an armed, already-crossed edit; force overrides", async () => {
    const armed = upsertLevel(hoisted.db, { security_id: secId, level_type: "resistance", price: 120 });
    const mod = await import("@/app/api/levels/route");
    const refused = await mod.PATCH(patchReq({ id: armed, action: "edit", price: 90 }));
    expect(refused.status).toBe(409);
    const json = await refused.json();
    expect(json).toMatchObject({
      success: false,
      code: "would_fire_immediately",
      currentPrice: 100,
      effectivePrice: 90,
    });
    expect(getLevelById(hoisted.db, armed)!.price).toBe(120);

    const forced = await mod.PATCH(patchReq({ id: armed, action: "edit", price: 90, force: true }));
    expect(forced.status).toBe(200);
    expect((await forced.json()).level.price).toBe(90);
  });
});
