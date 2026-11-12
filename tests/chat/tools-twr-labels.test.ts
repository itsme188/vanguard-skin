/**
 * query_twr is self-describing (live-evaluation round, 2026-11-11): the model
 * left the two return figures unlabelled because the result only named its
 * blocks `twr` and `xirr`. A `units` block now says in words what each figure
 * is, that all are decimal fractions, and the window they cover; a withheld
 * figure carries a reason. No field is renamed and no figure changes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS, compactToolOutput } from "@/lib/chat/tools";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const TWR_UNITS = {
  "twr.totalReturn": "time-weighted return over the whole window, NOT annualised; decimal fraction (0.05 = 5%)",
  "twr.annualizedReturn":
    "time-weighted return, annualised; decimal fraction; null when the window is shorter than 30 days",
  "xirr.xirr": "money-weighted return (XIRR), annualised; decimal fraction",
  window:
    "every figure covers window.start_date to window.end_date; twr.perAccount and xirr.perAccount give the same measures per account",
};

type Twr = { data: { units: Record<string, string>; twr: unknown; xirr: unknown; twr_reason?: string; xirr_reason?: string; window: unknown } };

describe("query_twr units", () => {
  it("labels every return figure, with the window", async () => {
    const r = (await executeTool(db, "query_twr", { period: "inception" })) as Twr;
    expect(r.data.units).toEqual(TWR_UNITS);
    expect(r.data).toHaveProperty("window");
  });

  it("gives a reason when a figure is withheld (empty book: both null)", async () => {
    const r = (await executeTool(db, "query_twr", {})) as Twr;
    expect(r.data.twr).toBeNull();
    expect(r.data.xirr).toBeNull();
    expect(r.data.twr_reason).toBe(
      "Time-weighted return not computed: the scope has no monthly statement values in this window to chain.",
    );
    expect(r.data.xirr_reason).toBe(
      "Money-weighted return (XIRR) not computed: the scope has no start and end values with cash flows in this window to solve it from.",
    );
  });

  it("the units survive compaction word for word", async () => {
    const full = await executeTool(db, "query_twr", { period: "inception" });
    expect(JSON.stringify(compactToolOutput("query_twr", full))).toContain(TWR_UNITS["twr.totalReturn"]);
  });

  it("the description says which figure is which", () => {
    const d = CHAT_TOOLS.find((t) => t.name === "query_twr")!.description!;
    expect(d).toContain("The result's units block names each figure");
  });
});
