/**
 * Tests for POST /api/earnings/correct-date (feedback #7 — fix a wrong
 * sync-sourced earnings date/slot from the EarningsHub date chip).
 *
 * The route is a thin honest wrapper over correctEarningsEventDate (the lib
 * carries its own transactional test suite in
 * tests/mutations/correct-earnings-event.test.ts) — these tests pin the
 * route-layer contract: validation 400s, 404 when nothing exists to correct,
 * 409 refusal passthrough (captured actuals), and the success shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertCalendarEvents,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { POST } from "@/app/api/earnings/correct-date/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/earnings/correct-date", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedFinnhub(
  db: Database.Database,
  symbol: string,
  date: string,
  opts?: { actual?: string | null },
): number {
  const sourceKey = `finnhub:${symbol}:${date}`;
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: "AMC",
      title: `${symbol} earnings`,
      description: null,
      symbol,
      security_id: null,
      expected_impact: "high",
      consensus_estimate: "EPS 1.00",
      previous_value: null,
      raw_json: null,
      source_key: sourceKey,
      week_of: "2026-08-03",
      release_time: "16:15",
    } as CalendarEventInput,
  ]);
  const { id } = db
    .prepare(`SELECT id FROM calendar_events WHERE source_key = ?`)
    .get(sourceKey) as { id: number };
  if (opts?.actual) {
    db.prepare(`UPDATE calendar_events SET actual_value = ? WHERE id = ?`).run(
      opts.actual,
      id,
    );
  }
  return id;
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("journal_mode = WAL");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

describe("POST /api/earnings/correct-date", () => {
  it("400s on missing/blank symbol", async () => {
    const res = await POST(makeRequest({ wrongDate: "2026-08-06", correctDate: "2026-08-07" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("400s on malformed dates", async () => {
    for (const bad of [
      { symbol: "RKT", wrongDate: "08/06/2026", correctDate: "2026-08-07" },
      { symbol: "RKT", wrongDate: "2026-08-06", correctDate: "tomorrow" },
    ]) {
      const res = await POST(makeRequest(bad));
      expect(res.status).toBe(400);
    }
  });

  it("400s on an invalid slot", async () => {
    const res = await POST(
      makeRequest({ symbol: "RKT", wrongDate: "2026-08-06", correctDate: "2026-08-07", slot: "noon" }),
    );
    expect(res.status).toBe(400);
  });

  it("404s when no earnings row exists for (symbol, wrongDate)", async () => {
    const res = await POST(
      makeRequest({ symbol: "RKT", wrongDate: "2026-08-06", correctDate: "2026-08-07" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("RKT");
    expect(body.error).toContain("2026-08-06");
  });

  it("409s with the lib's refusal verbatim when the wrong row has captured actuals", async () => {
    seedFinnhub(hoisted.db, "RKT", "2026-08-06", { actual: "EPS 0.10 · Rev 1,000,000" });
    const res = await POST(
      makeRequest({ symbol: "RKT", wrongDate: "2026-08-06", correctDate: "2026-08-07" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/captured actuals/);
    // Nothing deleted — the row survives.
    expect(
      hoisted.db.prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE symbol = 'RKT'`).get(),
    ).toEqual({ n: 1 });
  });

  it("moves a wrong date: success shape carries newEventId / deletedIds / bogeysMigrated", async () => {
    const wrongId = seedFinnhub(hoisted.db, "RKT", "2026-08-06");
    hoisted.db
      .prepare(
        `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 0.5)`,
      )
      .run(wrongId);

    const res = await POST(
      makeRequest({ symbol: "RKT", wrongDate: "2026-08-06", correctDate: "2026-08-13", slot: "bmo" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.deletedIds).toEqual([wrongId]);
    expect(body.data.bogeysMigrated).toBe(1);

    const corrected = hoisted.db
      .prepare(`SELECT event_date, event_time, source FROM calendar_events WHERE id = ?`)
      .get(body.data.newEventId) as { event_date: string; event_time: string; source: string };
    expect(corrected).toEqual({ event_date: "2026-08-13", event_time: "BMO", source: "manual" });

    // The wrong tuple is suppressed so a re-sync can't resurrect it.
    const suppressed = hoisted.db
      .prepare(`SELECT COUNT(*) AS n FROM calendar_event_suppressions WHERE symbol = 'RKT' AND event_date = '2026-08-06'`)
      .get() as { n: number };
    expect(suppressed.n).toBe(1);
  });

  it("slot-only fix (same date) keeps the event and flips the slot", async () => {
    seedFinnhub(hoisted.db, "IMAX", "2026-08-06"); // seeded AMC
    const res = await POST(
      makeRequest({ symbol: "IMAX", wrongDate: "2026-08-06", correctDate: "2026-08-06", slot: "bmo" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const rows = hoisted.db
      .prepare(
        `SELECT event_date, event_time FROM calendar_events WHERE symbol = 'IMAX' AND event_type = 'earnings'`,
      )
      .all() as Array<{ event_date: string; event_time: string }>;
    expect(rows).toEqual([{ event_date: "2026-08-06", event_time: "BMO" }]);
  });
});
