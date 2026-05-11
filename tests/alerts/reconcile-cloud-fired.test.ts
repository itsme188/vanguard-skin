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
});
