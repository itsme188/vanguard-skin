/**
 * getLiveReadThroughsForReporter (#13) — the live-pairs helper feeding the
 * widened push-at-print gate. A pair only counts when its TARGET is
 * currently held/watchlist, so the gate stays narrow as positions exit.
 *
 * Spec: docs/superpowers/specs/2026-07-16-read-through-push-design.md
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getLiveReadThroughsForReporter } from "@/lib/alerts/read-through-push";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
}

function seedHolding(securityId: number, quantity = 100) {
  const acct = db
    .prepare(`INSERT INTO accounts (name) VALUES (?)`)
    .run(`Acct ${securityId}`).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-07-15', ?)`,
  ).run(acct, securityId, quantity, `t:${acct}:${securityId}`);
}

function seedWatchlist(securityId: number) {
  db.prepare(`INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)`).run(securityId);
}

function seedPair(reporter: string, target: string, weight = 1.0, hypothesis: string | null = "why") {
  db.prepare(
    `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
     VALUES (?, ?, ?, ?)`,
  ).run(reporter, target, weight, hypothesis);
}

describe("getLiveReadThroughsForReporter", () => {
  it("returns held targets with hypothesis, weight-sorted", () => {
    seedHolding(seedSecurity("PRTO"));
    seedHolding(seedSecurity("XMTR"));
    seedPair("TER", "XMTR", 0.5, "second");
    seedPair("TER", "PRTO", 0.9, "first");

    expect(getLiveReadThroughsForReporter(db, "TER")).toEqual([
      { target: "PRTO", targetStatus: "held", hypothesis: "first" },
      { target: "XMTR", targetStatus: "held", hypothesis: "second" },
    ]);
  });

  it("drops pairs whose target is no longer held/watchlist (exited position)", () => {
    seedSecurity("GONE"); // securities row exists but no holding
    seedPair("TER", "GONE");
    expect(getLiveReadThroughsForReporter(db, "TER")).toEqual([]);
  });

  it("watchlist targets get watchlist status; held wins when both", () => {
    const wl = seedSecurity("WATCHED");
    seedWatchlist(wl);
    seedPair("TER", "WATCHED");
    expect(getLiveReadThroughsForReporter(db, "TER")).toEqual([
      { target: "WATCHED", targetStatus: "watchlist", hypothesis: "why" },
    ]);
  });

  it("matches the reporter family-aware (pair under GOOG fires for a GOOGL print)", () => {
    seedHolding(seedSecurity("TGT"));
    seedPair("GOOG", "TGT");
    expect(getLiveReadThroughsForReporter(db, "GOOGL")).toHaveLength(1);
  });

  it("caps at 3 live pairs", () => {
    for (const t of ["A", "B", "C", "D"]) {
      seedHolding(seedSecurity(t));
      seedPair("TER", t, 1.0);
    }
    expect(getLiveReadThroughsForReporter(db, "TER")).toHaveLength(3);
  });

  it("no pairs → empty (the common non-read-through reporter)", () => {
    expect(getLiveReadThroughsForReporter(db, "AAPL")).toEqual([]);
  });

  // [C-17 / v2 slice A §4.1] Selection consumers switched to coveredForEvents
  // (armed events get what held names get) — the push gate (and this
  // read-through-target check that feeds it) is explicitly NOT one of them
  // and must keep reading getSymbolStatus's held/watchlist union only. A
  // target that is armed-only (its own earnings event is armed, but the
  // target itself is neither held nor watchlisted) stays excluded.
  //
  // The fixture MUST be dated inside getSymbolStatus's real-wall-clock
  // 14-day armed horizon, or the target resolves "neither" regardless of
  // arming and this test would pass even after an erroneous future
  // widening of the gate to `status === "armed"` (fix round 1, Important
  // finding #1) — a hardcoded date (the original '2026-09-02' was
  // in-horizon only on the day it was written, stale from tomorrow).
  it("drops a pair whose target is armed-only (not held, not watchlist)", () => {
    seedSecurity("ARMEDTGT"); // securities row exists, no holding, no watchlist
    const eventDate = addDays(todayET(), 1); // inside the 14-day armed horizon
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
           VALUES ('manual', 'earnings', ?, 'ARMEDTGT', 'k:armedtgt', 'ARMEDTGT')`,
        )
        .run(eventDate).lastInsertRowid,
    );
    armWorksheet(db, eventId);
    seedPair("TER", "ARMEDTGT");
    expect(getLiveReadThroughsForReporter(db, "TER")).toEqual([]);
  });
});
