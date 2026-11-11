/**
 * Contract H (Portfolio Assistant plan, Task 5): executeTool takes the tool
 * call's abort signal. An already-aborted call starts nothing and answers
 * "Cancelled."; a signal that aborts before an external call is checked
 * again there, so no network request starts after Stop.
 *
 * Protects: Stop reaches the dispatcher. Bound: zero external calls after the
 * signal aborts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/apis/fred", () => ({
  getSeriesData: vi.fn(async () => []),
  searchSeries: vi.fn(async () => []),
  getLatestValue: vi.fn(),
  FRED_SERIES: {},
}));

import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { getSeriesData } from "@/lib/apis/fred";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(getSeriesData).mockClear();
});

describe("executeTool abort signal", () => {
  it("an aborted signal answers Cancelled. and starts no call", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await executeTool(db, "query_fred", { series_id: "DGS10" }, { abortSignal: ac.signal });
    expect(r).toEqual({ error: "Cancelled." });
    expect(vi.mocked(getSeriesData)).not.toHaveBeenCalled();
  });

  it("a live signal runs the tool", async () => {
    const ac = new AbortController();
    const r = (await executeTool(db, "query_fred", { series_id: "DGS10" }, { abortSignal: ac.signal })) as { error?: string };
    expect(r.error).toBeUndefined();
    expect(vi.mocked(getSeriesData)).toHaveBeenCalledTimes(1);
  });

  it("create_note is not saved after an abort", async () => {
    const ac = new AbortController();
    ac.abort();
    await executeTool(db, "create_note", { note_type: "journal", content: "x" }, { abortSignal: ac.signal });
    expect((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n).toBe(0);
  });
});
