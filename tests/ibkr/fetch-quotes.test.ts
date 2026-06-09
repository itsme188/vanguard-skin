import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchAndStoreQuotes } from "@/lib/ibkr/refresh";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import type { ParsedQuote } from "@/lib/ibkr/market-data";
import type { IbkrOAuthConfig } from "@/lib/ibkr/oauth-client";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const CFG = {} as IbkrOAuthConfig;

function getIbkrAccount(): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
}

function seedSecurity(symbol: string, conid: number | null, type = "Stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, ib_con_id) VALUES (?, ?, ?, 'equity', ?)",
    )
    .run(symbol, `${symbol} Corp`, type, conid).lastInsertRowid as number;
}

function hold(accountId: number, securityId: number, qty: number): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, '2026-06-08')",
  ).run(accountId, securityId, qty);
}

function watch(securityId: number): void {
  db.prepare("INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)").run(securityId);
}

describe("fetchAndStoreQuotes", () => {
  it("captures quotes for held + watchlist (not unrelated) securities and writes prices", async () => {
    const acct = getIbkrAccount();
    const aapl = seedSecurity("AAPL", 265598);
    const nvda = seedSecurity("NVDA", 4815747);
    const msft = seedSecurity("MSFT", 272093); // neither held nor watchlisted
    const tbill = seedSecurity("912810SA7", 99999999, "Bond"); // held bond — excluded
    hold(acct, aapl, 100);
    hold(acct, tbill, 10);
    watch(nvda);

    let requestedConids: number[] = [];
    const stub = async (
      _cfg: IbkrOAuthConfig,
      _lst: string,
      conids: number[],
    ): Promise<ParsedQuote[]> => {
      requestedConids = conids;
      return [
        { conid: 265598, last: 302.94, ivUnderlying: 0.2441, hv30d: 0.2322, week52High: 316.94, week52Low: 194.47 },
        { conid: 4815747, last: 140.5, ivUnderlying: 0.55, hv30d: 0.5, week52High: 195, week52Low: 86 },
      ];
    };

    const res = await fetchAndStoreQuotes(db, CFG, "lst-token", {
      asOfDate: "2026-06-08",
      fetchSnapshot: stub,
    });

    // Only held (AAPL) + watchlist (NVDA) conids requested — MSFT (not held)
    // and the held T-bill (bond) both excluded.
    expect(requestedConids.sort()).toEqual([265598, 4815747].sort());
    expect(requestedConids).not.toContain(272093);
    expect(requestedConids).not.toContain(99999999);

    expect(res.securitiesUpdated).toBe(2);
    expect(res.pricesWritten).toBe(2);

    const qa = getSecurityQuote(db, aapl);
    expect(qa!.iv_underlying).toBeCloseTo(0.2441, 4);
    expect(qa!.week52_high).toBe(316.94);

    // Price written at source 'tws' for AAPL.
    const px = db
      .prepare("SELECT close_price, source FROM prices WHERE security_id = ? AND date = '2026-06-08'")
      .get(aapl) as { close_price: number; source: string } | undefined;
    expect(px?.close_price).toBeCloseTo(302.94, 2);
    expect(px?.source).toBe("tws");

    // MSFT untouched.
    expect(getSecurityQuote(db, msft)).toBeNull();
  });

  it("no-ops cleanly when there are no candidate securities", async () => {
    const stub = async (): Promise<ParsedQuote[]> => [];
    const res = await fetchAndStoreQuotes(db, CFG, "lst", { fetchSnapshot: stub });
    expect(res.securitiesUpdated).toBe(0);
    expect(res.pricesWritten).toBe(0);
  });

  it("fills dividend yield via the injected yield fetcher and preserves it across refreshes", async () => {
    // IBKR's snapshot + fundamentals endpoints don't expose yield
    // (probe-verified 2026-06-09) — Finnhub /stock/metric fills it instead,
    // injected DI-style like fetchSnapshot.
    const acct = getIbkrAccount();
    const ko = seedSecurity("KO", 8894);
    hold(acct, ko, 100);

    const snapshotStub = async (): Promise<ParsedQuote[]> => [
      { conid: 8894, last: 81.19, ivUnderlying: 0.2, hv30d: 0.18, week52High: 90, week52Low: 60 },
    ];

    let requestedSymbols: string[] = [];
    const yieldStub = async (symbols: string[]) => {
      requestedSymbols = symbols;
      return { KO: 3.205 } as Record<string, number | null>;
    };

    await fetchAndStoreQuotes(db, CFG, "lst", {
      asOfDate: "2026-06-09",
      fetchSnapshot: snapshotStub,
      fetchYields: yieldStub,
    });
    expect(requestedSymbols).toContain("KO");
    expect(getSecurityQuote(db, ko)!.dividend_yield).toBeCloseTo(3.205, 3);

    // Second refresh whose yield fetcher returns nothing (already-fresh
    // candidate not selected / Finnhub down) must keep the known yield.
    await fetchAndStoreQuotes(db, CFG, "lst", {
      asOfDate: "2026-06-10",
      fetchSnapshot: snapshotStub,
      fetchYields: async () => ({}),
    });
    const q = getSecurityQuote(db, ko)!;
    expect(q.as_of_date).toBe("2026-06-10");
    expect(q.dividend_yield).toBeCloseTo(3.205, 3);
  });

  it("yield-fetcher failure is isolated — quotes still store", async () => {
    const acct = getIbkrAccount();
    const ko = seedSecurity("KO", 8894);
    hold(acct, ko, 100);
    const snapshotStub = async (): Promise<ParsedQuote[]> => [
      { conid: 8894, last: 81.19, ivUnderlying: 0.2, hv30d: 0.18, week52High: 90, week52Low: 60 },
    ];
    const res = await fetchAndStoreQuotes(db, CFG, "lst", {
      asOfDate: "2026-06-09",
      fetchSnapshot: snapshotStub,
      fetchYields: async () => {
        throw new Error("finnhub down");
      },
    });
    expect(res.securitiesUpdated).toBe(1);
    expect(getSecurityQuote(db, ko)!.week52_high).toBe(90);
  });

  it("stores the quote but skips the price write when last is null (warm-up gap)", async () => {
    const acct = getIbkrAccount();
    const aapl = seedSecurity("AAPL", 265598);
    hold(acct, aapl, 100);

    const stub = async (): Promise<ParsedQuote[]> => [
      { conid: 265598, last: null, ivUnderlying: 0.24, hv30d: 0.23, week52High: 316.94, week52Low: 194.47 },
    ];
    const res = await fetchAndStoreQuotes(db, CFG, "lst", { asOfDate: "2026-06-08", fetchSnapshot: stub });

    expect(res.securitiesUpdated).toBe(1);
    expect(res.pricesWritten).toBe(0); // no last → no price row
    expect(getSecurityQuote(db, aapl)!.week52_high).toBe(316.94);
    const px = db.prepare("SELECT COUNT(*) AS c FROM prices WHERE security_id = ?").get(aapl) as { c: number };
    expect(px.c).toBe(0);
  });
});
