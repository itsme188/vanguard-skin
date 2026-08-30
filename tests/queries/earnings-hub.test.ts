import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSymbolStatus,
  getHeldStockSymbols,
  getHeldOptionUnderlyingSymbols,
} from "@/lib/queries/briefing-symbols";
import { getEarningsForWeekDeduped, countEarningsDateConflicts } from "@/lib/queries/calendar";
import { getSentPhasesForEvents } from "@/lib/queries/earnings-emails";

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

function seedOption(
  symbol: string,
  underlyingSymbol: string,
  expirationDate: string | null,
): number {
  return db
    .prepare(
      `INSERT INTO securities
       (symbol, name, security_type, asset_class, multiplier, underlying_symbol, expiration_date)
       VALUES (?, ?, 'Option', 'option', 100, ?, ?)`,
    )
    .run(symbol, `${symbol} Option`, underlyingSymbol, expirationDate)
    .lastInsertRowid as number;
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

  it("a short-only stock position confers held status (quantity != 0)", () => {
    const acct = getAccount("IBKR");
    const tslaId = seedSecurity("TSLA");
    seedHolding(acct, tslaId, -300); // short, latest row for (account, security)
    expect(getSymbolStatus(db, ["TSLA"])).toEqual({ TSLA: "held" });
  });

  it("classifies a symbol held only via options as held", () => {
    const acct = getAccount("IBKR");
    const optId = seedOption("TER   270115C00120000", "TER", "2027-01-15"); // ~1yr out
    seedHolding(acct, optId, 2);
    expect(getSymbolStatus(db, ["TER"])).toEqual({ TER: "held" });
  });

  it("an EXPIRED option does not confer held status", () => {
    const acct = getAccount("IBKR");
    const optId = seedOption("TER   200115C00120000", "TER", "2020-01-15"); // long expired
    seedHolding(acct, optId, 2);
    expect(getSymbolStatus(db, ["TER"])).toEqual({ TER: "neither" });
  });

  it("a short option position confers held status (quantity != 0)", () => {
    const acct = getAccount("IBKR");
    const optId = seedOption("TER   270115P00120000", "TER", "2027-01-15");
    seedHolding(acct, optId, -3); // short
    expect(getSymbolStatus(db, ["TER"])).toEqual({ TER: "held" });
  });

  it("option underlying matches via issuer family", () => {
    const acct = getAccount("IBKR");
    // Option on GOOGL; query GOOG (same issuer family) should resolve held.
    const optId = seedOption("GOOGL 270115C00150000", "GOOGL", "2027-01-15");
    seedHolding(acct, optId, 1);
    expect(getSymbolStatus(db, ["GOOG"])).toEqual({ GOOG: "held" });
  });
});

