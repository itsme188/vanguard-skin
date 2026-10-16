import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getLatestPriceForSecurity } from "@/lib/queries/security-detail";
import { anchorIndex } from "@/tests/helpers/source-anchor";

/**
 * The hero's change is the shown price minus the previous STORED price row.
 * When that row is not the prior session (the prices table has gaps) the
 * caption must name the date it compares with, so the page passes the
 * previous row's date through to MarketDataPanel's changeCaption (qa:
 * dashboard-security-id-hero-marketdatapanel-hero-vs-prior-close-silently-measures-wednesday-against-monday-s-cl).
 */
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(symbol: string, closes: Record<string, number>): number {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  for (const [date, close] of Object.entries(closes)) {
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(id, date, close);
  }
  return id;
}

describe("getLatestPriceForSecurity carries the previous row's date", () => {
  it("names the row the change is measured against when a session is missing", () => {
    // Wed 2026-06-10 vs Mon 2026-06-08: no Tuesday row.
    const id = seed("ZZG", { "2026-06-08": 100, "2026-06-10": 90 });
    const price = getLatestPriceForSecurity(db, id)!;
    expect(price.date).toBe("2026-06-10");
    expect(price.prev_close).toBe(100);
    expect(price.prev_date).toBe("2026-06-08");
    expect(price.change_pct).toBeCloseTo(-10, 6);
  });

  it("has no previous date when only one price row exists", () => {
    const id = seed("ZZO", { "2026-06-10": 90 });
    const price = getLatestPriceForSecurity(db, id)!;
    expect(price.prev_close).toBeNull();
    expect(price.prev_date).toBeNull();
    expect(price.change).toBeNull();
  });
});

describe("the security page hands the previous price date to the hero", () => {
  it("passes prevPriceDate into MarketDataPanel beside priceDate", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/dashboard/security/[id]/page.tsx"),
      "utf8",
    );
    const panel = anchorIndex(source, "<MarketDataPanel");
    const block = source.slice(panel, source.indexOf("/>", panel));
    expect(block).toMatch(/priceDate=\{price\?\.date \?\? null\}/);
    expect(block).toMatch(/prevPriceDate=\{price\?\.prev_date \?\? null\}/);
  });
});
