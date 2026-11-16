/**
 * A kept earnings row never borrows a PER-SHARE figure from a share class on
 * another per-share basis (QA: a dual-class issuer whose Class A share is a
 * large fixed multiple of its Class B share; the kept Class A row showed the
 * Class B EPS consensus under the Class A symbol).
 *
 * The duplicate check folds every row of a print into the kept row and the
 * Finnhub carrier copies vendor data onto it. Between classes on DIFFERENT
 * per-share bases (`samePerShareBasis`, lib/securities/issuer-family.ts) only
 * what is not per-share travels: the revenue estimate, the fiscal quarter,
 * the vendor symbol. The EPS estimate, the EPS surprise history and the
 * description that prints it stay with the class they describe. Classes on
 * one basis (GOOG / GOOGL) and the same symbol keep today's behaviour.
 *
 * Synthetic rows, invented round figures. The family is one the issuer table
 * knows, because the rule reads that table.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { insertCalendarEvent, upsertCalendarEvents } from "@/lib/mutations/calendar";
import { mondayOf } from "@/lib/calendar/date-utils";
import { consensusRowStep } from "@/lib/earnings/prepare-steps/consensus-row";
import { samePerShareBasis } from "@/lib/securities/issuer-family";

const TODAY = "2026-11-02"; // Monday
const PRINT = "2026-11-05";
const ctx = { now: () => Date.now(), signal: new AbortController().signal };

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const idOf = (sourceKey: string): number =>
  (db.prepare("SELECT id FROM calendar_events WHERE source_key = ?").get(sourceKey) as { id: number }).id;

interface Row {
  symbol: string;
  superseded: number;
  consensus_estimate: string | null;
  consensus_value: string | null;
  description: string | null;
  raw_json: string | null;
}
const rowOf = (id: number) =>
  db
    .prepare(
      `SELECT symbol, COALESCE(superseded, 0) AS superseded, consensus_estimate, consensus_value,
              description, raw_json
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as Row;
const jsonOf = (id: number) => JSON.parse(rowOf(id).raw_json ?? "null");

/** A Nasdaq earnings row as lib/calendar/nasdaq.ts assembles it. */
function nasdaq(symbol: string, date: string, hour: "bmo" | "amc" | null, epsForecast: number | null): number {
  upsertCalendarEvents(db, [
    {
      source: "nasdaq",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      consensus_estimate: epsForecast != null ? `EPS ${epsForecast.toFixed(2)}` : null,
      raw_json: JSON.stringify({ entry: { hour, epsForecast, epsActual: null }, nasdaq_symbol: symbol }),
      source_key: `nasdaq:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`nasdaq:${symbol}:${date}`);
}

/** A Finnhub earnings row as lib/calendar/finnhub.ts assembles it (no slot). */
function finnhub(symbol: string, date: string, eps: number, rev: number): number {
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: "Q3 2026 report.\n\nLast 4 quarters (EPS):\n  - Q2 2026: actual 5.50 vs est 5.00 (surprise 10.0%)",
      symbol,
      consensus_estimate: `EPS ${eps.toFixed(2)} · Rev ${rev.toLocaleString("en-US")}`,
      raw_json: JSON.stringify({
        entry: {
          date,
          epsActual: null,
          epsEstimate: eps,
          quarter: 3,
          revenueActual: null,
          revenueEstimate: rev,
          symbol,
          year: 2026,
        },
        history: [{ quarter: 2, year: 2026, actual: 5.5, estimate: 5, surprisePercent: 10 }],
        finnhub_symbol: symbol,
      }),
      source_key: `finnhub:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`finnhub:${symbol}:${date}`);
}

describe("samePerShareBasis", () => {
  it("one class written two ways is one basis; the two Berkshire-style classes are not", () => {
    expect(samePerShareBasis("BRK.A", "BRK A")).toBe(true);
    expect(samePerShareBasis("brk.b", "BRK/B")).toBe(true);
    expect(samePerShareBasis("BRK.A", "BRK.B")).toBe(false);
  });

  it("classes the table keeps on one basis, the same symbol, and unrelated symbols", () => {
    expect(samePerShareBasis("GOOG", "GOOGL")).toBe(true);
    expect(samePerShareBasis("ZZA", "zza")).toBe(true);
    expect(samePerShareBasis("ZZA", "ZZB")).toBe(false);
    expect(samePerShareBasis(null, "ZZA")).toBe(false);
  });
});

describe("the fold between share classes on different per-share bases", () => {
  it("a kept Class A row with no forecast of its own does not take the Class B EPS", () => {
    const a = nasdaq("BRK.A", PRINT, "bmo", null);
    const b = nasdaq("BRK.B", PRINT, "bmo", 5);
    db.prepare("UPDATE calendar_events SET consensus_value = ? WHERE id = ?").run("EPS 5.00 · Rev 90,000,000,000", b);

    reconcileEarningsDates(db, { today: TODAY });

    // Precondition: the Class A row kept the print (as in the reported case).
    expect(rowOf(a).superseded).toBe(0);
    expect(rowOf(b).superseded).toBe(1);
    // No EPS crosses the class line; a revenue figure (one company, one
    // revenue) still does.
    expect(rowOf(a).consensus_estimate).toBeNull();
    expect(rowOf(a).consensus_value).toBe("Rev 90000000000");
    // The hidden row keeps its own figures.
    expect(rowOf(b).consensus_estimate).toBe("EPS 5.00");
  });

  it("a hand-entered Class A row beside a hidden Class B vendor row takes no EPS", () => {
    nasdaq("BRK.B", PRINT, "bmo", 5);
    const m = insertCalendarEvent(db, { symbol: "BRK.A", event_date: PRINT, event_time: "BMO", week_of: mondayOf(PRINT) }).id;

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).superseded).toBe(0);
    expect(rowOf(m).consensus_estimate).toBeNull();
    expect(rowOf(m).consensus_value).toBeNull();
  });

  it("the same class written another way still carries its EPS", () => {
    nasdaq("BRK A", PRINT, "bmo", 7500);
    const m = insertCalendarEvent(db, { symbol: "BRK.A", event_date: PRINT, event_time: "BMO", week_of: mondayOf(PRINT) }).id;

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).superseded).toBe(0);
    expect(rowOf(m).consensus_estimate).toBe("EPS 7500.00");
  });

  it("classes on one basis keep today's behaviour: the EPS is carried", () => {
    nasdaq("GOOGL", PRINT, "amc", 2);
    const m = insertCalendarEvent(db, { symbol: "GOOG", event_date: PRINT, event_time: "AMC", week_of: mondayOf(PRINT) }).id;

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).superseded).toBe(0);
    expect(rowOf(m).consensus_estimate).toBe("EPS 2.00");
  });
});

