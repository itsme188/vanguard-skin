import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAllocationByDimension,
  getConcentrationMetrics,
  getFactorHeatmap,
} from "@/lib/queries/analysis";
import { computePositionRisk } from "@/lib/compute/risk";

let db: Database.Database;

function seedAccount(name: string): number {
  return Number(db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid);
}

function seedSecurity(
  symbol: string,
  opts: {
    type?: string;
    fundCategory?: string;
    underlying?: string | null;
    optionType?: "CALL" | "PUT" | null;
    strike?: number | null;
    expiration?: string | null;
    multiplier?: number;
  } = {},
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities
          (symbol, name, security_type, fund_category, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        symbol,
        `${symbol} Test`,
        opts.type ?? "Stock",
        opts.fundCategory ?? "US Equity",
        opts.underlying ?? null,
        opts.optionType ?? null,
        opts.strike ?? null,
        opts.expiration ?? null,
        opts.multiplier ?? 1,
      ).lastInsertRowid,
  );
}

function seedHolding(accountId: number, securityId: number, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-06-09', ?)`,
  ).run(accountId, securityId, quantity, `qa-weight:${accountId}:${securityId}`);
}

function seedFlatPrices(securityId: number, price: number): void {
  for (let day = 1; day <= 40; day++) {
    const date = `2026-05-${String(day).padStart(2, "0")}`;
    const normalized =
      day <= 31 ? date : `2026-06-${String(day - 31).padStart(2, "0")}`;
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')",
    ).run(securityId, normalized, price);
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("analysis diagnostics canonical position weights", () => {
  it("uses one gross-book denominator across concentration, risk, breakdown and heatmap", () => {
    const taxable = seedAccount("Taxable QA");
    const ibkr = seedAccount("IBKR QA");
    const fund = seedSecurity("ZZFUND", { type: "ETF", fundCategory: "Diversified" });
    const option = seedSecurity("ZZFUND 270115C00012000", {
      type: "Option",
      fundCategory: "Options",
      underlying: "ZZFUND",
      optionType: "CALL",
      strike: 12,
      expiration: "2027-01-15",
      multiplier: 100,
    });
    const short = seedSecurity("ZZSHORT", { type: "Stock", fundCategory: "Single Name" });
    const cash = seedSecurity("ZZCASH", { type: "Mutual Fund", fundCategory: "Cash Equivalent" });

    seedHolding(taxable, fund, 100);
    seedHolding(ibkr, fund, 50);
    seedHolding(ibkr, option, 1);
    seedHolding(ibkr, short, -20);
    seedHolding(taxable, cash, 300);

    seedFlatPrices(fund, 10);
    seedFlatPrices(option, 2);
    seedFlatPrices(short, 5);
    seedFlatPrices(cash, 1);

    const scope = [taxable, ibkr];
    const expectedWeight = 1500 / 2100;

    const symbol = getAllocationByDimension(db, "symbol", scope).find(
      (row) => row.group_name === "ZZFUND",
    )!;
    const heatmap = getFactorHeatmap(db, scope).find((row) => row.symbol === "ZZFUND")!;
    const concentration = getConcentrationMetrics(db, scope).top_positions.find(
      (row) => row.symbol === "ZZFUND",
    )!;
    const risk = computePositionRisk(db, {
      accountIds: scope,
      asOfDate: "2026-06-09",
    }).positions.find((row) => row.symbol === "ZZFUND")!;

    expect(symbol.percentage / 100).toBeCloseTo(expectedWeight, 10);
    expect(heatmap.weight_pct / 100).toBeCloseTo(expectedWeight, 10);
    expect(concentration.weight_pct / 100).toBeCloseTo(expectedWeight, 10);
    expect(risk.weight).toBeCloseTo(expectedWeight, 10);

    expect(
      getAllocationByDimension(db, "symbol", scope).reduce((sum, row) => sum + row.percentage, 0),
    ).toBeCloseTo(100, 10);
    expect(getFactorHeatmap(db, scope).reduce((sum, row) => sum + row.weight_pct, 0)).toBeCloseTo(
      100,
      10,
    );
    expect(
      getConcentrationMetrics(db, scope).top_positions.reduce(
        (sum, row) => sum + row.weight_pct,
        0,
      ),
    ).toBeCloseTo(100, 10);
    expect(
      computePositionRisk(db, { accountIds: scope, asOfDate: "2026-06-09" }).positions.reduce(
        (sum, row) => sum + row.weight,
        0,
      ),
    ).toBeCloseTo((1500 + 200 + 300) / 2100, 10);
  });
});
