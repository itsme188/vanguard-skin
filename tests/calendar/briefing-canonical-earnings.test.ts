import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

// The weekly briefing's "Portfolio Earnings This Week" list used to be
// `source === "finnhub"`. Since the 2026-10-08 slot ruling a Nasdaq row can be
// the row the duplicate check keeps (and a hand-entered row always could), so
// the kept row fell into "Macro & Other Events" and its symbol never reached
// the current-prices block. The list is now "the kept earnings row for a
// print, whatever its source".
//
// Rows are written through the real writers in the shapes the vendor fetchers
// produce. Synthetic symbols and invented round figures only.

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/vital-knowledge", () => ({
  fetchVitalKnowledge: vi.fn(async () => ""),
}));

import { runMigrations } from "@/lib/db/migrate";
import { generateTextForFeature } from "@/lib/ai/generate";
import { generateWeeklyBriefing, buildCurrentPrices } from "@/lib/calendar/briefing";
import {
  partitionBriefingEvents,
  briefingRowHasRealSlot,
} from "@/lib/calendar/briefing-partition";
import { getEventsByWeek } from "@/lib/queries/calendar";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { insertCalendarEvent, upsertCalendarEvents } from "@/lib/mutations/calendar";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { mondayOf } from "@/lib/calendar/date-utils";

const TODAY = "2026-11-02"; // Monday
const WEEK = "2026-11-02";
const PRINT = "2026-11-05";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(generateTextForFeature).mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(generateTextForFeature).mockResolvedValue({ text: "# Briefing" } as any);
});

function idOf(sourceKey: string): number {
  return (
    db.prepare("SELECT id FROM calendar_events WHERE source_key = ?").get(sourceKey) as { id: number }
  ).id;
}

/** A Finnhub earnings row as lib/calendar/finnhub.ts assembles it. */
function finnhub(symbol: string, date: string, hour?: "bmo" | "amc" | "dmh"): number {
  const entry: Record<string, unknown> = {
    symbol,
    date,
    epsEstimate: 1,
    revenueEstimate: 2_000_000_000,
    quarter: 3,
    year: 2026,
    epsActual: null,
  };
  if (hour) entry.hour = hour;
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: "Q3 2026 report.",
      symbol,
      consensus_estimate: "EPS 1.00 · Rev 2B",
      raw_json: JSON.stringify({ entry, history: [], finnhub_symbol: symbol }),
      source_key: `finnhub:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`finnhub:${symbol}:${date}`);
}

/** A Nasdaq earnings row as lib/calendar/nasdaq.ts assembles it. */
function nasdaq(symbol: string, date: string, hour: "bmo" | "amc" | null): number {
  upsertCalendarEvents(db, [
    {
      source: "nasdaq",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      consensus_estimate: "EPS 1.00",
      raw_json: JSON.stringify({ entry: { hour, epsForecast: 1, epsActual: null }, nasdaq_symbol: symbol }),
      source_key: `nasdaq:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`nasdaq:${symbol}:${date}`);
}

