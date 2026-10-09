/**
 * The kept vendor figure (calendar_events.vendor_actual_value, migration 096)
 * follows the print across its twin rows.
 *
 * One print can carry several rows (finnhub / nasdaq / hand-entered). The row
 * that shows can change after a figure was hand-entered, and the reconciler
 * folds the hidden row's enrichment onto the showing one. The fold carried the
 * hand-entered actual and its stamp but not the vendor figure kept beside it,
 * so the recap scoreboard's vendor footnote was lost after a fold (Codex
 * review of the migration-096 commit, 2026-10-08).
 *
 * Rules pinned here:
 *   - the fold carries the donor's kept vendor figure together with the
 *     stamped actual it belongs to; written once, never overwritten;
 *   - a hidden row's own unstamped vendor actual is kept beside the showing
 *     row's different hand-entered one;
 *   - a hand-entered figure never lands in the column;
 *   - the read-side cluster heal resolves the kept figure the same way it
 *     resolves the stamp, so a reader does not depend on a fold having run.
 *
 * Synthetic tickers and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  createTwinFolder,
  reconcileEarningsDates,
  type TwinDonor,
} from "@/lib/calendar/reconcile-earnings-dates";
import { applyClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { getEventById } from "@/lib/queries/calendar";
import { renderHeadlineTable } from "@/lib/digest/send-earnings-email";

const DATE = "2020-01-07";
const WEEK = "2020-01-06";
const STAMP = "2020-01-07 21:30:00";
const HAND = "EPS 1.10 · Rev 510000000";
const HAND_2 = "EPS 1.12 · Rev 512000000";
const VENDOR = "EPS 1.02 · Rev 505,000,000";
const VENDOR_2 = "EPS 1.03 · Rev 506,000,000";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(opts: {
  source: string;
  symbol?: string;
  date?: string;
  actual?: string | null;
  stamp?: string | null;
  vendor?: string | null;
  superseded?: number;
}): number {
  const symbol = opts.symbol ?? "ZZA";
  const date = opts.date ?? DATE;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, source_key, event_type, event_date, week_of, event_time, title, symbol,
            consensus_estimate, actual_value, manual_actuals_at, vendor_actual_value,
            superseded, enriched_at)
         VALUES (?, ?, 'earnings', ?, ?, 'AMC', ?, ?, 'EPS 1.00 · Rev 500000000', ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.source,
        `${opts.source}:${symbol}:${date}`,
        date,
        WEEK,
        `${symbol} earnings`,
        symbol,
        opts.actual ?? null,
        opts.stamp ?? null,
        opts.vendor ?? null,
        opts.superseded ?? 0,
        opts.actual ? STAMP : null,
      ).lastInsertRowid,
  );
}

/** The donor exactly as the fold's callers read it: no vendor column. */
function donorRow(id: number): TwinDonor {
  return db
    .prepare(
      `SELECT id, consensus_estimate, consensus_value, actual_value, manual_actuals_at,
              reaction_snapshot, enriched_at
         FROM calendar_events WHERE source_key = (SELECT source_key FROM calendar_events WHERE id = ${id})`,
    )
    .get() as TwinDonor;
}

function stored(id: number) {
  return db
    .prepare(
      `SELECT actual_value AS actual, manual_actuals_at AS stamp, vendor_actual_value AS vendor
         FROM calendar_events WHERE source_key = (SELECT source_key FROM calendar_events WHERE id = ${id})`,
    )
    .get() as { actual: string | null; stamp: string | null; vendor: string | null };
}

// The fold's registry merge insists on a transaction, as every caller gives it.
const fold = (donorId: number, canonicalId: number) =>
  db.transaction(() => createTwinFolder(db)(donorRow(donorId), canonicalId, DATE))();

