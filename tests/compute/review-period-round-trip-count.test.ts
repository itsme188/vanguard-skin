/**
 * QA analysis-trade-reviews--picker-trade-count-contradicts-card (owner ruling
 * 2026-08-19, option 2): the Trade Reviews month picker and the review card
 * both count ROUND TRIPS. No leg counts on either surface.
 *
 * The card's number is whatever `prepareTradeReview` counted when the review
 * was generated: closing transactions, grouped, minus engine-owned closes,
 * minus closes whose matched lots cover under 90% of the quantity closed. The
 * picker used a second, SQL copy of that rule, and the two copies disagreed on
 * a mixed open-and-close fill whose matched lots are partly outside the
 * review's own row filter. The picker now counts through the generator's own
 * functions (`countReviewRoundTrips`), so the two cannot drift.
 *
 * All figures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  computeGroupedTrades,
  countReviewRoundTrips,
  detectNewTradeReviewPeriods,
  filterFullyCoveredTrades,
  getAvailableReviewPeriods,
  getRoundTrips,
  partitionSyntheticCloses,
} from "@/lib/compute/trade-roundtrips";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";

let db: Database.Database;
const ACCOUNT = 3;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare(
    "INSERT INTO securities(id,symbol,name,security_type) VALUES(1,'AAA','Long Co','Stock'),(2,'ZZZ','Short Co','Stock'),(3,'MMM','Mixed Co','Stock'),(4,'PPP','Partial Co','Stock')"
  ).run();
});
afterEach(() => db.close());

function trade(securityId: number, type: string, date: string, qty: number, price: number, code: string) {
  return db
    .prepare(
      "INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees,notes) VALUES(?,?,?,?,?,?,?,0,?)"
    )
    .run(ACCOUNT, securityId, type, date, qty, price, (type === "BUY" ? -1 : 1) * qty * price, ibkrTradeDirectionNote(code, `${date}, 12:00:00`))
    .lastInsertRowid as number;
}

/** What a review generated now would count for the month — the card's number. */
function generatorCount(periodStart: string, periodEnd: string): number {
  const grouped = computeGroupedTrades(getRoundTrips(db, ACCOUNT, periodStart, periodEnd));
  return filterFullyCoveredTrades(partitionSyntheticCloses(grouped).userTrades).length;
}

