/**
 * U20 — the alert-suggestion prompt must not put a "$" on a non-USD
 * security's level or fire price (both are stored in the native currency).
 * USD output stays byte-identical. Synthetic security, invented numbers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import {
  buildSuggestionContext,
  buildSuggestionPrompt,
  type SuggestionContext,
} from "@/lib/alerts/generate-suggestion";

function ctx(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    symbol: "ZZZ",
    securityName: "ZZZ Corp",
    securityType: "stock",
    levelType: "support",
    levelPrice: 1500,
    triggeredPrice: 1490,
    direction: null,
    sourceAuthor: null,
    thesis: null,
    timeframe: null,
    actionHint: null,
    held: [],
    onWatchlist: false,
    watchlistGroup: null,
    ...overrides,
  };
}

describe("buildSuggestionPrompt — currency of the level and fire price", () => {
  it("keeps the USD lines byte-identical (currency USD or absent)", () => {
    for (const c of [ctx(), ctx({ currency: "USD" }), ctx({ currency: null })]) {
      const prompt = buildSuggestionPrompt(c);
      expect(prompt).toContain("Level: support at $1500.00");
      expect(prompt).toContain("Price when the alert fired: $1490.00");
      expect(prompt).not.toContain("not US dollars");
    }
  });

  it("never dollar-labels a non-USD security's prices and names the currency", () => {
    const prompt = buildSuggestionPrompt(ctx({ currency: "JPY" }));
    expect(prompt).not.toContain("$1500");
    expect(prompt).not.toContain("$1490");
    expect(prompt).not.toMatch(/(^|[^A-Z])\$\d/);
    expect(prompt).toContain("Level: support at 1,500 JPY");
    expect(prompt).toContain("Price when the alert fired: 1,490 JPY");
    expect(prompt).toContain("Prices are in JPY, not US dollars.");
  });

  it("keeps two decimals for a non-USD currency that has a minor unit", () => {
    const prompt = buildSuggestionPrompt(ctx({ currency: "eur", levelPrice: 12.5, triggeredPrice: 12.4 }));
    expect(prompt).toContain("Level: support at 12.50 EUR");
    expect(prompt).toContain("Price when the alert fired: 12.40 EUR");
  });
});

describe("buildSuggestionContext — threads the security's currency", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("carries JPY from the securities row into the prompt", () => {
    const zzz = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, currency) VALUES ('ZZZ', 'ZZZ Corp', 'stock', 'equity', 1, 'JPY')"
      )
      .run().lastInsertRowid as number;
    const lvl = upsertLevel(db, { security_id: zzz, level_type: "support", price: 1500, source: "user" });
    const { alertId } = triggerLevel(db, { levelId: lvl, securityId: zzz, triggeredPrice: 1490 });

    const built = buildSuggestionContext(db, alertId as number);
    expect(built?.currency).toBe("JPY");
    expect(buildSuggestionPrompt(built as SuggestionContext)).not.toMatch(/\$\d/);
  });
});
