/**
 * Tests for Mac-side cloud-fired level reconciliation (Tier 4a).
 *
 * Strategy: mock global.fetch to simulate Worker /internal/cloud-fired-levels
 * responses; use in-memory SQLite to verify level_alerts are inserted and
 * security_levels rows are flipped correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { reconcileCloudFiredLevels } from "@/lib/alerts/reconcile-cloud-fired";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL
    );
    CREATE TABLE security_levels (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      level_type TEXT NOT NULL,
      price REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      triggered_at TEXT,
      triggered_price REAL,
      review_status TEXT NOT NULL DEFAULT 'auto_approved',
      price_source TEXT NOT NULL DEFAULT 'static'
    );
    CREATE TABLE level_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      triggered_at TEXT NOT NULL,
      triggered_price REAL NOT NULL,
      position_context TEXT,
      user_response TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`INSERT INTO securities (id, symbol) VALUES (10, 'AAPL'), (20, 'NVDA');`);
  db.exec(`INSERT INTO security_levels (id, security_id, level_type, price) VALUES (1, 10, 'support', 150), (2, 20, 'resistance', 500);`);
  return db;
}

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.WORKER_MARKER_URL = "https://worker.example.com";
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.WORKER_MARKER_URL;
});

describe("reconcileCloudFiredLevels", () => {
  it("returns a no-op note when WORKER_MARKER_URL is unset", async () => {
    delete process.env.WORKER_MARKER_URL;
    const db = makeDb();
    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.ok).toBe(true);
    expect(result.reconciled).toBe(0);
    expect(result.note).toContain("WORKER_MARKER_URL unset");
  });

  it("returns ok with zero counts when the Worker has no fired payloads", async () => {
    const db = makeDb();
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ payloads: {} }), { status: 200 }),
    ) as any;
    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.ok).toBe(true);
    expect(result.reconciled).toBe(0);
  });

  it("inserts a level_alerts row + flips the security_level on a fresh cloud-fired payload", async () => {
    const db = makeDb();
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(
        JSON.stringify({
          payloads: {
            "1": {
              levelId: 1,
              securityId: 10,
              symbol: "AAPL",
              levelType: "support",
              levelPrice: 150,
              triggeredPrice: 149.5,
              triggeredAt: "2026-05-11T14:30:00.000Z",
              sourceAuthor: "Me",
            },
          },
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchSpy as any;

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.ok).toBe(true);
    expect(result.reconciled).toBe(1);
    expect(result.skipped_already_alerted).toBe(0);

    const alerts = db.prepare(`SELECT level_id, security_id, triggered_price FROM level_alerts`).all();
    expect(alerts).toEqual([{ level_id: 1, security_id: 10, triggered_price: 149.5 }]);

    const level = db.prepare(`SELECT is_active, triggered_price FROM security_levels WHERE id = 1`).get() as { is_active: number; triggered_price: number };
    expect(level.is_active).toBe(0);
    expect(level.triggered_price).toBe(149.5);

    // Verify DELETE was called per reconciled levelId
    const deleteCalls = (fetchSpy.mock.calls as unknown[][]).filter((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0][0])).toContain("levelId=1");
  });

  it("dedups against an existing level_alerts row for the same level+date", async () => {
    const db = makeDb();
    // Seed an existing alert for the same level on the same day
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price)
       VALUES (?, ?, ?, ?)`,
    ).run(1, 10, "2026-05-11T13:00:00.000Z", 148.0);

    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(
        JSON.stringify({
          payloads: {
            "1": {
              levelId: 1,
              securityId: 10,
              symbol: "AAPL",
              levelType: "support",
              levelPrice: 150,
              triggeredPrice: 149.5,
              triggeredAt: "2026-05-11T14:30:00.000Z",
              sourceAuthor: "Me",
            },
          },
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchSpy as any;

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.skipped_already_alerted).toBe(1);
    expect(result.reconciled).toBe(0);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM level_alerts`).get() as { c: number };
    expect(count.c).toBe(1); // still 1 — no new insert
  });

  it("skips a payload whose levelId no longer exists (level deleted in the interim)", async () => {
    const db = makeDb();
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(
        JSON.stringify({
          payloads: {
            "9999": {
              levelId: 9999,
              securityId: 99,
              symbol: "GONE",
              levelType: "support",
              levelPrice: 1,
              triggeredPrice: 0.5,
              triggeredAt: "2026-05-11T14:30:00.000Z",
              sourceAuthor: null,
            },
          },
        }),
        { status: 200 },
      );
    }) as any;

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.skipped_level_missing).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  it("returns a 502-shaped error when the Worker request fails", async () => {
    const db = makeDb();
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as any;
    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("ECONNRESET");
  });

  /**
   * The Mac's once-a-day guard counts by EASTERN day (hasAlertToday). This
   * dedup compared UTC dates, so the two disagreed in the evening, when the
   * UTC date has already rolled over.
   */
  function cloudPayload(triggeredAt: string) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(
        JSON.stringify({
          payloads: {
            "1": {
              levelId: 1,
              securityId: 10,
              symbol: "AAPL",
              levelType: "support",
              levelPrice: 150,
              triggeredPrice: 149.5,
              triggeredAt,
              sourceAuthor: "Me",
            },
          },
        }),
        { status: 200 },
      );
    }) as any;
  }

  it("a cloud fire at 21:30 Eastern is the same day as a Mac alert that afternoon (before: UTC said different days and a second alert was inserted)", async () => {
    const db = makeDb();
    // Mac alert at 15:00 Eastern on 2026-10-07.
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (1, 10, ?, 148)`,
    ).run("2026-10-07T19:00:00.000Z");
    // Cloud fire at 21:30 Eastern the same day: 01:30 UTC on the 8th.
    global.fetch = cloudPayload("2026-10-08T01:30:00.000Z");

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.skipped_already_alerted).toBe(1);
    expect(result.reconciled).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM level_alerts`).get() as { c: number }).c).toBe(1);
  });

  it("a Mac alert at 21:30 Eastern does not swallow a cloud fire the next morning (before: UTC said same day and the alert was dropped)", async () => {
    const db = makeDb();
    // Mac alert at 21:30 Eastern on 2026-10-06: 01:30 UTC on the 7th,
    // stored the way SQLite datetime('now') writes it.
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (1, 10, ?, 148)`,
    ).run("2026-10-07 01:30:00");
    // Cloud fire at 10:00 Eastern on 2026-10-07: 14:00 UTC on the 7th.
    global.fetch = cloudPayload("2026-10-07T14:00:00.000Z");

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(1);
    expect(result.skipped_already_alerted).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM level_alerts`).get() as { c: number }).c).toBe(2);
  });

  it("an alert on an Eastern day a week earlier never blocks", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (1, 10, ?, 148)`,
    ).run("2026-09-30T14:00:00.000Z");
    global.fetch = cloudPayload("2026-10-07T14:00:00.000Z");
    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(1);
  });

  /**
   * The Worker keeps its marker 7 days (the Mac is often down overnight or
   * longer when the cloud fires). One marker per level; a later fire carries
   * the earlier, unreconciled ones in `earlier`.
   */
  function cloudBody(payloads: Record<string, unknown>) {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ payloads }), { status: 200 });
    });
    global.fetch = spy as any;
    return spy;
  }

  const record = (triggeredAt: string, triggeredPrice: number, extra: Record<string, unknown> = {}) => ({
    levelId: 1,
    securityId: 10,
    symbol: "AAPL",
    levelType: "support",
    levelPrice: 150,
    triggeredPrice,
    triggeredAt,
    sourceAuthor: "Me",
    ...extra,
  });

  it("a marker several days old is still filed, at its own time", async () => {
    const db = makeDb();
    const spy = cloudBody({ "1": record("2026-10-02T18:00:00.000Z", 149, { firedAt: "2026-10-02T18:00:05.000Z" }) });

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(1);
    // Recorded at the PUSH time (firedAt), the field the Worker's own
    // once-a-day guard reads; before 2026-10-08 this pinned the quote time.
    expect(db.prepare(`SELECT triggered_at, triggered_price FROM level_alerts`).all()).toEqual([
      { triggered_at: "2026-10-02T18:00:05.000Z", triggered_price: 149 },
    ]);
    const level = db.prepare(`SELECT is_active, triggered_at FROM security_levels WHERE id = 1`).get();
    expect(level).toEqual({ is_active: 0, triggered_at: "2026-10-02T18:00:05.000Z" });
    const deletes = (spy.mock.calls as unknown[][]).filter((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
    expect(deletes).toHaveLength(1);
  });

  it("two fires for one level on different Eastern days become two inbox rows; the level keeps the newest", async () => {
    const db = makeDb();
    const spy = cloudBody({
      "1": record("2026-10-08T14:00:00.000Z", 149.5, {
        earlier: [record("2026-10-06T18:00:00.000Z", 148)],
      }),
    });

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(2);
    expect(result.skipped_already_alerted).toBe(0);
    expect(
      db.prepare(`SELECT triggered_at, triggered_price FROM level_alerts ORDER BY triggered_at`).all(),
    ).toEqual([
      { triggered_at: "2026-10-06T18:00:00.000Z", triggered_price: 148 },
      { triggered_at: "2026-10-08T14:00:00.000Z", triggered_price: 149.5 },
    ]);
    const level = db.prepare(`SELECT is_active, triggered_at, triggered_price FROM security_levels WHERE id = 1`).get();
    expect(level).toEqual({ is_active: 0, triggered_at: "2026-10-08T14:00:00.000Z", triggered_price: 149.5 });
    // One marker, one delete.
    const deletes = (spy.mock.calls as unknown[][]).filter((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
    expect(deletes).toHaveLength(1);
  });

  it("a carried record on the SAME Eastern day as the main one is deduped (one row for that day)", async () => {
    const db = makeDb();
    cloudBody({
      // 21:30 Eastern on the 7th (UTC already the 8th) ...
      "1": record("2026-10-08T01:30:00.000Z", 149.5, {
        // ... and 15:00 Eastern on the 7th.
        earlier: [record("2026-10-07T19:00:00.000Z", 148)],
      }),
    });

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(1);
    expect(result.skipped_already_alerted).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM level_alerts`).get() as { c: number }).c).toBe(1);
  });

  it("a carried day the Mac already alerted on is skipped; the other day is still filed", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (1, 10, ?, 147)`,
    ).run("2026-10-06 15:00:00");
    cloudBody({
      "1": record("2026-10-08T14:00:00.000Z", 149.5, {
        earlier: [record("2026-10-06T18:00:00.000Z", 148)],
      }),
    });

    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(1);
    expect(result.skipped_already_alerted).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM level_alerts`).get() as { c: number }).c).toBe(2);
  });

  it("a malformed carried record is ignored; the main record is still filed", async () => {
    const db = makeDb();
    cloudBody({
      "1": record("2026-10-08T14:00:00.000Z", 149.5, {
        earlier: [null, { triggeredAt: "not a time", triggeredPrice: 1 }, "text"],
      }),
    });
    const result = await reconcileCloudFiredLevels(db, "secret");
    expect(result.reconciled).toBe(1);
    expect(result.errors).toEqual([]);
  });
});