describe("getHeldOptionUnderlyingSymbols", () => {
  it("returns distinct unexpired option underlyings, uppercased", () => {
    const acct = getAccount("IBKR");
    const terOpt = seedOption("TER   270115C00120000", "ter", "2027-01-15");
    const glwOpt = seedOption("GLW   270115P00030000", "GLW", "2027-01-15");
    seedHolding(acct, terOpt, 2);
    seedHolding(acct, glwOpt, -1); // short still counts
    expect(getHeldOptionUnderlyingSymbols(db).sort()).toEqual(["GLW", "TER"]);
  });

  it("excludes expired options and zero-quantity holdings", () => {
    const acct = getAccount("IBKR");
    const expiredOpt = seedOption("TER   200115C00120000", "TER", "2020-01-15");
    const closedOpt = seedOption("GLW   270115P00030000", "GLW", "2027-01-15");
    seedHolding(acct, expiredOpt, 2);
    seedHolding(acct, closedOpt, 0);
    expect(getHeldOptionUnderlyingSymbols(db)).toEqual([]);
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

  it("excludes superseded rows and surfaces date_status / date_conflict_with", () => {
    // Canonical (Nasdaq) conflict row + a superseded (Finnhub) ghost.
    const canonical = seedEarningsEvent({
      symbol: "NVDA",
      source: "nasdaq",
      eventDate: "2026-04-29",
      weekOf: "2026-04-27",
    });
    const ghost = seedEarningsEvent({
      symbol: "NVDA",
      source: "finnhub",
      eventDate: "2026-04-30",
      weekOf: "2026-04-27",
    });
    db.prepare("UPDATE calendar_events SET date_status='conflict', date_conflict_with='finnhub:2026-04-30' WHERE id=?").run(canonical);
    db.prepare("UPDATE calendar_events SET superseded=1 WHERE id=?").run(ghost);

    const events = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(events).toHaveLength(1);
    expect(events[0].event_date).toBe("2026-04-29");
    expect(events[0].date_status).toBe("conflict");
    expect(events[0].date_conflict_with).toBe("finnhub:2026-04-30");
  });

  it("surfaces manual_actuals_at — null by default, the stamped value after a manual save", () => {
    const eventId = seedEarningsEvent({
      symbol: "TER",
      source: "manual",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
    });

    const before = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(before).toHaveLength(1);
    expect(before[0].manual_actuals_at).toBeNull();

    db.prepare(
      "UPDATE calendar_events SET actual_value = 'EPS -1.20', manual_actuals_at = '2026-04-28 12:00:00' WHERE id = ?",
    ).run(eventId);

    const after = getEarningsForWeekDeduped(db, "2026-04-27");
    expect(after).toHaveLength(1);
    expect(after[0].manual_actuals_at).toBe("2026-04-28 12:00:00");
  });

  it("countEarningsDateConflicts counts only in-window, non-superseded conflicts", () => {
    const mkConflict = (sym: string, date: string, superseded = 0) => {
      const id = seedEarningsEvent({ symbol: sym, source: "nasdaq", eventDate: date, weekOf: "2026-06-08" });
      db.prepare("UPDATE calendar_events SET date_status='conflict', superseded=? WHERE id=?").run(superseded, id);
    };
    mkConflict("NVDA", "2026-06-11"); // in window
    mkConflict("AMD", "2026-06-13"); // in window
    mkConflict("OLD", "2026-05-01"); // out of window (before today)
    mkConflict("SUP", "2026-06-12", 1); // superseded → excluded

    expect(countEarningsDateConflicts(db, "2026-06-08")).toBe(2);
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

  it("getHeldStockSymbols surfaces a statement-lag holding: a security whose only row is older than another security's newer row in the same account", () => {
    // Per-(account, security) "latest" keying (latestHoldingsPredicate) must
    // not drop AAPL just because MSFT's row in the same account is newer —
    // a per-account global MAX(as_of_date) would compute IBKR's max as
    // 2025-02-28 (from MSFT) and silently exclude AAPL's only row.
    const ibkr = getAccount("IBKR");
    const a = seedSecurity("AAPL");
    const b = seedSecurity("MSFT");
    seedHolding(ibkr, a, 100, "2025-01-31");
    seedHolding(ibkr, b, 50, "2025-02-28");
    expect(getHeldStockSymbols(db).sort()).toEqual(["AAPL", "MSFT"]);
  });
});

describe("EarningsHub chip source — getSentPhasesForEvents tri-state filter", () => {
  // EarningsHub.tsx renders previewSent/recapSent chips from this query
  // (replacing a pre-existing inline SELECT that had no tri-state filter,
  // see final-review fix pass). A live/stale 'in_progress' claim must NOT
  // render as "sent" — only a completed local send or a 'sent-by-cloud'
  // Worker delivery should.
  it("excludes a live 'in_progress' claim row from the sent set", () => {
    const eventId = seedEarningsEvent({
      symbol: "GLW",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
    });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, 'preview', 'user@example.com', datetime('now'), NULL, NULL, 'in_progress')`,
    ).run(eventId);

    const result = getSentPhasesForEvents(db, [eventId]);
    expect(result[eventId]?.preview ?? false).toBe(false);
  });

  it("counts a 'sent-by-cloud' row as sent", () => {
    const eventId = seedEarningsEvent({
      symbol: "GLW",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
    });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'cloud-fallback', NULL, 'sent-by-cloud')`,
    ).run(eventId);

    const result = getSentPhasesForEvents(db, [eventId]);
    expect(result[eventId]?.preview).toBe(true);
  });

  it("counts a completed local send (error NULL) as sent", () => {
    const eventId = seedEarningsEvent({
      symbol: "GLW",
      source: "finnhub",
      eventDate: "2026-04-28",
      weekOf: "2026-04-27",
    });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'recap', 'user@example.com', '# recap prose', NULL)`,
    ).run(eventId);

    const result = getSentPhasesForEvents(db, [eventId]);
    expect(result[eventId]?.recap).toBe(true);
  });
});
