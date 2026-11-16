/**
 * Review 2026-11-16 (FX3): an unmeasured proxy-fund beta is usually a gap in
 * what THIS APP has collected, not in the fund's own history. The reason says
 * so, and each not-credited row carries what resolveProxyBeta found on file:
 * daily closes in `prices` / `benchmark_prices`, the usable day-to-day moves
 * against SPY, and the moves the house gate needs (MIN_BETA_PAIRS).
 * resolveProxyBeta never reads `ohlcv_bars` (the chart's table), so chart
 * bars must not count. Nothing about what is credited changes.
 */
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { MIN_BETA_PAIRS } from "@/lib/compute/beta-confidence";
import {
  computeDefenseAnalysis,
  countAlignedReturnPairs,
  resolveProxyBeta,
  NOT_CREDITED_BETA_NO_HISTORY,
} from "@/lib/compute/hedging";

function db() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

const BASE = "2026-03-02"; // a Monday
const day = (i: number) => addDays(BASE, i);

function security(d: Database.Database, symbol: string, type = "ETF", sector: string | null = "Energy") {
  return d
    .prepare("INSERT INTO securities (symbol, name, security_type, sector, asset_class, source_key) VALUES (?, ?, ?, ?, 'equity', ?)")
    .run(symbol, symbol, type, sector, `t:${symbol}`).lastInsertRowid as number;
}

function closes(d: Database.Database, sid: number, days: number[]) {
  const st = d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')");
  for (const i of days) st.run(sid, 100 + (i % 3), day(i));
}

function spy(d: Database.Database, days: number[]) {
  const st = d.prepare("INSERT INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)");
  for (const i of days) st.run(day(i), 400 + (i % 5));
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("FX3: resolveProxyBeta reports what is on file", () => {
  it("counts daily closes and usable moves against SPY, and the moves needed", () => {
    const d = db();
    const sid = security(d, "ZZF");
    closes(d, sid, range(10));
    spy(d, range(40));
    const r = resolveProxyBeta(d, "ZZF");
    expect(r.source).toBe("unmeasured");
    if (r.source !== "unmeasured") return;
    expect(r.reason).toBe("no_history");
    expect(r.history).toEqual({ closesOnFile: 10, usablePairs: 9, pairsNeeded: MIN_BETA_PAIRS });
  });

  it("a close more than a week from the one before gives no usable move", () => {
    const d = db();
    const sid = security(d, "ZZG");
    closes(d, sid, [0, 1, 2, 20, 21]);
    spy(d, range(30));
    const r = resolveProxyBeta(d, "ZZG");
    expect(r.source === "unmeasured" && r.history).toEqual({ closesOnFile: 5, usablePairs: 3, pairsNeeded: MIN_BETA_PAIRS });
  });

  it("never counts chart bars (ohlcv_bars): resolveProxyBeta does not read them", () => {
    const d = db();
    const sid = security(d, "ZZH");
    closes(d, sid, [0, 1]);
    spy(d, range(60));
    const bar = d.prepare(
      "INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume) VALUES (?, ?, '1 day', 100, 101, 99, 100, 1)"
    );
    for (const i of range(60)) bar.run(sid, day(i));
    const r = resolveProxyBeta(d, "ZZH");
    expect(r.source).toBe("unmeasured");
    expect(r.source === "unmeasured" && r.history?.closesOnFile).toBe(2);
  });

  it("countAlignedReturnPairs matches the regression's own pair count when one runs", () => {
    const sec = range(12).map((i) => ({ date: day(i), close: 100 + (i % 4) }));
    const bench = range(12).map((i) => ({ date: day(i), close: 400 + (i % 3) }));
    expect(countAlignedReturnPairs(sec, bench)).toBe(11);
  });
});

describe("FX3: the not-credited row carries the history and the new reason", () => {
  it("names what the app has not collected, with the counts; the protection ratio is untouched", () => {
    const d = db();
    const acct = d.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run().lastInsertRowid as number;
    const asOf = todayET();
    const hold = (sid: number, qty: number, price: number) => {
      d.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)").run(
        acct,
        sid,
        qty,
        qty * price,
        asOf
      );
      d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')").run(sid, price, asOf);
    };
    hold(security(d, "ZZE", "Stock", "Energy"), 1000, 100);
    const fund = security(d, "ZZU");
    d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, ?, 'test')").run(fund, asOf);
    const expiry = addDays(asOf, 180);
    const put = d
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, 'ZZU PUT', 'Option', 'ZZU', 'PUT', 100, ?, 100)`
      )
      .run(`ZZU   ${expiry.replace(/-/g, "").slice(2)}P00100000`, expiry).lastInsertRowid as number;
    hold(put, 2, 5);

    const r = computeDefenseAnalysis(d, [acct]);
    const row = r.notCreditedHedges.find((h) => h.underlying === "ZZU")!;
    expect(row.reason).toBe(NOT_CREDITED_BETA_NO_HISTORY);
    expect(row.reason).toBe("this app has not collected enough of its price history to measure a beta");
    expect(row.betaHistory).toEqual({ closesOnFile: 1, usablePairs: 0, pairsNeeded: MIN_BETA_PAIRS });
    expect(r.hedgeScores.some((h) => h.underlying === "ZZU")).toBe(false);
    const diag = r.diagnostics.find((x) => x.kind === "unmeasured_beta" && x.symbol === "ZZU")!;
    expect(diag.detail).toMatch(/has not collected enough price history/);
    expect(diag.detail).toMatch(/1 daily closes on file, 0 usable day-to-day moves, 30 needed/);
  });
});