describe("twin fold: the kept vendor figure travels with the stamped actual", () => {
  it("an empty showing row adopts the hand-entered actual, its stamp and the kept vendor figure", () => {
    const donor = seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR });
    const canonical = seed({ source: "nasdaq" });
    fold(donor, canonical);
    expect(stored(canonical)).toEqual({ actual: HAND, stamp: STAMP, vendor: VENDOR });
  });

  it("a showing row that already shows the same hand-entered figure takes the kept vendor figure", () => {
    const donor = seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR });
    const canonical = seed({ source: "nasdaq", actual: HAND });
    fold(donor, canonical);
    expect(stored(canonical)).toEqual({ actual: HAND, stamp: STAMP, vendor: VENDOR });
  });

  it("written once: the showing row's own kept vendor figure is never overwritten", () => {
    const donor = seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR });
    const canonical = seed({ source: "nasdaq", actual: HAND, stamp: STAMP, vendor: VENDOR_2 });
    fold(donor, canonical);
    expect(stored(canonical).vendor).toBe(VENDOR_2);
  });

  it("a showing row that keeps a different vendor actual takes neither the stamp nor the kept figure", () => {
    const donor = seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR });
    const canonical = seed({ source: "nasdaq", actual: VENDOR_2 });
    fold(donor, canonical);
    expect(stored(canonical)).toEqual({ actual: VENDOR_2, stamp: null, vendor: null });
  });

  it("a stamped donor with nothing kept leaves the column empty", () => {
    const donor = seed({ source: "finnhub", actual: HAND, stamp: STAMP });
    const canonical = seed({ source: "nasdaq" });
    fold(donor, canonical);
    expect(stored(canonical)).toEqual({ actual: HAND, stamp: STAMP, vendor: null });
  });
});

describe("twin fold: a hidden row's own vendor actual beside a hand-entered one", () => {
  it("is kept on the showing row when that row carries a different hand-entered actual", () => {
    const donor = seed({ source: "finnhub", actual: VENDOR });
    const canonical = seed({ source: "manual", actual: HAND, stamp: STAMP });
    fold(donor, canonical);
    expect(stored(canonical)).toEqual({ actual: HAND, stamp: STAMP, vendor: VENDOR });
  });

  it("never replaces a figure already kept", () => {
    const donor = seed({ source: "finnhub", actual: VENDOR });
    const canonical = seed({ source: "manual", actual: HAND, stamp: STAMP, vendor: VENDOR_2 });
    fold(donor, canonical);
    expect(stored(canonical).vendor).toBe(VENDOR_2);
  });

  it("is not kept when the hidden row shows the same hand-entered figure with no stamp of its own", () => {
    const donor = seed({ source: "finnhub", actual: HAND });
    const canonical = seed({ source: "manual", actual: HAND, stamp: STAMP });
    fold(donor, canonical);
    expect(stored(canonical).vendor).toBeNull();
  });

  it("is not kept when the hidden row's figure is hand-entered on another twin of the print", () => {
    // The donor shows HAND_2 with no stamp of its own; a third row of the same
    // print carries the stamp for exactly that figure, so HAND_2 is not a
    // vendor figure.
    const donor = seed({ source: "finnhub", actual: HAND_2 });
    seed({ source: "nasdaq", actual: HAND_2, stamp: STAMP, superseded: 1 });
    const canonical = seed({ source: "manual", actual: HAND, stamp: STAMP });
    fold(donor, canonical);
    expect(stored(canonical).vendor).toBeNull();
  });

  it("an unstamped showing row keeps no second copy", () => {
    const donor = seed({ source: "finnhub", actual: VENDOR });
    const canonical = seed({ source: "nasdaq", actual: VENDOR_2 });
    fold(donor, canonical);
    expect(stored(canonical)).toEqual({ actual: VENDOR_2, stamp: null, vendor: null });
  });
});

describe("reconcile pass: the footnote survives the fold", () => {
  it("a hand-entered row that takes over the print keeps the vendor figure for the recap", () => {
    const feed = seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR });
    const manual = seed({ source: "manual" });
    reconcileEarningsDates(db, { today: DATE });

    const hidden = db
      .prepare("SELECT COALESCE(superseded, 0) AS s FROM calendar_events WHERE source = 'finnhub'")
      .get() as { s: number };
    expect(hidden.s).toBe(1);
    expect(feed).not.toBe(manual);
    expect(stored(manual)).toEqual({ actual: HAND, stamp: STAMP, vendor: VENDOR });

    const md = renderHeadlineTable(getEventById(db, manual)!, "ZZA", "recap");
    expect(md).toContain(
      "*Actuals basis: adjusted (worksheet or hand-entered figure). For reference, vendor figure (basis may differ): EPS 1.02 · Revenue $505.0M.*",
    );
  });
});

