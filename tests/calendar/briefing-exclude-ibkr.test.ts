import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getBriefingHoldings,
  buildCombinedPositionsForEvents,
  getExpiringOptions,
} from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";

// Migration 002 seeds default accounts:
//   Vanguard Taxable (id=1), Vanguard Roth IRA (id=2), IBKR (id=3).
const VANGUARD_TAXABLE = 1;
const VANGUARD_ROTH = 2;
const IBKR = 3;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedStock(symbol: string, sector?: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, sector, multiplier) VALUES (?, ?, 'stock', 'equity', ?, 1)",
    )
    .run(symbol, `${symbol} Corp`, sector ?? null);
  return r.lastInsertRowid as number;
}

function seedEtf(symbol: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'ETF', 'equity', 1)",
    )
    .run(symbol, `${symbol} ETF`);
  return r.lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  strike: number,
  exp: string,
): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
       VALUES (?, ?, 'option', 'option', 100, ?, ?, ?, 'PUT')`,
    )
    .run(symbol, `${underlying} option`, underlying, strike, exp);
  return r.lastInsertRowid as number;
}

function seedHolding(
  secId: number,
  accountId: number,
  qty: number,
  asOfDate = "2026-06-15",
): void {
  db.prepare(
    "INSERT INTO holdings (security_id, account_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(secId, accountId, qty, asOfDate);
}

describe("getBriefingHoldings — IBKR exclusion (U4: 'holds QQQ outright' bug)", () => {
  it("excludes a position held ONLY in IBKR (the QQQ case)", () => {
    // QQQ held only in IBKR — exactly the real-world bug. It must NOT appear
    // in the briefing's portfolio context.
    const qqq = seedEtf("QQQ");
    seedHolding(qqq, IBKR, 20);

    // A genuine Vanguard holding that SHOULD appear.
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_TAXABLE, 100);

    const holdings = getBriefingHoldings(db);
    const symbols = holdings.map((h) => h.symbol);

    expect(symbols).toContain("VTI");
    expect(symbols).not.toContain("QQQ");
  });

  it("includes a Vanguard position and excludes the IBKR leg of the same symbol", () => {
    // AAPL held in BOTH Vanguard Taxable and IBKR. The briefing's net_qty
    // must reflect ONLY the Vanguard legs.
    const aapl = seedStock("AAPL", "Technology");
    seedHolding(aapl, VANGUARD_TAXABLE, 50);
    seedHolding(aapl, VANGUARD_ROTH, 10);
    seedHolding(aapl, IBKR, 1000); // huge IBKR position must be ignored

    const holdings = getBriefingHoldings(db);
    const aaplRow = holdings.find((h) => h.symbol === "AAPL");

    expect(aaplRow).toBeDefined();
    // 50 (Taxable) + 10 (Roth) = 60, NOT 1060.
    expect(aaplRow!.net_qty).toBe(60);
  });

  it("still surfaces Vanguard net shorts (A7 behavior preserved)", () => {
    const msft = seedStock("MSFT", "Technology");
    seedHolding(msft, VANGUARD_TAXABLE, -25);

    const holdings = getBriefingHoldings(db);
    const msftRow = holdings.find((h) => h.symbol === "MSFT");

    expect(msftRow).toBeDefined();
    expect(msftRow!.net_qty).toBe(-25);
  });

  it("returns nothing when the user holds the name only in IBKR", () => {
    const qqq = seedEtf("QQQ");
    seedHolding(qqq, IBKR, 20);
    const qqqPut = seedOption("QQQ 260612P00715000", "QQQ", 715, "2026-06-12");
    seedHolding(qqqPut, IBKR, -5);

    expect(getBriefingHoldings(db)).toHaveLength(0);
  });

  // ── per-(account, security) "latest" keying ──────────────────────
  //
  // The old query keyed "latest" off a per-ACCOUNT MAX(as_of_date). A
  // position that only restates on the monthly statement (Treasuries,
  // mutual funds) carries an older as_of_date than the daily Plaid/TWS rows
  // written for other securities in the same account, so the per-account
  // MAX silently dropped it from the briefing prompt entirely.

  it("keeps a statement-lag position when a newer row exists for another security in the same account", () => {
    // VWIUX only restates on the monthly statement (2025-01-31); VTI gets a
    // daily Plaid row (2025-02-28) in the SAME account.
    const vwiux = seedEtf("VWIUX");
    seedHolding(vwiux, VANGUARD_TAXABLE, 500, "2025-01-31");
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_TAXABLE, 100, "2025-02-28");

    const symbols = getBriefingHoldings(db).map((h) => h.symbol);
    // Under per-account MAX, VWIUX vanished from the prompt.
    expect(symbols).toContain("VWIUX");
    expect(symbols).toContain("VTI");
  });

  it("hides a closed position whose latest row is a quantity=0 tombstone", () => {
    // The closed-position reconciler writes a quantity=0 row at the latest
    // snapshot date. That tombstone IS the latest row for its (account,
    // security) pair, so per-pair keying must not resurrect the older
    // non-zero row.
    const closed = seedStock("CLOSED", "Technology");
    seedHolding(closed, VANGUARD_TAXABLE, 10, "2025-01-31");
    seedHolding(closed, VANGUARD_TAXABLE, 0, "2025-02-28");
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_TAXABLE, 100, "2025-02-28");

    const symbols = getBriefingHoldings(db).map((h) => h.symbol);
    expect(symbols).not.toContain("CLOSED");
    expect(symbols).toContain("VTI");
  });

  it("does not flip a net-LONG book to NET SHORT when one account's long leg lags (net_qty sign)", () => {
    // net_qty is a cross-account SUM, so a dropped leg does not merely
    // shrink the number — it can invert its SIGN. formatHoldingsList then
    // stamps "NET SHORT" on a net-long position in an outbound, cc'd email.
    const x = seedStock("X", "Technology");

    // Vanguard Taxable: long 100, but the X row is the older statement date.
    seedHolding(x, VANGUARD_TAXABLE, 100, "2025-01-31");
    // A newer daily row for a DIFFERENT security pushes Taxable's
    // per-account MAX past the X row → the old query dropped the long leg.
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_TAXABLE, 5, "2025-02-28");
    // Roth: short 40 at Roth's own latest date → survived the old query.
    seedHolding(x, VANGUARD_ROTH, -40, "2025-02-28");

    const row = getBriefingHoldings(db).find((h) => h.symbol === "X");
    expect(row).toBeDefined();
    // Old per-account MAX: 0 + (-40) = -40 → "NET SHORT 40".
    // Per-pair keying: 100 + (-40) = 60 → net long, which is the truth.
    expect(row!.net_qty).toBe(60);
  });
});

describe("getExpiringOptions — IBKR exclusion + per-(account, security) latest keying", () => {
  it("excludes IBKR option legs from the expiry roster", () => {
    const qqqPut = seedOption("QQQ 260612P00715000", "QQQ", 715, "2026-06-12");
    seedHolding(qqqPut, IBKR, -5);
    const vgPut = seedOption("SPY 260612P00500000", "SPY", 500, "2026-06-12");
    seedHolding(vgPut, VANGUARD_TAXABLE, -1);

    const rows = getExpiringOptions(db, "2026-06-08", "2026-06-14");
    expect(rows.map((r) => r.underlying_symbol)).toEqual(["SPY"]);
  });

  it("keeps a statement-lag option leg when a newer row exists for another security in the same account", () => {
    // The option leg last restated on the monthly statement; a daily Plaid
    // row for the underlying stock moved the account's MAX past it.
    const put = seedOption("SPY 260612P00500000", "SPY", 500, "2026-06-12");
    seedHolding(put, VANGUARD_TAXABLE, -1, "2025-01-31");
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_TAXABLE, 100, "2025-02-28");

    const rows = getExpiringOptions(db, "2026-06-08", "2026-06-14");
    // Under per-account MAX this expiring short put was invisible to the
    // briefing — the user got no warning that it expires this week.
    expect(rows).toHaveLength(1);
    expect(rows[0].underlying_symbol).toBe("SPY");
    expect(rows[0].quantity).toBe(-1);
    expect(rows[0].account_name).toBe("Vanguard Taxable");
  });

  it("hides a closed option leg whose latest row is a quantity=0 tombstone", () => {
    const put = seedOption("SPY 260612P00500000", "SPY", 500, "2026-06-12");
    seedHolding(put, VANGUARD_TAXABLE, -1, "2025-01-31");
    seedHolding(put, VANGUARD_TAXABLE, 0, "2025-02-28");

    expect(getExpiringOptions(db, "2026-06-08", "2026-06-14")).toHaveLength(0);
  });
});

describe("buildCombinedPositionsForEvents — IBKR exclusion", () => {
  it("omits IBKR-only positions from an earnings event roster", () => {
    const nvda = seedStock("NVDA", "Technology");
    seedHolding(nvda, IBKR, 30); // IBKR-only → excluded

    const event = {
      id: 1,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-06-18",
      title: "NVDA earnings",
      symbol: "NVDA",
      source_key: "finnhub:NVDA:2026-06-18",
    } as CalendarEvent;

    const out = buildCombinedPositionsForEvents(db, [event], new Map());
    // No Vanguard position → no roster entry at all.
    expect(out.has(1)).toBe(false);
  });

  it("keeps the Vanguard leg and drops the IBKR leg for a split-account name", () => {
    const nvda = seedStock("NVDA", "Technology");
    seedHolding(nvda, VANGUARD_ROTH, 5);
    seedHolding(nvda, IBKR, 30);

    const event = {
      id: 2,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-06-18",
      title: "NVDA earnings",
      symbol: "NVDA",
      source_key: "finnhub:NVDA:2026-06-18",
    } as CalendarEvent;

    const out = buildCombinedPositionsForEvents(db, [event], new Map());
    const cp = out.get(2);
    expect(cp).toBeDefined();
    expect(cp!.stockPositions).toHaveLength(1);
    expect(cp!.stockPositions[0]).toMatchObject({
      symbol: "NVDA",
      quantity: 5,
      account: "Vanguard Roth IRA",
    });
  });

  it("keeps a statement-lag Vanguard leg when a newer row exists for another security in the same account", () => {
    const nvda = seedStock("NVDA", "Technology");
    seedHolding(nvda, VANGUARD_ROTH, 5, "2025-01-31");
    // Newer daily row for a different security in the same account.
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_ROTH, 100, "2025-02-28");

    const event = {
      id: 3,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-06-18",
      title: "NVDA earnings",
      symbol: "NVDA",
      source_key: "finnhub:NVDA:2026-06-18",
    } as CalendarEvent;

    const out = buildCombinedPositionsForEvents(db, [event], new Map());
    const cp = out.get(3);
    // Under per-account MAX the roster was empty and the briefing framed
    // the earnings print as "no position."
    expect(cp).toBeDefined();
    expect(cp!.stockPositions).toHaveLength(1);
    expect(cp!.stockPositions[0].quantity).toBe(5);
  });
});
