/**
 * Skipping an email on a calendar entry that no longer exists is refused
 * plainly (deep QA 2026-11-26).
 *
 * The Earnings Hub row can outlive its event: the entry is deleted in another
 * tab, or a refresh replaces a vendor row under a new id. A skip click on the
 * stale row used to reach the INSERT, trip the foreign key and answer 500 with
 * a raw constraint error. POST /api/earnings/skip now answers 404 with a
 * sentence and writes nothing.
 *
 * Synthetic symbol.
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

import { POST } from "@/app/api/earnings/skip/route";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/earnings/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function skipCount(): number {
  return (
    hoisted.db.prepare("SELECT COUNT(*) AS n FROM earnings_email_skips").get() as { n: number }
  ).n;
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.db
    .prepare(
      `INSERT INTO calendar_events (id, source, event_type, event_date, title, source_key, symbol)
       VALUES (1, 'manual', 'earnings', '2026-06-01', 'QAXX earnings', 'manual:QAXX:2026-06-01', 'QAXX')`,
    )
    .run();
});

describe("POST /api/earnings/skip on a missing event", () => {
  it("answers 404 with a sentence and writes nothing", async () => {
    const res = await post({ eventId: 999, phase: "preview" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success?: boolean; code?: string; error?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("event_not_found");
    expect(body.error).toMatch(/no longer exists/i);
    expect(body.error).not.toMatch(/FOREIGN KEY/i);
    expect(skipCount()).toBe(0);
  });

  it("an event deleted after the page loaded is refused the same way", async () => {
    hoisted.db.prepare("DELETE FROM calendar_events WHERE id = 1").run();
    const res = await post({ eventId: 1, phase: "recap" });
    expect(res.status).toBe(404);
    expect(skipCount()).toBe(0);
  });

  it("still records a skip for an event that exists", async () => {
    const res = await post({ eventId: 1, phase: "preview" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: true });
    expect(skipCount()).toBe(1);
  });
});