describe("review periods count round trips, the same way the review does", () => {
  it("a long and a short round trip each count once, and both gains are positive", () => {
    // Long: buy 10 at 50, sell 10 at 60. Gain = 10 x (60 - 50) = +100, +20%.
    trade(1, "BUY", "2026-08-03", 10, 50, "O");
    trade(1, "SELL", "2026-08-10", 10, 60, "C");
    // Short: sell 10 at 100 to open, buy 10 at 90 to cover.
    // Gain = 10 x (100 - 90) = +100. A profitable short is a POSITIVE return.
    trade(2, "SELL", "2026-08-12", 10, 100, "O");
    trade(2, "BUY", "2026-08-14", 10, 90, "C");
    computeTaxLots(db);

    const trips = getRoundTrips(db, ACCOUNT, "2026-08-01", "2026-08-31");
    const long = trips.find((t) => t.symbol === "AAA")!;
    const short = trips.find((t) => t.symbol === "ZZZ")!;
    expect(long).toMatchObject({ isShort: false, realizedPnl: 100, holdingDays: 7 });
    expect(long.returnPct).toBeCloseTo(20);
    expect(short).toMatchObject({ isShort: true, realizedPnl: 100, holdingDays: 2 });
    expect(short.returnPct).toBeGreaterThan(0);

    expect(countReviewRoundTrips(trips)).toBe(2);
    expect(getAvailableReviewPeriods(db, ACCOUNT)).toEqual([
      { periodStart: "2026-08-01", periodEnd: "2026-08-31", tradeCount: 2, reviewableCount: 2 },
    ]);
  });

  it("several lots closed by one sale are one round trip, not one per lot", () => {
    trade(1, "BUY", "2026-08-03", 4, 50, "O");
    trade(1, "BUY", "2026-08-04", 6, 55, "O");
    trade(1, "SELL", "2026-08-10", 10, 60, "C");
    computeTaxLots(db);

    expect(getRoundTrips(db, ACCOUNT, "2026-08-01", "2026-08-31")).toHaveLength(2);
    expect(getAvailableReviewPeriods(db, ACCOUNT)[0].reviewableCount).toBe(1);
    expect(generatorCount("2026-08-01", "2026-08-31")).toBe(1);
  });

  it("a mixed fill the review would drop for thin lot history is not counted by the picker either", () => {
    // One fully-tracked long round trip the review will keep.
    trade(1, "BUY", "2026-08-03", 10, 50, "O");
    trade(1, "SELL", "2026-08-10", 10, 60, "C");
    computeTaxLots(db);

    // A close-and-open fill of 10. Two matched lot rows of 5: one opened
    // before the close, one dated AFTER it (a legacy pairing the review's row
    // filter leaves out). The review sees 5 of 10 matched = 50% coverage and
    // drops the fill.
    const mixed = trade(3, "SELL", "2026-08-20", 10, 30, "C;O");
    const lot = db.prepare(
      "INSERT INTO tax_lots(account_id,security_id,acquisition_date,acquisition_price,quantity_acquired,quantity_remaining,cost_basis) VALUES(?,?,?,?,?,0,?)"
    );
    const sale = db.prepare(
      "INSERT INTO tax_lot_sales(tax_lot_id,sale_transaction_id,sale_date,quantity_sold,sale_price,proceeds,cost_basis_allocated,realized_gain_loss,is_long_term,holding_period_days) VALUES(?,?,?,?,?,?,?,?,0,?)"
    );
    const before = lot.run(ACCOUNT, 3, "2026-08-05", 20, 5, 100).lastInsertRowid;
    const after = lot.run(ACCOUNT, 3, "2026-08-25", 20, 5, 100).lastInsertRowid;
    sale.run(before, mixed, "2026-08-20", 5, 30, 150, 100, 50, 15);
    sale.run(after, mixed, "2026-08-20", 5, 30, 150, 100, 50, -5);

    const card = generatorCount("2026-08-01", "2026-08-31");
    expect(card).toBe(1);
    const [period] = getAvailableReviewPeriods(db, ACCOUNT);
    expect(period.tradeCount).toBe(2);
    expect(period.reviewableCount).toBe(card);
  });

  it("matches the generator month by month, with partial-history and engine closes left out", () => {
    trade(1, "BUY", "2026-07-01", 10, 50, "O");
    trade(1, "SELL", "2026-07-15", 10, 60, "C");
    trade(2, "SELL", "2026-08-12", 10, 100, "O");
    trade(2, "BUY", "2026-08-14", 10, 90, "C");
    trade(1, "BUY", "2026-08-03", 10, 50, "O");
    trade(1, "SELL", "2026-08-10", 10, 60, "C");
    computeTaxLots(db);
    // A sale of 100 with only 50 matched (position pre-dates the imported
    // history): a closing leg, but not a reviewable round trip.
    const partial = db
      .prepare("INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees) VALUES(?,4,'SELL','2026-08-20',100,20,2000,0)")
      .run(ACCOUNT).lastInsertRowid;
    const lotId = db
      .prepare("INSERT INTO tax_lots(account_id,security_id,acquisition_date,acquisition_price,quantity_acquired,quantity_remaining,cost_basis) VALUES(?,4,'2026-08-05',10,50,0,500)")
      .run(ACCOUNT).lastInsertRowid;
    db.prepare(
      "INSERT INTO tax_lot_sales(tax_lot_id,sale_transaction_id,sale_date,quantity_sold,sale_price,proceeds,cost_basis_allocated,realized_gain_loss,is_long_term,holding_period_days) VALUES(?,?,'2026-08-20',50,20,1000,500,500,0,15)"
    ).run(lotId, partial);

    const periods = getAvailableReviewPeriods(db, ACCOUNT);
    expect(periods).toEqual([
      { periodStart: "2026-08-01", periodEnd: "2026-08-31", tradeCount: 3, reviewableCount: 2 },
      { periodStart: "2026-07-01", periodEnd: "2026-07-31", tradeCount: 1, reviewableCount: 1 },
    ]);
    for (const p of periods) {
      expect(p.reviewableCount).toBe(generatorCount(p.periodStart, p.periodEnd));
    }
  });

  it("the unreviewed-months list counts only months the account has not reviewed", () => {
    trade(1, "BUY", "2026-07-01", 10, 50, "O");
    trade(1, "SELL", "2026-07-15", 10, 60, "C");
    trade(1, "BUY", "2026-08-03", 10, 50, "O");
    trade(1, "SELL", "2026-08-10", 10, 60, "C");
    computeTaxLots(db);
    db.prepare(
      "INSERT INTO trade_reviews(account_id,period_start,period_end,total_trades,winning_trades,losing_trades,win_rate,total_realized_pnl,review_markdown) VALUES(?,'2026-07-01','2026-07-31',1,1,0,1,100,'saved')"
    ).run(ACCOUNT);

    expect(detectNewTradeReviewPeriods(db)).toEqual([
      { periodStart: "2026-08-01", periodEnd: "2026-08-31", tradeCount: 1, reviewableCount: 1 },
    ]);
  });
});
