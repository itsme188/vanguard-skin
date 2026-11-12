/**
 * Owner ruling A (2026-11-12): the chat market snapshot never sends a held
 * ticker to an outside quote source. The live fallback asks only for the
 * three index funds (SPY, QQQ, DIA). A held name with no fresh local price is
 * returned as stale with the date of its last local price, never fetched from
 * outside and never shown with a made-up or zero move.
 *
 * Synthetic tickers and round figures only. Thu 2026-06-04 and Fri
 * 2026-06-05 are ordinary trading days.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getMarketSnapshot,
  OUTSIDE_QUOTE_SYMBOLS,
  type QuoteFetcher,
  type LiveQuote,
} from "@/lib/queries/market-snapshot";

let db: Database.Database;
// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const TAXABLE = 1;
const IBKR = 3;
const INDEX_FUNDS = new Set(["SPY", "QQQ", "DIA"]);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, type = "Stock"): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)")
    .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
}

function seedPrice(securityId: number, date: string, close: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(
    securityId,
    date,
    close,
  );
}

function seedHolding(accountId: number, securityId: number, date: string, qty: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, qty, date, `tws:${accountId}:${securityId}:${date}`);
}

/** A stub that records every symbol asked and answers for ANY symbol, held or not. */
function recordingFetcher(): { asked: string[][]; fetch: QuoteFetcher } {
  const asked: string[][] = [];
  return {
    asked,
    fetch: async (symbols) => {
      asked.push([...symbols]);
      // Answers for every symbol it is asked AND for held names it was not
      // asked: the snapshot must never read a held name's quote either way.
      const all = [...symbols, "ZZA", "ZZB", "ZZC"];
      return Object.fromEntries(
        all.map((s): [string, LiveQuote] => [s, { price: 999, prior: 100, asOf: "2026-06-12" }]),
      );
    },
  };
}

/** SPY priced on the pair; three held names (one held long and short), all priced on the pair. */
function seedStaleBook(): void {
  const spy = seedSecurity("SPY", "ETF");
  seedPrice(spy, "2026-06-04", 600);
  seedPrice(spy, "2026-06-05", 606);
  const zza = seedSecurity("ZZA");
  seedHolding(TAXABLE, zza, "2026-06-05", 100);
  seedHolding(IBKR, zza, "2026-06-05", -40);
  seedPrice(zza, "2026-06-04", 100);
  seedPrice(zza, "2026-06-05", 102);
  const zzb = seedSecurity("ZZB", "ETF");
  seedHolding(TAXABLE, zzb, "2026-06-05", 10);
  seedPrice(zzb, "2026-06-04", 50);
  seedPrice(zzb, "2026-06-05", 49);
  // ZZC: held, last local price two sessions earlier than the pair.
  const zzc = seedSecurity("ZZC", "Mutual Fund");
  seedHolding(TAXABLE, zzc, "2026-06-05", 5);
  seedPrice(zzc, "2026-06-02", 20);
}

describe("the outside quote source sees only the index funds", () => {
  it("the allowed list is exactly SPY, QQQ, DIA", () => {
    expect([...OUTSIDE_QUOTE_SYMBOLS].sort()).toEqual(["DIA", "QQQ", "SPY"]);
  });

  it("a stale book asks only for index funds, never a held ticker", async () => {
    seedStaleBook();
    const rec = recordingFetcher();
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes: rec.fetch });

    expect(snap.source).toBe("yahoo");
    expect(rec.asked).toHaveLength(1);
    // The guard: any held ticker other than the three index funds fails here.
    for (const s of rec.asked[0]) expect(INDEX_FUNDS.has(s)).toBe(true);
    expect(rec.asked[0]).not.toContain("ZZA");
    expect(rec.asked[0]).not.toContain("ZZB");
    expect(rec.asked[0]).not.toContain("ZZC");
  });

  it("a benchmark list naming a held ticker still sends only index funds", async () => {
    seedStaleBook();
    const rec = recordingFetcher();
    await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes: rec.fetch, benchmarks: ["SPY", "ZZA", "QQQ"] });
    for (const s of rec.asked.flat()) expect(INDEX_FUNDS.has(s)).toBe(true);
  });

  it("a book with no pair at all still sends only index funds", async () => {
    const spy = seedSecurity("SPY", "ETF");
    seedPrice(spy, "2026-06-05", 606); // one SPY price: no pair forms
    const zza = seedSecurity("ZZA");
    seedHolding(TAXABLE, zza, "2026-06-05", 100);
    seedPrice(zza, "2026-06-05", 102);
    const rec = recordingFetcher();
    await getMarketSnapshot(db, { today: "2026-06-05", fetchQuotes: rec.fetch });
    for (const s of rec.asked.flat()) expect(INDEX_FUNDS.has(s)).toBe(true);
  });
});

