/**
 * PATCH /api/levels action "deactivate" on a level that is not armed.
 * The UI offers Pause only on an auto-approved active level; the route now
 * enforces the same rule with a 409 instead of pausing a rejected or pending row.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { getLevelById } from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let secId: number;

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  secId = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('ZZA', 'ZZA Corp', 'stock', 'equity', 1)"
    )
    .run().lastInsertRowid as number;
});

function pause(id: number): NextRequest {
  return new NextRequest("http://test/api/levels", {
    method: "PATCH",
    body: JSON.stringify({ id, action: "deactivate" }),
  });
}

describe("PATCH /api/levels deactivate", () => {
  it("still pauses an approved active level", async () => {
    const id = upsertLevel(hoisted.db, { security_id: secId, level_type: "entry", price: 100 });
    const mod = await import("@/app/api/levels/route");
    const res = await mod.PATCH(pause(id));
    expect(res.status).toBe(200);
    expect(getLevelById(hoisted.db, id)!.is_active).toBe(0);
  });

  for (const review_status of ["rejected", "pending_review"] as const) {
    it(`refuses a ${review_status} level with a 409 and writes nothing`, async () => {
      const id = upsertLevel(hoisted.db, { security_id: secId, level_type: "entry", price: 100, review_status });
      const mod = await import("@/app/api/levels/route");
      const res = await mod.PATCH(pause(id));
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/not armed, so there is nothing to pause/i);
      const row = getLevelById(hoisted.db, id)!;
      expect(row.is_active).toBe(1);
      expect(row.review_status).toBe(review_status);
    });
  }
});
