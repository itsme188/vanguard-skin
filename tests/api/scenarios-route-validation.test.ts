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

import { GET, POST } from "@/app/api/compute/scenarios/route";

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
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tax_treatment TEXT);
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      sector TEXT,
      industry TEXT,
      geography TEXT,
      market_cap_category TEXT,
      style TEXT,
      duration_years REAL,
      maturity_date TEXT,
      coupon_rate REAL,
      credit_rating TEXT,
      expiration_date TEXT,
      underlying_symbol TEXT,
      strike_price REAL,
      option_type TEXT,
      fund_category TEXT,
      currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE security_quotes (
      security_id INTEGER PRIMARY KEY,
      as_of_date TEXT NOT NULL,
      iv_underlying REAL
    );
    CREATE TABLE security_factors (
      security_id INTEGER PRIMARY KEY,
      interest_rate_sensitive TEXT,
      growth_vs_value TEXT,
      cyclical TEXT,
      international_exposure TEXT,
      geopolitical_onshoring TEXT,
      tariff_exposure TEXT,
      ai_exposure TEXT,
      crypto_adjacent TEXT,
      regulatory_risk TEXT
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

function seedScopeAccounts(db: Database.Database) {
  db.exec(`
    INSERT INTO accounts (id, name, tax_treatment) VALUES
      (1, 'Vanguard Taxable', 'taxable'),
      (2, 'Vanguard Trust', 'taxable'),
      (3, 'IBKR', 'taxable');
  `);
  const security = db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (?, ?, ?, 'Stock', 'Technology')"
  );
  const holding = db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, '2026-01-31', ?)"
  );
  const price = db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-01-31', 100)");
  for (const [id, accountId, quantity] of [
    [1, 1, 10],
    [2, 2, 20],
    [3, 3, 30],
  ] as const) {
    security.run(id, `ZZ${id}`, `ZZ ${id}`);
    holding.run(accountId, id, quantity);
    price.run(id);
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, 'High')").run(id);
  }
}

