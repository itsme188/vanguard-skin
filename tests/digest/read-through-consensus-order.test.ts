/**
 * Which consensus does the read-through builder read? (sprint unit 4c)
 *
 * `buildReadThroughEntries` reads `consensus_estimate ?? consensus_value`
 * (the sync-time figure first). Every other surface reads the opposite order
 * through `effectiveConsensus` (`consensus_value ?? consensus_estimate`, the
 * at-release figure first). The proposal was to align the builder.
 *
 * This file records, with the REAL builder and rows in the shapes the two
 * real writers produce, exactly which reporter would enter or leave the
 * prompt if the order were aligned. One of them (ZZC) enters with a revenue
 * figure that is 2.5 times the only revenue consensus on its row: the
 * at-release string carries no revenue leg (the enrichment writer omits it
 * when the vendor sends no revenue estimate), so the aligned gate has nothing
 * to compare the revenue against and waves it through. Because of that case
 * the order was NOT aligned in this unit; the builder is unchanged and this
 * file pins what it does today. If the order is ever aligned, the "today"
 * assertions below fail and the owner sees the ZZC case first.
 *
 * Writers checked: lib/calendar/finnhub.ts writes `consensus_estimate` at
 * sync time; lib/calendar/enrich-actuals.ts::fetchFinnhubActual builds the
 * at-release string ("EPS 1.00 · Rev 100,000,000", or "EPS 1.00" alone when
 * there is no revenue estimate) that lands in `consensus_value`.
 *
 * Synthetic ZZ* tickers and round figures.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildReadThroughEntries } from "@/lib/digest/send-earnings-email";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import type { CalendarEvent } from "@/lib/types";

const TARGET = "ZZT";
const TARGET_DATE = "2026-06-10";
const REPORTER_DATE = "2026-06-08";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const reaction = JSON.stringify({
  t0_utc: "2026-06-08T20:00:00.000Z",
  window_min: 120,
  source: "yahoo",
  spy: { t_pre: 600, t_post: 603, delta_pct: 0.5 },
  qqq: { t_pre: 500, t_post: 504, delta_pct: 0.8 },
  symbol: { symbol: "X", t_pre: 100, t_post: 102, delta_pct: 2 },
});

function seedReporter(o: {
  symbol: string;
  estimate: string | null;
  atRelease: string | null;
  actual: string;
}): void {
  db.prepare(
    `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, hypothesis, weight, created_at)
     VALUES (?, ?, 'synthetic', 1.0, datetime('now'))`,
  ).run(o.symbol, TARGET);
  db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, title, source_key, symbol,
        consensus_estimate, consensus_value, actual_value, reaction_snapshot, enriched_at)
     VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-08 22:30:00')`,
  ).run(
    REPORTER_DATE,
    `${o.symbol} earnings`,
    `finnhub:${o.symbol}:${REPORTER_DATE}:earnings`,
    o.symbol,
    o.estimate,
    o.atRelease,
    o.actual,
    reaction,
  );
}

function seedAll(): void {
  // ZZA: the estimate moved up before the print. Sync-time 1.00, at-release 1.50, actual 1.80.
  seedReporter({
    symbol: "ZZA",
    estimate: "EPS 1.00 / Rev 100,000,000",
    atRelease: "EPS 1.50 · Rev 100,000,000",
    actual: "EPS 1.80 · Rev 100,000,000",
  });
  // ZZB: sync-time 1.00, at-release 2.50, actual 1.10.
  seedReporter({
    symbol: "ZZB",
    estimate: "EPS 1.00 / Rev 100,000,000",
    atRelease: "EPS 2.50 · Rev 100,000,000",
    actual: "EPS 1.10 · Rev 100,000,000",
  });
  // ZZC: the at-release string has NO revenue leg; the actual revenue is 2.5x
  // the sync-time revenue consensus (the builder's own "near-certain scrape
  // failure" band is 1.4x).
  seedReporter({
    symbol: "ZZC",
    estimate: "EPS 1.00 / Rev 100,000,000",
    atRelease: "EPS 1.00",
    actual: "EPS 1.05 · Rev 250,000,000",
  });
  // ZZD: control, one consensus only. The order cannot matter.
  seedReporter({
    symbol: "ZZD",
    estimate: "EPS 1.00 / Rev 100,000,000",
    atRelease: null,
    actual: "EPS 1.05 · Rev 101,000,000",
  });
}

/** What the gate would admit if it read consensus through `effectiveConsensus`. */
function admittedIfAligned(): string[] {
  const rows = db
    .prepare(`SELECT * FROM calendar_events WHERE event_type = 'earnings' ORDER BY symbol`)
    .all() as CalendarEvent[];
  return rows
    .filter((ev) => !actualsAreImplausible(effectiveConsensus(ev), ev.actual_value, ev.manual_actuals_at))
    .map((ev) => ev.symbol as string);
}

describe("read-through builder: the consensus order it reads today", () => {
  it("today (sync-time figure first): ZZB and ZZD are in the prompt; ZZA and ZZC are held back", () => {
    seedAll();
    const entries = buildReadThroughEntries(db, [TARGET], TARGET_DATE);
    expect(entries.map((e) => e.reporter).sort()).toEqual(["ZZB", "ZZD"]);
    // The figures it prints beside them are the sync-time ones.
    expect(entries.find((e) => e.reporter === "ZZB")).toMatchObject({
      consensusEps: 1,
      actualEps: 1.1,
    });
  });

  it("if aligned (at-release figure first): ZZA and ZZC would ENTER, ZZB would LEAVE, ZZD stays", () => {
    seedAll();
    expect(admittedIfAligned()).toEqual(["ZZA", "ZZC", "ZZD"]);
  });

  it("the entry that blocks aligning: ZZC's revenue would go in unchecked, 2.5x the only revenue consensus on its row", () => {
    seedAll();
    const zzc = db
      .prepare(`SELECT * FROM calendar_events WHERE symbol = 'ZZC'`)
      .get() as CalendarEvent;
    // Today's order sees the revenue consensus and holds the reporter back.
    expect(actualsAreImplausible(zzc.consensus_estimate, zzc.actual_value, zzc.manual_actuals_at)).toBe(true);
    // The aligned order reads a string with no revenue leg, so nothing is compared.
    expect(effectiveConsensus(zzc)).toBe("EPS 1.00");
    expect(actualsAreImplausible(effectiveConsensus(zzc), zzc.actual_value, zzc.manual_actuals_at)).toBe(false);
  });
});
