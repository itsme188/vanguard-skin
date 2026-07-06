import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findEarningsCoverageGaps,
  renderCoverageGapsBlock,
  getCoverageGuardIgnoredSymbols,
  wasCoveragePushSentToday,
  markCoveragePushSent,
} from "@/lib/calendar/coverage-guard";

const TODAY = "2026-07-05";

function insertAccount(db: Database.Database, name = "Test Account"): number {
  const r = db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(name);
  return Number(r.lastInsertRowid);
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  securityType = "stock",
): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)`,
    )
    .run(symbol, symbol, securityType);
  return Number(r.lastInsertRowid);
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate = "2026-07-01",
): number {
  const r = db
    .prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      accountId,
      securityId,
      quantity,
      asOfDate,
      `test:${accountId}:${securityId}:${asOfDate}`,
    );
  return Number(r.lastInsertRowid);
}

function insertOptionHolding(
  db: Database.Database,
  accountId: number,
  underlyingSymbol: string,
  quantity: number,
  expirationDate = "2027-01-15",
): number {
  const optSymbol = `${underlyingSymbol}  270115C00120000`;
  const secId = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, expiration_date, multiplier)
       VALUES (?, ?, 'option', ?, ?, 100)`,
    )
    .run(optSymbol, optSymbol, underlyingSymbol, expirationDate).lastInsertRowid as number;
  insertHolding(db, accountId, Number(secId), quantity);
  return Number(secId);
}

function insertWatchlist(
  db: Database.Database,
  securityId: number,
  isActive = 1,
): number {
  const r = db
    .prepare(`INSERT INTO watchlist (security_id, is_active) VALUES (?, ?)`)
    .run(securityId, isActive);
  return Number(r.lastInsertRowid);
}

let eventCounter = 0;
function insertEarningsEvent(
  db: Database.Database,
  symbol: string,
  eventDate: string,
  opts: { superseded?: number } = {},
): number {
  eventCounter++;
  const r = db
    .prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, title, symbol, superseded)
       VALUES ('finnhub', ?, 'earnings', ?, ?, ?, ?)`,
    )
    .run(
      `finnhub:${symbol}:${eventDate}:${eventCounter}`,
      eventDate,
      `${symbol} earnings`,
      symbol,
      opts.superseded ?? 0,
    );
  return Number(r.lastInsertRowid);
}

describe("findEarningsCoverageGaps", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("flags a held stock whose last report is >75d old with nothing scheduled in 45d", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "AAPL");
    insertHolding(db, acct, sec, 100);
    insertEarningsEvent(db, "AAPL", "2026-04-10"); // 86d before today

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([
      { symbol: "AAPL", kind: "due_no_event", lastEventDate: "2026-04-10", daysSinceLast: 86 },
    ]);
  });

  it("stays quiet for a name that just reported (last event 30d ago)", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "NVDA");
    insertHolding(db, acct, sec, 50);
    insertEarningsEvent(db, "NVDA", "2026-06-05"); // 30d before today

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([]);
  });

  it("stays quiet when a FUTURE event exists within 45d (superseded=0)", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "MSFT");
    insertHolding(db, acct, sec, 20);
    insertEarningsEvent(db, "MSFT", "2026-07-20"); // future, within horizon, not superseded

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([]);
  });

  it("a superseded future event does NOT count as coverage", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "JPM");
    insertHolding(db, acct, sec, 40);
    insertEarningsEvent(db, "JPM", "2026-03-01"); // stale past event, 126d ago
    insertEarningsEvent(db, "JPM", "2026-07-20", { superseded: 1 }); // future but superseded

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([
      { symbol: "JPM", kind: "due_no_event", lastEventDate: "2026-03-01", daysSinceLast: 126 },
    ]);
  });

  it("a sibling's event covers the family (held GOOG, future GOOGL event)", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "GOOG");
    insertHolding(db, acct, sec, 10);
    insertEarningsEvent(db, "GOOGL", "2026-07-15"); // sibling symbol, future within horizon

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([]);
  });

  it("no-history names get kind no_history", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "ZOOM");
    insertHolding(db, acct, sec, 15);
    // zero earnings events ever

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([
      { symbol: "ZOOM", kind: "no_history", lastEventDate: null, daysSinceLast: null },
    ]);
  });

  it("watchlist stocks are candidates too", () => {
    const sec = insertSecurity(db, "WLST");
    insertWatchlist(db, sec);
    insertEarningsEvent(db, "WLST", "2026-04-01"); // stale, no future event

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([
      { symbol: "WLST", kind: "due_no_event", lastEventDate: "2026-04-01", daysSinceLast: 95 },
    ]);
  });

  it("short positions (quantity < 0) are candidates", () => {
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "TSLA");
    insertHolding(db, acct, sec, -300);
    insertEarningsEvent(db, "TSLA", "2026-04-01"); // stale, no future event

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([
      { symbol: "TSLA", kind: "due_no_event", lastEventDate: "2026-04-01", daysSinceLast: 95 },
    ]);
  });

  it("ETFs and options are never candidates", () => {
    const acct = insertAccount(db);
    const etf = insertSecurity(db, "VOO", "ETF");
    const opt = insertSecurity(db, "AAPL  260320C00200000", "Option");
    insertHolding(db, acct, etf, 100);
    insertHolding(db, acct, opt, 5);
    // no earnings events for either — would be a gap if they were candidates

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([]);
  });

  it("an option-only underlying (no stock position) with no earnings history is a no_history gap", () => {
    const acct = insertAccount(db);
    insertOptionHolding(db, acct, "TER", 2); // LEAP, no TER stock held
    // zero earnings events ever for TER

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([
      { symbol: "TER", kind: "no_history", lastEventDate: null, daysSinceLast: null },
    ]);
  });

  it("ignored symbols are excluded", () => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('coverage_guard_ignored_symbols', '["402340"]')`,
    ).run();
    const acct = insertAccount(db);
    const sec = insertSecurity(db, "402340");
    insertHolding(db, acct, sec, 100);
    // no earnings history at all — would be a no_history gap if not ignored

    const gaps = findEarningsCoverageGaps(db, { today: TODAY });

    expect(gaps).toEqual([]);
  });
});

