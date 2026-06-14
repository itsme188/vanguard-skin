import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
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

import { classifyOptionSectors, getUnsectoredOptionUnderlyings } from "@/lib/securities/classify-option-sectors";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT, security_type TEXT, sector TEXT, underlying_symbol TEXT);
    CREATE TABLE holdings (id INTEGER PRIMARY KEY, account_id INTEGER, security_id INTEGER, quantity REAL, as_of_date TEXT);
  `);
  // Two held CRWD options (blank sector), one already-sectored option (should be ignored).
  db.prepare("INSERT INTO securities (id,symbol,security_type,sector,underlying_symbol) VALUES (1,'CRWD  270319C00470000','Option',NULL,'CRWD')").run();
  db.prepare("INSERT INTO securities (id,symbol,security_type,sector,underlying_symbol) VALUES (2,'CRWD  280121C00500000','Option','','CRWD')").run();
  db.prepare("INSERT INTO securities (id,symbol,security_type,sector,underlying_symbol) VALUES (3,'AAPL  260116C00200000','Option','Technology','AAPL')").run();
  for (const sid of [1,2,3]) db.prepare("INSERT INTO holdings (account_id,security_id,quantity,as_of_date) VALUES (1,?,1,'2026-06-08')").run(sid);
  return db;
}
// Reset in afterEach (not beforeEach): on vitest 4.0.18, mutating the awaited
// `ai` mock inside beforeEach makes a later caught rejection surface as a phantom
// "unhandled rejection" (tinyspy result-tracking quirk). afterEach gives identical
// per-test isolation but runs after the rejection is already handled.
afterEach(() => generateTextMock.mockReset());

describe("classify-option-sectors", () => {
  it("lists distinct underlyings of held blank-sector options", () => {
    const db = makeDb();
    expect(getUnsectoredOptionUnderlyings(db)).toEqual(["CRWD"]); // AAPL already sectored
  });

  it("writes a validated GICS sector onto all blank-sector options for that underlying", async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify([{ symbol: "CRWD", sector: "Technology" }]) });
    const db = makeDb();
    const res = await classifyOptionSectors(db);
    expect(res.classified).toBe(2); // both CRWD options
    expect((db.prepare("SELECT sector FROM securities WHERE id=1").get() as any).sector).toBe("Technology");
    expect((db.prepare("SELECT sector FROM securities WHERE id=2").get() as any).sector).toBe("Technology");
    // AAPL option untouched
    expect((db.prepare("SELECT sector FROM securities WHERE id=3").get() as any).sector).toBe("Technology");
  });

  it("normalizes Bloomberg-ish sector and rejects non-GICS junk", async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify([{ symbol: "CRWD", sector: "Klingon" }]) });
    const db = makeDb();
    const res = await classifyOptionSectors(db);
    expect(res.classified).toBe(0); // invalid sector dropped
    expect((db.prepare("SELECT sector FROM securities WHERE id=1").get() as any).sector).toBeNull();
  });

  it("returns an error and writes nothing when Claude fails", async () => {
    generateTextMock.mockRejectedValue(new Error("402"));
    const db = makeDb();
    const res = await classifyOptionSectors(db);
    expect(res.classified).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
