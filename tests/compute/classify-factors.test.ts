// tests/compute/classify-factors.test.ts
//
// Uses the vi.fn()-direct mock pattern (same as classify-securities-fallback.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(feature: string, modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6-20250219" })),
}));

import { generateTextForFeature } from "@/lib/ai/generate";
import { classifyFactors } from "@/lib/compute/classify-factors";

const FUTURE_EXPIRY = "2030-01-16";
const PAST_EXPIRY = "2020-01-17";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // accounts 1-3 pre-seeded by migration 002
  return db;
}

function insertSecurity(
  db: Database.Database,
  fields: {
    symbol: string;
    security_type?: string | null;
    name?: string | null;
    underlying_symbol?: string | null;
    expiration_date?: string | null;
  }
): number {
  const res = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, name, underlying_symbol, expiration_date)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      fields.symbol,
      fields.security_type ?? null,
      fields.name ?? null,
      fields.underlying_symbol ?? null,
      fields.expiration_date ?? null
    );
  return Number(res.lastInsertRowid);
}

function insertHolding(db: Database.Database, securityId: number, quantity = 1) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (3, ?, '2026-06-01', ?, 'test-' || ?)`
  ).run(securityId, quantity, securityId);
}

function claudeReturns(rows: Array<Record<string, string>>) {
  (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
    text: JSON.stringify(rows),
  });
}

const PANW_FACTORS = {
  symbol: "PANW",
  sector: "Technology",
  industry: "Cybersecurity",
  interest_rate_sensitive: "Low",
  growth_vs_value: "Growth",
  cyclical: "Moderate",
  international_exposure: "Moderate",
  geopolitical_onshoring: "Low",
  tariff_exposure: "Low",
  ai_exposure: "High",
  crypto_adjacent: "No",
  regulatory_risk: "Moderate",
};

beforeEach(() => vi.clearAllMocks());

describe("classifyFactors — option underlying coverage", () => {
  it("creates a securities row for a missing underlying of a held option and classifies it", async () => {
    const db = makeDb();
    const optId = insertSecurity(db, {
      symbol: "PANW  300116C00200000",
      security_type: "Option",
      underlying_symbol: "PANW",
      expiration_date: FUTURE_EXPIRY,
    });
    insertHolding(db, optId);
    claudeReturns([PANW_FACTORS]);

    const result = await classifyFactors(db);

    const underlying = db
      .prepare("SELECT id, sector FROM securities WHERE symbol = 'PANW'")
      .get() as { id: number; sector: string | null } | undefined;
    expect(underlying).toBeDefined();
    expect(underlying!.sector).toBe("Technology");

    const row = db
      .prepare("SELECT sector_source, sector_verified_at FROM securities WHERE symbol = 'PANW'")
      .get() as { sector_source: string | null; sector_verified_at: string | null };
    expect(row.sector_source).toBe("ai_classify");
    expect(row.sector_verified_at).toBeNull(); // the sweep alone owns this column

    const factors = db
      .prepare("SELECT growth_vs_value FROM security_factors WHERE security_id = ?")
      .get(underlying!.id) as { growth_vs_value: string } | undefined;
    expect(factors?.growth_vs_value).toBe("Growth");
    expect(result.classified).toBe(1);
    expect(result.underlyingsCreated).toBe(1);
  });

  it("classifies an existing but unclassified underlying that is not held", async () => {
    const db = makeDb();
    const vloId = insertSecurity(db, { symbol: "VLO", security_type: "Stock", name: "Valero" });
    const optId = insertSecurity(db, {
      symbol: "VLO   300116P00100000",
      security_type: "Option",
      underlying_symbol: "VLO",
      expiration_date: FUTURE_EXPIRY,
    });
    insertHolding(db, optId);
    claudeReturns([{ ...PANW_FACTORS, symbol: "VLO", sector: "Energy", growth_vs_value: "Value" }]);

    const result = await classifyFactors(db);

    const factors = db
      .prepare("SELECT growth_vs_value FROM security_factors WHERE security_id = ?")
      .get(vloId) as { growth_vs_value: string } | undefined;
    expect(factors?.growth_vs_value).toBe("Value");
    expect(result.classified).toBe(1);
    expect(result.underlyingsCreated).toBe(0);
  });

  it("does nothing when the underlying already has factors (and never sends the option itself)", async () => {
    const db = makeDb();
    const msftId = insertSecurity(db, { symbol: "MSFT", security_type: "Stock" });
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, 'High')").run(msftId);
    const optId = insertSecurity(db, {
      symbol: "MSFT  300116C00400000",
      security_type: "Option",
      underlying_symbol: "MSFT",
      expiration_date: FUTURE_EXPIRY,
    });
    insertHolding(db, optId);

    const result = await classifyFactors(db);

    expect(generateTextForFeature).not.toHaveBeenCalled();
    expect(result.classified).toBe(0);
    expect(result.candidates).toBe(0);
  });

  it("ignores expired options — their underlyings are not classification candidates", async () => {
    const db = makeDb();
    const optId = insertSecurity(db, {
      symbol: "XYZ   200117C00050000",
      security_type: "Option",
      underlying_symbol: "XYZ",
      expiration_date: PAST_EXPIRY,
    });
    insertHolding(db, optId);

    const result = await classifyFactors(db);

    expect(generateTextForFeature).not.toHaveBeenCalled();
    expect(db.prepare("SELECT id FROM securities WHERE symbol='XYZ'").get()).toBeUndefined();
    expect(result.classified).toBe(0);
  });

  it("dedupes a held stock that is also an option underlying — classified once", async () => {
    const db = makeDb();
    const vloId = insertSecurity(db, { symbol: "VLO", security_type: "Stock" });
    insertHolding(db, vloId, 100);
    const optId = insertSecurity(db, {
      symbol: "VLO   300116C00150000",
      security_type: "Option",
      underlying_symbol: "VLO",
      expiration_date: FUTURE_EXPIRY,
    });
    insertHolding(db, optId);
    claudeReturns([{ ...PANW_FACTORS, symbol: "VLO", sector: "Energy" }]);

    const result = await classifyFactors(db);

    expect(generateTextForFeature).toHaveBeenCalledTimes(1);
    const prompt = (generateTextForFeature as ReturnType<typeof vi.fn>).mock.calls[0][1].prompt as string;
    expect(prompt.match(/VLO/g)?.length).toBe(1); // one candidate line, not two
    expect(result.classified).toBe(1);
  });

  it("classifies short positions — quantity != 0, not > 0", async () => {
    const db = makeDb();
    const pinsId = insertSecurity(db, { symbol: "PINS", security_type: "Stock" });
    insertHolding(db, pinsId, -600);
    claudeReturns([{ ...PANW_FACTORS, symbol: "PINS", sector: "Communication Services" }]);

    const result = await classifyFactors(db);

    const factors = db
      .prepare("SELECT security_id FROM security_factors WHERE security_id = ?")
      .get(pinsId);
    expect(factors).toBeDefined();
    expect(result.classified).toBe(1);
  });

  it("reports candidates so callers can explain a no-op run", async () => {
    const db = makeDb();
    const result = await classifyFactors(db);
    expect(result.candidates).toBe(0);
    expect(result.classified).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
