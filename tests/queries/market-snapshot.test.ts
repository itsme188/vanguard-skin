import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getMarketSnapshot,
  parseYahooChart,
  fetchYahooQuotes,
  YAHOO_QUOTE_CONCURRENCY,
  type QuoteFetcher,
} from "@/lib/queries/market-snapshot";

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

describe("getMarketSnapshot local note is session-aware", () => {
  // 2026-06-05 is a Friday (EDT, UTC-4).
  it("pre-open on the price date: intraday wording, not a close", async () => {
    seedFreshPair();
    const snap = await getMarketSnapshot(db, { now: new Date("2026-06-05T07:30:00Z") }); // 03:30 ET
    expect(snap.source).toBe("local");
    expect(snap.note).toMatch(/pre-market \/ intraday/);
    expect(snap.note).not.toMatch(/^Closing prices/);
  });

  it("midday on the price date: still intraday wording", async () => {
    seedFreshPair();
    const snap = await getMarketSnapshot(db, { now: new Date("2026-06-05T16:00:00Z") }); // 12:00 ET
    expect(snap.note).toMatch(/pre-market \/ intraday/);
  });

  it("after 16:00 ET on the price date: closing wording", async () => {
    seedFreshPair();
    const snap = await getMarketSnapshot(db, { now: new Date("2026-06-05T20:30:00Z") }); // 16:30 ET
    expect(snap.note).toMatch(/^Closing prices as of 2026-06-05/);
  });

  it("price date before today: closing wording", async () => {
    seedFreshPair();
    const snap = await getMarketSnapshot(db, { now: new Date("2026-06-06T14:00:00Z") }); // Sat 10:00 ET
    expect(snap.note).toMatch(/^Closing prices as of 2026-06-05/);
  });
});

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

describe("getMarketSnapshot universe coverage", () => {
  it("measures every held name (beyond the 50 largest) and short positions", async () => {
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-06-04", 600);
    seedPrice(spyId, "2026-06-05", 585);
    const acctId = seedAccount("Vanguard Taxable");
    // 60 long holdings; SYM01 is the smallest by value (price 1) and the biggest mover.
    for (let i = 1; i <= 60; i++) {
      const sym = `SYM${String(i).padStart(2, "0")}`;
      const id = seedSecurity(sym);
      seedHolding(acctId, id, "2026-06-05");
      const base = i === 1 ? 1 : 100 + i;
      seedPrice(id, "2026-06-04", base);
      seedPrice(id, "2026-06-05", i === 1 ? base * 1.5 : base * 1.01);
    }
    // A short position (negative quantity) with prices.
    const shortId = seedSecurity("SHRT1");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, -50, '2026-06-05', 'test:short')`
    ).run(acctId, shortId);
    seedPrice(shortId, "2026-06-04", 200);
    seedPrice(shortId, "2026-06-05", 210); // +5% price move (sign not flipped)

    const fetchQuotes: QuoteFetcher = async () => null;
    const snap = await getMarketSnapshot(db, { today: "2026-06-05", fetchQuotes });

    const holdings = snap.moves.filter((m) => m.kind === "holding");
    expect(holdings.length).toBe(61);
    const small = snap.moves.find((m) => m.symbol === "SYM01");
    expect(small?.pct).toBeCloseTo(50, 1);
    const short = snap.moves.find((m) => m.symbol === "SHRT1");
    expect(short?.pct).toBeCloseTo(5, 1);
    // pct is the PRICE move; the direction of the position rides beside it so
    // a reader never takes a rising short for a gain.
    expect(short?.position).toBe("short");
    expect(small?.position).toBe("long");
    expect(snap.moves.find((m) => m.symbol === "SPY")?.position).toBeUndefined();
  });

  // Owner ruling 2026-10-08: one row per (symbol, side). This test used to pin
  // a single row with position "mixed"; that value no longer exists.
  it("gives a name held long in one account and short in another one row per side", async () => {
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-06-04", 600);
    seedPrice(spyId, "2026-06-05", 585);
    const taxable = seedAccount("Vanguard Taxable");
    const ibkr = seedAccount("IBKR");
    const id = seedSecurity("BOTH1");
    seedHolding(taxable, id, "2026-06-05");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, -40, '2026-06-05', 'test:both-short')`
    ).run(ibkr, id);
    seedPrice(id, "2026-06-04", 100);
    seedPrice(id, "2026-06-05", 102);

    const fetchQuotes: QuoteFetcher = async () => null;
    const snap = await getMarketSnapshot(db, { today: "2026-06-05", fetchQuotes });

    const rows = snap.moves.filter((m) => m.symbol === "BOTH1");
    expect(rows.map((r) => r.position).sort()).toEqual(["long", "short"]);
    expect(rows.some((r) => (r.position as string) === "mixed")).toBe(false);
  });
});


