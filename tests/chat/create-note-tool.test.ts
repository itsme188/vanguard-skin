/**
 * create_note chat tool: the same two rules as the notes route.
 *  - An earnings note needs a security (the Earnings tab files notes under
 *    per-security headers, so one without a security is shown nowhere).
 *  - A note with no date is dated today in New York, not today in UTC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

function noteCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
}

interface NoteToolResult {
  error?: string;
  saved?: boolean;
  note?: { security_id: number | null; event_date: string };
}

// executeTool wraps a tool's own result as { data, ...annotations }.
async function run(input: Record<string, unknown>): Promise<NoteToolResult> {
  const wrapped = (await executeTool(db, "create_note", input)) as { data: NoteToolResult };
  return wrapped.data;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Corp', 'Stock')"
  ).run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("create_note tool — earnings note needs a security", () => {
  it("refuses an earnings note with no symbol and saves nothing", async () => {
    const result = await run({
      note_type: "earnings",
      content: "Guide raised",
    });

    expect(result.error).toContain("An earnings note needs a security.");
    expect(result.saved).toBeUndefined();
    expect(noteCount()).toBe(0);
  });

  it("refuses an earnings note whose symbol matches no security", async () => {
    const result = await run({
      note_type: "earnings",
      content: "Guide raised",
      symbol: "NOSUCH",
    });

    expect(result.error).toContain("An earnings note needs a security.");
    expect(noteCount()).toBe(0);
  });

  it("saves an earnings note linked to a security on file", async () => {
    const result = await run({
      note_type: "earnings",
      content: "Guide raised",
      symbol: "AAA",
    });

    expect(result.saved).toBe(true);
    expect(result.note?.security_id).not.toBeNull();
    expect(noteCount()).toBe(1);
  });

  it("still saves a journal note with no security", async () => {
    const result = await run({
      note_type: "journal",
      content: "A thought",
    });

    expect(result.saved).toBe(true);
    expect(noteCount()).toBe(1);
  });
});

describe("create_note tool — default date is today in New York", () => {
  it("dates an evening note with the New York day, not the UTC day", async () => {
    // 02:00 UTC on the 11th is the evening of the 10th in New York.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-11T02:00:00Z"));

    const result = await run({
      note_type: "journal",
      content: "Evening thought",
    });

    expect(result.note?.event_date).toBe("2026-03-10");
  });

  it("keeps an explicit date", async () => {
    const result = await run({
      note_type: "journal",
      content: "Dated",
      event_date: "2026-02-02",
    });

    expect(result.note?.event_date).toBe("2026-02-02");
  });
});
