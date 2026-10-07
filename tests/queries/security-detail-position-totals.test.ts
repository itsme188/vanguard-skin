/**
 * Security hub POSITIONS: the TOTAL row and the frame around open lots.
 *
 * qa: dashboard-security-1711-app-positions-total-row-hub-positions-total-nets-a-short-basis-into-the-denominator-34
 *   A short stores its sale proceeds as a NEGATIVE cost basis. The TOTAL row
 *   divided the combined gain by the NET basis, so a long + short pair printed
 *   a percent outside both of its own rows. Gain % now divides by GROSS basis:
 *   the sum of |cost basis| over the rows that are in Gain.
 *
 * qa: security-detail-positions--total-mixes-full-value-with-partial-cost-basis-and-gain
 *   Value summed every row while cost basis and gain summed only the rows with
 *   a known basis. The totals now name the rows left out.
 *
 * qa: security-detail--positions-omit-account-with-open-tax-lot-regression-3
 *   Open lots in an account with no current position rendered with no
 *   Positions section at all.
 *
 * Synthetic symbols and round invented numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  computeLotsWithoutPosition,
  computePositionTotals,
  getSecurityDetail,
  type SecurityPosition,
} from "@/lib/queries/security-detail";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedPx,
} from "../setup/pending-statement-fixtures";

const TAXABLE = 1; // seeded by migration 002
const ROTH = 2;

function seedSecurity(db: Database.Database, symbol: string, type = "Stock", multiplier = 1): number {
  return Number(
    db
      .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, ?, ?)")
      .run(symbol, `${symbol} Corp`, type, multiplier).lastInsertRowid
  );
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number | null
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, '2026-07-10', ?)`
  ).run(accountId, securityId, quantity, costBasis, `canonical:hold:${accountId}:${securityId}`);
}

function seedPrice(db: Database.Database, securityId: number, closePrice: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-10', ?, 'tws')"
  ).run(securityId, closePrice);
}

function pos(over: Partial<SecurityPosition>): SecurityPosition {
  return {
    account_id: 1,
    account_name: "Acct One",
    quantity: 0,
    cost_basis: null,
    as_of_date: "2026-07-10",
    current_price: null,
    current_value: null,
    unrealized_gain: null,
    security_type: "Stock",
    multiplier: 1,
    ...over,
  };
}

describe("hub positions TOTAL: gain % over gross basis", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("a single long: 100 bought for 2,000, now 2,500 -> +25%", () => {
    const id = seedSecurity(db, "AAA");
    seedHolding(db, TAXABLE, id, 100, 2000);
    seedPrice(db, id, 25);

    const d = getSecurityDetail(db, id)!;
    expect(d.totalValue).toBe(2500);
    expect(d.totalCostBasis).toBe(2000);
    expect(d.totalUnrealizedGain).toBe(500);
    expect(d.totalGainRatio).toBeCloseTo(0.25, 10);
    expect(d.positionsWithoutBasis).toEqual([]);
  });

  it("a single profitable short: sold 50 for 1,500, now owes 1,250 -> +250, +16.67%", () => {
    const id = seedSecurity(db, "ZZZ");
    seedHolding(db, ROTH, id, -50, -1500); // short proceeds are a negative basis
    seedPrice(db, id, 25);

    const d = getSecurityDetail(db, id)!;
    expect(d.totalValue).toBe(-1250);
    expect(d.totalCostBasis).toBe(-1500);
    // value - basis = -1,250 - (-1,500) = +250: the stock fell, the short won.
    expect(d.totalUnrealizedGain).toBe(250);
    expect(d.totalGainRatio).toBeCloseTo(250 / 1500, 10);
    expect(d.totalGainRatio!).toBeGreaterThan(0);
  });

  it("a losing short shows a negative percent", () => {
    const id = seedSecurity(db, "ZZZ");
    seedHolding(db, ROTH, id, -50, -1000); // sold at 20, now 25
    seedPrice(db, id, 25);

    const d = getSecurityDetail(db, id)!;
    expect(d.totalUnrealizedGain).toBe(-250);
    expect(d.totalGainRatio).toBeCloseTo(-0.25, 10);
  });

  it("long + short across two accounts: the total percent lies between the two rows", () => {
    const id = seedSecurity(db, "AAA");
    seedHolding(db, TAXABLE, id, 100, 2000); // +500 on 2,000 = +25%
    seedHolding(db, ROTH, id, -50, -1500); //   +250 on 1,500 = +16.67%
    seedPrice(db, id, 25);

    const d = getSecurityDetail(db, id)!;
    expect(d.totalValue).toBe(1250);
    // The displayed cost-basis total stays NET (2,000 - 1,500).
    expect(d.totalCostBasis).toBe(500);
    expect(d.totalUnrealizedGain).toBe(750);
    // Net basis would print 750 / 500 = +150%, above both rows.
    // Gross basis: 750 / (2,000 + 1,500) = +21.43%.
    expect(d.totalGainRatio).toBeCloseTo(750 / 3500, 10);
    expect(d.totalGainRatio!).toBeGreaterThan(250 / 1500);
    expect(d.totalGainRatio!).toBeLessThan(0.25);
  });

  it("a losing long beside a winning short never prints a loss worse than the long's own", () => {
    // The filed shape: the long is down 20%, the short is slightly up.
    const id = seedSecurity(db, "AAA");
    seedHolding(db, TAXABLE, id, 100, 3000); // now 2,400: -600, -20%
    seedHolding(db, ROTH, id, -50, -1250); //   now -1,200: +50, +4%
    seedPrice(db, id, 24);

    const d = getSecurityDetail(db, id)!;
    expect(d.totalUnrealizedGain).toBe(-550);
    expect(d.totalGainRatio).toBeCloseTo(-550 / 4250, 10); // about -12.9%
    expect(d.totalGainRatio!).toBeGreaterThan(-0.2);
    expect(d.totalGainRatio!).toBeLessThan(0.04);
  });

  it("an option position is valued with its multiplier", () => {
    const id = seedSecurity(db, "AAA 270115C00010000", "Option", 100);
    seedHolding(db, TAXABLE, id, 2, 400); // 2 contracts, paid 400
    seedPrice(db, id, 3); // 2 x 3 x 100 = 600

    const d = getSecurityDetail(db, id)!;
    expect(d.totalValue).toBe(600);
    expect(d.totalUnrealizedGain).toBe(200);
    expect(d.totalGainRatio).toBeCloseTo(0.5, 10);
  });
});

describe("hub positions TOTAL: partial cost basis is named, never blended", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("one account without a basis: cost, gain and % cover the other; the row left out is listed", () => {
    const id = seedSecurity(db, "AAA");
    seedHolding(db, ROTH, id, 150, 3000); // now 6,000: +3,000, +100%
    seedHolding(db, TAXABLE, id, 200, null); // now 8,000, basis unknown
    seedPrice(db, id, 40);

    const d = getSecurityDetail(db, id)!;
    expect(d.totalValue).toBe(14000); // every row
    expect(d.totalCostBasis).toBe(3000); // known rows only
    expect(d.totalUnrealizedGain).toBe(3000);
    // The percent is the covered row's own: 3,000 / 3,000. It is never
    // (14,000 - 3,000) / 3,000, a full value over a partial basis.
    expect(d.totalGainRatio).toBeCloseTo(1, 10);
    expect(d.positionsWithoutBasis).toEqual([
      { account_id: TAXABLE, account_name: expect.any(String), quantity: 200 },
    ]);
    // The value those figures do cover, so the row can say what it covers.
    expect(d.gainCoveredValue).toBe(6000);
  });

  it("a stored basis of exactly 0 is unknown and is listed as left out", () => {
    const totals = computePositionTotals([
      pos({ account_id: 1, account_name: "Acct One", quantity: 10, cost_basis: 100, current_value: 150, unrealized_gain: 50 }),
      pos({ account_id: 2, account_name: "Acct Two", quantity: 5, cost_basis: 0, current_value: 75, unrealized_gain: null }),
    ]);
    expect(totals.totalCostBasis).toBe(100);
    expect(totals.totalGainRatio).toBeCloseTo(0.5, 10);
    expect(totals.positionsWithoutBasis).toEqual([
      { account_id: 2, account_name: "Acct Two", quantity: 5 },
    ]);
    expect(totals.gainCoveredValue).toBe(150);
  });

  it("every basis unknown: cost, gain and % are null, not zero", () => {
    const totals = computePositionTotals([
      pos({ account_id: 1, quantity: 10, current_value: 150 }),
      pos({ account_id: 2, quantity: 5, current_value: 75 }),
    ]);
    expect(totals.totalValue).toBe(225);
    expect(totals.totalCostBasis).toBeNull();
    expect(totals.totalUnrealizedGain).toBeNull();
    expect(totals.totalGainRatio).toBeNull();
    expect(totals.gainCoveredValue).toBeNull();
    expect(totals.positionsWithoutBasis).toHaveLength(2);
  });

  it("a basis without a price is in Cost Basis but not in the percent's denominator", () => {
    // Gain % divides by the basis of the positions that are in Gain.
    const totals = computePositionTotals([
      pos({ account_id: 1, quantity: 10, cost_basis: 100, current_value: 150, unrealized_gain: 50 }),
      pos({ account_id: 2, quantity: 5, cost_basis: 400, current_value: null, unrealized_gain: null }),
    ]);
    expect(totals.totalCostBasis).toBe(500);
    expect(totals.totalUnrealizedGain).toBe(50);
    expect(totals.totalGainRatio).toBeCloseTo(0.5, 10);
  });
});

describe("open lots in an account with no current position", () => {
  const lot = (over: Record<string, unknown>) => ({
    account_id: 3,
    account_name: "Acct Three",
    quantity_remaining: 10,
    is_short: 0,
    pending_statement: false,
    ...over,
  });

  it("groups by account and skips accounts that have a position row", () => {
    const out = computeLotsWithoutPosition(
      [pos({ account_id: 1, account_name: "Acct One", quantity: 5 })],
      [
        lot({ account_id: 1, account_name: "Acct One", quantity_remaining: 5 }),
        lot({ quantity_remaining: 10 }),
        lot({ quantity_remaining: 15 }),
      ]
    );
    expect(out).toEqual([
      {
        accountId: 3,
        accountName: "Acct Three",
        lotCount: 2,
        quantity: 25,
        shortLotCount: 0,
        allPendingStatement: false,
      },
    ]);
  });

  it("counts short lots and marks an account whose lots are all pending a statement", () => {
    const out = computeLotsWithoutPosition(
      [],
      [
        lot({ is_short: 1, quantity_remaining: 200 }),
        lot({ is_short: 1, quantity_remaining: 200 }),
        lot({ account_id: 1, account_name: "Acct One", pending_statement: true }),
      ]
    );
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.accountId === 3)).toMatchObject({
      lotCount: 2,
      quantity: 400,
      shortLotCount: 2,
      allPendingStatement: false,
    });
    expect(out.find((o) => o.accountId === 1)).toMatchObject({ allPendingStatement: true });
  });

  it("ignores float-dust remainders", () => {
    expect(computeLotsWithoutPosition([], [lot({ quantity_remaining: 1e-15 })])).toEqual([]);
  });

  it("getSecurityDetail reports the account when its latest holding is zero but lots remain", () => {
    const db = createPendingTestDb();
    const id = seedSec(db, "PENDX");
    seedFill(db, 3, id, "2026-05-01", "BUY", 5, 100);
    seedFill(db, 3, id, "2026-05-02", "BUY", 5, 100);
    seedHold(db, 3, id, "2026-07-10", "live-zero");
    seedPx(db, id, "2026-07-10", 150);
    computeTaxLots(db);

    const d = getSecurityDetail(db, id)!;
    expect(d.positions).toEqual([]);
    expect(d.openTaxLots).toHaveLength(2);
    expect(d.lotsWithoutPosition).toEqual([
      {
        accountId: 3,
        accountName: expect.any(String),
        lotCount: 2,
        quantity: 10,
        shortLotCount: 0,
        allPendingStatement: true,
      },
    ]);
  });
});

describe("hub page source: the Positions frame", () => {
  const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
  const start = anchorIndex(src, "{/* Positions */}");
  const end = anchorIndex(src, "{/* Tax Lots */}", start);
  const block = src.slice(start, end);

  it("renders when lots exist without a position, not only when positions exist", () => {
    expect(block).toMatch(/positions\.length > 0 \|\| lotsWithoutPosition\.length > 0/);
    expect(block).toContain("lotsWithoutPosition.map(");
  });

  it("the TOTAL percent reads the gross-basis ratio, never gain over the net basis", () => {
    expect(block).toContain("detail.totalGainRatio");
    expect(block).not.toContain("unrealizedGainRatio(detail.totalUnrealizedGain, detail.totalCostBasis)");
  });

  it("names the rows left out of cost basis and gain", () => {
    expect(block).toContain("positionsWithoutBasis");
  });

  it("every figure in the frame goes through a privacy component", () => {
    const notes = block.slice(anchorIndex(block, "lotsWithoutPosition.map("));
    expect(notes).toContain("<Count value={orphan.lotCount}");
    expect(notes).toContain("<Shares value={orphan.quantity}");
    expect(notes).toContain("<QuantityUnit");
  });
});
