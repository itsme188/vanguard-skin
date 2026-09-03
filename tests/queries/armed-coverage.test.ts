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

function seedEvent(symbol: string, date: string, extra: Partial<{ superseded: number }> = {}): number {
  const r = db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded)
     VALUES ('manual','earnings',?,?,?,?,?)`,
  ).run(date, `${symbol} earnings`, `manual:${symbol}:${date}:earnings`, symbol, extra.superseded ?? 0);
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