describe("the Finnhub carrier and the consensus prepare step across per-share bases", () => {
  function keptClassAOverHiddenClassB(): { a: number; f: number } {
    const f = finnhub("BRK.B", PRINT, 5, 90_000_000_000);
    const a = nasdaq("BRK.A", PRINT, "bmo", null);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(f).superseded).toBe(1);
    expect(rowOf(a).superseded).toBe(0);
    return { a, f };
  }

  it("carries the revenue estimate and the fiscal quarter, never the EPS estimate, the EPS history or its description", () => {
    const { a } = keptClassAOverHiddenClassB();
    const j = jsonOf(a);
    expect(j.entry).toMatchObject({ revenueEstimate: 90_000_000_000, quarter: 3, year: 2026, symbol: "BRK.B" });
    expect(j.entry).not.toHaveProperty("epsEstimate");
    expect(j).not.toHaveProperty("history");
    expect(rowOf(a).description).toBeNull();
    expect(rowOf(a).consensus_estimate).toBe("Rev 90000000000");
    // A second pass writes nothing new.
    const before = rowOf(a);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(a)).toEqual(before);
  });

  it("the prepare step's vendor bogey takes the revenue, never the other class's EPS", async () => {
    const { a } = keptClassAOverHiddenClassB();
    expect(await consensusRowStep.run(db, a, ctx)).toEqual({ status: "done" });
    const bogey = db
      .prepare(
        `SELECT eps_consensus, eps_consensus_vendor, revenue_consensus_usd
           FROM earnings_bogeys WHERE event_id = ? AND source = 'finnhub'`,
      )
      .get(a);
    expect(bogey).toEqual({ eps_consensus: null, eps_consensus_vendor: null, revenue_consensus_usd: 90_000_000_000 });
  });
});
