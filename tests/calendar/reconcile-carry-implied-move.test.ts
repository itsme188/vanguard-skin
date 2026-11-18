import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";
import { upsertEarningsIntel } from "@/lib/mutations/earnings-intel";
import { mondayOf } from "@/lib/calendar/date-utils";

// QA finding dashboard-today-earnings-hub-after-refresh-flips-hd-and-lqdt-
// kept-rows-implied-move-recomputed-onto-hidden-twin: a refresh can flip which
// of two same-date vendor rows is kept. The stored implied move (earnings_intel,
// keyed by event id) stayed on the now-hidden row, so with no option source up
// the kept row showed no implied move. The fold now copies the hidden twin's
// measurement onto the kept row: same event date only, never over an implied
// move the kept row already has, the whole measurement with its own
// computed_at.
//
// Synthetic symbols and invented round figures.

const TODAY = "2026-11-02"; // Monday, fixed
const PRINT = "2026-11-05";
const PRICED_AT = "2026-11-01 15:00:00";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function idOf(sourceKey: string): number {
  return (
    db.prepare("SELECT id FROM calendar_events WHERE source_key = ?").get(sourceKey) as { id: number }
  ).id;
}

/** A Finnhub row with a during-market-hours default (loses to a real Nasdaq slot). */
function finnhub(symbol: string, date: string): number {
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      consensus_estimate: "EPS 1.00",
      raw_json: JSON.stringify({
        entry: { date, epsEstimate: 1, epsActual: null, hour: "dmh", quarter: 3, year: 2026, symbol },
        finnhub_symbol: symbol,
      }),
      source_key: `finnhub:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`finnhub:${symbol}:${date}`);
}

function nasdaq(symbol: string, date: string): number {
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
      raw_json: JSON.stringify({ entry: { hour: "bmo", epsForecast: 1, epsActual: null }, nasdaq_symbol: symbol }),
      source_key: `nasdaq:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`nasdaq:${symbol}:${date}`);
}

function priced(eventId: number, pct = 5, computedAt = PRICED_AT): void {
  upsertEarningsIntel(db, {
    eventId,
    impliedMovePct: pct,
    impliedMethod: "straddle",
    expiryUsed: "2026-11-06",
    straddleMid: 4,
    spot: 80,
    computedAt,
  });
}

interface IntelRow {
  event_id: number;
  implied_move_pct: number | null;
  implied_method: string | null;
  expiry_used: string | null;
  straddle_mid: number | null;
  spot: number | null;
  computed_at: string;
}
const intelOf = (id: number) =>
  db.prepare("SELECT * FROM earnings_intel WHERE event_id = ?").get(id) as IntelRow | undefined;
const supersededOf = (id: number) =>
  (db.prepare("SELECT COALESCE(superseded, 0) AS s FROM calendar_events WHERE id = ?").get(id) as { s: number }).s;

describe("a twin fold carries the stored implied move to the kept row", () => {
  it("same-date flip: the kept row takes the hidden twin's measurement and its computed_at", () => {
    const f = finnhub("AAA", PRINT);
    const n = nasdaq("AAA", PRINT);
    priced(f);

    reconcileEarningsDates(db, { today: TODAY });

    expect(supersededOf(f)).toBe(1);
    expect(supersededOf(n)).toBe(0);
    expect(intelOf(n)).toEqual({
      event_id: n,
      implied_move_pct: 5,
      implied_method: "straddle",
      expiry_used: "2026-11-06",
      straddle_mid: 4,
      spot: 80,
      computed_at: PRICED_AT,
    });
    // Copied, not moved: the hidden row keeps its own record.
    expect(intelOf(f)?.implied_method).toBe("straddle");

    // A second pass writes nothing new.
    reconcileEarningsDates(db, { today: TODAY });
    expect(intelOf(n)?.computed_at).toBe(PRICED_AT);
  });

  it("never overwrites an implied move the kept row already has", () => {
    const f = finnhub("AAA", PRINT);
    const n = nasdaq("AAA", PRINT);
    priced(f, 5, PRICED_AT);
    priced(n, 7, "2026-11-02 10:00:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(supersededOf(n)).toBe(0);
    expect(intelOf(n)).toMatchObject({ implied_move_pct: 7, computed_at: "2026-11-02 10:00:00" });
  });

  it("fills a kept row whose record has no implied move (spot only)", () => {
    const f = finnhub("AAA", PRINT);
    const n = nasdaq("AAA", PRINT);
    priced(f);
    upsertEarningsIntel(db, {
      eventId: n,
      impliedMovePct: null,
      impliedMethod: null,
      expiryUsed: null,
      straddleMid: null,
      spot: 90,
      computedAt: "2026-11-02 10:00:00",
    });

    reconcileEarningsDates(db, { today: TODAY });

    expect(intelOf(n)).toEqual({
      event_id: n,
      implied_move_pct: 5,
      implied_method: "straddle",
      expiry_used: "2026-11-06",
      straddle_mid: 4,
      spot: 80,
      computed_at: PRICED_AT,
    });
  });

  it("carries nothing from a hidden row on a different date in the same cluster", () => {
    const f = finnhub("ZZZ", "2026-11-04");
    const n = nasdaq("ZZZ", PRINT);
    // First pass decides which row the cluster keeps; every later pass folds
    // the hidden row again, so pricing it now and re-running exercises the fold.
    reconcileEarningsDates(db, { today: TODAY });
    const kept = supersededOf(f) === 0 ? f : n;
    const hidden = kept === f ? n : f;
    expect(supersededOf(hidden)).toBe(1);

    priced(hidden);
    reconcileEarningsDates(db, { today: TODAY });

    expect(supersededOf(hidden)).toBe(1);
    expect(intelOf(kept)).toBeUndefined();
  });

  it("a hidden twin with no implied move carries nothing and invents no row", () => {
    const f = finnhub("AAA", PRINT);
    const n = nasdaq("AAA", PRINT);
    upsertEarningsIntel(db, {
      eventId: f,
      impliedMovePct: null,
      impliedMethod: null,
      expiryUsed: null,
      straddleMid: null,
      spot: 80,
      computedAt: PRICED_AT,
    });

    reconcileEarningsDates(db, { today: TODAY });

    expect(supersededOf(f)).toBe(1);
    expect(intelOf(n)).toBeUndefined();
  });
});
