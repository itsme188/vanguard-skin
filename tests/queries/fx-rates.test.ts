import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

function db() { const d = new Database(":memory:"); runMigrations(d); return d; }

describe("fx-rates helpers", () => {
  it("USD is always 1 and never stored", () => {
    const d = db();
    expect(getUsdPerUnit(d, "USD")).toBe(1);
    upsertFxRate(d, { currency: "USD", usdPerUnit: 0.9, asOf: "2026-07-01", source: "x" });
    expect(d.prepare("SELECT COUNT(*) n FROM fx_rates").get()).toMatchObject({ n: 0 });
  });

  it("round-trips a KRW rate and reads it back", () => {
    const d = db();
    upsertFxRate(d, { currency: "KRW", usdPerUnit: 0.000734, asOf: "2026-07-01", source: "ibkr_derived" });
    expect(getUsdPerUnit(d, "KRW")).toBeCloseTo(0.000734, 9);
  });

  it("unknown currency and missing table fall back to 1 (never fabricate)", () => {
    const d = db();
    expect(getUsdPerUnit(d, "JPY")).toBe(1);
    const bare = new Database(":memory:");
    expect(getUsdPerUnit(bare, "KRW")).toBe(1);
  });

  it("refuses to write an implausible rate", () => {
    const d = db();
    expect(() => upsertFxRate(d, { currency: "KRW", usdPerUnit: 0, asOf: "2026-07-01", source: "x" })).toThrow();
    expect(() => upsertFxRate(d, { currency: "KRW", usdPerUnit: -1, asOf: "2026-07-01", source: "x" })).toThrow();
  });
});
