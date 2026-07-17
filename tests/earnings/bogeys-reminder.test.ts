/**
 * Sunday-briefing bogeys reminder line (#11 A2).
 * Spec: .superpowers/sdd/task-2-brief.md
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { renderBogeysReminderLine } from "@/lib/earnings/bogeys-reminder";

const WEEK_OF = "2026-07-20"; // Monday

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const sec = Number(
    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-07-15', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

function seedWatchlist(symbol: string): number {
  const sec = Number(
    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  db.prepare(`INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)`).run(sec);
  return sec;
}

function seedEvent(opts: {
  symbol: string;
  date: string;
  superseded?: number;
}): number {
  return Number(
    db.prepare(
      `INSERT INTO calendar_events
        (source, event_type, event_date, title, symbol, source_key, week_of, superseded)
       VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.date,
      `${opts.symbol} earnings`,
      opts.symbol,
      `finnhub:${opts.symbol}:${opts.date}`,
      WEEK_OF,
      opts.superseded ?? 0,
    ).lastInsertRowid,
  );
}

function addBogey(eventId: number, sourceLabel = "manual entry") {
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
     VALUES (?, 'manual', ?, 1.23)`,
  ).run(eventId, sourceLabel);
}

describe("renderBogeysReminderLine", () => {
  it("returns null when fewer than 3 held/watchlist reporters have events in the window", () => {
    seedHeld("AAA");
    seedHeld("BBB");
    seedEvent({ symbol: "AAA", date: "2026-07-21" });
    seedEvent({ symbol: "BBB", date: "2026-07-22" });

    expect(renderBogeysReminderLine(db, WEEK_OF)).toBeNull();
  });

  it("returns a reminder line when >=3 held/watchlist reporters have events in [weekOf, weekOf+4d] and none have bogeys", () => {
    seedHeld("AAA");
    seedHeld("BBB");
    seedWatchlist("CCC");
    seedEvent({ symbol: "AAA", date: "2026-07-20" });
    seedEvent({ symbol: "BBB", date: "2026-07-22" });
    seedEvent({ symbol: "CCC", date: "2026-07-24" }); // weekOf+4d, still in window

    const line = renderBogeysReminderLine(db, WEEK_OF);
    expect(line).not.toBeNull();
    expect(line).toContain("3");
    expect(line).toContain("AAA");
    expect(line).toContain("BBB");
    expect(line).toContain("CCC");
  });

  it("returns null when ANY of the week's qualifying events already has a bogey", () => {
    seedHeld("AAA");
    seedHeld("BBB");
    const ccc = seedWatchlist("CCC");
    seedEvent({ symbol: "AAA", date: "2026-07-20" });
    seedEvent({ symbol: "BBB", date: "2026-07-21" });
    const cccEvent = seedEvent({ symbol: "CCC", date: "2026-07-22" });
    void ccc;
    addBogey(cccEvent);

    expect(renderBogeysReminderLine(db, WEEK_OF)).toBeNull();
  });

  it("excludes events outside [weekOf, weekOf+4d]", () => {
    seedHeld("AAA");
    seedHeld("BBB");
    seedHeld("CCC");
    seedEvent({ symbol: "AAA", date: "2026-07-20" });
    seedEvent({ symbol: "BBB", date: "2026-07-21" });
    // Outside the window (weekOf+4d = 2026-07-24)
    seedEvent({ symbol: "CCC", date: "2026-07-25" });

    expect(renderBogeysReminderLine(db, WEEK_OF)).toBeNull();
  });

  it("excludes symbols that are neither held nor watchlisted", () => {
    seedHeld("AAA");
    seedHeld("BBB");
    // DDD has an event but no holding/watchlist row.
    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('DDD', 'DDD', 'Stock')`).run();
    seedEvent({ symbol: "AAA", date: "2026-07-20" });
    seedEvent({ symbol: "BBB", date: "2026-07-21" });
    seedEvent({ symbol: "DDD", date: "2026-07-22" });

    expect(renderBogeysReminderLine(db, WEEK_OF)).toBeNull();
  });

  it("excludes superseded calendar events", () => {
    seedHeld("AAA");
    seedHeld("BBB");
    seedHeld("CCC");
    seedEvent({ symbol: "AAA", date: "2026-07-20" });
    seedEvent({ symbol: "BBB", date: "2026-07-21" });
    seedEvent({ symbol: "CCC", date: "2026-07-22", superseded: 1 });

    expect(renderBogeysReminderLine(db, WEEK_OF)).toBeNull();
  });

  it("names only up to 5 symbols but the count reflects the full reporter set", () => {
    for (const sym of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]) {
      seedHeld(sym);
      seedEvent({ symbol: sym, date: "2026-07-21" });
    }

    const line = renderBogeysReminderLine(db, WEEK_OF);
    expect(line).not.toBeNull();
    expect(line).toContain("6");
    for (const sym of ["AAA", "BBB", "CCC", "DDD", "EEE"]) {
      expect(line).toContain(sym);
    }
  });

  it("is family-aware — a GOOGL event counts toward a GOOG holding", () => {
    seedHeld("GOOG");
    seedHeld("AAA");
    seedHeld("BBB");
    seedEvent({ symbol: "GOOGL", date: "2026-07-20" });
    seedEvent({ symbol: "AAA", date: "2026-07-21" });
    seedEvent({ symbol: "BBB", date: "2026-07-22" });

    const line = renderBogeysReminderLine(db, WEEK_OF);
    expect(line).not.toBeNull();
    expect(line).toContain("3");
  });
});
