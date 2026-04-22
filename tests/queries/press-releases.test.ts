import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  listPressReleases,
  getLatestCachedPressRelease,
} from "@/lib/queries/press-releases";
import {
  upsertPressRelease,
  deletePressRelease,
  type PressReleaseInput,
} from "@/lib/mutations/press-releases";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seed(
  db: Database.Database,
  overrides: Partial<PressReleaseInput> = {},
): number {
  const defaults: PressReleaseInput = {
    finnhub_id: Math.floor(Math.random() * 1_000_000_000),
    symbol: "AAPL",
    headline: "Headline",
    summary: "Summary",
    source: "Business Wire",
    category: "press release",
    url: "https://example.com/story",
    image_url: null,
    published_at: "2026-04-22T14:00:00Z",
    raw_json: null,
  };
  return upsertPressRelease(db, { ...defaults, ...overrides });
}

describe("press_releases mutations", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("upserts a new row + reads back symbol uppercased", () => {
    seed(db, { symbol: "aapl", finnhub_id: 1 });
    const [row] = listPressReleases(db, { symbol: "AAPL" });
    expect(row.symbol).toBe("AAPL");
  });

  it("upsert on same finnhub_id updates headline + cached_at", () => {
    seed(db, { finnhub_id: 42, headline: "v1" });
    seed(db, { finnhub_id: 42, headline: "v2" });
    const rows = listPressReleases(db, { symbol: "AAPL" });
    expect(rows).toHaveLength(1);
    expect(rows[0].headline).toBe("v2");
  });

  it("two symbols with different finnhub_ids both persist", () => {
    seed(db, { finnhub_id: 1, symbol: "AAPL" });
    seed(db, { finnhub_id: 2, symbol: "MSFT" });
    expect(listPressReleases(db)).toHaveLength(2);
  });

  it("deletePressRelease returns true then false", () => {
    const id = seed(db, { finnhub_id: 99 });
    expect(deletePressRelease(db, id)).toBe(true);
    expect(deletePressRelease(db, id)).toBe(false);
  });
});

describe("listPressReleases", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("orders by published_at DESC", () => {
    seed(db, { finnhub_id: 1, headline: "older", published_at: "2026-01-01T00:00:00Z" });
    seed(db, { finnhub_id: 2, headline: "newer", published_at: "2026-04-01T00:00:00Z" });
    seed(db, { finnhub_id: 3, headline: "middle", published_at: "2026-02-15T00:00:00Z" });
    const rows = listPressReleases(db, {});
    expect(rows.map((r) => r.headline)).toEqual(["newer", "middle", "older"]);
  });

  it("filters by keyword in headline", () => {
    seed(db, { finnhub_id: 1, headline: "Apple announces new iPhone" });
    seed(db, { finnhub_id: 2, headline: "Apple files lawsuit" });
    seed(db, { finnhub_id: 3, headline: "Unrelated news" });
    const rows = listPressReleases(db, { keyword: "iPhone" });
    expect(rows.map((r) => r.finnhub_id)).toEqual([1]);
  });

  it("filters by keyword in summary", () => {
    seed(db, {
      finnhub_id: 1,
      headline: "X",
      summary: "Includes iphone sales data",
    });
    seed(db, { finnhub_id: 2, headline: "Y", summary: "Different topic" });
    const rows = listPressReleases(db, { keyword: "iphone" });
    expect(rows.map((r) => r.finnhub_id)).toEqual([1]);
  });

  it("symbol filter is case-insensitive on input", () => {
    seed(db, { finnhub_id: 1, symbol: "AAPL" });
    seed(db, { finnhub_id: 2, symbol: "MSFT" });
    const rows = listPressReleases(db, { symbol: "aapl" });
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("AAPL");
  });

  it("days_back filters the window", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 2);
    seed(db, { finnhub_id: 1, headline: "old", published_at: oldDate.toISOString() });
    seed(db, {
      finnhub_id: 2,
      headline: "recent",
      published_at: recentDate.toISOString(),
    });
    const rows = listPressReleases(db, { days_back: 7 });
    expect(rows.map((r) => r.headline)).toEqual(["recent"]);
  });

  it("respects limit", () => {
    for (let i = 1; i <= 5; i++) seed(db, { finnhub_id: i });
    expect(listPressReleases(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("getLatestCachedPressRelease", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns null when no rows for symbol", () => {
    expect(getLatestCachedPressRelease(db, "NVDA")).toBeNull();
  });

  it("returns the most-recently-cached row for the symbol", () => {
    seed(db, { finnhub_id: 1, symbol: "AAPL", headline: "first" });
    seed(db, { finnhub_id: 2, symbol: "AAPL", headline: "second" });
    // SQLite datetime('now') is second-resolution; in-test inserts can tie.
    // Force distinct cached_at values so the ORDER BY is deterministic.
    db.prepare(`UPDATE press_releases SET cached_at = ? WHERE finnhub_id = ?`)
      .run("2026-04-22 10:00:00", 1);
    db.prepare(`UPDATE press_releases SET cached_at = ? WHERE finnhub_id = ?`)
      .run("2026-04-22 10:00:05", 2);
    const latest = getLatestCachedPressRelease(db, "AAPL");
    expect(latest?.headline).toBe("second");
  });
});
