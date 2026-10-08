/**
 * QA finding alerts-tabs--emails-badge-lazy-no-count-until-visited: the
 * Emails tab showed no count until it was opened, because the count only
 * existed as the length of the lazily loaded rows.
 *
 * GET /api/earnings/emails?countOnly=true answers with the count and no rows.
 * The API rule is that a count-only answer uses the identical predicate and
 * window as the list, so each case here asks both and compares.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET } from "@/app/api/earnings/emails/route";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function seedEvent(symbol: string, date: string): number {
  return hoisted.db
    .prepare(
      `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, symbol, source_key, week_of)
       VALUES ('finnhub', 'earnings', ?, 'BMO', ?, ?, ?, '2026-04-27')`,
    )
    .run(date, `${symbol} earnings`, symbol, `finnhub:${symbol}:${date}`)
    .lastInsertRowid as number;
}

function seedEmail(eventId: number, phase: string, error: string | null): void {
  hoisted.db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, ?, 'user@example.com', '# prose', ?)`,
    )
    .run(eventId, phase, error);
}

async function get(query: string): Promise<{
  success: boolean;
  count: number;
  emails?: unknown[];
}> {
  const res = await GET(new Request(`http://test/api/earnings/emails${query}`));
  return res.json();
}

describe("GET /api/earnings/emails?countOnly=true", () => {
  beforeEach(() => {
    const aaa = seedEvent("AAA", "2026-04-28");
    const zzz = seedEvent("ZZZ", "2026-04-29");
    seedEmail(aaa, "preview", null);
    seedEmail(aaa, "recap", "sent-by-cloud");
    seedEmail(zzz, "preview", null);
    // A live claim is not a sent email: the list leaves it out, so the count must too.
    seedEmail(zzz, "recap", "in_progress");
  });

  it("returns the count with no rows", async () => {
    const body = await get("?countOnly=true");
    expect(body.success).toBe(true);
    expect(body.count).toBe(3);
    expect(body.emails).toBeUndefined();
  });

  it("matches the list's own length, live claims excluded", async () => {
    const list = await get("");
    const count = await get("?countOnly=true");
    expect(list.emails).toHaveLength(3);
    expect(count.count).toBe(list.emails!.length);
  });

  it("honours the same symbol filter as the list", async () => {
    const list = await get("?symbol=AAA");
    const count = await get("?symbol=AAA&countOnly=true");
    expect(list.emails).toHaveLength(2);
    expect(count.count).toBe(2);
  });

  it("honours the same limit as the list", async () => {
    const list = await get("?limit=1");
    const count = await get("?limit=1&countOnly=true");
    expect(list.emails).toHaveLength(1);
    expect(count.count).toBe(1);
  });

  it("the list response is unchanged when countOnly is absent or not 'true'", async () => {
    const body = await get("?countOnly=false");
    expect(body.count).toBe(3);
    expect(body.emails).toHaveLength(3);
  });
});