describe("read-side cluster heal: the kept vendor figure resolves like the stamp", () => {
  it("the showing row reads the stamp AND the kept figure off a hidden stamped twin", () => {
    const canonical = seed({ source: "nasdaq", actual: HAND });
    seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR, superseded: 1 });
    const event = getEventById(db, canonical)!;
    expect(event.manual_actuals_at).toBe(STAMP);
    expect(event.vendor_actual_value).toBe(VENDOR);
    // Read only: nothing is written to the row.
    expect(stored(canonical)).toEqual({ actual: HAND, stamp: null, vendor: null });
  });

  it("a row with its own stamp and nothing kept reads the twin's kept figure", () => {
    const canonical = seed({ source: "nasdaq", actual: HAND, stamp: STAMP });
    seed({ source: "finnhub", actual: HAND, stamp: "2020-01-07 20:00:00", vendor: VENDOR, superseded: 1 });
    const event = getEventById(db, canonical)!;
    expect(event.manual_actuals_at).toBe(STAMP);
    expect(event.vendor_actual_value).toBe(VENDOR);
  });

  it("the row's own kept figure wins", () => {
    const canonical = seed({ source: "nasdaq", actual: HAND, stamp: STAMP, vendor: VENDOR_2 });
    seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR, superseded: 1 });
    expect(getEventById(db, canonical)!.vendor_actual_value).toBe(VENDOR_2);
  });

  it("a twin stamped for a DIFFERENT figure lends nothing", () => {
    const canonical = seed({ source: "nasdaq", actual: VENDOR_2 });
    seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR, superseded: 1 });
    const event = getEventById(db, canonical)!;
    expect(event.manual_actuals_at).toBeNull();
    expect(event.vendor_actual_value).toBeNull();
  });

  it("another issuer or another date lends nothing", () => {
    const canonical = seed({ source: "nasdaq", actual: HAND });
    seed({ source: "finnhub", symbol: "ZZB", actual: HAND, stamp: STAMP, vendor: VENDOR });
    seed({ source: "finnhub", date: "2020-01-08", actual: HAND, stamp: STAMP, vendor: VENDOR });
    const event = getEventById(db, canonical)!;
    expect(event.manual_actuals_at).toBeNull();
    expect(event.vendor_actual_value).toBeNull();
  });

  it("a read shape that never selected the column is not given one", () => {
    seed({ source: "nasdaq", actual: HAND });
    seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR, superseded: 1 });
    const rows = db
      .prepare(
        `SELECT symbol, event_date, event_type, actual_value, manual_actuals_at
           FROM calendar_events WHERE source = 'nasdaq'`,
      )
      .all() as Array<Record<string, unknown>>;
    applyClusterManualActuals(db, rows);
    expect(rows[0].manual_actuals_at).toBe(STAMP);
    expect("vendor_actual_value" in rows[0]).toBe(false);
  });

  it("the snapshot's read (SELECT * over a window, healed in place) carries the kept figure", () => {
    const canonical = seed({ source: "nasdaq", actual: HAND });
    seed({ source: "finnhub", actual: HAND, stamp: STAMP, vendor: VENDOR, superseded: 1 });
    const rows = db
      .prepare("SELECT * FROM calendar_events WHERE event_date = ? ORDER BY id")
      .all(DATE) as Array<Record<string, unknown>>;
    applyClusterManualActuals(db, rows);
    const kept = rows.find((r) => r.id === canonical)!;
    expect(kept.manual_actuals_at).toBe(STAMP);
    expect(kept.vendor_actual_value).toBe(VENDOR);
  });
});
