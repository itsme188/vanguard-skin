import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";
import { commitImport } from "@/lib/import/engine";

const HEADER =
  "Statement,Header,Field Name,Field Value\n" +
  'Statement,Data,Period,"January 1, 2024 - December 31, 2024"\n';

const TRANSFERS =
  "Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code\n" +
  'Transfers,Data,Stocks,USD,U13643679,SQQQ,2024-01-05,ACATS,In,--,118056084,"2,500",--,"37,100.00",0.00,0.00,\n' +
  "Transfers,Data,Stocks,USD,U13643679,TQQQ,2024-01-05,ACATS,In,--,118056084,150,--,\"6,871.50\",0.00,0.00,\n" +
  "Transfers,Data,Total,,,,,,,,,,,63496,0,0,\n";

describe("ibkr-activity Transfers section", () => {
  it("parses stock ACATS In legs as TRANSFER_IN with MV-derived price", () => {
    const result = parseIbkrActivity(HEADER + TRANSFERS, "test.csv");
    const xfers = result.transactions.filter((t) => t.type === "TRANSFER_IN");
    expect(xfers).toHaveLength(2);
    const sqqq = xfers.find((t) => t.symbol === "SQQQ")!;
    expect(sqqq.quantity).toBe(2500);
    expect(sqqq.tradeDate).toBe("2024-01-05");
    expect(sqqq.pricePerShare).toBeCloseTo(37100 / 2500, 6); // 14.84
    expect(sqqq.amount).toBeCloseTo(37100, 2);
    expect(sqqq.sourceKey).toBe("ibkr:xfer:2024-01-05:SQQQ:2500:In");
  });

  it("skips the Total row and non-stock rows, and maps Out direction", () => {
    const out =
      "Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code\n" +
      'Transfers,Data,Stocks,USD,U13643679,ABC,2024-06-01,ACATS,Out,--,999,100,--,"1,000.00",0.00,0.00,\n' +
      "Transfers,Data,Cash,USD,U13643679,,2024-06-01,ACATS,In,--,999,,,,,500.00,\n" +
      "Transfers,Data,Total,,,,,,,,,,,1000,0,0,\n";
    const result = parseIbkrActivity(HEADER + out, "test.csv");
    const xfers = result.transactions.filter((t) => t.type.startsWith("TRANSFER"));
    expect(xfers).toHaveLength(1);
    expect(xfers[0].type).toBe("TRANSFER_OUT");
    expect(xfers[0].symbol).toBe("ABC");
  });

  it("registers the transferred symbol as a Stock security", () => {
    const result = parseIbkrActivity(HEADER + TRANSFERS, "test.csv");
    const sqqqSec = result.securities.find((s) => s.symbol === "SQQQ");
    expect(sqqqSec).toBeTruthy();
    expect(sqqqSec!.securityType).toBe("Stock");
  });

  it("produces no warnings for an ordinary Stocks + Cash + Total transfers block", () => {
    const withCash =
      "Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code\n" +
      'Transfers,Data,Stocks,USD,U13643679,ABC,2024-06-01,ACATS,Out,--,999,100,--,"1,000.00",0.00,0.00,\n' +
      "Transfers,Data,Cash,USD,U13643679,,2024-06-01,ACATS,In,--,999,,,,,500.00,\n" +
      "Transfers,Data,Total,,,,,,,,,,,1000,0,0,\n";
    const result = parseIbkrActivity(HEADER + withCash, "test.csv");
    expect(result.warnings).toHaveLength(0);
  });

  it("warns (but doesn't drop the row silently) on a non-Stocks, non-Cash transfer leg it can't yet convert", () => {
    // A hypothetical Bonds ACATS leg — not yet handled by this parser (only
    // "Stocks" legs become TRANSFER_IN/TRANSFER_OUT). Must surface a warning
    // instead of vanishing without a trace.
    const bondLeg =
      "Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code\n" +
      'Transfers,Data,Bonds,USD,U13643679,912828XX1,2024-06-01,ACATS,In,--,999,10,--,"9,800.00",0.00,0.00,\n' +
      "Transfers,Data,Total,,,,,,,,,,,9800,0,0,\n";
    const result = parseIbkrActivity(HEADER + bondLeg, "test.csv");

    const xfers = result.transactions.filter((t) => t.type.startsWith("TRANSFER"));
    expect(xfers).toHaveLength(0);

    expect(
      result.warnings.some((w) => w.includes("Bonds") && w.includes("912828XX1"))
    ).toBe(true);
  });

  describe("commitImport integration", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db);
    });

    it("lands a TRANSFER_IN row through validation + commit with the right price_per_share", () => {
      const parsed = parseIbkrActivity(HEADER + TRANSFERS, "test.csv");
      const result = commitImport(db, parsed);

      expect(result.newTransactions).toBeGreaterThanOrEqual(2);

      const row = db
        .prepare(
          `SELECT type, quantity, price_per_share, amount, is_external_flow
           FROM transactions WHERE source_key = ?`
        )
        .get("ibkr:xfer:2024-01-05:SQQQ:2500:In") as
        | {
            type: string;
            quantity: number;
            price_per_share: number;
            amount: number;
            is_external_flow: number;
          }
        | undefined;

      expect(row).toBeTruthy();
      expect(row!.type).toBe("TRANSFER_IN");
      expect(row!.quantity).toBe(2500);
      expect(row!.price_per_share).toBeCloseTo(37100 / 2500, 6);
      expect(row!.amount).toBeCloseTo(37100, 2);
      expect(row!.is_external_flow).toBe(1);
    });
  });
});