/**
 * The Worker's once-a-day guard counts the day from the marker's `firedAt`
 * (when the push went out, workers/cron/src/level-scan.ts). The Mac used the
 * quote time (`triggeredAt`), so for a thinly traded name whose last quote is
 * a day old it filed an inbox row dated on a day with no push.
 */
describe("reconcileCloudFiredLevels counts the day from the push time", () => {
  function cloudBody(payloads: Record<string, unknown>) {
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ payloads }), { status: 200 });
    }) as any;
  }
  const record = (extra: Record<string, unknown>) => ({
    levelId: 1,
    securityId: 10,
    symbol: "AAPL",
    levelType: "support",
    levelPrice: 150,
    triggeredPrice: 149,
    sourceAuthor: "Me",
    ...extra,
  });
  const QUOTE_YESTERDAY = "2026-10-06T19:55:00.000Z"; // 15:55 Eastern on the 6th
  const PUSH_TODAY = "2026-10-07T14:00:00.000Z"; // 10:00 Eastern on the 7th

  it("a stale-quote marker fired today becomes ONE inbox row dated today; the quote time is kept in the context", async () => {
    const db = makeDb();
    cloudBody({ "1": record({ triggeredAt: QUOTE_YESTERDAY, firedAt: PUSH_TODAY }) });

    const result = await reconcileCloudFiredLevels(db, "secret");

    expect(result.reconciled).toBe(1);
    const rows = db
      .prepare(`SELECT triggered_at, triggered_price, position_context FROM level_alerts`)
      .all() as Array<{ triggered_at: string; triggered_price: number; position_context: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].triggered_at).toBe(PUSH_TODAY);
    expect(rows[0].triggered_price).toBe(149);
    const context = JSON.parse(rows[0].position_context);
    expect(context.fired_at).toBe(PUSH_TODAY);
    expect(context.quote_at).toBe(QUOTE_YESTERDAY);
    expect(db.prepare(`SELECT is_active, triggered_at FROM security_levels WHERE id = 1`).get()).toEqual({
      is_active: 0,
      triggered_at: PUSH_TODAY,
    });
  });

  it("a Mac alert earlier TODAY swallows a stale-quote cloud fire sent today (same push day)", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (1, 10, ?, 148)`,
    ).run("2026-10-07T13:40:00.000Z");
    cloudBody({ "1": record({ triggeredAt: QUOTE_YESTERDAY, firedAt: PUSH_TODAY }) });

    const result = await reconcileCloudFiredLevels(db, "secret");

    expect(result.skipped_already_alerted).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  it("a Mac alert YESTERDAY does not swallow a cloud fire sent today on yesterday's quote", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (1, 10, ?, 148)`,
    ).run("2026-10-06T15:00:00.000Z");
    cloudBody({ "1": record({ triggeredAt: QUOTE_YESTERDAY, firedAt: PUSH_TODAY }) });

    const result = await reconcileCloudFiredLevels(db, "secret");

    expect(result.reconciled).toBe(1);
    expect(
      (db.prepare(`SELECT triggered_at FROM level_alerts ORDER BY id`).all() as Array<{ triggered_at: string }>).map(
        (r) => r.triggered_at,
      ),
    ).toEqual(["2026-10-06T15:00:00.000Z", PUSH_TODAY]);
  });

  it("a legacy marker with no firedAt behaves as before: dated and deduped on the quote time", async () => {
    const db = makeDb();
    cloudBody({ "1": record({ triggeredAt: QUOTE_YESTERDAY }) });

    const result = await reconcileCloudFiredLevels(db, "secret");

    expect(result.reconciled).toBe(1);
    const row = db.prepare(`SELECT triggered_at, position_context FROM level_alerts`).get() as {
      triggered_at: string;
      position_context: string;
    };
    expect(row.triggered_at).toBe(QUOTE_YESTERDAY);
    const context = JSON.parse(row.position_context);
    expect(context.fired_at).toBe(QUOTE_YESTERDAY);
    expect(context).not.toHaveProperty("quote_at");
  });

  it("an unreadable firedAt falls back to the quote time", async () => {
    const db = makeDb();
    cloudBody({ "1": record({ triggeredAt: QUOTE_YESTERDAY, firedAt: "soon" }) });
    await reconcileCloudFiredLevels(db, "secret");
    expect(db.prepare(`SELECT triggered_at FROM level_alerts`).all()).toEqual([{ triggered_at: QUOTE_YESTERDAY }]);
  });

  it("carried earlier-day records are each dated on their own push time", async () => {
    const db = makeDb();
    cloudBody({
      "1": record({
        triggeredAt: QUOTE_YESTERDAY,
        firedAt: PUSH_TODAY,
        earlier: [record({ triggeredAt: "2026-10-02T19:55:00.000Z", firedAt: "2026-10-05T14:00:00.000Z" })],
      }),
    });

    const result = await reconcileCloudFiredLevels(db, "secret");

    expect(result.reconciled).toBe(2);
    expect(
      (db.prepare(`SELECT triggered_at FROM level_alerts ORDER BY id`).all() as Array<{ triggered_at: string }>).map(
        (r) => r.triggered_at,
      ),
    ).toEqual(["2026-10-05T14:00:00.000Z", PUSH_TODAY]);
  });
});
