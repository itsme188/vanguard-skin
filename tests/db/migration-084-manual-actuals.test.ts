import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 084: manual_actuals_at", () => {
  it("adds a nullable manual_actuals_at column to calendar_events", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(calendar_events)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === "manual_actuals_at");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  it("defaults to NULL for existing rows (no backfill)", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, actual_value)
       VALUES ('finnhub','earnings','2026-08-19','XMTR earnings','finnhub:XMTR:2026-08-19','EPS 1.05')`,
    ).run();

    const row = db
      .prepare(`SELECT manual_actuals_at FROM calendar_events WHERE source_key = ?`)
      .get("finnhub:XMTR:2026-08-19") as { manual_actuals_at: string | null };
    expect(row.manual_actuals_at).toBeNull();
  });

  it("upgrades a POPULATED database cleanly", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
