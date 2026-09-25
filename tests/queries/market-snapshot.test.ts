import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getMarketSnapshot, parseYahooChart, type QuoteFetcher } from "@/lib/queries/market-snapshot";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Seed helpers (mirror tests/digest/anomalies.test.ts) ───────────────────────

function seedSecurity(symbol: string, name?: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedHolding(accountId: number, securityId: number, date: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, ?, ?)`
  ).run(accountId, securityId, date, `test:${accountId}:${securityId}:${date}`);
}

function seedPrice(securityId: number, date: string, closePrice: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')"
  ).run(securityId, date, closePrice);
}

/**
 * Seed a fresh, consecutive trading-day pair (Thu 6/4 → Fri 6/5 2026):
 * SPY benchmark (not held) + GS held in a Vanguard account.
 */
function seedFreshPair(): void {
  const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
  seedPrice(spyId, "2026-06-04", 600);
  seedPrice(spyId, "2026-06-05", 585); // -2.5%

  const acctId = seedAccount("Vanguard Taxable");
  const gsId = seedSecurity("GS", "Goldman Sachs");
  seedHolding(acctId, gsId, "2026-06-05");
  seedPrice(gsId, "2026-06-04", 1092);
  seedPrice(gsId, "2026-06-05", 1038); // -4.945%
}

describe("getMarketSnapshot", () => {
  it("uses local closes when the local book is fresh, without calling Yahoo", async () => {
    seedFreshPair();
    let yahooCalled = false;
    const fetchQuotes: QuoteFetcher = async () => {
      yahooCalled = true;
      return null;
    };

    const snap = await getMarketSnapshot(db, { today: "2026-06-05", fetchQuotes });

    expect(snap.source).toBe("local");
    expect(snap.asOf).toBe("2026-06-05");
    expect(snap.stale).toBe(false);
    expect(yahooCalled).toBe(false); // local-first: fresh local skips Yahoo

    const spy = snap.moves.find((m) => m.symbol === "SPY");
    const gs = snap.moves.find((m) => m.symbol === "GS");
    expect(spy?.kind).toBe("benchmark");
    expect(spy?.pct).toBeCloseTo(-2.5, 1);
    expect(gs?.kind).toBe("holding");
    expect(gs?.pct).toBeCloseTo(-4.95, 1);
  });

  it("serves benchmarks from benchmark_prices when absent from prices (DIA gap)", async () => {
    seedFreshPair();
    // DIA lives only in benchmark_prices (Yahoo top-off path) — there is no
    // securities/prices row for it on the common fresh-local path.
    db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('DIA', '2026-06-04', 500, 'yahoo')"
    ).run();
    db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('DIA', '2026-06-05', 510, 'yahoo')"
    ).run();

    const snap = await getMarketSnapshot(db, { today: "2026-06-05" });

    expect(snap.source).toBe("local");
    const dia = snap.moves.find((m) => m.symbol === "DIA");
    expect(dia?.kind).toBe("benchmark");
    expect(dia?.pct).toBeCloseTo(2.0, 1);
  });

  it("falls back to Yahoo when the local book is stale", async () => {
    seedFreshPair(); // latest local = 2026-06-05
    const fetchQuotes: QuoteFetcher = async (symbols) => {
      expect(symbols).toContain("SPY");
      expect(symbols).toContain("GS");
      return {
        SPY: { price: 590, prior: 600 }, // -1.667%
        GS: { price: 1050, prior: 1092 }, // -3.846%
      };
    };

    // today is 7 calendar days after the latest local close → stale
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    expect(snap.asOf).toBe("2026-06-12");
    expect(snap.stale).toBe(false);
    expect(snap.moves.find((m) => m.symbol === "SPY")?.pct).toBeCloseTo(-1.67, 1);
    expect(snap.moves.find((m) => m.symbol === "GS")?.pct).toBeCloseTo(-3.85, 1);
  });

  it("returns stale local data (flagged) when local is stale AND Yahoo fails", async () => {
    seedFreshPair();
    const fetchQuotes: QuoteFetcher = async () => null; // Yahoo down

    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    expect(snap.source).toBe("local");
    expect(snap.stale).toBe(true);
    expect(snap.staleDays).toBe(7);
    expect(snap.moves.find((m) => m.symbol === "SPY")).toBeDefined();
    expect(snap.note.toLowerCase()).toContain("stale");
  });

  it("returns source 'none' when there is no local pair and no Yahoo", async () => {
    // Only one SPY price → resolveTradingDayPair returns null
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-06-05", 585);

    const snap = await getMarketSnapshot(db, { today: "2026-06-05" });

    expect(snap.source).toBe("none");
    expect(snap.moves).toEqual([]);
    expect(snap.note.toLowerCase()).toContain("unavailable");
  });

  it("dates a Yahoo fallback by the quote's own session, not today (pre-open)", async () => {
    seedFreshPair(); // latest local = 2026-06-05 (Fri)
    // Tuesday 2026-06-16 pre-open: the latest Yahoo session is Monday 06-15.
    const fetchQuotes: QuoteFetcher = async () => ({
      SPY: { price: 590, prior: 600, asOf: "2026-06-15" },
      GS: { price: 1050, prior: 1092, asOf: "2026-06-15" },
    });

    const snap = await getMarketSnapshot(db, { today: "2026-06-16", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    expect(snap.asOf).toBe("2026-06-15");
    expect(snap.staleDays).toBe(1);
    expect(snap.stale).toBe(false);
    expect(snap.note).toContain("2026-06-15");
    expect(snap.note.toLowerCase()).toContain("not today");
  });

  it("flags a Yahoo fallback whose quotes are several days old as stale", async () => {
    seedFreshPair();
    const fetchQuotes: QuoteFetcher = async () => ({
      SPY: { price: 590, prior: 600, asOf: "2026-06-08" },
    });

    const snap = await getMarketSnapshot(db, { today: "2026-06-16", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    expect(snap.asOf).toBe("2026-06-08");
    expect(snap.staleDays).toBe(8);
    expect(snap.stale).toBe(true);
  });
});

// ─── Yahoo chart parsing (pure) ─────────────────────────────────────────────────

/** 2026-09-24 20:00:00Z = 16:00 ET, the regular-session close. */
const SEP24_CLOSE = Date.UTC(2026, 8, 24, 20, 0, 0) / 1000;
const DAY = 86400;

function chartFixture(
  closes: (number | null)[],
  meta: Record<string, unknown>,
): unknown {
  const n = closes.length;
  const timestamp = closes.map((_, i) => SEP24_CLOSE - (n - 1 - i) * DAY - 6.5 * 3600);
  return {
    chart: {
      result: [
        {
          meta,
          timestamp,
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

describe("parseYahooChart", () => {
  const meta = {
    regularMarketPrice: 127.39,
    chartPreviousClose: 108.8, // close BEFORE the 5-day window — never the prior session
    previousClose: 122.6,
    regularMarketTime: SEP24_CLOSE,
  };

  it("uses the previous session's bar close, never chartPreviousClose", () => {
    const q = parseYahooChart(chartFixture([110.1, 115.2, 119.9, 122.6, 127.39], meta));
    expect(q).not.toBeNull();
    expect(q!.price).toBe(127.39);
    expect(q!.prior).toBe(122.6);
    expect(q!.prior).not.toBe(108.8);
    expect(q!.asOf).toBe("2026-09-24");
  });

  it("ignores a trailing null close when picking the latest and prior bars", () => {
    const q = parseYahooChart(
      chartFixture([110.1, 115.2, 119.9, 122.6, 127.39, null], meta),
    );
    expect(q!.price).toBe(127.39);
    expect(q!.prior).toBe(122.6);
  });

  it("falls back to meta.previousClose when only one priced bar exists", () => {
    const q = parseYahooChart(chartFixture([127.39], meta));
    expect(q!.price).toBe(127.39);
    expect(q!.prior).toBe(122.6);
  });

  it("uses the latest bar close when regularMarketPrice is missing", () => {
    const { regularMarketPrice: _omit, ...noPrice } = meta;
    const q = parseYahooChart(chartFixture([119.9, 122.6, 127.39], noPrice));
    expect(q!.price).toBe(127.39);
    expect(q!.prior).toBe(122.6);
  });

  it("returns asOf null when regularMarketTime is missing", () => {
    const { regularMarketTime: _omit, ...noTime } = meta;
    const q = parseYahooChart(chartFixture([122.6, 127.39], noTime));
    expect(q!.asOf).toBeNull();
  });

  it("returns null for an empty or malformed response", () => {
    expect(parseYahooChart({})).toBeNull();
    expect(parseYahooChart(null)).toBeNull();
    expect(parseYahooChart(chartFixture([], {}))).toBeNull();
  });
});
