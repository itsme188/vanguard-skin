/**
 * HTTP-boundary tests for /api/corporate-actions — the manual-road guards
 * added alongside the IBKR corporate-actions importer (issue #37):
 *   - POST refuses (409) when an action already exists for the same
 *     security + effective_date, with an extra hint when the collision
 *     is an imported row.
 *   - DELETE refuses (403) when the target row is source='import'.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

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
    .prepare("INSERT INTO securities (symbol) VALUES (?)")
    .run(symbol).lastInsertRowid as number;
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/corporate-actions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function deleteReq(id: number): NextRequest {
  return new NextRequest(`http://test/api/corporate-actions?id=${id}`, {
    method: "DELETE",
  });
}

describe("POST /api/corporate-actions", () => {
  it("returns 409 when a manual action already exists for this security + date", async () => {
    const secId = seedSecurity(hoisted.db, "AAAA");
    hoisted.db
      .prepare(
        `INSERT INTO corporate_actions
           (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
         VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 1, 'manual')`,
      )
      .run(secId);

    const mod = await import("@/app/api/corporate-actions/route");
    const res = await mod.POST(
      postReq({
        securityId: secId,
        actionType: "SPLIT",
        effectiveDate: "2026-07-01",
        ratioNumerator: 2,
        ratioDenominator: 1,
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("2026-07-01");
    expect(body.error).not.toContain("imported from a statement");
  });

  it("returns 409 with an import hint when the collision is an imported row", async () => {
    const secId = seedSecurity(hoisted.db, "BBBB");
    hoisted.db
      .prepare(
        `INSERT INTO corporate_actions
           (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
         VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 0, 'import', 'ibkr:ca:split:2026-07-01:BBBB:4:1')`,
      )
      .run(secId);

    const mod = await import("@/app/api/corporate-actions/route");
    const res = await mod.POST(
      postReq({
        securityId: secId,
        actionType: "SPLIT",
        effectiveDate: "2026-07-01",
        ratioNumerator: 2,
        ratioDenominator: 1,
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("imported from a statement");
  });
});

describe("DELETE /api/corporate-actions", () => {
  it("returns 403 when the target row is source='import'", async () => {
    const secId = seedSecurity(hoisted.db, "CCCC");
    const r = hoisted.db
      .prepare(
        `INSERT INTO corporate_actions
           (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
         VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 0, 'import', 'ibkr:ca:split:2026-07-01:CCCC:4:1')`,
      )
      .run(secId);
    const actionId = Number(r.lastInsertRowid);

    const mod = await import("@/app/api/corporate-actions/route");
    const res = await mod.DELETE(deleteReq(actionId));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/import/i);

    const still = hoisted.db
      .prepare("SELECT COUNT(*) AS c FROM corporate_actions WHERE id = ?")
      .get(actionId) as { c: number };
    expect(still.c).toBe(1);
  });
});
