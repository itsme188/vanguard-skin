import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSymbolStatus,
  getHeldStockSymbols,
} from "@/lib/queries/briefing-symbols";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// Migrations seed 3 default accounts (Vanguard Taxable, Vanguard Roth IRA,
// IBKR). Tests reuse those by name rather than INSERT-failing on UNIQUE.
function getAccount(name: string): number {
  const row = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (!row) throw new Error(`No account ${name} (default seed missing?)`);
  return row.id;
}

function seedSecurity(symbol: string, type = "stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, qty: number, asOf = "2026-04-28"): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(accountId, securityId, qty, asOf);
}

function seedWatchlist(securityId: number, active = 1): void {
  db.prepare(
    "INSERT INTO watchlist (security_id, is_active) VALUES (?, ?)",
  ).run(securityId, active);
}

function seedEarningsEvent(opts: {
  symbol: string;
  source: string;
  eventDate: string;
  weekOf: string;
  consensus?: string | null;
  releaseTime?: string;
  createdAt?: string;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, symbol,
        consensus_estimate, source_key, week_of, release_time, created_at)
       VALUES (?, 'earnings', ?, 'BMO', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.source,
      opts.eventDate,
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.consensus ?? null,
      `${opts.source}:${opts.symbol}:${opts.eventDate}`,
      opts.weekOf,
      opts.releaseTime ?? "08:00",
      opts.createdAt ?? "2026-04-27 12:00:00",
    ).lastInsertRowid as number;
}

describe("getSymbolStatus", () => {
  it("classifies held / watchlist / neither in one call", () => {
    const acct = getAccount("IBKR");
    const glwId = seedSecurity("GLW");
    const terId = seedSecurity("TER");
    const aaplId = seedSecurity("AAPL");
    seedSecurity("MSFT"); // exists but neither

    seedHolding(acct, glwId, 150);
    seedHolding(acct, terId, 70);
    seedWatchlist(aaplId);

    const status = getSymbolStatus(db, ["GLW", "TER", "AAPL", "MSFT", "ZZZZ"]);
    expect(status).toEqual({
      GLW: "held",
      TER: "held",
      AAPL: "watchlist",
      MSFT: "neither",
      ZZZZ: "neither",
    });
  });

  it("treats held + watchlist symbols as held (held wins)", () => {
    const acct = getAccount("IBKR");
    const glwId = seedSecurity("GLW");
    seedHolding(acct, glwId, 150);
    seedWatchlist(glwId); // also on watchlist

    const status = getSymbolStatus(db, ["GLW"]);
    expect(status.GLW).toBe("held");
  });

  it("ignores deactivated watchlist rows", () => {
    const aaplId = seedSecurity("AAPL");
    seedWatchlist(aaplId, 0); // is_active = 0
    expect(getSymbolStatus(db, ["AAPL"]).AAPL).toBe("neither");
  });

  it("is case-insensitive on input", () => {
    const acct = getAccount("IBKR");
    const glwId = seedSecurity("GLW");
    seedHolding(acct, glwId, 150);

    const status = getSymbolStatus(db, ["glw", "Glw"]);
    expect(status).toEqual({ GLW: "held" });
  });

  it("returns empty object for empty input", () => {
    expect(getSymbolStatus(db, [])).toEqual({});
  });

  it("ignores held positions with quantity = 0 (closed)", () => {
    const acct = getAccount("IBKR");
    const glwId = seedSecurity("GLW");
    seedHolding(acct, glwId, 0); // closed position
    expect(getSymbolStatus(db, ["GLW"]).GLW).toBe("neither");
  });
});

describe("getEarningsForWeekDeduped", () => {
  it("returns earnings events for the week ordered by date + time", () => {
    seedEarningsEvent({
      symbol: "GLW",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
      consensus: "EPS 0.70 · Rev 4.3B",
    });
    seedEarningsEvent({
      symbol: "KO",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
      consensus: "EPS 0.84 · Rev 12.6B",
    });
    seedEarningsEvent({
      symbol: "AAPL",
      source: "finnhub",
      eventDate: "2026-04-30",
      weekOf: "2026-04-27",
    });

    const events = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.symbol)).toEqual(["GLW", "KO", "AAPL"]);
  });

  it("prefers Finnhub over manual when both exist for the same event", () => {
    // Manual row inserted first (consensus blank), then Finnhub catches up
    const manualId = seedEarningsEvent({
      symbol: "TER",
      source: "manual",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
      consensus: null,
      createdAt: "2026-04-27 22:00:00",
    });
    const finnhubId = seedEarningsEvent({
      symbol: "TER",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
      consensus: "EPS 1.40 · Rev 750M",
      createdAt: "2026-04-28 06:00:00",
    });

    const events = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(finnhubId);
    expect(events[0].consensus_estimate).toBe("EPS 1.40 · Rev 750M");
    expect(manualId).toBeGreaterThan(0); // sanity: manual row was actually inserted
  });

  it("returns the manual row when only manual exists (no Finnhub coverage)", () => {
    seedEarningsEvent({
      symbol: "TER",
      source: "manual",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
      consensus: null,
    });
    const events = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("manual");
  });

  it("excludes non-earnings events from other types", () => {
    seedEarningsEvent({
      symbol: "GLW",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
    });
    db.prepare(
      `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, source_key, week_of)
       VALUES ('fred', 'cpi', '2026-04-29', '08:30', 'CPI release', 'fred:1:2026-04-29', '2026-04-27')`,
    ).run();
    const events = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(events).toHaveLength(1);
    expect(events[0].symbol).toBe("GLW");
  });

  it("returns empty array when the week has no earnings events", () => {
    expect(getEarningsForWeekDeduped(db, "2026-05-04")).toEqual([]);
  });

  it("getHeldStockSymbols still returns the all-accounts list for sanity", () => {
    const ibkr = getAccount("IBKR");
    const vt = getAccount("Vanguard Taxable");
    const a = seedSecurity("AAPL");
    const b = seedSecurity("MSFT");
    seedHolding(ibkr, a, 100);
    seedHolding(vt, b, 50);
    expect(getHeldStockSymbols(db).sort()).toEqual(["AAPL", "MSFT"]);
  });
});
