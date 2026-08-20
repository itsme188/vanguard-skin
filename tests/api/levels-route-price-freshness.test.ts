/**
 * Gap 1 pin (client half): GET /api/levels is what LevelsPanel renders, so the
 * panel can only disclose a stale-priced armed level if the route tells it.
 * Every row carries the scanner's freshness verdict — the same window
 * findCrossedLevels applies — alongside the price date it was judged on.
 *
 * Plus the Gap 2 tail: POST /api/levels creates levels ALREADY auto_approved
 * (armed), so a mis-scaled manual add arms dead coverage. The Add forms warn
 * before the save (f7823b6), but a headless POST had no signal at all — the
 * response now carries a non-blocking `warning`. Deliberately not a refusal:
 * marking structure to arm later is legitimate, and the create path has no
 * force flag to override one with.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
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

function seedPriceDaysAgo(securityId: number, price: number, daysAgo: number): void {
  hoisted.db
    .prepare(
      `INSERT INTO prices (security_id, date, close_price, source)
       VALUES (?, date('now', '-' || ? || ' days'), ?, 'manual')`,
    )
    .run(securityId, daysAgo, price);
}

async function getLevels(securityId: number) {
  const mod = await import("@/app/api/levels/route");
  const res = await mod.GET(
    new NextRequest(`http://test/api/levels?securityId=${securityId}`),
  );
  const body = (await res.json()) as {
    success: boolean;
    levels: Array<{
      id: number;
      price: number;
      price_date: string | null;
      price_is_stale: boolean;
    }>;
  };
  expect(body.success).toBe(true);
  return body.levels;
}

describe("GET /api/levels — scan price freshness", () => {
  it("marks a level whose security's price has gone stale", async () => {
    const secId = seedSecurity("STALEQA");
    upsertLevel(hoisted.db, { security_id: secId, level_type: "support", price: 90 });
    seedPriceDaysAgo(secId, 100, 30);

    const [level] = await getLevels(secId);
    expect(level.price_is_stale).toBe(true);
    expect(level.price_date).not.toBeNull();
  });

  it("does not mark a level priced inside the window", async () => {
    const secId = seedSecurity("FRESHQA");
    upsertLevel(hoisted.db, { security_id: secId, level_type: "support", price: 90 });
    seedPriceDaysAgo(secId, 100, 1);

    const [level] = await getLevels(secId);
    expect(level.price_is_stale).toBe(false);
  });

  it("does not mark a security with no price at all — absent is not stale", async () => {
    const secId = seedSecurity("NOPRICEQA");
    upsertLevel(hoisted.db, { security_id: secId, level_type: "support", price: 90 });

    const [level] = await getLevels(secId);
    expect(level.price_is_stale).toBe(false);
    expect(level.price_date).toBeNull();
  });
});

async function postLevel(body: unknown) {
  const mod = await import("@/app/api/levels/route");
  const res = await mod.POST(
    new NextRequest("http://test/api/levels", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      success: boolean;
      id?: number;
      warning?: string;
    },
  };
}

describe("POST /api/levels — beyond-scan-range warning", () => {
  it("creates the level but warns that the scanner will skip it", async () => {
    const secId = seedSecurity("MISSCALEQA");
    seedPriceDaysAgo(secId, 748, 0);

    const { status, body } = await postLevel({
      security_id: secId,
      level_type: "support",
      price: 7100,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.id).toBeGreaterThan(0); // saved, not refused
    expect(body.warning).toBeTruthy();
    expect(body.warning).toContain("scanner");
  });

  it("does not warn for an in-band level", async () => {
    const secId = seedSecurity("OKQA");
    seedPriceDaysAgo(secId, 100, 0);

    const { body } = await postLevel({
      security_id: secId,
      level_type: "support",
      price: 90,
    });

    expect(body.success).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it("does not warn when the price is stale — the band can't be judged", async () => {
    const secId = seedSecurity("STALEBANDQA");
    seedPriceDaysAgo(secId, 748, 30);

    const { body } = await postLevel({
      security_id: secId,
      level_type: "support",
      price: 7100,
    });

    expect(body.success).toBe(true);
    expect(body.warning).toBeUndefined();
  });
});
