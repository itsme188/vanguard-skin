/**
 * QA fix (2026-08-18): POST /api/compute/scenarios validates rateMove the
 * same way it already validates marketMove — a non-finite rateMove (e.g. a
 * value that overflows to Infinity on JSON parse, or a non-number) must 400
 * with the standard envelope instead of flowing into computeScenario. No
 * magnitude bounds are added (per the signed-off design — only marketMove
 * has a bounded range).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { POST } from "@/app/api/compute/scenarios/route";

function postScenario(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/compute/scenarios", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }) as never
  );
}

// JSON has no NaN/Infinity literal — JSON.stringify(Infinity) collapses to
// `null`, which the guard treats as "not provided" and skips. The realistic
// non-finite case over the wire is a numeric literal that overflows double
// precision on parse (e.g. 1e400 -> Infinity), so build the body as raw text.
function postScenarioRaw(rawBody: string) {
  return POST(
    new Request("http://localhost/api/compute/scenarios", {
      method: "POST",
      body: rawBody,
      headers: { "content-type": "application/json" },
    }) as never
  );
}

// Minimal schema so a request that clears the guard actually reaches
// computeScenario and returns a real 200 (empty portfolio), rather than an
// incidental 500 from missing tables — same tables/columns as
// tests/compute/scenarios.test.ts / scenarios-composed.test.ts.
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      sector TEXT,
      market_cap_category TEXT,
      style TEXT,
      duration_years REAL,
      credit_rating TEXT,
      expiration_date TEXT,
      currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test'
    );
  `);
  return db;
}

describe("POST /api/compute/scenarios — rateMove validation", () => {
  beforeEach(() => {
    // No scope/accountId is passed in these bodies, so resolveScopeToSingleId
    // short-circuits before touching the db.
    hoisted.db = createTestDb();
  });

  it("400s when rateMove overflows to Infinity on parse", async () => {
    const res = await postScenarioRaw('{"marketMove": -0.1, "rateMove": 1e400}');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("400s when rateMove is a non-number", async () => {
    const res = await postScenario({ marketMove: -0.1, rateMove: "100" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("does not 400 a valid finite rateMove (no magnitude bounds added)", async () => {
    // 5000bp is an absurd shock but the design explicitly adds no magnitude
    // bounds for rateMove — only the finite-number guard.
    const res = await postScenario({ marketMove: -0.1, rateMove: 5000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("still 400s the pre-existing marketMove guard unchanged", async () => {
    const res = await postScenario({ marketMove: 5 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
