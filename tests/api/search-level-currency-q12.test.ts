/**
 * Q12: the Cmd+K search title shows a level's price in the security's own
 * currency. A level price is stored native: it is labelled, never converted.
 * Synthetic symbols and round prices only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { upsertLevel } from "@/lib/mutations/security-levels";
import { formatLevelPrice } from "@/lib/chart/price-formatter";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

function seedSecurity(symbol: string, currency?: string): number {
  const id = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  if (currency) {
    hoisted.db.prepare("UPDATE securities SET currency = ? WHERE id = ?").run(currency, id);
  }
  return id;
}

async function levelTitle(q: string): Promise<string> {
  const mod = await import("@/app/api/search/route");
  const res = await mod.GET(new NextRequest(`http://test/api/search?q=${encodeURIComponent(q)}`));
  const body = (await res.json()) as { results: Array<{ type: string; title: string }> };
  const level = body.results.find((r) => r.type === "level");
  if (!level) throw new Error(`no level result for ${q}`);
  return level.title;
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.resetModules();
});

describe("/api/search level title currency", () => {
  it("labels a yen level in yen, with no dollar sign and no conversion", async () => {
    const sec = seedSecurity("ZZA", "JPY");
    // A rate on file must not be applied to the level price.
    hoisted.db
      .prepare(
        "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.01, '2026-04-20', 'ibkr_ledger')"
      )
      .run();
    upsertLevel(hoisted.db, {
      security_id: sec, level_type: "support", price: 5000, thesis: "yen shelf marker",
    });
    const title = await levelTitle("yen shelf");
    expect(title).toBe(`ZZA support ${formatLevelPrice("JPY", 5000)}`);
    expect(title).not.toContain("$");
    expect(title).toMatch(/5,000/);
  });

  it("keeps the dollar label for a dollar security and for one seeded with no currency", async () => {
    const usd = seedSecurity("ZZB", "USD");
    upsertLevel(hoisted.db, {
      security_id: usd, level_type: "scale_in", price: 1250, thesis: "dollar shelf marker",
    });
    expect(await levelTitle("dollar shelf")).toBe("ZZB scale in $1,250.00");

    // No currency given: the column's own default applies.
    const blank = seedSecurity("ZZC");
    upsertLevel(hoisted.db, {
      security_id: blank, level_type: "support", price: 40, thesis: "blank shelf marker",
    });
    expect(await levelTitle("blank shelf")).toBe("ZZC support $40.00");
  });

  it("still marks an inactive level", async () => {
    const sec = seedSecurity("ZZD", "EUR");
    const id = upsertLevel(hoisted.db, {
      security_id: sec, level_type: "support", price: 80, thesis: "euro shelf marker",
    });
    hoisted.db.prepare("UPDATE security_levels SET is_active = 0 WHERE id = ?").run(id);
    expect(await levelTitle("euro shelf")).toBe(
      `ZZD support ${formatLevelPrice("EUR", 80)} (inactive)`
    );
  });
});
