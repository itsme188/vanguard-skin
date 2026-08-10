import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildBogeyEventMap } from "@/lib/queries/bogey-event-match";

function insertEvent(
  db: Database.Database,
  opts: { symbol: string; date: string; source?: string; superseded?: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, symbol, superseded, title)
       VALUES (?, ?, 'earnings', ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.source ?? "finnhub",
      `${opts.source ?? "finnhub"}:${opts.symbol}:${opts.date}`,
      opts.date,
      opts.date,
      opts.symbol,
      opts.superseded ?? 0,
      `${opts.symbol} earnings`,
    );
  return Number(info.lastInsertRowid);
}

describe("buildBogeyEventMap (qa: bogeys-upload lands on superseded event)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("binds a symbol to its live row, never a superseded sibling", () => {
    // LAC: superseded vendor row on 8/12, live manual row on 8/13 —
    // the exact shape a date correction leaves behind.
    insertEvent(db, { symbol: "LAC", date: "2026-08-12", superseded: 1 });
    const liveId = insertEvent(db, { symbol: "LAC", date: "2026-08-13", source: "manual" });

    const map = buildBogeyEventMap(db, "2026-08-07", "2026-08-20");
    expect(map.get("LAC")).toBe(liveId);
  });

  it("omits a symbol whose only in-window row is superseded", () => {
    insertEvent(db, { symbol: "NET", date: "2026-08-12", superseded: 1 });

    const map = buildBogeyEventMap(db, "2026-08-07", "2026-08-20");
    expect(map.has("NET")).toBe(false);
  });

  it("keys symbols uppercase and keeps first-write-wins for duplicate live rows", () => {
    const first = insertEvent(db, { symbol: "gfl", date: "2026-08-11" });
    insertEvent(db, { symbol: "GFL", date: "2026-08-12", source: "nasdaq" });

    const map = buildBogeyEventMap(db, "2026-08-07", "2026-08-20");
    expect(map.get("GFL")).toBe(first);
  });
});