function macro(title: string, date: string): number {
  upsertCalendarEvents(db, [
    {
      source: "fred",
      event_type: "cpi",
      event_date: date,
      event_time: "08:30",
      title,
      source_key: `fred:cpi:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`fred:cpi:${date}`);
}

function seedPricedStock(symbol: string, close: number): void {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-10-30', ?)").run(id, close);
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe("partitionBriefingEvents over the real week reader", () => {
  it("a Nasdaq row the duplicate check kept is a portfolio earning; its hidden Finnhub twin is not listed", () => {
    const f = finnhub("ZZA", PRINT); // no hour: vendor default only
    const n = nasdaq("ZZA", PRINT, "bmo");
    const cpi = macro("CPI", "2026-11-04");
    reconcileEarningsDates(db, { today: TODAY });
    // Precondition: the slot ruling kept the Nasdaq row.
    expect(
      db.prepare("SELECT COALESCE(superseded,0) AS s FROM calendar_events WHERE id = ?").get(f),
    ).toEqual({ s: 1 });

    const parts = partitionBriefingEvents(getEventsByWeek(db, WEEK));

    expect(ids(parts.portfolioEarnings)).toEqual([n]);
    expect(ids(parts.otherEvents)).toEqual([cpi]);
    expect(parts.wshEarnings).toEqual([]);
  });

  it("a hand-entered kept row is a portfolio earning, not an 'other' event", () => {
    finnhub("ZZB", PRINT, "amc");
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: WEEK }).id;
    reconcileEarningsDates(db, { today: TODAY });

    const parts = partitionBriefingEvents(getEventsByWeek(db, WEEK));

    expect(ids(parts.portfolioEarnings)).toEqual([m]);
    expect(parts.otherEvents).toEqual([]);
  });

  it("both vendor rows still showing (no reconcile pass yet): the print is listed once, the slotted row", () => {
    finnhub("ZZA", PRINT); // no hour
    const n = nasdaq("ZZA", PRINT, "amc");

    const events = getEventsByWeek(db, WEEK);
    expect(events).toHaveLength(2); // precondition: both showing
    const parts = partitionBriefingEvents(events);

    expect(ids(parts.portfolioEarnings)).toEqual([n]);
    expect(parts.otherEvents).toEqual([]);
  });

  it("both showing and both slotted (or neither): Finnhub is listed", () => {
    const f1 = finnhub("ZZA", PRINT, "amc");
    nasdaq("ZZA", PRINT, "amc");
    const f2 = finnhub("ZZB", PRINT);
    nasdaq("ZZB", PRINT, null);

    const parts = partitionBriefingEvents(getEventsByWeek(db, WEEK));

    expect(ids(parts.portfolioEarnings).sort()).toEqual([f1, f2].sort());
  });

  it("two rows for one symbol on DIFFERENT dates are both listed (that choice is the reconciler's)", () => {
    const f = finnhub("ZZA", "2026-11-04", "amc");
    const n = nasdaq("ZZA", PRINT, "amc");

    const parts = partitionBriefingEvents(getEventsByWeek(db, WEEK));

    expect(ids(parts.portfolioEarnings)).toEqual([f, n]);
  });

  it("WSH earnings keep their own list; non-earnings rows never become earnings", () => {
    upsertCalendarEvents(db, [
      {
        source: "wsh",
        event_type: "earnings",
        event_date: PRINT,
        title: "ZZC earnings",
        symbol: "ZZC",
        source_key: `wsh:ZZC:${PRINT}`,
        week_of: WEEK,
      },
    ]);
    const w = idOf(`wsh:ZZC:${PRINT}`);
    const cpi = macro("CPI", "2026-11-04");

    const parts = partitionBriefingEvents(getEventsByWeek(db, WEEK));

    expect(ids(parts.wshEarnings)).toEqual([w]);
    expect(parts.portfolioEarnings).toEqual([]);
    expect(ids(parts.otherEvents)).toEqual([cpi]);
  });

  it("a superseded row handed in directly is dropped from every list", () => {
    const rows = [
      { id: 1, source: "finnhub", event_type: "earnings", event_date: PRINT, symbol: "ZZA", superseded: 1 },
      { id: 2, source: "nasdaq", event_type: "earnings", event_date: PRINT, symbol: "ZZA", superseded: 0 },
      { id: 3, source: "fred", event_type: "cpi", event_date: PRINT, symbol: null, superseded: 1 },
    ];
    const parts = partitionBriefingEvents(rows);
    expect(ids(parts.portfolioEarnings)).toEqual([2]);
    expect(parts.otherEvents).toEqual([]);
  });
});

describe("briefingRowHasRealSlot agrees with the one slot resolver", () => {
  const cases: { event_time: string | null; raw_json: string | null }[] = [
    { event_time: null, raw_json: null },
    { event_time: "BMO", raw_json: null },
    { event_time: "amc", raw_json: null },
    { event_time: " AMC ", raw_json: null },
    { event_time: "07:00", raw_json: null },
    { event_time: "16:05", raw_json: null },
    { event_time: "TAS", raw_json: JSON.stringify({ entry: { hour: "amc" } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: { hour: "bmo" } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: { hour: " AMC " } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: { hour: "dmh" } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: { hour: "" } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: { hour: null } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: { hour: "unknown" } }) },
    { event_time: null, raw_json: JSON.stringify({ entry: {} }) },
    { event_time: null, raw_json: JSON.stringify({}) },
    { event_time: null, raw_json: "not json" },
    { event_time: "Manual entry", raw_json: JSON.stringify({ entry: { hour: "bmo" } }) },
    { event_time: "", raw_json: JSON.stringify({ entry: { hour: "amc" } }) },
  ];
  it.each(cases)("%o", (row) => {
    expect(briefingRowHasRealSlot(row)).toBe(deriveEarningsSlot(row) !== null);
  });
});

describe("generateWeeklyBriefing prompt", () => {
  function sectionOf(prompt: string, heading: string): string {
    const start = prompt.indexOf(`\n## ${heading}`);
    if (start < 0) return "";
    const next = prompt.indexOf("\n## ", start + 4);
    return prompt.slice(start, next < 0 ? undefined : next);
  }

  it("lists a Nasdaq-kept print under Portfolio Earnings once, prices its symbol, and keeps it out of Macro & Other", async () => {
    seedPricedStock("ZZA", 50);
    finnhub("ZZA", PRINT);
    nasdaq("ZZA", PRINT, "bmo");
    macro("CPI", "2026-11-04");
    reconcileEarningsDates(db, { today: TODAY });

    await generateWeeklyBriefing(db, WEEK);

    const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
    const earnings = sectionOf(prompt, "Portfolio Earnings This Week");
    const other = sectionOf(prompt, "Macro & Other Events This Week");
    expect(earnings.match(/\*\*ZZA earnings/g)).toHaveLength(1);
    expect(other).toContain("**CPI**");
    expect(other).not.toContain("ZZA");
    expect(sectionOf(prompt, "Current Prices")).toContain("- ZZA: $50.00 (2026-10-30)");
  });

  it("a hand-entered kept print is listed under Portfolio Earnings and priced", async () => {
    seedPricedStock("ZZB", 40);
    finnhub("ZZB", PRINT, "amc");
    insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: WEEK });
    reconcileEarningsDates(db, { today: TODAY });

    await generateWeeklyBriefing(db, WEEK);

    const prompt = vi.mocked(generateTextForFeature).mock.calls[0][1].prompt as string;
    const earnings = sectionOf(prompt, "Portfolio Earnings This Week");
    expect(earnings.match(/\*\*ZZB earnings/g)).toHaveLength(1);
    expect(sectionOf(prompt, "Macro & Other Events This Week")).toBe("");
    expect(sectionOf(prompt, "Current Prices")).toContain("- ZZB: $40.00");
  });
});

describe("buildCurrentPrices takes the kept row's symbol", () => {
  it("prices a symbol that only a Nasdaq-kept earnings row names", () => {
    seedPricedStock("ZZA", 50);
    finnhub("ZZA", PRINT);
    nasdaq("ZZA", PRINT, "bmo");
    reconcileEarningsDates(db, { today: TODAY });
    const { portfolioEarnings, wshEarnings } = partitionBriefingEvents(getEventsByWeek(db, WEEK));

    const prices = buildCurrentPrices(db, { holdings: [], expiringOptions: [], portfolioEarnings, wshEarnings });

    expect(prices.get("ZZA")).toEqual({ close: 50, date: "2026-10-30" });
  });
});
