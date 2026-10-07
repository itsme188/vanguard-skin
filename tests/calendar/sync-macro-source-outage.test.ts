import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// [qa:today-earningshub-refresh--deletes-scheduled-macro-release-never-recreated]
// review finding: a FRED outage (non-OK response, or no key) came back as an
// EMPTY release list, so the orphan cleanup ran against a keep list of only
// the built-in rows, deleted the week's stored FRED releases and reported
// them as "no longer on the release schedule the source publishes".
//
// An outage now throws inside the macro fetch; the sync's existing catch
// takes the upsert-only fallback road, deletes nothing and reports `macro:`.
// A SUCCESSFUL response that omits a stored row still removes and names it —
// this is not the source-silence guard the owner declined.
//
// The macro module is REAL here (only the network is stubbed). The week is
// passed explicitly and only macro rows are seeded, so the fixed synthetic
// week is not wall-clock stale.
vi.mock("@/lib/tws/wsh", () => ({ fetchWshEvents: vi.fn() }));
vi.mock("@/lib/calendar/parse-wsh", () => ({
  parseWshEvents: vi.fn(() => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/calendar/finnhub", () => ({ fetchFinnhubEarningsForSymbols: vi.fn() }));
vi.mock("@/lib/calendar/nasdaq", () => ({
  fetchNasdaqEarningsForSymbols: vi.fn(async () => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => null),
  disconnectTws: vi.fn(),
}));

import { syncCalendarForWeek } from "@/lib/calendar/sync";

const WEEK = "2026-04-20";

const saved = {
  fred: process.env.FRED_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  finnhub: process.env.FINNHUB_API_KEY,
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  process.env.FRED_API_KEY = "test-key";
  // No AI key: titles fall back to "<period> <short name>" with no AI call.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FINNHUB_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("FRED_API_KEY", saved.fred);
  restore("ANTHROPIC_API_KEY", saved.anthropic);
  restore("FINNHUB_API_KEY", saved.finnhub);
});

const RETAIL = { release_id: 9, release_name: "Advance Monthly Sales for Retail and Food Services", date: "2026-04-21" };
const NEW_HOMES = { release_id: 97, release_name: "New Residential Sales", date: "2026-04-23" };

function stubFredOk(releaseDates: { release_id: number; release_name: string; date: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ release_dates: releaseDates }),
    })),
  );
}

function fredKeys(): string[] {
  return (
    db
      .prepare("SELECT source_key FROM calendar_events WHERE source_key LIKE 'fred:%' ORDER BY source_key")
      .all() as { source_key: string }[]
  ).map((r) => r.source_key);
}

describe("syncCalendarForWeek — a macro source outage", () => {
  it("a 503 deletes nothing, reports an error, and names no row as removed", async () => {
    stubFredOk([RETAIL, NEW_HOMES]);
    await syncCalendarForWeek(db, WEEK);
    expect(fredKeys()).toEqual(["fred:97:2026-04-23", "fred:9:2026-04-21"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const second = await syncCalendarForWeek(db, WEEK);

    expect(fredKeys()).toEqual(["fred:97:2026-04-23", "fred:9:2026-04-21"]);
    expect(second.removed).toEqual([]);
    expect(second.errors.some((e) => /^macro: .*503/.test(e))).toBe(true);
  });

  it("a missing source key deletes nothing and reports an error", async () => {
    stubFredOk([RETAIL, NEW_HOMES]);
    await syncCalendarForWeek(db, WEEK);

    delete process.env.FRED_API_KEY;
    const second = await syncCalendarForWeek(db, WEEK);

    expect(fredKeys()).toEqual(["fred:97:2026-04-23", "fred:9:2026-04-21"]);
    expect(second.removed).toEqual([]);
    expect(second.errors.some((e) => /^macro: .*FRED_API_KEY/.test(e))).toBe(true);
  });

  it("a successful response that omits a stored release still removes it and names it", async () => {
    stubFredOk([RETAIL, NEW_HOMES]);
    await syncCalendarForWeek(db, WEEK);

    stubFredOk([RETAIL]);
    const second = await syncCalendarForWeek(db, WEEK);

    expect(fredKeys()).toEqual(["fred:9:2026-04-21"]);
    expect(second.removed).toEqual([
      {
        title: "March New Home Sales",
        eventDate: "2026-04-23",
        source: "claude_macro",
        reason: "no longer on the release schedule the source publishes",
      },
    ]);
    expect(second.errors.filter((e) => e.startsWith("macro:"))).toEqual([]);
  });
});