describe("held names on the fallback are the local book's, dated and flagged stale", () => {
  it("each held row carries the date of its last local price and is flagged stale; no outside move", async () => {
    seedStaleBook();
    const rec = recordingFetcher();
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes: rec.fetch });

    const held = snap.moves.filter((m) => m.kind === "holding");
    expect(held.map((m) => `${m.symbol}|${m.position}`).sort()).toEqual([
      "ZZA|long",
      "ZZA|short",
      "ZZB|long",
      "ZZC|long",
    ]);
    for (const m of held) {
      expect(m.price_stale).toBe(true);
      expect(m.day_effect).toBeNull();
      // The stub's 999 / 100 quote would be an 899% move: never used.
      expect(m.pct).not.toBeCloseTo(899, 0);
      expect(m.day_effect_reason).toMatch(/never sent/i);
    }
    // ZZA and ZZB have the stale pair: their move is the book's move on 06-05.
    const zza = held.find((m) => m.symbol === "ZZA" && m.position === "long")!;
    expect(zza.price_as_of).toBe("2026-06-05");
    expect(zza.pct).toBeCloseTo(2, 6);
    const zzb = held.find((m) => m.symbol === "ZZB")!;
    expect(zzb.price_as_of).toBe("2026-06-05");
    expect(zzb.pct).toBeCloseTo(-2, 6);
    // ZZC has no move on the pair: null, never zero, dated by its last price.
    const zzc = held.find((m) => m.symbol === "ZZC")!;
    expect(zzc.price_as_of).toBe("2026-06-02");
    expect(zzc.pct).toBeNull();
    // The quantity and value are still the book's.
    expect(zza.quantity).toBe(100);
    expect(zza.market_value).toBeCloseTo(10200, 6);

    expect(snap.note).toMatch(/held names are not sent/i);
  });

  it("a held index fund may use the index quote", async () => {
    seedStaleBook();
    const spy = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;
    seedHolding(TAXABLE, spy, "2026-06-05", 10);
    const fetchQuotes: QuoteFetcher = async (symbols) =>
      Object.fromEntries(symbols.map((s) => [s, { price: 612, prior: 600, asOf: "2026-06-12" }]));
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    const spyHeld = snap.moves.find((m) => m.symbol === "SPY" && m.kind === "holding")!;
    expect(spyHeld.pct).toBeCloseTo(2, 6);
    expect(spyHeld.price_as_of).toBe("2026-06-12");
    expect(spyHeld.price_stale).toBe(false);
    expect(spyHeld.day_effect).toBeNull();
  });

  it("with no pair, a held name is dated by its last local price and has no move", async () => {
    const spy = seedSecurity("SPY", "ETF");
    seedPrice(spy, "2026-06-04", 600);
    seedPrice(spy, "2026-06-08", 610); // no 06-05 row: no pair
    const zza = seedSecurity("ZZA");
    seedHolding(TAXABLE, zza, "2026-06-08", 100);
    seedPrice(zza, "2026-06-04", 100);
    seedPrice(zza, "2026-06-08", 105);
    const fetchQuotes: QuoteFetcher = async () => ({ SPY: { price: 610, prior: 600, asOf: "2026-06-08" } });
    const snap = await getMarketSnapshot(db, { today: "2026-06-08", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    const row = snap.moves.find((m) => m.symbol === "ZZA")!;
    expect(row.pct).toBeNull();
    expect(row.price_as_of).toBe("2026-06-08");
    expect(row.day_effect).toBeNull();
  });

  it("no index quote at all: the stale local book is returned, flagged", async () => {
    seedStaleBook();
    const fetchQuotes: QuoteFetcher = async () => null;
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });
    expect(snap.source).toBe("local");
    expect(snap.stale).toBe(true);
    for (const m of snap.moves.filter((x) => x.kind === "holding")) expect(m.price_stale).toBe(true);
  });
});

describe("the fresh local path keeps a held name it cannot price, as stale", () => {
  it("a held name with no price on the latest session is listed with its last price date, no move, and nothing is fetched", async () => {
    const spy = seedSecurity("SPY", "ETF");
    seedPrice(spy, "2026-06-04", 600);
    seedPrice(spy, "2026-06-05", 606);
    const zza = seedSecurity("ZZA");
    seedHolding(TAXABLE, zza, "2026-06-05", 100);
    seedPrice(zza, "2026-06-04", 100);
    seedPrice(zza, "2026-06-05", 102);
    const zzc = seedSecurity("ZZC");
    seedHolding(TAXABLE, zzc, "2026-06-05", 5);
    seedPrice(zzc, "2026-06-01", 20);

    const rec = recordingFetcher();
    const snap = await getMarketSnapshot(db, { today: "2026-06-05", fetchQuotes: rec.fetch });
    expect(rec.asked).toHaveLength(0);
    expect(snap.source).toBe("local");

    const zzaRow = snap.moves.find((m) => m.symbol === "ZZA")!;
    expect(zzaRow.price_as_of).toBe("2026-06-05");
    expect(zzaRow.price_stale).toBe(false);

    const zzcRow = snap.moves.find((m) => m.symbol === "ZZC")!;
    expect(zzcRow).toBeDefined();
    expect(zzcRow.pct).toBeNull();
    expect(zzcRow.price_as_of).toBe("2026-06-01");
    expect(zzcRow.price_stale).toBe(true);
  });
});
