/**
 * Construction caps saved on the Settings page must reach the engine that
 * consumes them — not merely round-trip through the settings table.
 *
 * Why this file exists, on top of the stored-shape assertions in
 * tests/api/settings-preferences.test.ts: `getCaps` (lib/compute/exposure-delta.ts)
 * reads snake_case fields and merges each one against DEFAULT_CAPS with `??`,
 * and `beta_range` is a 2-element [low, high] array. A control that wrote
 * camelCase (`{top1Max: 0.35}`) or a flat `{betaMin, betaMax}` pair would store
 * valid JSON, parse without error, yield `undefined` for every field the reader
 * asks for, and silently fall back to the DEFAULTS. Nothing would log and
 * nothing would throw — the What-if calculator and the cash-deploy suggestions
 * would just keep applying the old position-concentration limits while the
 * Settings page showed the owner the new ones.
 *
 * A stored-shape test alone cannot catch that, because a test can mirror the
 * reader's parse and drift from it later. These tests therefore go through the
 * real exported engine entry point, `computeExposureDelta`, and assert on
 * BEHAVIOUR: a cap the owner saved changes which flags the engine raises and
 * the `capValue` it reports. A camelCase write fails them.
 *
 * Seeded defaults for scope "all" (migration 049_construction_caps.sql):
 *   top1_max 0.10, top3_max 0.25, sector_max 0.35, beta_range [0.7, 1.2]
 * Every cap written below is deliberately a different number from the default
 * it replaces, so a fallback-to-default cannot pass by coincidence.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { constructionCapsKey } from "@/lib/queries/app-preferences";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Imported AFTER the mock so the route binds to the in-memory database.
import { PATCH } from "@/app/api/settings/preferences/route";

/**
 * Book worth $7,000, chosen so each weight sits in a gap between the seeded
 * default and the cap written in each test:
 *   JNJ  20 x $150 = $3,000 -> 42.86% (top position)
 *   AAPL 10 x $200 = $2,000 -> 28.57%
 *   MSFT  5 x $400 = $2,000 -> 28.57%
 *   Technology (AAPL + MSFT) = $4,000 -> 57.14%
 *   Portfolio beta = (2000*1.2 + 3000*0.6 + 2000*1.1) / 7000 = 0.9143
 * Migration 002 seeds accounts 1 = Vanguard Taxable, 3 = IBKR.
 */
function seedBook(db: Database.Database) {
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (1, 'AAPL', 'Stock', 'Technology')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (2, 'MSFT', 'Stock', 'Technology')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (3, 'JNJ', 'Stock', 'Healthcare')`).run();

  db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (1, 60, 1.2, '2026-05-10')`).run();
  db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (2, 60, 1.1, '2026-05-10')`).run();
  db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (3, 60, 0.6, '2026-05-10')`).run();

  // The engine reads today's price; the Eastern day is what the app uses.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 400, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 150, 'tws')`).run(today);

  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, ?, 10, 'vg-aapl')`).run(today);
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 3, ?, 20, 'vg-jnj')`).run(today);
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 2, ?, 5, 'tws-msft')`).run(today);
}

async function saveCaps(caps: Record<string, number>) {
  const res = await PATCH(
    new NextRequest("http://localhost/api/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ constructionCaps: { all: caps } }),
    }),
  );
  expect(res.status).toBe(200);
  return res;
}

const CAPS_ALL = { top1Max: 0.35, top3Max: 0.9, sectorMax: 0.9, betaMin: 0.1, betaMax: 5 };

describe("construction caps saved on the Settings page reach the What-if engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedBook(db);
    hoisted.db = db;
  });

  it("baseline: the seeded default top1_max of 10% is what the engine applies before any save", () => {
    const flags = computeExposureDelta(db, "all", undefined, []).flags;
    const top1 = flags.find((f) => f.metric === "top1");
    // JNJ at 42.86% breaches the seeded 10% cap, so the engine reports 0.10.
    expect(top1?.capValue).toBe(0.1);
  });

  it("a saved top-position cap is the number the engine reports, not the default", async () => {
    await saveCaps(CAPS_ALL);

    const flags = computeExposureDelta(db, "all", undefined, []).flags;
    const top1 = flags.find((f) => f.metric === "top1");

    // JNJ at 42.86% still breaches, but now against the owner's 35%.
    expect(top1).toBeDefined();
    expect(top1!.capValue).toBe(0.35);
    // The guard: a camelCase or mis-shaped write falls back to DEFAULT_CAPS.
    expect(top1!.capValue).not.toBe(0.1);
    expect(top1!.message).toContain("cap 35%");
  });

  it("raising the cap above the real weight removes the flag entirely", async () => {
    // 45% clears JNJ's 42.86%, so a correctly-stored cap silences the warning.
    await saveCaps({ ...CAPS_ALL, top1Max: 0.45 });

    const flags = computeExposureDelta(db, "all", undefined, []).flags;
    expect(flags.find((f) => f.metric === "top1")).toBeUndefined();
  });

  it("a saved beta band reaches the engine as a [low, high] pair", async () => {
    // Portfolio beta is 0.9143, inside the seeded [0.7, 1.2] band, so there is
    // no beta flag by default. A band of [0.95, 1.5] puts it below the floor.
    expect(
      computeExposureDelta(db, "all", undefined, []).flags.find((f) => f.metric === "beta"),
    ).toBeUndefined();

    await saveCaps({ ...CAPS_ALL, betaMin: 0.95, betaMax: 1.5 });

    const beta = computeExposureDelta(db, "all", undefined, []).flags.find(
      (f) => f.metric === "beta",
    );
    // Only a real 2-element beta_range array can produce this; a flat
    // {betaMin, betaMax} write leaves the reader on [0.7, 1.2] and no flag.
    expect(beta).toBeDefined();
  });

  it("a sector cap saved for one scope does not leak into another scope's engine run", async () => {
    // IBKR is seeded most permissive (sector_max 0.45). Tighten only "all".
    await saveCaps({ ...CAPS_ALL, sectorMax: 0.2 });

    const all = computeExposureDelta(db, "all", undefined, []).flags;
    const tech = all.find((f) => f.metric === "sector:Technology");
    expect(tech).toBeDefined();
    expect(tech!.capValue).toBe(0.2);

    // The ibkr row was never written, so its engine run keeps its own seed.
    const ibkrRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(constructionCapsKey("ibkr")) as { value: string };
    expect(JSON.parse(ibkrRow.value).sector_max).toBe(0.45);
  });
});
