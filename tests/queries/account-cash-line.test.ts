import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAccountCashLine,
  LIVE_SNAPSHOT_TIMING_RESIDUAL_PHRASE,
} from "@/lib/queries/account-cash-line";

/**
 * The single-account Holdings footer states a positions total, a Cash line
 * and an account total taken from ONE daily_valuations row, so the three
 * figures tie by construction (total_value = holdings_value + cash_balance
 * is how lib/compute/daily-valuation.ts writes the row).
 *
 * Fixtures are synthetic: ZZ* tickers, round numbers.
 */
describe("getAccountCashLine", () => {
  let db: Database.Database;
  let accountId: number;
  let otherAccountId: number;

  function seedValuation(
    account: number,
    date: string,
    cash: number,
    holdings: number,
    counts: { holdings: number; priced: number } = { holdings: 2, priced: 2 },
  ): void {
    db.prepare(
      `INSERT INTO daily_valuations
         (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(account, date, cash, holdings, cash + holdings, counts.holdings, counts.priced);
  }

  function seedAnchor(
    account: number,
    date: string,
    source: string,
    opts: { total?: number; cashValue?: number | null } = {},
  ): void {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, cash_value)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(account, date, opts.total ?? 1000, source, opts.cashValue ?? null);
  }

  function seedHolding(
    account: number,
    symbol: string,
    asOfDate: string,
    quantity: number,
    sec: { securityType?: string; fundCategory?: string | null; currency?: string } = {},
  ): number {
    const existing = db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as
      | { id: number }
      | undefined;
    const securityId =
      existing?.id ??
      (db
        .prepare(
          "INSERT INTO securities (symbol, name, security_type, fund_category, currency) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          symbol,
          `${symbol} Corp`,
          sec.securityType ?? "Stock",
          sec.fundCategory ?? null,
          sec.currency ?? "USD",
        ).lastInsertRowid as number);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(account, securityId, quantity, asOfDate, `zz:${account}:${symbol}:${asOfDate}`);
    return securityId;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Broker One')").run()
      .lastInsertRowid as number;
    otherAccountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Broker Two')").run()
      .lastInsertRowid as number;
  });

  it("returns null when the account has no daily valuation", () => {
    expect(getAccountCashLine(db, accountId)).toBeNull();
  });

  it("reads the latest row of THIS account, with its date, and the three figures tie", () => {
    seedValuation(accountId, "2026-03-02", 100, 900);
    seedValuation(accountId, "2026-03-03", 300, 700);
    // A newer, larger row on another account must never leak in.
    seedValuation(otherAccountId, "2026-03-04", 5000, 5000);
    seedAnchor(accountId, "2026-03-02", "statement");
    seedAnchor(otherAccountId, "2026-03-04", "statement");

    const line = getAccountCashLine(db, accountId);

    expect(line).not.toBeNull();
    expect(line!.accountId).toBe(accountId);
    expect(line!.valuationDate).toBe("2026-03-03");
    expect(line!.cashBalance).toBe(300);
    expect(line!.holdingsValue).toBe(700);
    expect(line!.totalValue).toBe(1000);
    expect(line!.holdingsValue + line!.cashBalance!).toBe(line!.totalValue);

    const other = getAccountCashLine(db, otherAccountId);
    expect(other!.valuationDate).toBe("2026-03-04");
    expect(other!.cashBalance).toBe(5000);
  });

  it("carries the row's priced / total position counts", () => {
    seedValuation(accountId, "2026-03-03", 300, 700, { holdings: 4, priced: 3 });
    const line = getAccountCashLine(db, accountId)!;
    expect(line.holdingsCount).toBe(4);
    expect(line.pricedCount).toBe(3);
  });

  describe("live-source flag", () => {
    it("is false, with no caption, when the governing anchor is a statement", () => {
      seedValuation(accountId, "2026-02-27", 300, 700);
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedAnchor(accountId, "2026-02-28", "statement");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBe("2026-02-28");
      expect(line.isLiveSource).toBe(false);
      expect(line.liveSourceCaption).toBeNull();
    });

    it.each(["tws", "plaid"])("is true, with the caption, when the anchor on the valuation date is %s", (source) => {
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedAnchor(accountId, "2026-02-28", "statement", { cashValue: 300 });
      seedAnchor(accountId, "2026-03-03", source);

      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBe("2026-03-03");
      expect(line.isLiveSource).toBe(true);
      expect(line.liveSourceCaption).toContain(LIVE_SNAPSHOT_TIMING_RESIDUAL_PHRASE);
    });

    it("stays true on a later day whose cash is carried forward from a live anchor", () => {
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedValuation(accountId, "2026-03-04", 300, 720);
      seedAnchor(accountId, "2026-03-03", "tws");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.valuationDate).toBe("2026-03-04");
      expect(line.anchorDate).toBe("2026-03-03");
      expect(line.isLiveSource).toBe(true);
    });

    it("ignores an anchor dated after the valuation and another account's anchors", () => {
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedAnchor(accountId, "2026-03-03", "statement");
      seedAnchor(accountId, "2026-03-05", "tws", { cashValue: 1 });
      seedAnchor(otherAccountId, "2026-03-03", "plaid", { cashValue: 1 });

      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBe("2026-03-03");
      expect(line.isLiveSource).toBe(false);
    });

    it("names no owner when the newest anchor is one the valuation engine could not resolve", () => {
      // Statement anchor resolves through the valuation row two days earlier.
      seedValuation(accountId, "2026-02-26", 300, 700);
      seedAnchor(accountId, "2026-02-28", "statement");
      // Live anchor with no valuation row in its five-day lookback and no
      // broker-reported cash. The engine skips it, but it still ends the
      // statement anchor's window: rows from its date on keep placeholder
      // cash. So the statement anchor does NOT own the latest row.
      seedAnchor(accountId, "2026-03-20", "tws");
      seedValuation(accountId, "2026-03-30", 0, 700);

      const line = getAccountCashLine(db, accountId)!;
      expect(line.valuationDate).toBe("2026-03-30");
      expect(line.anchorDate).toBeNull();
      expect(line.cashAnchored).toBe(false);
      expect(line.cashBalance).toBeNull();
      expect(line.isLiveSource).toBe(false);
    });

    it("reports no anchor when none exists on or before the valuation date", () => {
      seedValuation(accountId, "2026-03-03", 0, 700);
      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBeNull();
      expect(line.isLiveSource).toBe(false);
      expect(line.liveSourceCaption).toBeNull();
      // No owner, so no cash and no total: positions only.
      expect(line.cashAnchored).toBe(false);
      expect(line.cashBalance).toBeNull();
      expect(line.totalValue).toBeNull();
      expect(line.holdingsValue).toBe(700);
    });
  });

  describe("cash-equivalent holdings rows", () => {
    it("names the latest held sweep funds, which daily valuations count as cash", () => {
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedHolding(accountId, "ZZSTK", "2026-03-03", 10);
      seedHolding(accountId, "ZZSWEEP", "2026-03-03", 300, {
        securityType: "Mutual Fund",
        fundCategory: "Cash Equivalent",
      });
      seedHolding(accountId, "ZZMMKT", "2026-03-03", 50, { securityType: "money_market" });
      // Another account's sweep fund is not this page's row.
      seedHolding(otherAccountId, "ZZOTHER", "2026-03-03", 300, {
        securityType: "Mutual Fund",
        fundCategory: "Cash Equivalent",
      });

      const line = getAccountCashLine(db, accountId)!;
      expect(line.cashEquivalentSymbols).toEqual(["ZZMMKT", "ZZSWEEP"]);
    });

    it("drops a sweep fund whose latest row is a zero-quantity tombstone", () => {
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedHolding(accountId, "ZZSWEEP", "2026-02-28", 300, {
        securityType: "Mutual Fund",
        fundCategory: "Cash Equivalent",
      });
      seedHolding(accountId, "ZZSWEEP", "2026-03-03", 0);

      expect(getAccountCashLine(db, accountId)!.cashEquivalentSymbols).toEqual([]);
    });

    it("is empty for a broker account with no sweep-fund row", () => {
      seedValuation(accountId, "2026-03-03", 300, 700);
      seedHolding(accountId, "ZZSTK", "2026-03-03", 10);
      expect(getAccountCashLine(db, accountId)!.cashEquivalentSymbols).toEqual([]);
    });
  });

  it("does not convert again: daily valuations are already US dollars, even beside a non-USD holding", () => {
    // lib/compute/daily-valuation.ts applies the FX factor when it WRITES
    // holdings_value, and cash is the broker total (US dollars) minus that.
    // Threading a second factor here would double-convert.
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.01, '2026-03-03', 'ibkr_ledger')",
    ).run();
    seedHolding(accountId, "ZZJPY", "2026-03-03", 100, { currency: "JPY" });
    seedValuation(accountId, "2026-03-03", 300, 700);
    seedAnchor(accountId, "2026-03-03", "statement");

    const line = getAccountCashLine(db, accountId)!;
    expect(line.cashBalance).toBe(300);
    expect(line.holdingsValue).toBe(700);
    expect(line.totalValue).toBe(1000);
  });

  it("reuses the reconciliation surface's wording for a live-snapshot day", () => {
    // One wording, two surfaces: the Data Confidence detail line and this
    // caption. A reworded source fails here instead of silently diverging.
    const dataConfidence = readFileSync("lib/queries/data-confidence.ts", "utf8");
    expect(dataConfidence).toContain(LIVE_SNAPSHOT_TIMING_RESIDUAL_PHRASE);
  });

  it("classifies the anchor source through the shared live-source helper", () => {
    const src = readFileSync("lib/queries/account-cash-line.ts", "utf8");
    expect(src).toContain("onlyLiveSnapshotsSql(");
    expect(src).toContain("latestHoldingsPredicate(");
    expect(src).toContain("isCashEquivalentSecurity(");
    expect(src).not.toMatch(/'tws'|'plaid'/);
  });
});
