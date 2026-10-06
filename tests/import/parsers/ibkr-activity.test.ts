import { describe, it, expect } from "vitest";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";
import fs from "node:fs";
import path from "node:path";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/ibkr-activity-sample.csv"),
  "utf-8"
);

describe("IBKR activity parser", () => {
  it("returns correct source type", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.sourceType).toBe("ibkr-activity");
  });

  it("extracts monthly snapshot with NAV data", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.snapshots).toHaveLength(1);
    const snap = result.snapshots[0];
    expect(snap.accountName).toBe("IBKR");
    expect(snap.monthEndDate).toBe("2025-01-31");
    expect(snap.totalValue).toBe(63000);
    expect(snap.startingValue).toBe(55000);
    expect(snap.markToMarket).toBe(6200);
    expect(snap.dividends).toBe(150);
    expect(snap.interest).toBe(50);
    expect(snap.fees).toBe(-30);
    expect(snap.commissions).toBe(-15.5);
    expect(snap.depositsWithdrawals).toBe(1775.5);
    expect(snap.twr).toBeCloseTo(14.545454545);
  });

  it("parses 'Deposits & Withdrawals' field name (ampersand variant)", () => {
    // Real IBKR CSVs use "Deposits & Withdrawals" not "Deposits/Withdrawals"
    const modified = fixture.replace(
      "Deposits/Withdrawals,1775.5",
      "Deposits & Withdrawals,-100000"
    );
    const result = parseIbkrActivity(modified, "test.csv");
    expect(result.snapshots[0].depositsWithdrawals).toBe(-100000);
  });

  it("parses negative TWR correctly", () => {
    // IBKR reports negative TWR as "-6.43%" — the minus sign must be captured
    const negTwr = fixture.replace("14.545454545%", "-6.426701465%");
    const result = parseIbkrActivity(negTwr, "test.csv");
    expect(result.snapshots[0].twr).toBeCloseTo(-6.426701465);
  });

  it("ignores a secondary zeroed Change-in-NAV block (multi-currency statements)", () => {
    // Regression: securities-lending / multi-currency statements append a SECOND
    // zeroed "Change in NAV" block and a "0%" TWR after the real primary block.
    // The parser must keep the FIRST block's values, not let the zero block
    // overwrite ending value → 0 (which silently drops the whole snapshot).
    const doubled = fixture
      .replace(
        "Change in NAV,Data,Ending Value,63000",
        "Change in NAV,Data,Ending Value,63000\n" +
          "Change in NAV,Header,Field Name,Field Value\n" +
          "Change in NAV,Data,Starting Value,0\n" +
          "Change in NAV,Data,Ending Value,0"
      )
      .replace(
        "Net Asset Value,Data,14.545454545%",
        "Net Asset Value,Data,14.545454545%\n" +
          "Net Asset Value,Header,Time Weighted Rate of Return\n" +
          "Net Asset Value,Data,0%"
      );
    const result = parseIbkrActivity(doubled, "IBKR 2026-05 activity.csv");
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].totalValue).toBe(63000);
    expect(result.snapshots[0].startingValue).toBe(55000);
    expect(result.snapshots[0].twr).toBeCloseTo(14.545454545);
  });

  it("sets twr to undefined when NAV section has no TWR row", () => {
    // Remove the TWR lines from the fixture
    const noTwr = fixture
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("Net Asset Value,Header,Time Weighted") &&
          !line.match(/^Net Asset Value,Data,[\d.]+%/)
      )
      .join("\n");
    const result = parseIbkrActivity(noTwr, "test.csv");
    expect(result.snapshots[0].twr).toBeUndefined();
  });

  it("sets depositsWithdrawals to undefined when not present in CSV", () => {
    // Remove the Deposits/Withdrawals line from the fixture
    const noDW = fixture
      .split("\n")
      .filter((line) => !line.includes("Deposits/Withdrawals"))
      .join("\n");
    const result = parseIbkrActivity(noDW, "test.csv");
    expect(result.snapshots[0].depositsWithdrawals).toBeUndefined();
  });

  it("extracts deposits/withdrawals as external flow transactions", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const deposits = result.transactions.filter((t) => t.type === "DEPOSIT");
    const withdrawals = result.transactions.filter((t) => t.type === "WITHDRAWAL");

    expect(deposits).toHaveLength(1);
    expect(deposits[0].amount).toBe(5000);
    expect(deposits[0].tradeDate).toBe("2025-01-15");
    expect(deposits[0].isExternalFlow).toBe(true);

    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0].amount).toBe(-3224.5);
    expect(withdrawals[0].tradeDate).toBe("2025-01-20");
    expect(withdrawals[0].isExternalFlow).toBe(true);
  });

  it("extracts trades as transactions", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const trades = result.transactions.filter((t) => t.type === "SELL" || t.type === "BUY");
    expect(trades).toHaveLength(2);

    const sell = trades.find((t) => t.type === "SELL");
    expect(sell).toBeTruthy();
    expect(sell!.symbol).toBe("MSFT");
    expect(sell!.quantity).toBe(50);
    expect(sell!.amount).toBe(19350);
    expect(sell!.fees).toBe(2.75);

    const buy = trades.find((t) => t.type === "BUY");
    expect(buy).toBeTruthy();
    expect(buy!.symbol).toBe("GOOG");
    expect(buy!.quantity).toBe(200);
    expect(buy!.amount).toBe(-27200);
  });

  it("parses trades when the optional 'Account' column is absent (single-account statements)", () => {
    // Regression: IBKR omits the "Account" column on single-account statements,
    // shifting every later Trades column by one. Hardcoded indices then read the
    // timestamp into `symbol` and a quantity into `tradeDate`, and validation
    // rejects every trade. Columns must be resolved by name from the header.
    const noAccount = fixture
      .split("\n")
      .map((line) => {
        if (line.startsWith("Trades,")) {
          // The "Account" column is the 6th field (index 5), before the quoted
          // Date/Time, so a plain split/splice/join is lossless here.
          const parts = line.split(",");
          parts.splice(5, 1);
          return parts.join(",");
        }
        return line;
      })
      .join("\n");

    const result = parseIbkrActivity(noAccount, "IBKR 2026-05 activity.csv");
    const trades = result.transactions.filter((t) => t.type === "SELL" || t.type === "BUY");
    expect(trades).toHaveLength(2);
    const sell = trades.find((t) => t.type === "SELL");
    expect(sell!.symbol).toBe("MSFT");
    expect(sell!.quantity).toBe(50);
    expect(sell!.amount).toBe(19350);
    const buy = trades.find((t) => t.type === "BUY");
    expect(buy!.symbol).toBe("GOOG");
    expect(buy!.quantity).toBe(200);
  });

  it("maps a blank T. Price / Comm/Fee cell to undefined, never NaN", () => {
    const line =
      'Trades,Data,Order,Stocks,USD,U99999999,MSFT,"2025-01-10, 10:30:00",-50,387.00,375.00,19350,-2.75,-18750,597.25,600,C';
    const blank = line.replace(",-50,387.00,375.00,19350,-2.75,", ",-50,,375.00,19350,,");
    expect(blank).not.toBe(line);
    const base = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const result = parseIbkrActivity(fixture.replace(line, blank), "IBKR 2025-01 activity.csv");
    const t = result.transactions.find((x) => x.symbol === "MSFT" && x.type === "SELL")!;
    expect(t).toBeTruthy();
    expect(t.fees).toBeUndefined();
    expect(t.pricePerShare).toBeUndefined();
    expect(t.amount).toBe(19350);
    const b = base.transactions.find((x) => x.symbol === "MSFT" && x.type === "SELL")!;
    expect(b.fees).toBe(2.75);
    expect(b.pricePerShare).toBe(387);
    expect(t.sourceKey).toBe(b.sourceKey);
    expect(
      result.warnings.some(
        (w) => w.includes("MSFT 2025-01-10") && /no trade price/.test(w) && /tax lot/.test(w)
      )
    ).toBe(true);
    expect(base.warnings.some((w) => /no trade price/.test(w))).toBe(false);
  });

  it("routes 'Equity and Index Options' trades down the option branch", () => {
    // Regression: real IBKR statements label option trades "Equity and Index
    // Options", never "Options". A strict equality check sent every option
    // trade down the stock branch: type BUY/SELL instead of *_TO_OPEN/_TO_CLOSE,
    // raw IBKR symbol instead of OCC, and securityType "Equity and Index
    // Options" written verbatim. April + May 2026 live imports were affected.
    const withOptionTrades = fixture.replace(
      'Trades,Data,Order,Stocks,USD,U99999999,MSFT,"2025-01-10, 10:30:00",-50,387.00,375.00,19350,-2.75,-18750,597.25,600,C',
      'Trades,Data,Order,Stocks,USD,U99999999,MSFT,"2025-01-10, 10:30:00",-50,387.00,375.00,19350,-2.75,-18750,597.25,600,C\n' +
        'Trades,Data,Order,Equity and Index Options,USD,U99999999,AMPL 15MAY26 8 C,"2025-01-12, 15:55:43",5,0.51,0.525,-255,-3.50,258.50,0,7.5,O;P\n' +
        'Trades,Data,Order,Equity and Index Options,USD,U99999999,AMPL 15MAY26 8 C,"2025-01-13, 10:59:44",-5,0.01,0.0232,5,2.49,-258.50,-251.01,-6.6,C'
    );

    const result = parseIbkrActivity(withOptionTrades, "IBKR 2025-01 activity.csv");

    const open = result.transactions.find((t) => t.type === "BUY_TO_OPEN");
    expect(open).toBeTruthy();
    expect(open!.symbol).toBe("AMPL  260515C00008000");
    expect(open!.quantity).toBe(5);
    expect(open!.amount).toBe(-255);

    const close = result.transactions.find((t) => t.type === "SELL_TO_CLOSE");
    expect(close).toBeTruthy();
    expect(close!.symbol).toBe("AMPL  260515C00008000");

    // The security carries option metadata, not a raw asset-category string
    const sec = result.securities.find((s) => s.symbol === "AMPL  260515C00008000");
    expect(sec).toBeTruthy();
    expect(sec!.securityType).toBe("option");
    expect(sec!.underlyingSymbol).toBe("AMPL");
    expect(sec!.strikePrice).toBe(8);
    expect(sec!.expirationDate).toBe("2026-05-15");
    expect(sec!.multiplier).toBe(100);

    // No raw-symbol stock security should be created for the option
    expect(result.securities.find((s) => s.symbol === "AMPL 15MAY26 8 C")).toBeUndefined();
  });

  it("extracts dividends", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const divs = result.transactions.filter((t) => t.type === "DIVIDEND");
    expect(divs).toHaveLength(2);
    expect(divs[0].amount).toBe(25);
    expect(divs[1].amount).toBe(125);
  });

  it("extracts interest", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const interest = result.transactions.filter((t) => t.type === "INTEREST");
    expect(interest).toHaveLength(1);
    expect(interest[0].amount).toBe(50);
  });

  it("extracts fees", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const fees = result.transactions.filter((t) => t.type === "FEE");
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBe(-30);
  });

  it("extracts securities", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const symbols = result.securities.map((s) => s.symbol);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("MSFT");
    expect(symbols).toContain("GOOG");
  });

  it("has no errors", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.errors).toHaveLength(0);
  });

  it("parses Open Positions into holdings array", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.holdings.length).toBeGreaterThanOrEqual(3);

    const aapl = result.holdings.find((h) => h.symbol === "AAPL");
    expect(aapl).toBeTruthy();
    expect(aapl!.accountName).toBe("IBKR");
    expect(aapl!.quantity).toBe(100);
    expect(aapl!.costBasis).toBe(19000);
    expect(aapl!.asOfDate).toBe("2025-01-31");
    expect(aapl!.sourceKey).toBe("ibkr:pos:2025-01-31:AAPL");

    const goog = result.holdings.find((h) => h.symbol === "GOOG");
    expect(goog).toBeTruthy();
    expect(goog!.quantity).toBe(200);
    expect(goog!.costBasis).toBe(27200);
  });

  it("parses Open Positions options with OCC symbol", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    // SPY 12FEB25 610 P → OCC symbol
    const spyPut = result.holdings.find((h) => h.symbol.includes("SPY"));
    expect(spyPut).toBeTruthy();
    expect(spyPut!.quantity).toBe(5);
    expect(spyPut!.costBasis).toBeCloseTo(2783.43, 1);

    // Should also register as option security
    const optSec = result.securities.find((s) => s.symbol === spyPut!.symbol);
    expect(optSec).toBeTruthy();
    expect(optSec!.securityType).toBe("option");
    expect(optSec!.multiplier).toBe(100);
  });

  it("extracts prices from Open Positions", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.prices.length).toBeGreaterThanOrEqual(3);

    const aaplPrice = result.prices.find((p) => p.symbol === "AAPL");
    expect(aaplPrice).toBeTruthy();
    expect(aaplPrice!.closePrice).toBe(195.5);
    expect(aaplPrice!.date).toBe("2025-01-31");
    expect(aaplPrice!.source).toBe("ibkr-activity");

    const googPrice = result.prices.find((p) => p.symbol === "GOOG");
    expect(googPrice).toBeTruthy();
    expect(googPrice!.closePrice).toBe(140);
  });

  it("disambiguates identical fills with an ordinal instead of dropping them", () => {
    // Two genuinely identical fills (same date/symbol/qty/proceeds) collide on
    // the `ibkr:trade:` source_key and the second is silently dropped by
    // INSERT OR IGNORE at commit — annual statements (1,736 trade rows) raise
    // the odds. Header copied verbatim from a real single-account IBKR annual
    // statement's Trades section:
    // grep "^Trades,Header" "2025 Annual IBKR.csv" | head -1
    const dupTrades =
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Account,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
      'Trades,Data,Order,Stocks,USD,U99999999,AAPL,"2025-03-03, 10:00:00",100,200,200,-20000,-1,20001,0,0,O\n' +
      'Trades,Data,Order,Stocks,USD,U99999999,AAPL,"2025-03-03, 10:00:05",100,200,200,-20000,-1,20001,0,0,O\n';
    const result = parseIbkrActivity(dupTrades, "test.csv");
    const keys = result.transactions.map((t) => t.sourceKey);
    expect(new Set(keys).size).toBe(keys.length); // all unique
    expect(keys[1]).toBe(keys[0] + ":#2");
  });
});