describe("getMarketSnapshot Yahoo fallback is narrowed and bounded", () => {
  function seedTyped(symbol: string, type: string): number {
    return db
      .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, ?, 1)")
      .run(symbol, symbol, type).lastInsertRowid as number;
  }

  it("never asks Yahoo for option or bond symbols, and still asks for every stock, ETF and fund", async () => {
    seedFreshPair(); // SPY + GS (stock), latest local 2026-06-05
    const acctId = seedAccount("Vanguard Taxable");
    const typed: [string, string][] = [
      ["AAA", "Stock"],
      ["BBB", "ETF"],
      ["CCCXX", "Mutual Fund"],
      ["AAA 260619C00100000", "Option"],
      ["AAA 260619P00100000", "OPTION"],
      ["912800ZZ1", "Bond"],
      ["912800ZZ2", "bond"],
    ];
    for (const [symbol, type] of typed) seedHolding(acctId, seedTyped(symbol, type), "2026-06-05");

    let asked: string[] = [];
    const fetchQuotes: QuoteFetcher = async (symbols) => {
      asked = symbols;
      return Object.fromEntries(symbols.map((s) => [s, { price: 101, prior: 100 }]));
    };
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    expect([...asked].sort()).toEqual(["AAA", "BBB", "CCCXX", "DIA", "GS", "QQQ", "SPY"]);
    const shown = snap.moves.map((m) => m.symbol);
    for (const s of ["SPY", "GS", "AAA", "BBB", "CCCXX"]) expect(shown).toContain(s);
  });

  it("keeps option and bond rows on the local path", async () => {
    seedFreshPair();
    const acctId = seedAccount("Vanguard Taxable");
    const optId = seedTyped("AAA 260619C00100000", "Option");
    seedHolding(acctId, optId, "2026-06-05");
    seedPrice(optId, "2026-06-04", 2);
    seedPrice(optId, "2026-06-05", 3);

    const snap = await getMarketSnapshot(db, { today: "2026-06-05" });
    expect(snap.source).toBe("local");
    expect(snap.moves.find((m) => m.symbol === "AAA 260619C00100000")?.pct).toBeCloseTo(50, 5);
  });
});

describe("fetchYahooQuotes concurrency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never has more than the fixed pool of requests in flight, and still returns every symbol", async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return {
        ok: true,
        json: async () => chartFixture([100, 101], { regularMarketPrice: 101, regularMarketTime: SEP24_CLOSE }),
      };
    });

    const symbols = Array.from({ length: 40 }, (_, i) => `SYM${String(i).padStart(2, "0")}`);
    const quotes = await fetchYahooQuotes(symbols);

    expect(calls).toBe(40);
    expect(peak).toBeLessThanOrEqual(YAHOO_QUOTE_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(Object.keys(quotes ?? {}).sort()).toEqual(symbols);
  });

  it("a failing symbol does not stop the others", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("BAD")) throw new Error("network");
      return {
        ok: true,
        json: async () => chartFixture([100, 101], { regularMarketPrice: 101, regularMarketTime: SEP24_CLOSE }),
      };
    });
    const quotes = await fetchYahooQuotes(["AAA", "BAD", "ZZZ"]);
    expect(Object.keys(quotes ?? {}).sort()).toEqual(["AAA", "ZZZ"]);
  });
});
