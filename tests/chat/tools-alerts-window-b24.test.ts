/**
 * B24 / QA-8 (Portfolio Assistant plan, Task 5): query_alerts' since_days
 * window compared the stored triggered_at as a STRING with an ISO cutoff.
 * SQLite's space form ("2026-11-03 12:30:00") sorts below the ISO "T" form
 * on the same day, so an alert inside the window on the boundary day was
 * dropped, and the window ran after the row limit.
 *
 * The fix parses both stored forms as UTC instants and keeps rows at or after
 * the cutoff instant, then slices to `limit`.
 *
 * Protects: which alerts are in the window. Bound: exact on the boundary day
 * (30 minutes either side of the cutoff instant, both stored forms).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQA', 'ZQA Corp', 'stock', 'USD')")
    .run().lastInsertRowid as number;
  const levelId = db
    .prepare("INSERT INTO security_levels (security_id, level_type, price) VALUES (?, 'support', 10)")
    .run(secId).lastInsertRowid as number;
  const ins = db.prepare(
    "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (?, ?, ?, ?)",
  );
  // Cutoff for since_days 7: 2026-11-03T12:00:00Z.
  ins.run(levelId, secId, "2026-11-03 12:30:00", 1); // space form, inside
  ins.run(levelId, secId, "2026-11-03 11:30:00", 2); // space form, outside
  ins.run(levelId, secId, "2026-11-03T12:30:00.000Z", 3); // ISO form, inside
  ins.run(levelId, secId, "2026-11-03T11:30:00.000Z", 4); // ISO form, outside
});

afterEach(() => {
  vi.useRealTimers();
});

type Result = { error?: string; data: { alerts: Array<{ triggered_price: number }> } };

describe("query_alerts since_days window", () => {
  it("keeps both stored forms inside the window and drops both outside", async () => {
    const r = (await executeTool(db, "query_alerts", { since_days: 7 })) as Result;
    expect(r.error).toBeUndefined();
    expect(r.data.alerts.map((a) => a.triggered_price).sort()).toEqual([1, 3]);
  });

  it("applies the window before the limit", async () => {
    const r = (await executeTool(db, "query_alerts", { since_days: 7, limit: 1 })) as Result & {
      list_info: { returned: number; truncated: boolean };
    };
    expect(r.data.alerts).toHaveLength(1);
    expect(r.list_info).toMatchObject({ returned: 1, truncated: true });
  });
});
