import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

interface SeedRow {
  source: string;
  symbol: string;
  date: string;
  epsActual?: number | null;
  actualValue?: string | null;
  dateStatus?: string | null;
}

function seed(r: SeedRow): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, actual_value, date_status, raw_json)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.source,
      r.date,
      `${r.symbol} earnings`,
      r.symbol,
      `${r.source}:${r.symbol}:${r.date}`,
      r.actualValue ?? null,
      r.dateStatus ?? null,
      JSON.stringify({ entry: { epsActual: r.epsActual ?? null } }),
    ).lastInsertRowid as number;
}

function row(id: number) {
  return db
    .prepare(
      "SELECT source, event_date, date_status, date_conflict_with, superseded FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    source: string;
    event_date: string;
    date_status: string | null;
    date_conflict_with: string | null;
    superseded: number;
  };
}

const TODAY = "2026-06-08";

describe("reconcileEarningsDates", () => {
  it("marks confirmed when both sources agree on a future date", () => {
    const f = seed({ source: "finnhub", symbol: "AAPL", date: "2026-06-12" });
    const n = seed({ source: "nasdaq", symbol: "AAPL", date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(f).date_status).toBe("confirmed");
    expect(row(f).superseded).toBe(0);
    expect(row(n).superseded).toBe(1); // duplicate of the canonical row
  });

  it("flags a future-vs-future disagreement as conflict, Nasdaq provisional", () => {
    const f = seed({ source: "finnhub", symbol: "NVDA", date: "2026-06-11" });
    const n = seed({ source: "nasdaq", symbol: "NVDA", date: "2026-06-13" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(n).date_status).toBe("conflict");
    expect(row(n).superseded).toBe(0); // Nasdaq is the provisional canonical
    expect(row(n).date_conflict_with).toBe("finnhub:2026-06-11");
    expect(row(f).superseded).toBe(1);
  });

  it("auto-resolves a past-with-actuals date over a future ghost (the RBRK case)", () => {
    // Finnhub says Mon Jun 8 (future ghost); Nasdaq says Thu Jun 4 with a
    // reported actual → demonstrably happened, so Jun 4 wins silently.
    const ghost = seed({ source: "finnhub", symbol: "RBRK", date: "2026-06-08" });
    const real = seed({ source: "nasdaq", symbol: "RBRK", date: "2026-06-04", epsActual: -0.19 });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(real).date_status).toBe("confirmed");
    expect(row(real).superseded).toBe(0);
    expect(row(ghost).superseded).toBe(1); // ghost dies → drops off "this week"
  });

  it("marks single when only one source has the name", () => {
    const f = seed({ source: "finnhub", symbol: "TSLA", date: "2026-06-12" });
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(f).date_status).toBe("single");
    expect(row(f).superseded).toBe(0);
  });

  it("locks a user-confirmed/manual date and supersedes conflicting sync rows, idempotently", () => {
    const manual = seed({ source: "manual", symbol: "META", date: "2026-06-10", dateStatus: "user_confirmed" });
    const finn = seed({ source: "finnhub", symbol: "META", date: "2026-06-15" });

    reconcileEarningsDates(db, { today: TODAY });
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(manual).superseded).toBe(0);
    expect(row(manual).event_date).toBe("2026-06-10"); // user date untouched
    expect(row(finn).superseded).toBe(1);

    // Re-run (simulating the next sync) must not revert anything.
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(manual).event_date).toBe("2026-06-10");
    expect(row(finn).superseded).toBe(1);
  });

  it("clusters dual-class siblings (GOOG/GOOGL) as one event", () => {
    const goog = seed({ source: "finnhub", symbol: "GOOG", date: "2026-06-12" });
    const googl = seed({ source: "nasdaq", symbol: "GOOGL", date: "2026-06-12" });
    reconcileEarningsDates(db, { today: TODAY });
    // Same event, agreeing date → confirmed + one superseded.
    const states = [row(goog), row(googl)];
    expect(states.filter((s) => s.superseded === 0)).toHaveLength(1);
    expect(states.find((s) => s.superseded === 0)!.date_status).toBe("confirmed");
  });
});
