import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  isEventArmed,
  getArmedEventIds,
  getArmedSymbolsInHorizon,
} from "@/lib/queries/earnings-worksheet-flags";
import {
  getSymbolStatus,
  getSymbolStatusDetailed,
  coveredForEvents,
  coveredForEvent,
} from "@/lib/queries/briefing-symbols";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// Migrations seed 3 default accounts (Vanguard Taxable, Vanguard Roth IRA,
// IBKR) — see tests/queries/earnings-hub.test.ts:22-42, the source of truth
// for this seed shape. `accounts` only has (id, name); there is no
// account_type/institution column to insert against.
function getAccount(name: string): number {
  const row = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (!row) throw new Error(`No account ${name} (default seed missing?)`);
  return row.id;
}

function seedEvent(
  symbol: string,
  date: string,
  extra: Partial<{ superseded: number; tag: string }> = {},
): number {
  const key = extra.tag
    ? `manual:${symbol}:${date}:earnings:${extra.tag}`
    : `manual:${symbol}:${date}:earnings`;
  const r = db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded)
     VALUES ('manual','earnings',?,?,?,?,?)`,
  ).run(date, `${symbol} earnings`, key, symbol, extra.superseded ?? 0);
  return Number(r.lastInsertRowid);
}

function seedHeld(symbol: string): void {
  const acctId = getAccount("IBKR");
  const secId = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)`,
    )
    .run(symbol, symbol).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 10, '2026-09-01')`,
  ).run(acctId, secId);
}

describe("armed coverage (spec §4.1)", () => {
  it("isEventArmed is event-scoped: arming one event does not cover the sibling event of the same symbol", () => {
    // coveredForEvent/coveredForEvents take no `today` override (plan-mandated),
    // so the display-armed horizon is real wall-clock — seed relative to today
    // so this stays permanently armed rather than going stale.
    const armedId = seedEvent("ACME", addDays(todayET(), 1));
    const siblingId = seedEvent("ACME", addDays(todayET(), 90));
    armWorksheet(db, armedId);
    expect(isEventArmed(db, armedId)).toBe(true);
    expect(isEventArmed(db, siblingId)).toBe(false);
    expect(getArmedEventIds(db, [armedId, siblingId, 999])).toEqual(new Set([armedId]));
    expect(coveredForEvent(db, "ACME", armedId)).toBe(true);
    expect(coveredForEvent(db, "ACME", siblingId)).toBe(false);
  });

  it("coveredForEvents keeps held/watchlist family coverage and adds armed events", () => {
    seedHeld("GOOG");
    const googl = seedEvent("GOOGL", "2026-10-20"); // family-held; date irrelevant to coverage
    // Armed-only coverage relies on real wall-clock (no `today` override), so
    // this date must stay relative to today to keep discriminating forever.
    const snow = seedEvent("ACME", addDays(todayET(), 1)); // armed only
    const zs = seedEvent("BETA", "2026-09-03"); // nothing; date irrelevant to coverage
    armWorksheet(db, snow);
    expect(
      coveredForEvents(db, [
        { symbol: "GOOGL", eventId: googl },
        { symbol: "ACME", eventId: snow },
        { symbol: "BETA", eventId: zs },
        { symbol: null, eventId: 12345 },
      ]),
    ).toEqual(new Set([googl, snow]));
  });

  it("symbol-level armed honours the 14-day ET horizon and skips superseded rows", () => {
    const inside = seedEvent("ACME", "2026-09-10");
    const outside = seedEvent("BETA", "2026-09-30");
    const superseded = seedEvent("PATH", "2026-09-05", { superseded: 1 });
    const past = seedEvent("MDB", "2026-08-30");
    for (const id of [inside, outside, superseded, past]) armWorksheet(db, id);
    expect(getArmedSymbolsInHorizon(db, { today: "2026-09-02" })).toEqual(new Set(["ACME"]));
    const status = getSymbolStatus(db, ["ACME", "BETA", "PATH", "MDB"], { today: "2026-09-02" });
    expect(status).toEqual({ ACME: "armed", BETA: "neither", PATH: "neither", MDB: "neither" });
  });

  it("precedence is held > watchlist > armed and the reason set is exposed", () => {
    seedHeld("ACME");
    const id = seedEvent("ACME", "2026-09-05");
    armWorksheet(db, id);
    const detailed = getSymbolStatusDetailed(db, ["ACME"], { today: "2026-09-02" });
    expect(detailed.ACME).toEqual({ status: "held", reasons: { held: true, watchlist: false, armed: true } });
    expect(getSymbolStatus(db, ["ACME"], { today: "2026-09-02" })).toEqual({ ACME: "held" });
  });
});

// R11 (fix round 1): the sweep's cross-source dedupe (finnhub-first, then
// lowest id) and the cockpit's dedupe (finnhub-first, then newest
// created_at) can pick DIFFERENT twins of one (symbol, event_date) print —
// arming the twin the cockpit shows must still cover the twin the sweep
// acts on. coveredForEvents' armed leg is cluster-aware: an event id is
// covered when it, OR any unsuperseded earnings row sharing its
// (UPPER(symbol), event_date), carries a worksheet flag. getArmedEventIds /
// isEventArmed are untouched — they keep their exact per-id meaning.
describe("R11: cluster-aware armed coverage (dedupe-twin safety)", () => {
  it("two unsuperseded twins for ACME on the same date, flag on the higher id only, → BOTH ids are covered", () => {
    const lower = seedEvent("ACME", "2026-09-10", { tag: "a" }); // e.g. the sweep's pick (lowest id)
    const higher = seedEvent("ACME", "2026-09-10", { tag: "b" }); // e.g. the cockpit's pick (armed here)
    expect(higher).toBeGreaterThan(lower);
    armWorksheet(db, higher);

    expect(isEventArmed(db, lower)).toBe(false); // per-id meaning is unchanged
    expect(isEventArmed(db, higher)).toBe(true);

    expect(
      coveredForEvents(db, [
        { symbol: "ACME", eventId: lower },
        { symbol: "ACME", eventId: higher },
      ]),
    ).toEqual(new Set([lower, higher]));
    expect(coveredForEvent(db, "ACME", lower)).toBe(true);
    expect(coveredForEvent(db, "ACME", higher)).toBe(true);
  });

  it("a SUPERSEDED twin does not confer coverage onto its unsuperseded sibling", () => {
    const live = seedEvent("ACME", "2026-09-10", { tag: "a" }); // unsuperseded, no flag itself
    const superseded = seedEvent("ACME", "2026-09-10", { tag: "b", superseded: 1 }); // flagged, but superseded
    armWorksheet(db, superseded);

    expect(coveredForEvents(db, [{ symbol: "ACME", eventId: live }])).toEqual(new Set());
    expect(coveredForEvent(db, "ACME", live)).toBe(false);
  });

  it("a same-symbol event on a DIFFERENT date is not covered by the flag (clustering is date-scoped)", () => {
    const thisQuarter = seedEvent("ACME", "2026-09-10"); // unarmed
    const nextQuarter = seedEvent("ACME", "2026-12-10"); // armed, different date
    armWorksheet(db, nextQuarter);

    expect(coveredForEvents(db, [{ symbol: "ACME", eventId: thisQuarter }])).toEqual(new Set());
    expect(coveredForEvent(db, "ACME", thisQuarter)).toBe(false);
    expect(coveredForEvent(db, "ACME", nextQuarter)).toBe(true);
  });
});