describe("POST /api/compute/scenarios — rateMove validation", () => {
  beforeEach(() => {
    // No scope/accountId is passed in these bodies, so scope resolution
    // short-circuits before reading accounts.
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

  it("accepts a large but in-bound rateMove", async () => {
    const res = await postScenario({ marketMove: -0.1, rateMove: 500 });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("still 400s the pre-existing marketMove guard unchanged", async () => {
    const res = await postScenario({ marketMove: 5 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("accepts a volMove inside the range and passes it to the engine", async () => {
    const res = await postScenario({ marketMove: -0.2, volMove: 15 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.scenario.volMove).toBe(15);
    expect(json.data.scenario.description).toContain("vol +15 pts");
  });

  it("accepts both end stops of the slider range", async () => {
    for (const volMove of [-20, 60]) {
      const res = await postScenario({ marketMove: -0.2, volMove });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.scenario.volMove).toBe(volMove);
    }
  });

  it("omits volMove from the scenario when it is zero or null", async () => {
    for (const unset of [0, null]) {
      const res = await postScenario({ marketMove: -0.2, volMove: unset });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.scenario.volMove).toBeUndefined();
      expect(json.data.scenario.description).not.toContain("vol");
    }
  });

  it("rejects a volMove that is not a number", async () => {
    const res = await postScenario({ marketMove: -0.2, volMove: "15" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/volMove/);
  });

  it("rejects a non-finite volMove", async () => {
    const res = await postScenarioRaw('{"marketMove": -0.2, "volMove": 1e400}');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/volMove/);
  });

  it("rejects a volMove outside the slider range", async () => {
    for (const bad of [-21, 61, 500]) {
      const res = await postScenario({ marketMove: -0.2, volMove: bad });
      expect(res.status, String(bad)).toBe(400);
    }
  });
});

describe("POST /api/compute/scenarios — custom input bounds", () => {
  beforeEach(() => {
    hoisted.db = createTestDb();
  });

  it("rateMove: edges and just inside pass, just outside 400s naming basis points", async () => {
    for (const ok of [-1000, -999, 0, 999, 1000]) {
      const res = await postScenario({ marketMove: -0.1, rateMove: ok });
      expect(res.status, String(ok)).toBe(200);
    }
    for (const bad of [-1000.5, -1001, 1001, 100000]) {
      const res = await postScenario({ marketMove: -0.1, rateMove: bad });
      expect(res.status, String(bad)).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/rateMove/);
      expect(body.error).toMatch(/basis points/);
      expect(body.error).toMatch(/1000/);
    }
  });

  it("sectorMoves: edges and just inside pass, just outside 400s naming the sector", async () => {
    for (const ok of [-0.5, -0.49, 0.49, 0.5]) {
      const res = await postScenario({ marketMove: -0.1, sectorMoves: { Technology: ok } });
      expect(res.status, String(ok)).toBe(200);
    }
    for (const bad of [-0.51, 0.51, 5, 1000]) {
      const res = await postScenario({ marketMove: -0.1, sectorMoves: { Technology: 0.1, Energy: bad } });
      expect(res.status, String(bad)).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Energy/);
      expect(body.error).toMatch(/0\.50/);
    }
  });

  it("sectorMoves: a non-numeric or non-finite value 400s", async () => {
    for (const bad of ["0.1", null, true, [0.1], { a: 1 }]) {
      const res = await postScenario({ marketMove: -0.1, sectorMoves: { Technology: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const res = await postScenarioRaw('{"marketMove": -0.1, "sectorMoves": {"Technology": 1e400}}');
    expect(res.status).toBe(400);
  });

  it("sectorMoves: must be a plain object of sector name to number", async () => {
    for (const bad of [[0.1], "Technology", 5, true]) {
      const res = await postScenario({ marketMove: -0.1, sectorMoves: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toMatch(/sectorMoves/);
    }
    // A nested object as the whole map is not a name-to-number map either.
    const nested = await postScenario({ marketMove: -0.1, sectorMoves: { Technology: { a: 0.1 } } });
    expect(nested.status).toBe(400);
  });

  it("an absent or null rateMove / sectorMoves is still fine", async () => {
    const res = await postScenario({ marketMove: -0.1, rateMove: null, sectorMoves: null });
    expect(res.status).toBe(200);
  });

  it("a valid custom scenario with all inputs still computes", async () => {
    const res = await postScenario({
      marketMove: -0.2,
      rateMove: 100,
      volMove: 10,
      sectorMoves: { Technology: -0.3 },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.scenario.sectorMoves).toEqual({ Technology: -0.3 });
  });

  it("marketMove error text matches what the code enforces (+/-0.50)", async () => {
    const missing = await postScenario({});
    expect((await missing.json()).error).toMatch(/-0\.50 and 0\.50/);
    const out = await postScenario({ marketMove: 0.6 });
    expect((await out.json()).error).toMatch(/-0\.50 and 0\.50/);
  });
});

describe("scenario input bounds module", () => {
  it("is the single source the route and the form both read", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/compute/scenarios/route.ts", "utf8");
    const form = readFileSync("app/dashboard/components/ScenarioModeling.tsx", "utf8");
    expect(route).toContain("@/lib/compute/scenario-input-bounds");
    expect(form).toContain("@/lib/compute/scenario-input-bounds");
    const { SCENARIO_INPUT_BOUNDS } = await import("@/lib/compute/scenario-input-bounds");
    expect(SCENARIO_INPUT_BOUNDS).toEqual({ marketMove: 0.5, rateMoveBp: 1000, sectorMove: 0.5 });
  });
});

describe("/api/compute/scenarios — scope resolution", () => {
  beforeEach(() => {
    hoisted.db = createTestDb();
    seedScopeAccounts(hoisted.db);
  });

  it("POST custom scenarios apply a multi-account scope instead of collapsing to the first account", async () => {
    const res = await postScenario({ marketMove: -0.1, scope: "vanguard" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.currentPortfolioValue).toBeCloseTo(3_000, 8);
  });

  it("GET preset scenarios apply a multi-account scope instead of collapsing to the first account", async () => {
    const res = await GET(
      new Request("http://localhost/api/compute/scenarios?scenario=ai_capex_pause&scope=vanguard") as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.currentPortfolioValue).toBeCloseTo(3_000, 8);
  });
});