// U9 (2026-10-05): the Dividends, Fees and Deposits & Withdrawals sections are
// per-currency blocks like Interest — native rows, a native "Total", then
// IBKR's own "Total in USD". Non-USD rows convert through that line.
describe("IBKR activity parser — non-USD Dividends / Fees / Deposits & Withdrawals", () => {
  const multi = fs.readFileSync(
    path.join(__dirname, "../../fixtures/ibkr-activity-multicurrency.csv"),
    "utf-8"
  );
  const CASH_TYPES = ["DIVIDEND", "FEE", "DEPOSIT", "WITHDRAWAL"];
  const cashRows = (csv: string) =>
    parseIbkrActivity(csv, "test.csv").transactions.filter((t) =>
      CASH_TYPES.includes(t.type)
    );
  const STATEMENT =
    "Statement,Header,Field Name,Field Value\n" +
    'Statement,Data,Period,"March 1, 2025 - March 31, 2025"\n';

  it("USD byte-identity: the USD-only sample fixture yields the exact pre-change records and source keys", () => {
    // Snapshot computed from the parser BEFORE the U9 change (JSON string, so
    // key order and absent `notes` are pinned too). A changed USD source_key
    // would re-import every historical row as new.
    const before =
      '[{"accountName":"IBKR","tradeDate":"2025-01-31","type":"DIVIDEND","symbol":"AAPL","amount":25,"sourceKey":"ibkr:div:2025-01-31:AAPL:25"},' +
      '{"accountName":"IBKR","tradeDate":"2025-01-31","type":"DIVIDEND","symbol":"SPY","amount":125,"sourceKey":"ibkr:div:2025-01-31:SPY:125"},' +
      '{"accountName":"IBKR","tradeDate":"2025-01-03","type":"FEE","amount":-30,"notes":"Market Data Subscription for Jan 2025","sourceKey":"ibkr:fee:2025-01-03:-30:Market Data Subscription for Jan 2025"},' +
      '{"accountName":"IBKR","tradeDate":"2025-01-15","type":"DEPOSIT","amount":5000,"isExternalFlow":true,"notes":"Electronic Fund Transfer","sourceKey":"ibkr:dw:2025-01-15:5000:Electronic Fund Transfer"},' +
      '{"accountName":"IBKR","tradeDate":"2025-01-20","type":"WITHDRAWAL","amount":-3224.5,"isExternalFlow":true,"notes":"Disbursement Initiated by User","sourceKey":"ibkr:dw:2025-01-20:-3224.5:Disbursement Initiated by User"}]';
    const result = parseIbkrActivity(fixture, "ibkr-activity-sample.csv");
    expect(JSON.stringify(result.transactions.filter((t) => CASH_TYPES.includes(t.type)))).toBe(before);
    expect(JSON.stringify(result.transactions)).toHaveLength(1654);
    expect(result.warnings).toEqual([]);
  });

  it("USD byte-identity: USD rows inside a multi-currency statement are untouched", () => {
    const usd = cashRows(multi).filter((t) => !/converted at IBKR/.test(t.notes ?? ""));
    expect(JSON.stringify(usd)).toBe(
      '[{"accountName":"IBKR","tradeDate":"2025-03-20","type":"DIVIDEND","symbol":"ZZC","amount":25,"sourceKey":"ibkr:div:2025-03-20:ZZC:25"},' +
        '{"accountName":"IBKR","tradeDate":"2025-03-03","type":"FEE","amount":-30,"notes":"Market Data Subscription for Mar 2025","sourceKey":"ibkr:fee:2025-03-03:-30:Market Data Subscription for Mar 2025"},' +
        '{"accountName":"IBKR","tradeDate":"2025-03-15","type":"DEPOSIT","amount":5000,"isExternalFlow":true,"notes":"Electronic Fund Transfer","sourceKey":"ibkr:dw:2025-03-15:5000:Electronic Fund Transfer"},' +
        '{"accountName":"IBKR","tradeDate":"2025-03-20","type":"WITHDRAWAL","amount":-1000,"isExternalFlow":true,"notes":"Disbursement Initiated by User","sourceKey":"ibkr:dw:2025-03-20:-1000:Disbursement Initiated by User"}]'
    );
  });

  it("never emits a Total / Total in USD / grand-total line as a transaction", () => {
    const rows = cashRows(multi);
    // 4 dividends + 2 fees + 4 deposits/withdrawals, all dated.
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.tradeDate))).toBe(true);
    expect(parseIbkrActivity(multi, "test.csv").warnings).toEqual([]);
  });

  it("converts a EUR dividend block pro rata, keeping the native figure in the note and the source key", () => {
    const divs = cashRows(multi).filter((t) => t.type === "DIVIDEND");
    const zza = divs.find((d) => d.symbol === "ZZA")!;
    expect(zza.amount).toBeCloseTo(10 * (76.01 / 70), 9);
    expect(zza.notes).toContain("EUR 10 converted at IBKR's Total-in-USD rate");
    expect(zza.sourceKey).toBe("ibkr:div:2025-03-10:ZZA:10");
    const result = parseIbkrActivity(multi, "test.csv");
    expect(result.securities.map((s) => s.symbol)).toEqual(
      expect.arrayContaining(["ZZA", "ZZB", "ZZC", "ZZD"])
    );
  });

  it("converts a JPY fee, keeping the native figure in the note and the source key", () => {
    const jpy = cashRows(multi).find((t) => t.type === "FEE" && /JPY/.test(t.notes ?? ""))!;
    expect(jpy.amount).toBeCloseTo(-10, 9);
    expect(jpy.notes).toBe(
      "Market Data Subscription JPY for Mar 2025 (JPY -1500 converted at IBKR's Total-in-USD rate)"
    );
    expect(jpy.sourceKey).toBe("ibkr:fee:2025-03-03:-1500:Market Data Subscription JPY for Mar 2025");
  });

  // The fixture's CAD block is single-sign (two deposits): a mixed-sign block
  // is skipped, not converted — see the mixed-sign case below.
  it("converts a single-sign CAD deposit block and keeps the external-flow flag and the direction type", () => {
    const cad = cashRows(multi).filter((t) => /CAD/.test(t.notes ?? ""));
    expect(cad.map((t) => t.type)).toEqual(["DEPOSIT", "DEPOSIT"]);
    expect(cad.every((t) => t.isExternalFlow === true)).toBe(true);
    expect(cad[0].amount).toBeCloseTo(1000 * (1100 / 1500), 9);
    expect(cad[1].amount).toBeCloseTo(500 * (1100 / 1500), 9);
    expect(cad.map((t) => t.sourceKey)).toEqual([
      "ibkr:dw:2025-03-05:1000:Electronic Fund Transfer CAD",
      "ibkr:dw:2025-03-25:500:Electronic Fund Transfer CAD 2",
    ]);
  });

  it("converts a single-sign non-USD withdrawal block and keeps the WITHDRAWAL direction", () => {
    const csv =
      STATEMENT +
      "Deposits & Withdrawals,Header,Currency,Account,Settle Date,Description,Amount\n" +
      "Deposits & Withdrawals,Data,CAD,U99999999,2025-03-25,Disbursement Initiated by User CAD,-500\n" +
      "Deposits & Withdrawals,Data,Total,,,,-500\n" +
      "Deposits & Withdrawals,Data,Total in USD,,,,-360\n";
    const result = parseIbkrActivity(csv, "test.csv");
    const rows = result.transactions.filter((t) => CASH_TYPES.includes(t.type));
    expect(rows.map((t) => [t.type, t.amount, t.isExternalFlow])).toEqual([["WITHDRAWAL", -360, true]]);
    expect(result.warnings).toEqual([]);
  });

  it("conservation: each non-USD block's converted rows sum to IBKR's own Total in USD to the cent", () => {
    const rows = cashRows(multi).filter((t) => /converted at IBKR/.test(t.notes ?? ""));
    const cents = (pred: (t: (typeof rows)[number]) => boolean) =>
      Math.round(rows.filter(pred).reduce((s, t) => s + (t.amount ?? 0), 0) * 100);
    expect(cents((t) => t.type === "DIVIDEND")).toBe(7601); // EUR block
    expect(cents((t) => t.type === "FEE")).toBe(-1000); // JPY block
    expect(cents((t) => t.type === "DEPOSIT" || t.type === "WITHDRAWAL")).toBe(110000); // CAD block
  });

  it("skips a non-USD block with no Total-in-USD line and warns, rather than storing native magnitude as dollars", () => {
    const csv =
      STATEMENT +
      "Dividends,Header,Currency,Account,Date,Description,Amount\n" +
      "Dividends,Data,EUR,U99999999,2025-03-10,ZZA(XX0000000001) Cash Dividend,10\n" +
      "Dividends,Data,Total,,,,10\n" +
      "Dividends,Data,USD,U99999999,2025-03-20,ZZC(XX0000000003) Cash Dividend,25\n" +
      "Dividends,Data,Total,,,,25\n" +
      "Fees,Header,Subtitle,Currency,Account,Date,Description,Amount\n" +
      "Fees,Data,Other Fees,JPY,U99999999,2025-03-03,Market Data JPY,-1500\n" +
      "Fees,Data,Total,,,,,-1500\n" +
      "Deposits & Withdrawals,Header,Currency,Account,Settle Date,Description,Amount\n" +
      "Deposits & Withdrawals,Data,CAD,U99999999,2025-03-05,Electronic Fund Transfer CAD,2000\n" +
      "Deposits & Withdrawals,Data,Total,,,,2000\n";
    const result = parseIbkrActivity(csv, "test.csv");
    const rows = result.transactions.filter((t) => CASH_TYPES.includes(t.type));
    expect(rows.map((t) => [t.type, t.amount])).toEqual([["DIVIDEND", 25]]);
    expect(result.warnings.some((w) => /^Dividends:/.test(w) && /EUR/.test(w) && /Total in USD/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /^Fees:/.test(w) && /JPY/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /^Deposits & Withdrawals:/.test(w) && /CAD/.test(w))).toBe(true);
  });

  it("skips a non-USD block whose native Total is 0 (no ratio derivable) with a warning — never divides by zero", () => {
    const csv =
      STATEMENT +
      "Deposits & Withdrawals,Header,Currency,Account,Settle Date,Description,Amount\n" +
      "Deposits & Withdrawals,Data,CAD,U99999999,2025-03-05,Electronic Fund Transfer CAD,2000\n" +
      "Deposits & Withdrawals,Data,CAD,U99999999,2025-03-25,Disbursement Initiated by User CAD,-2000\n" +
      "Deposits & Withdrawals,Data,Total,,,,0\n" +
      "Deposits & Withdrawals,Data,Total in USD,,,,12\n" +
      "Deposits & Withdrawals,Data,USD,U99999999,2025-03-15,Electronic Fund Transfer,5000\n" +
      "Deposits & Withdrawals,Data,Total,,,,5000\n" +
      "Deposits & Withdrawals,Data,Total Deposits & Withdrawals in USD,,,,5012\n";
    const result = parseIbkrActivity(csv, "test.csv");
    const rows = result.transactions.filter((t) => CASH_TYPES.includes(t.type));
    expect(rows.map((t) => t.amount)).toEqual([5000]);
    expect(rows.every((t) => Number.isFinite(t.amount))).toBe(true);
    // This block is also mixed-sign, so the mixed-sign guard is what skips it;
    // the warning still names the zero native total.
    expect(result.warnings.some((w) => /CAD/.test(w) && /native total 0/.test(w))).toBe(true);
  });

  it("skips a single-sign non-USD block whose printed Total is 0 — no ratio derivable", () => {
    const csv =
      STATEMENT +
      "Fees,Header,Subtitle,Currency,Account,Date,Description,Amount\n" +
      "Fees,Data,Other Fees,JPY,U99999999,2025-03-03,Market Data JPY,-1500\n" +
      "Fees,Data,Total,,,,,0\n" +
      "Fees,Data,Total in USD,,,,,-10\n";
    const result = parseIbkrActivity(csv, "test.csv");
    expect(result.transactions.filter((t) => CASH_TYPES.includes(t.type))).toEqual([]);
    expect(result.warnings.some((w) => /^Fees:/.test(w) && /no usable conversion ratio/.test(w))).toBe(true);
  });

  // IBKR converts each row at its own date's rate, so Total-in-USD / native
  // Total is only a sane exchange rate when the rows share a sign. In a block
  // where a deposit and a withdrawal (or a dividend and its reversal) nearly
  // cancel, net-over-net can be wildly off. Fail closed.
  it("skips a mixed-sign non-USD block with a manual-entry warning instead of applying a net-over-net ratio", () => {
    const csv =
      STATEMENT +
      "Dividends,Header,Currency,Account,Date,Description,Amount\n" +
      "Dividends,Data,EUR,U99999999,2025-03-10,ZZA(XX0000000001) Cash Dividend,100\n" +
      "Dividends,Data,EUR,U99999999,2025-03-12,ZZA(XX0000000001) Cash Dividend (Reversal),-99\n" +
      "Dividends,Data,Total,,,,1\n" +
      "Dividends,Data,Total in USD,,,,3.5\n" +
      "Dividends,Data,USD,U99999999,2025-03-20,ZZC(XX0000000003) Cash Dividend,25\n" +
      "Dividends,Data,USD,U99999999,2025-03-21,ZZC(XX0000000003) Cash Dividend (Reversal),-5\n" +
      "Dividends,Data,Total,,,,20\n" +
      "Dividends,Data,Total Dividends in USD,,,,23.5\n" +
      "Deposits & Withdrawals,Header,Currency,Account,Settle Date,Description,Amount\n" +
      "Deposits & Withdrawals,Data,CAD,U99999999,2025-03-05,Electronic Fund Transfer CAD,2000\n" +
      "Deposits & Withdrawals,Data,CAD,U99999999,2025-03-25,Disbursement Initiated by User CAD,-1990\n" +
      "Deposits & Withdrawals,Data,Total,,,,10\n" +
      "Deposits & Withdrawals,Data,Total in USD,,,,31\n" +
      "Deposits & Withdrawals,Data,JPY,U99999999,2025-03-06,Electronic Fund Transfer JPY,1500\n" +
      "Deposits & Withdrawals,Data,JPY,U99999999,2025-03-07,Electronic Fund Transfer JPY 2,3000\n" +
      "Deposits & Withdrawals,Data,Total,,,,4500\n" +
      "Deposits & Withdrawals,Data,Total in USD,,,,30\n";
    const result = parseIbkrActivity(csv, "test.csv");
    const rows = result.transactions.filter((t) => CASH_TYPES.includes(t.type));
    // The mixed-sign EUR and CAD blocks emit nothing; the mixed-sign USD block
    // and the single-sign JPY block are untouched.
    expect(rows.map((t) => [t.type, Math.round((t.amount ?? 0) * 100) / 100])).toEqual([
      ["DIVIDEND", 25],
      ["DIVIDEND", -5],
      ["DEPOSIT", 10],
      ["DEPOSIT", 20],
    ]);
    const mixed = result.warnings.filter((w) => /mixed-sign/.test(w));
    expect(mixed).toHaveLength(2);
    expect(mixed.some((w) => /^Dividends:/.test(w) && /EUR/.test(w) && /entered manually/.test(w))).toBe(true);
    expect(mixed.some((w) => /^Deposits & Withdrawals:/.test(w) && /CAD/.test(w) && /entered manually/.test(w))).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});
