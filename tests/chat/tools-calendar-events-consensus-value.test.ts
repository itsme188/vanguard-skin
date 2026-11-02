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
       (source, event_type, event_date, title, symbol, consensus_estimate, consensus_value, source_key, week_of)
     VALUES ('manual', 'earnings', '2026-03-10', ?, ?, ?, ?, ?, '2026-03-09')`,
  );
  ins.run("AAA earnings", "AAA", "EPS 1.00", "EPS 1.20", "t:aaa");
  ins.run("BBB earnings", "BBB", "EPS 2.00", null, "t:bbb");
  ins.run("CCC earnings", "CCC", "EPS 3.00", "", "t:ccc");
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

type Out = { data: { events: Array<Record<string, unknown>> } };

describe("query_calendar_events consensus matches the hub", () => {
  it("resolves one figure per row and exposes no consensus_value key", async () => {
    const out = (await executeTool(db, "query_calendar_events", { event_type: "earnings" })) as Out;
    const by = Object.fromEntries(out.data.events.map((e) => [e.symbol as string, e]));
    expect(by.AAA.consensus_estimate).toBe("EPS 1.20");
    expect(by.BBB.consensus_estimate).toBe("EPS 2.00");
    expect(by.CCC.consensus_estimate).toBe("EPS 3.00");
    for (const e of out.data.events) expect("consensus_value" in e).toBe(false);
  });
});
