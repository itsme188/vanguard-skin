import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-09T15:00:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ins = db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, title, symbol, consensus_estimate, superseded, source_key, week_of)
     VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?, '2026-03-09')`,
  );
  ins.run("2026-03-10", "AAA earnings kept", "AAA", "1.50", 0, "t:aaa-kept");
  ins.run("2026-03-10", "AAA earnings hidden", "AAA", "1.10", 1, "t:aaa-hidden");
  ins.run("2026-03-11", "ZZZ earnings", "ZZZ", "2.00", 0, "t:zzz");
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

type Out = { data: { events: Array<{ symbol: string; consensus_estimate: string }> } };

describe("chat query_calendar_events skips hidden duplicate rows", () => {
  it("returns only the kept rows", async () => {
    const out = (await executeTool(db, "query_calendar_events", { event_type: "earnings" })) as Out;
    expect(out.data.events.map((e) => e.symbol)).toEqual(["AAA", "ZZZ"]);
    expect(out.data.events[0].consensus_estimate).toBe("1.50");
  });

  it("a symbol filter still returns one row", async () => {
    const out = (await executeTool(db, "query_calendar_events", { symbol: "AAA" })) as Out;
    expect(out.data.events).toHaveLength(1);
    expect(out.data.events[0].consensus_estimate).toBe("1.50");
  });
});
