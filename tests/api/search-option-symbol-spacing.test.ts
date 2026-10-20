/**
 * An option is stored under its OCC symbol, which pads the root to six
 * characters ("SPY   251219C00500000"). The palette shows that symbol, but a
 * reader types it with one space or none, and a plain LIKE on the stored
 * symbol then finds nothing
 * (qa:cmd-k-palette-commandpalette-tsx-get-api-search-option-contracts-cmd-k-finds-an-option-only-with-the-occ-double-space).
 * The security match also compares the symbol with its spaces removed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

function seed(symbol: string, type: string): number {
  return hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} name`, type).lastInsertRowid as number;
}

async function search(q: string) {
  const mod = await import("@/app/api/search/route");
  const res = await mod.GET(new NextRequest(`http://test/api/search?q=${encodeURIComponent(q)}`));
  const body = (await res.json()) as { results: Array<{ type: string; title: string }> };
  return body.results.filter((r) => r.type === "security").map((r) => r.title);
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.resetModules();
});

describe("/api/search option symbol spacing", () => {
  const occ = "AAA   271217C00100000";

  it("finds the option when the query has one space where the OCC symbol has three", async () => {
    seed(occ, "option");
    expect(await search("AAA 271217")).toContain(occ);
  });

  it("finds the option when the query has no space at all", async () => {
    seed(occ, "option");
    expect(await search("AAA271217C")).toContain(occ);
  });

  it("still finds it with the exact padded symbol, and a stock by plain prefix", async () => {
    seed(occ, "option");
    seed("AAA", "stock");
    expect(await search("AAA   2712")).toContain(occ);
    const plain = await search("AAA");
    expect(plain).toContain("AAA");
    expect(plain).toContain(occ);
  });
});
