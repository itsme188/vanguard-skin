/**
 * HTTP-boundary tests for POST/PATCH /api/levels — specifically the
 * past-expiry guard on NEW user-created levels.
 *
 * QA finding security-detail-levels--past-expiry-accepted-renders-armed-never-fires:
 * a level created with expires_at in the past used to be accepted silently
 * (200), rendered in the active list looking armed, but getArmedLevels /
 * findCrossedLevels filter `expires_at >= date('now')` so it could never
 * fire. The create path (POST, no id) now rejects a past expires_at with an
 * honest 400. The update path (PATCH, has id — deactivate/reactivate/edit)
 * must NOT be gated: an edit that keeps an already-past expiry (or a sync/
 * import re-upsert of a historical row) is a legitimate write.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { todayET, addDays } from "@/lib/calendar/date-utils";
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

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/levels", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("POST /api/levels — past-expiry guard on create", () => {
  it("rejects a new level with expires_at in the past (400, honest envelope)", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const past = "2020-01-01";

    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(
      postReq({
        security_id: secId,
        level_type: "entry",
        price: 180,
        expires_at: past,
      })
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain(past);

    // Nothing was written.
    const rows = hoisted.db
      .prepare("SELECT COUNT(*) as n FROM security_levels")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("accepts a new level with a future expires_at (200)", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const future = addDays(todayET(), 30);

    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(
      postReq({
        security_id: secId,
        level_type: "entry",
        price: 180,
        expires_at: future,
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: number };
    expect(body.success).toBe(true);

    const level = getLevelById(hoisted.db, body.id)!;
    expect(level.expires_at).toBe(future);
  });

  it("accepts a new level with expires_at === today (>= today('now') survives the scanner filter)", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");
    const today = todayET();

    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(
      postReq({
        security_id: secId,
        level_type: "entry",
        price: 180,
        expires_at: today,
      })
    );

    expect(res.status).toBe(200);
  });

  it("accepts a new level with no expires_at (200)", async () => {
    const secId = seedSecurity(hoisted.db, "AAPL");

    const mod = await import("@/app/api/levels/route");
    const res = await mod.POST(
      postReq({ security_id: secId, level_type: "entry", price: 180 })
    );

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/levels — update path is not gated by the past-expiry guard", () => {
  it("still allows editing a level while keeping its already-past expires_at", async () => {
    // Simulates a historical/legacy level (e.g. a sync re-upsert or an old
    // user level) that already expired. Editing an unrelated field (price)
    // must not suddenly 400 just because expires_at is in the past.
    const secId = seedSecurity(hoisted.db, "AAPL");
    const past = "2020-01-01";
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "entry",
      price: 180,
      expires_at: past,
    });

    const mod = await import("@/app/api/levels/route");
    const res = await mod.PATCH(
      patchReq({
        id: levelId,
        security_id: secId,
        level_type: "entry",
        price: 190,
        expires_at: past,
      })
    );

    expect(res.status).toBe(200);
    const level = getLevelById(hoisted.db, levelId)!;
    expect(level.price).toBe(190);
    expect(level.expires_at).toBe(past);
  });

  it("in-process upsertLevel (sync/import/newsletter-accept path) is untouched by the route guard", () => {
    // upsertLevel itself must remain callable directly with a past
    // expires_at — the guard lives only in the POST route, not the lib fn.
    const secId = seedSecurity(hoisted.db, "AAPL");
    const past = "2020-01-01";
    const id = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "entry",
      price: 180,
      expires_at: past,
      source: "newsletter",
    });

    const level = getLevelById(hoisted.db, id)!;
    expect(level.expires_at).toBe(past);
  });
});
