import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// Owner ruling 2026-11-01, item 4: the Housing Starts revision slot
// (fred:27:<second date>) is no longer synced. What happens to a row an older
// build already stored for it, on the next refresh of its week: an
// UN-enriched one is removed as "no longer on the release schedule the source
// publishes"; an ENRICHED one stays (sync never deletes history; the repair
// script scripts/repair-fred-revision-second-date-rows.ts handles those).
// Real macro module, network stubbed; fixed week passed explicitly.
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

const WEEK = "2026-10-26";

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


const SCHEDULE = [
  { release_id: 27, release_name: "New Residential Construction", date: "2026-10-20" },
  { release_id: 27, release_name: "New Residential Construction", date: "2026-10-27" },
  { release_id: 97, release_name: "New Residential Sales", date: "2026-10-28" },
];

function stubFred() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      const from = u.searchParams.get("realtime_start") ?? "";
      const to = u.searchParams.get("realtime_end") ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ release_dates: SCHEDULE.filter((d) => d.date >= from && d.date <= to) }),
      };
    }),
  );
}

function seedSecondDateRow(enriched: boolean): void {
  db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of, actual_value, enriched_at)
     VALUES ('claude_macro', 'housing', '2026-10-27', 'September Housing Starts', 'fred:27:2026-10-27', ?, ?, ?)`,
  ).run(WEEK, enriched ? "1.0M" : null, enriched ? "2026-10-27 15:00:00" : null);
}

function fredKeys(): string[] {
  return (
    db
      .prepare("SELECT source_key FROM calendar_events WHERE source_key LIKE 'fred:%' ORDER BY source_key")
      .all() as { source_key: string }[]
  ).map((r) => r.source_key);
}

describe("syncCalendarForWeek — a stored Housing Starts revision-slot row", () => {
  it("an un-enriched one is removed and named on the next refresh of its week", async () => {
    seedSecondDateRow(false);
    stubFred();
    const result = await syncCalendarForWeek(db, WEEK);
    expect(fredKeys()).toEqual(["fred:97:2026-10-28"]);
    expect(result.removed).toEqual([
      expect.objectContaining({
        eventDate: "2026-10-27",
        reason: "no longer on the release schedule the source publishes",
      }),
    ]);
  });

  it("an enriched one stays (sync never deletes history)", async () => {
    seedSecondDateRow(true);
    stubFred();
    await syncCalendarForWeek(db, WEEK);
    expect(fredKeys()).toEqual(["fred:27:2026-10-27", "fred:97:2026-10-28"]);
  });
});