describe("getCoverageGuardIgnoredSymbols", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns [] when the settings table has no row for the key", () => {
    expect(getCoverageGuardIgnoredSymbols(db)).toEqual([]);
  });

  it("returns [] when the settings table is absent", () => {
    const bareDb = new Database(":memory:");
    expect(getCoverageGuardIgnoredSymbols(bareDb)).toEqual([]);
  });

  it("parses and uppercases a JSON array", () => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('coverage_guard_ignored_symbols', '["abc", "xyz"]')`,
    ).run();
    expect(getCoverageGuardIgnoredSymbols(db)).toEqual(["ABC", "XYZ"]);
  });

  it("returns [] for malformed JSON", () => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('coverage_guard_ignored_symbols', 'not json')`,
    ).run();
    expect(getCoverageGuardIgnoredSymbols(db)).toEqual([]);
  });
});

describe("coverage guard push dedup", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("wasCoveragePushSentToday is false when no push has ever been recorded", () => {
    expect(wasCoveragePushSentToday(db, TODAY)).toBe(false);
  });

  it("markCoveragePushSent then wasCoveragePushSentToday for the same day is true", () => {
    markCoveragePushSent(db, TODAY);
    expect(wasCoveragePushSentToday(db, TODAY)).toBe(true);
  });

  it("a push recorded on a prior day does not count as sent today", () => {
    markCoveragePushSent(db, "2026-07-04");
    expect(wasCoveragePushSentToday(db, TODAY)).toBe(false);
  });
});

describe("renderCoverageGapsBlock", () => {
  it("returns empty string for no gaps", () => {
    expect(renderCoverageGapsBlock([])).toBe("");
  });

  it("renders due and no-history lines under a ## heading", () => {
    const out = renderCoverageGapsBlock([
      { symbol: "JPM", kind: "due_no_event", lastEventDate: "2026-04-11", daysSinceLast: 85 },
      { symbol: "XYZ", kind: "no_history", lastEventDate: null, daysSinceLast: null },
    ]);
    expect(out).toContain("## Earnings coverage gaps");
    expect(out).toContain(
      "**JPM** — last report 2026-04-11 (85d ago); nothing scheduled in the next 45 days",
    );
    expect(out).toContain("**XYZ** — no earnings history in the calendar; verify coverage");
  });
});
