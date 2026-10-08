/**
 * GET /api/research/articles took any `limit` (the feed's "Load more" re-reads
 * an ever longer page) and gave no total. The route now clamps the limit and
 * returns `total` counted under the identical filter as the list.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { countRecentArticles } from "@/lib/queries/research";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// The route's cap (a route file may only export handlers, so it is restated here).
const MAX_ARTICLES_LIMIT = 500;

let srcA: number;
let srcB: number;
const A_PROCESSED = MAX_ARTICLES_LIMIT + 7;

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  const src = (name: string) =>
    db
      .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
      .run(name, `${name}@example.test`).lastInsertRowid as number;
  srcA = src("aaa");
  srcB = src("bbb");
  const ins = db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, processed_at, is_relevant)
     VALUES (?, ?, 'x@example.test', ?, 'body', 'Summary', ?, ?)`,
  );
  const seedAll = db.transaction(() => {
    for (let i = 0; i < A_PROCESSED; i++) {
      const minute = String(i % 60).padStart(2, "0");
      const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
      ins.run(srcA, `alpha ${i}`, `2026-01-10 ${hour}:${minute}:00`, "2026-01-20 12:00:00", 1);
    }
    ins.run(srcA, "alpha unprocessed", "2026-01-11 09:00:00", null, 1);
    ins.run(srcB, "beta one", "2026-01-12 09:00:00", "2026-01-20 12:00:00", 1);
    ins.run(srcB, "beta two zebra", "2026-01-13 09:00:00", "2026-01-20 12:00:00", 1);
    ins.run(srcB, "beta filtered", "2026-01-14 09:00:00", "2026-01-20 12:00:00", 0);
  });
  seedAll();
});

async function get(query: string) {
  const { GET } = await import("@/app/api/research/articles/route");
  const res = await GET(new Request(`http://localhost/api/research/articles${query}`));
  return (await res.json()) as {
    success: boolean;
    data: unknown[];
    total?: number;
    symbolMap?: Record<string, number>;
  };
}

describe("GET /api/research/articles limit cap and total", () => {
  it("clamps a limit above the cap", async () => {
    const r = await get("?limit=100000");
    expect(r.success).toBe(true);
    expect(r.data).toHaveLength(MAX_ARTICLES_LIMIT);
  });

  it.each(["-1", "0", "abc", "1e9"])("never reads unbounded for limit=%s", async (limit) => {
    const r = await get(`?limit=${limit}`);
    expect(r.success).toBe(true);
    expect(r.data.length).toBeLessThanOrEqual(MAX_ARTICLES_LIMIT);
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("keeps the default page of 50 and honors a small limit", async () => {
    expect((await get("")).data).toHaveLength(50);
    expect((await get("?limit=3")).data).toHaveLength(3);
  });

  it("returns total under the identical filter, independent of limit", async () => {
    const all = await get("?limit=5");
    expect(all.total).toBe(countRecentArticles(hoisted.db, { processedOnly: true }));
    expect(all.total).toBe(
      (
        hoisted.db
          .prepare("SELECT COUNT(*) AS n FROM research_articles WHERE processed_at IS NOT NULL")
          .get() as { n: number }
      ).n,
    );

    const bySource = await get(`?sourceId=${srcB}&limit=1`);
    expect(bySource.data).toHaveLength(1);
    expect(bySource.total).toBe(
      countRecentArticles(hoisted.db, { sourceId: srcB, processedOnly: true }),
    );
    expect(bySource.total).toBe(3);

    const bySearch = await get(`?sourceId=${srcB}&search=zebra`);
    expect(bySearch.total).toBe(
      countRecentArticles(hoisted.db, { sourceId: srcB, search: "zebra", processedOnly: true }),
    );
    expect(bySearch.total).toBe(bySearch.data.length);

    const byDate = await get("?startDate=2026-01-12&endDate=2026-01-13");
    expect(byDate.total).toBe(
      countRecentArticles(hoisted.db, {
        startDate: "2026-01-12",
        endDate: "2026-01-13",
        processedOnly: true,
      }),
    );
    expect(byDate.total).toBe(byDate.data.length);
  });

  it("clamps the filtered=1 audit fetch too", async () => {
    const r = await get("?filtered=1&limit=100000");
    expect(r.success).toBe(true);
    expect(r.data).toHaveLength(1);
    const neg = await get("?filtered=1&limit=-1&offset=-5");
    expect(neg.success).toBe(true);
    expect(neg.data).toHaveLength(1);
  });
});
