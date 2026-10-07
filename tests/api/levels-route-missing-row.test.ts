/**
 * PATCH / DELETE /api/levels on an id that does not exist.
 *
 * Every branch used to answer 200 `{success:true}` for a missing row (the
 * UPDATE / DELETE simply matched nothing), so the panel toasted "Level
 * reactivated" / "Level deleted" for a level that was never there. Each
 * branch now answers 404 with the standard `{success:false,error}` envelope
 * and writes nothing.
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
const MISSING = 987654;

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  secId = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 1)"
    )
    .run().lastInsertRowid as number;
  levelId = upsertLevel(hoisted.db, { security_id: secId, level_type: "entry", price: 100 });
});

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function deleteReq(id: string): NextRequest {
  return new NextRequest(`http://test/api/levels?id=${id}`, { method: "DELETE" });
}

function levelCount(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM security_levels").get() as { n: number }).n;
}

async function expect404(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const json = await res.json();
  expect(json.success).toBe(false);
  expect(typeof json.error).toBe("string");
  expect(json.error).toMatch(/not found/i);
  expect(json.level).toBeUndefined();
}

describe("PATCH /api/levels — missing row is 404", () => {
  it("reactivate", async () => {
    const mod = await import("@/app/api/levels/route");
    await expect404(await mod.PATCH(patchReq({ id: MISSING, action: "reactivate" })));
    await expect404(await mod.PATCH(patchReq({ id: MISSING, action: "reactivate", force: true })));
  });

  it("deactivate", async () => {
    const mod = await import("@/app/api/levels/route");
    await expect404(await mod.PATCH(patchReq({ id: MISSING, action: "deactivate" })));
  });

  it("edit (no action) writes no row", async () => {
    const mod = await import("@/app/api/levels/route");
    await expect404(
      await mod.PATCH(patchReq({ id: MISSING, security_id: secId, level_type: "entry", price: 55 }))
    );
    expect(levelCount()).toBe(1);
    expect(getLevelById(hoisted.db, levelId)!.price).toBe(100);
  });

  it("an existing row still answers 200 on every branch", async () => {
    const mod = await import("@/app/api/levels/route");
    const paused = await mod.PATCH(patchReq({ id: levelId, action: "deactivate" }));
    expect(paused.status).toBe(200);
    expect((await paused.json()).level.is_active).toBe(0);
    const back = await mod.PATCH(patchReq({ id: levelId, action: "reactivate" }));
    expect(back.status).toBe(200);
    expect((await back.json()).level.is_active).toBe(1);
    const edited = await mod.PATCH(
      patchReq({ id: levelId, security_id: secId, level_type: "entry", price: 105 })
    );
    expect(edited.status).toBe(200);
    expect((await edited.json()).level.price).toBe(105);
  });

  it("a missing id is still 400, not 404", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.PATCH(patchReq({ action: "reactivate" }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/levels — missing row is 404", () => {
  it("an id that does not exist", async () => {
    const mod = await import("@/app/api/levels/route");
    await expect404(await mod.DELETE(deleteReq(String(MISSING))));
    expect(levelCount()).toBe(1);
  });

  it("an id that is not a number", async () => {
    const mod = await import("@/app/api/levels/route");
    await expect404(await mod.DELETE(deleteReq("abc")));
    expect(levelCount()).toBe(1);
  });

  it("an existing row is deleted (200)", async () => {
    const mod = await import("@/app/api/levels/route");
    const res = await mod.DELETE(deleteReq(String(levelId)));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(levelCount()).toBe(0);
  });
});
