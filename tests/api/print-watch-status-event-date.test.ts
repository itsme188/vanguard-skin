/**
 * GET /api/print-watch/status — the additive `eventDate` (slice F minor (h)).
 *
 * The "Live prints outside this week" block could name a print's symbol,
 * state and window but not the DAY it belongs to, because the payload carried
 * no date. The route now sends the print's own event date; nothing else in
 * the payload moves. Every identifier is synthetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runMigrations } from "@/lib/db/migrate";
import { readFileSync } from "node:fs";
import { upsertPrint } from "@/lib/print-watch/store";
import { getWatchStatus } from "@/lib/print-watch/watcher";
import { anchorIndex } from "../helpers/source-anchor";
import { LivePrintsOutsideWeek, eventDateLabel } from "@/app/dashboard/today/EarningsHubLive";
import type { PrintStatusEntry } from "@/app/dashboard/today/hub-live/types";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({ get db() { return hoisted.db; } }));

let db: Database.Database;
const seedPrint = (symbol: string, date: string): number => {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings',?,?,?,?)`,
      )
      .run(date, symbol, `k-${symbol}`, symbol).lastInsertRowid,
  );
  return upsertPrint(db, eventId, symbol, date, "16:05");
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
});
afterEach(() => db.close());

type Entry = Record<string, unknown> & { printId: number };
const prints = async (): Promise<Entry[]> =>
  (await (await (await import("@/app/api/print-watch/status/route")).GET()).json()).data.prints;

describe("GET /api/print-watch/status — eventDate", () => {
  it("each print carries its own event date as YYYY-MM-DD", async () => {
    const a = seedPrint("AAA", "2026-09-10");
    const z = seedPrint("ZZZ", "2026-09-21");
    const out = await prints();
    expect(out.find((p) => p.printId === a)?.eventDate).toBe("2026-09-10");
    expect(out.find((p) => p.printId === z)?.eventDate).toBe("2026-09-21");
  });

  it("is additive: every field the payload carried before is still there", async () => {
    const a = seedPrint("AAA", "2026-09-10");
    const entry = (await prints()).find((p) => p.printId === a)!;
    for (const key of [
      "printId", "eventId", "symbol", "state", "sources", "coverage", "forcedOpenAt", "windowExtendedUntil",
      "effectiveWindow", "goRequest", "lines", "documents", "documentRoads", "read", "activeRead", "lastAttempt",
      "callouts", "outputs",
    ]) {
      expect(entry, key).toHaveProperty(key);
    }
  });
});

describe("eventDate comes from the status row, not a second read per print", () => {
  it("getWatchStatus carries each print row's own event date", () => {
    const a = seedPrint("AAA", "2026-09-10");
    const z = seedPrint("ZZZ", "2026-09-21");
    const rows = getWatchStatus(db);
    expect(rows.find((r) => r.printId === a)?.eventDate).toBe("2026-09-10");
    expect(rows.find((r) => r.printId === z)?.eventDate).toBe("2026-09-21");
  });

  it("the route passes the row's date through and never re-reads the print", () => {
    const src = readFileSync("app/api/print-watch/status/route.ts", "utf8");
    const handler = src.slice(anchorIndex(src, "export async function GET"));
    expect(handler).toContain("eventDate: row.eventDate,");
    expect(src).not.toContain("getPrintById");
  });
});

describe("eventDateLabel", () => {
  it("formats a calendar date without shifting it across a timezone", () => {
    expect(eventDateLabel("2026-09-10")).toBe("Thu, Sep 10");
    expect(eventDateLabel("2026-01-01")).toBe("Thu, Jan 1");
    expect(eventDateLabel("2026-12-31")).toBe("Thu, Dec 31");
  });
  it("returns null for anything that is not a real YYYY-MM-DD date", () => {
    for (const bad of [null, undefined, "", "2026-9-10", "2026-13-40", "2026-02-30", "2026-09-10T20:00:00Z", 20260910, {}]) {
      expect(eventDateLabel(bad)).toBeNull();
    }
  });
});

describe("LivePrintsOutsideWeek — names the day", () => {
  const entry = (o: Record<string, unknown>) =>
    ({ printId: 7, eventId: 99, symbol: "ZZZ", state: "window_open", sources: {}, coverage: [], lines: [], ...o }) as PrintStatusEntry;

  it("shows the event date between the symbol and the state", () => {
    const html = renderToStaticMarkup(createElement(LivePrintsOutsideWeek, { prints: [entry({ eventDate: "2026-09-21" })] }));
    expect(html).toContain("ZZZ · Mon, Sep 21 · window open");
  });

  it("an entry with no date (an older server) renders exactly as before", () => {
    const html = renderToStaticMarkup(createElement(LivePrintsOutsideWeek, { prints: [entry({})] }));
    expect(html).toContain("ZZZ · window open");
  });
});
