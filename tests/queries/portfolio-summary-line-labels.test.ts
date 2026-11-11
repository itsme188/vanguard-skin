/**
 * RF-10: every figure on a holdings or short line carries its own label.
 *
 * The holdings line printed "G/L:+$300 (50.0%)" where 50.0% was the position
 * WEIGHT; a reader (the model) took it as the return. Now value, cost basis,
 * gain/loss (with the gain as a percent of cost, the figure query_holdings
 * returns) and weight are each named, and the weight's base is stated once in
 * the section header: the scope's priced long market value, the same base as
 * query_holdings' position_weight_pct.
 *
 * Account 3 (IBKR) from the migration seed. Synthetic tickers, small figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3;
let db: Database.Database;

function hold(securityId: number, qty: number, basis: number | null): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(IBKR, securityId, qty, basis, todayET(), `rf10-${securityId}`);
}

beforeEach(() => {
  db = createPendingTestDb();
  const px = todayET();
  // Long ZZG: 10 at 50 = value 500, basis 200 -> gain +300, +150.0% of cost.
  const g = seedSec(db, "ZZG");
  db.prepare("UPDATE securities SET sector = 'Technology' WHERE id = ?").run(g);
  hold(g, 10, 200);
  seedPx(db, g, px, 50);
  // Long ZZH: 20 at 25 = value 500, basis 600 -> loss -100, -16.7% of cost.
  const h = seedSec(db, "ZZH");
  hold(h, 20, 600);
  seedPx(db, h, px, 25);
  // Short ZZK: 4 at 25 = value -100 (the liability).
  const k = seedSec(db, "ZZK");
  hold(k, -4, null);
  seedPx(db, k, px, 25);
  // Long book = 500 + 500 = 1,000, so each long weighs 50.0% (not its gain).
});

describe("holdings and short lines label every figure", () => {
  it("a long line names value, cost basis, gain/loss and weight", () => {
    const s = getPortfolioSummaryForChat(db);
    expect(s).toContain(
      "- ZZG (IBKR): 10 shares; value $500; cost basis $200; gain/loss +$300 (+150.0% of cost); weight 50.0%; sector Technology"
    );
    expect(s).toContain("- ZZH (IBKR): 20 shares; value $500; cost basis $600; gain/loss -$100 (-16.7% of cost); weight 50.0%");
    expect(s).not.toMatch(/G\/L:|MV:/);
  });

  it("the section header states the weight's base once", () => {
    const s = getPortfolioSummaryForChat(db);
    expect(s).toContain(
      "### Current Holdings — long positions (verified, quantity > 0; weight = share of the priced long market value in this scope; short positions are listed in the next section)"
    );
  });

  it("a short line names its value as the liability", () => {
    expect(getPortfolioSummaryForChat(db)).toContain("- ZZK (IBKR): short 4 shares; value -$100 (liability)");
  });

  it("weight and gain percent equal query_holdings' figures for the same scope", () => {
    const s = getPortfolioSummaryForChat(db, "IBKR");
    for (const row of getHoldingsForChat(db, { account_name: "IBKR" })) {
      const line = s.split("\n").find((l) => l.startsWith(`- ${row.symbol} (`)) ?? "";
      expect(line).toContain(`weight ${row.position_weight_pct!.toFixed(1)}%`);
      const pct = row.unrealized_gain_pct!;
      expect(line).toContain(`(${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% of cost)`);
    }
  });

  it("allocation percentages name themselves as shares of a stated base", () => {
    const s = getPortfolioSummaryForChat(db);
    expect(s).toContain("### Asset Allocation (share = of the priced long market value in this scope)");
    expect(s).toContain("- Stock: $1,000 (100.0% share, 2 positions)");
    expect(s).toContain("### Sector Allocation (share = of the priced long market value in this scope)");
    expect(s).toContain("- Technology: $500 (50.0% share)");
    expect(s).toContain("- Unclassified: $500 (50.0% share, 1 positions without sector data)");
  });

  it("a recent transaction's dollar figure is labelled as its amount", () => {
    const g = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZG'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, '2025-05-01', 'BUY', 10, -200, 'rf10-txn')`
    ).run(IBKR, g);
    expect(getPortfolioSummaryForChat(db)).toContain("- 2025-05-01 | IBKR | BUY ZZG 10 shares amount $200");
  });
});
