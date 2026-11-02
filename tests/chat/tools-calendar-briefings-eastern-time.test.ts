import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T21:00:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ins = db.prepare(
    `INSERT INTO calendar_briefings (week_of, title, content, event_count, generated_at)
     VALUES (?, ?, 'body', 3, ?)`,
  );
  ins.run("2026-10-12", "Week A", "2026-10-18 20:37:26");
  ins.run("2026-01-05", "Week B", "2026-01-11 21:37:00");
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

type Row = Record<string, unknown>;
type Out = { data: { briefings: Row[]; now_et: string } };

describe("query_calendar_briefings reports Eastern time", () => {
  it("converts a daylight-time UTC stamp to Eastern and labels it", async () => {
    const out = (await executeTool(db, "query_calendar_briefings", { week_of: "2026-10-12" })) as Out;
    const b = out.data.briefings[0];
    expect(b.generated_at_et).toContain("16:37");
    expect(b.generated_at_et).toContain("ET");
    expect(b.generated_at_utc).toBe("2026-10-18 20:37:26");
    expect("generated_at" in b).toBe(false);
    expect(out.data.now_et).toContain("ET");
  });

  it("converts a standard-time stamp correctly", async () => {
    const out = (await executeTool(db, "query_calendar_briefings", { week_of: "2026-01-05" })) as Out;
    expect(out.data.briefings[0].generated_at_et).toBe("2026-01-11 16:37 ET");
  });
});
