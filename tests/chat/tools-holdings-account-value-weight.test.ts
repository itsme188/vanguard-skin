/**
 * Owner ruling B (2026-11-12): query_holdings reports each position's weight
 * on the scope's total account value INCLUDING cash, beside the existing
 * gross-exposure `position_weight_pct`.
 *
 * Worked example (synthetic, round figures). IBKR (account 3): value 100,000
 * on the latest daily valuation (20,000 cash + 80,000 holdings). Holdings ZVA
 * 80 shares at 100 = 8,000 and ZVB 720 shares at 100 = 72,000.
 *   ZVA: position_weight_pct      = 8,000 / 80,000 gross    = 10
 *        account_value_weight_pct = 8,000 / 100,000 account = 8
 * Margin: value 50,000 (cash -30,000): ZVA = 8,000 / 50,000 = 16; the
 * account-value weights sum to 160 (levered), never capped at 100.
 * Short: ZVS -10 shares at 100 = -1,000 -> -1 (signed), while its gross
 * weight stays positive.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS, compactToolOutput, compactRoundingFor } from "@/lib/chat/tools";
import { getAccountValueBaseForChat } from "@/lib/queries/chat-tools";
import { getPortfolioCurrentValues } from "@/lib/queries/dashboard";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const TAXABLE = 1;
const IBKR = 3;

let db: Database.Database;
const today = todayET();
const asOf = addDays(today, -1);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSec(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'Stock', 'equity', 1)")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPosition(accountId: number, symbol: string, quantity: number, price: number): void {
  let id = (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number } | undefined)?.id;
  if (id === undefined) {
    id = seedSec(symbol);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(id, asOf, price);
  }
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(accountId, id, quantity, Math.abs(quantity) * price, asOf, `t:${accountId}:${symbol}`);
}

function seedValue(accountId: number, cash: number, holdings: number): void {
  db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, ?, ?, ?)",
  ).run(accountId, asOf, cash, holdings, cash + holdings);
}

type Row = { symbol: string; account_name: string; position_weight_pct: number | null; account_value_weight_pct: number | null };
type Result = { data: Row[]; account_value_base: { account_value_usd: number | null; as_of_date: string | null; reason: string | null } };

async function holdings(input: Record<string, unknown> = {}, scopeAccountIds?: number[]): Promise<Result> {
  return (await executeTool(db, "query_holdings", input, scopeAccountIds ? { scopeAccountIds } : undefined)) as Result;
}
const row = (r: Result, symbol: string, account = "IBKR") => r.data.find((h) => h.symbol === symbol && h.account_name === account)!;

describe("query_holdings: weight on account value including cash", () => {
  it("worked example: 8,000 in a 100,000 account with 20,000 cash is 8 of account value and 10 of gross exposure", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedPosition(IBKR, "ZVB", 720, 100);
    seedValue(IBKR, 20000, 80000);

    const r = await holdings({ account_name: "IBKR" });
    expect(row(r, "ZVA").position_weight_pct).toBeCloseTo(10, 9);
    expect(row(r, "ZVA").account_value_weight_pct).toBeCloseTo(8, 9);
    expect(row(r, "ZVB").account_value_weight_pct).toBeCloseTo(72, 9);
    expect(r.account_value_base.account_value_usd).toBe(100000);
    expect(r.account_value_base.as_of_date).toBe(asOf);
    expect(r.account_value_base.reason).toBeNull();
  });

  it("the base is the dashboard's own reader (getPortfolioCurrentValues) for the scope", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedValue(IBKR, 20000, 80000);
    seedPosition(TAXABLE, "ZVC", 10, 100);
    seedValue(TAXABLE, 4000, 1000);
    expect(getAccountValueBaseForChat(db, [IBKR]).account_value_usd).toBe(getPortfolioCurrentValues(db, [IBKR]).totalValue);
    expect(getAccountValueBaseForChat(db, undefined).account_value_usd).toBe(getPortfolioCurrentValues(db).totalValue);
  });

  it("every account (no account_name) divides by the combined value", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedValue(IBKR, 20000, 80000);
    seedPosition(TAXABLE, "ZVC", 10, 100);
    seedValue(TAXABLE, 99000, 1000);
    // Roth (2) has no value and no holdings: it does not make the base unknown.
    const r = await holdings();
    expect(r.account_value_base.account_value_usd).toBe(200000);
    expect(row(r, "ZVA").account_value_weight_pct).toBeCloseTo(4, 9);
    expect(row(r, "ZVC", "Vanguard Taxable").account_value_weight_pct).toBeCloseTo(0.5, 9);
  });

  it("a symbol filter never narrows the base", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedPosition(IBKR, "ZVB", 720, 100);
    seedValue(IBKR, 20000, 80000);
    const r = await holdings({ account_name: "IBKR", symbol: "ZVA" });
    expect(row(r, "ZVA").account_value_weight_pct).toBeCloseTo(8, 9);
  });

  it("margin debit: the base is net of the debit and the weights may sum past 100", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedPosition(IBKR, "ZVB", 720, 100);
    seedValue(IBKR, -30000, 80000); // account value 50,000
    const r = await holdings({ account_name: "IBKR" });
    expect(row(r, "ZVA").account_value_weight_pct).toBeCloseTo(16, 9);
    const sum = r.data.reduce((a, h) => a + (h.account_value_weight_pct ?? 0), 0);
    expect(sum).toBeCloseTo(160, 9);
  });

  it("a short is signed negative on account value; its gross weight stays positive", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedPosition(IBKR, "ZVS", -10, 100);
    seedValue(IBKR, 93000, 7000); // 8,000 long - 1,000 short + 93,000 cash = 100,000
    const r = await holdings({ account_name: "IBKR" });
    expect(row(r, "ZVS").account_value_weight_pct).toBeCloseTo(-1, 9);
    expect(row(r, "ZVS").position_weight_pct!).toBeGreaterThan(0);
  });

  it("zero, negative or unknown account value gives null, never 0", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedValue(IBKR, -8000, 8000); // zero
    let r = await holdings({ account_name: "IBKR" });
    expect(row(r, "ZVA").account_value_weight_pct).toBeNull();
    expect(r.account_value_base.account_value_usd).toBe(0);
    expect(r.account_value_base.reason).toMatch(/zero or negative/i);

    db.prepare("UPDATE daily_valuations SET cash_balance = -9000, total_value = -1000").run(); // negative
    r = await holdings({ account_name: "IBKR" });
    expect(row(r, "ZVA").account_value_weight_pct).toBeNull();

    db.prepare("DELETE FROM daily_valuations").run(); // unknown
    r = await holdings({ account_name: "IBKR" });
    expect(row(r, "ZVA").account_value_weight_pct).toBeNull();
    expect(r.account_value_base.account_value_usd).toBeNull();
    expect(r.account_value_base.reason).toMatch(/no value on record/i);
  });

  it("an account in scope holding positions with no value makes the combined base unknown", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedValue(IBKR, 20000, 80000);
    seedPosition(TAXABLE, "ZVC", 10, 100); // Taxable has no valuation
    const r = await holdings();
    expect(r.account_value_base.account_value_usd).toBeNull();
    expect(r.account_value_base.reason).toMatch(/Vanguard Taxable/);
    for (const h of r.data) expect(h.account_value_weight_pct).toBeNull();
  });

  it("an empty id list reads no account (never the whole book)", () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedValue(IBKR, 20000, 80000);
    const base = getAccountValueBaseForChat(db, []);
    expect(base.account_value_usd).toBeNull();
  });

  it("a single-account chat uses that account's value", async () => {
    seedPosition(IBKR, "ZVA", 80, 100);
    seedValue(IBKR, 20000, 80000);
    seedValue(TAXABLE, 100000, 0);
    const r = await holdings({}, [IBKR]);
    expect(r.account_value_base.account_value_usd).toBe(100000);
    expect(row(r, "ZVA").account_value_weight_pct).toBeCloseTo(8, 9);
  });

  it("the compact form rounds the new figures deliberately and the description names both bases", async () => {
    expect(compactRoundingFor("query_holdings", "account_value_weight_pct")).toEqual({ dp: 2 });
    expect(compactRoundingFor("query_holdings", "account_value_usd")).toEqual({ dp: 2 });
    seedPosition(IBKR, "ZVA", 3, 100);
    seedPosition(IBKR, "ZVB", 720, 100);
    seedValue(IBKR, 20000.123, 72300);
    const full = await holdings({ account_name: "IBKR" });
    const a = JSON.stringify(compactToolOutput("query_holdings", full));
    const b = JSON.stringify(compactToolOutput("query_holdings", JSON.parse(JSON.stringify(full))));
    expect(a).toBe(b);
    const desc = CHAT_TOOLS.find((t) => t.name === "query_holdings")!.description;
    expect(desc).toContain("account_value_weight_pct");
    expect(desc).toMatch(/GROSS exposure/);
    expect(desc).toMatch(/including cash/i);
    expect(desc).toMatch(/margin/i);
  });
});
