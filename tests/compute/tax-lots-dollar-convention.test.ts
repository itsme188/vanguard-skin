/**
 * WS1 (number-trust durable fixes): the tax-lot engine's TRUE-DOLLAR
 * storage convention.
 *
 * `tax_lots.cost_basis`, `tax_lot_sales.proceeds` and
 * `tax_lot_sales.cost_basis_allocated` hold real economic dollars in the
 * security's native currency — bonds ÷100 (per-100-face quotes), options
 * ×multiplier, fees folded in on the side that bears them. Per-unit columns
 * (`acquisition_price`, `sale_price`) stay per-unit.
 *
 * Every expectation here is hand-computed from the fixture inputs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots, isLongTermHolding } from "@/lib/compute/tax-lots";
import { getTaxConventionState } from "@/lib/compute/tax-convention";

const ACCOUNT_ID = 1; // Vanguard Taxable (seeded by migration 002)

let db: Database.Database;
let txnSeq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  txnSeq = 0;
});

function seedSecurity(opts: {
  symbol: string;
  securityType?: string;
  multiplier?: number;
  underlyingSymbol?: string;
  optionType?: "CALL" | "PUT";
}): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, multiplier, underlying_symbol, option_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.symbol,
      opts.symbol,
      opts.securityType ?? null,
      opts.multiplier ?? 1,
      opts.underlyingSymbol ?? null,
      opts.optionType ?? null
    );
  return r.lastInsertRowid as number;
}

function addTxn(opts: {
  securityId: number;
  type: string;
  date: string;
  quantity: number;
  price?: number | null;
  amount?: number | null;
  fees?: number;
}): number {
  txnSeq++;
  const r = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity,
                                 price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ACCOUNT_ID,
      opts.securityId,
      opts.date,
      opts.type,
      opts.quantity,
      opts.price ?? null,
      opts.amount ?? null,
      opts.fees ?? 0,
      `test:${opts.type}:${opts.date}:${txnSeq}`
    );
  return r.lastInsertRowid as number;
}

interface LotRow {
  id: number;
  acquisition_price: number;
  quantity_acquired: number;
  quantity_remaining: number;
  cost_basis: number;
  is_short: number;
}
interface SaleRow {
  id: number;
  quantity_sold: number;
  sale_price: number;
  proceeds: number;
  cost_basis_allocated: number;
  realized_gain_loss: number;
  is_long_term: number;
  holding_period_days: number;
  premium_rollover: number;
}

function lots(): LotRow[] {
  return db
    .prepare("SELECT * FROM tax_lots ORDER BY acquisition_date, id")
    .all() as LotRow[];
}
function onlyLot(): LotRow {
  const all = lots();
  expect(all).toHaveLength(1);
  return all[0];
}
function sales(): SaleRow[] {
  return db
    .prepare("SELECT * FROM tax_lot_sales ORDER BY sale_date, id")
    .all() as SaleRow[];
}
function onlySale(): SaleRow {
  const all = sales();
  expect(all).toHaveLength(1);
  return all[0];
}

describe("bond dollar convention", () => {
  // Bond: qty 20,000 face at 99.438385 per-100-face → 20000 × 99.438385 / 100
  //     = $19,887.677 economic dollars.
  function seedBond(): number {
    const secId = seedSecurity({ symbol: "912796XY0", securityType: "Bond" });
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2023-02-08",
      quantity: 20000,
      price: 99.438385,
    });
    return secId;
  }

  it("stores bond lot cost_basis at economic dollars (÷100)", () => {
    seedBond();
    computeTaxLots(db);

    const lot = onlyLot();
    expect(lot.cost_basis).toBeCloseTo(19887.68, 2); // NOT 1,988,768
    expect(lot.acquisition_price).toBeCloseTo(99.438385, 6); // per-unit price unchanged
  });

  it("bill redemption at cost realizes ~$0 with proceeds == |amount|", () => {
    const secId = seedBond();
    addTxn({
      securityId: secId,
      type: "REDEMPTION",
      date: "2023-08-10",
      quantity: 20000,
      price: null,
      amount: 19887.69,
    });
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.proceeds).toBeCloseTo(19887.69, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(19887.68, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(0.01, 2);
    // derived per-100-face price survives: |amount|/qty×100
    expect(sale.sale_price).toBeCloseTo(99.43845, 6);
  });
});

describe("short-cover IRS orientation", () => {
  function seedShort(coverDate: string): number {
    const secId = seedSecurity({ symbol: "SHRT", securityType: "Stock" });
    // SELL_TO_OPEN 100 @ $50 fees $1 → net open proceeds 5000 − 1 = $4,999
    addTxn({
      securityId: secId,
      type: "SELL_TO_OPEN",
      date: "2025-01-01",
      quantity: 100,
      price: 50,
      fees: 1,
    });
    // BUY_TO_COVER 100 @ $40 fees $1 → cover cost 4000 + 1 = $4,001
    addTxn({
      securityId: secId,
      type: "BUY_TO_COVER",
      date: coverDate,
      quantity: 100,
      price: 40,
      fees: 1,
    });
    return secId;
  }

  it("stores the short-open lot at NET proceeds (gross − fees)", () => {
    seedShort("2025-01-31");
    computeTaxLots(db);
    const lot = onlyLot();
    expect(lot.is_short).toBe(1);
    expect(lot.cost_basis).toBeCloseTo(4999, 2);
    expect(lot.acquisition_price).toBe(50); // per-unit, unchanged
  });

  it("proceeds = net short-open leg, basis = cover cost + fees, gain falls out unsigned", () => {
    seedShort("2025-01-31"); // 30 days after the open
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.proceeds).toBeCloseTo(4999, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(4001, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(998, 2);
    expect(sale.is_long_term).toBe(0);
    // Signed display convention: negative days identify a short lifecycle.
    expect(sale.holding_period_days).toBe(-30);
  });

  it("short cover held >1yr is STILL short-term (§1233 blanket rule)", () => {
    seedShort("2026-05-16"); // 2025-01-01 + 500 days
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.is_long_term).toBe(0);
    expect(sale.holding_period_days).toBe(-500);
    expect(sale.realized_gain_loss).toBeCloseTo(998, 2);
  });

  it("allocates both stored proceeds and cover fees proportionally on a partial cover", () => {
    const secId = seedSecurity({ symbol: "SHRT2", securityType: "Stock" });
    // Open 100 short @ $50 fees $1 → stored leg $4,999
    addTxn({
      securityId: secId,
      type: "SELL_TO_OPEN",
      date: "2025-01-01",
      quantity: 100,
      price: 50,
      fees: 1,
    });
    // Cover 40 @ $40 fees $1 → cover leg 40×40 + 1 = $1,601, all 40 from one lot
    addTxn({
      securityId: secId,
      type: "BUY_TO_COVER",
      date: "2025-01-31",
      quantity: 40,
      price: 40,
      fees: 1,
    });
    computeTaxLots(db);

    const sale = onlySale();
    // proceeds = 4999 × (40/100) = 1999.6
    expect(sale.proceeds).toBeCloseTo(1999.6, 2);
    // basis = (1600 + 1) × (40/40) = 1601
    expect(sale.cost_basis_allocated).toBeCloseTo(1601, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(398.6, 2);
  });
});

describe("fees on long lots", () => {
  it("buy fees enter stored basis; sell fees reduce proceeds proportionally on partial sale", () => {
    const secId = seedSecurity({ symbol: "LONG", securityType: "Stock" });
    // BUY 100 @ $10 fees $2 → cost_basis 1000 + 2 = $1,002
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      fees: 2,
    });
    // SELL 40 @ $12 fees $1 → proceeds 480 − 1×(40/40) = $479
    addTxn({
      securityId: secId,
      type: "SELL",
      date: "2025-03-02",
      quantity: 40,
      price: 12,
      fees: 1,
    });
    computeTaxLots(db);

    const lot = onlyLot();
    expect(lot.cost_basis).toBeCloseTo(1002, 2);

    const sale = onlySale();
    expect(sale.proceeds).toBeCloseTo(479, 2);
    // dollar-proportional from stored basis: 1002 × (40/100) = 400.80
    expect(sale.cost_basis_allocated).toBeCloseTo(400.8, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(78.2, 2);
  });
});

describe("authoritative broker amount takes precedence over qty×price±fees", () => {
  it("uses |amount| for an acquisition when the row carries one", () => {
    const secId = seedSecurity({ symbol: "AMT1", securityType: "Stock" });
    // qty×price+fees would be 1002; the broker's net figure says 1005.
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      fees: 2,
      amount: -1005,
    });
    computeTaxLots(db);
    expect(onlyLot().cost_basis).toBeCloseTo(1005, 2);
  });

  it("uses |amount| for a disposal and allocates it by quantity", () => {
    const secId = seedSecurity({ symbol: "AMT2", securityType: "Stock" });
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      amount: -1000,
    });
    // Broker net proceeds 478.50 on a 40-share sale (derivation would say 479).
    addTxn({
      securityId: secId,
      type: "SELL",
      date: "2025-03-02",
      quantity: 40,
      price: 12,
      fees: 1,
      amount: 478.5,
    });
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.proceeds).toBeCloseTo(478.5, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(400, 2); // 1000 × 40/100
    expect(sale.realized_gain_loss).toBeCloseTo(78.5, 2);
  });

  it("uses |amount| for a short open and for its cover", () => {
    const secId = seedSecurity({ symbol: "AMT3", securityType: "Stock" });
    addTxn({
      securityId: secId,
      type: "SELL_TO_OPEN",
      date: "2025-01-01",
      quantity: 100,
      price: 50,
      fees: 1,
      amount: 4998,
    });
    addTxn({
      securityId: secId,
      type: "BUY_TO_COVER",
      date: "2025-01-31",
      quantity: 100,
      price: 40,
      fees: 1,
      amount: -4002,
    });
    computeTaxLots(db);

    expect(onlyLot().cost_basis).toBeCloseTo(4998, 2);
    const sale = onlySale();
    expect(sale.proceeds).toBeCloseTo(4998, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(4002, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(996, 2);
  });

  it("a zero amount is not authoritative — the derivation still runs", () => {
    const secId = seedSecurity({ symbol: "AMT4", securityType: "Stock" });
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      fees: 2,
      amount: 0,
    });
    computeTaxLots(db);
    expect(onlyLot().cost_basis).toBeCloseTo(1002, 2);
  });

  // Sources disagree about whether `amount` is gross or net, so the engine
  // self-detects: fees present AND |amount| sitting on the qty×price gross
  // means the source stored GROSS (IBKR activity's Proceeds column) and the
  // fee still has to be applied. Otherwise the fee is already inside it
  // (Vanguard canonical). Zero-fee rows are unambiguous.
  it("IBKR shape: a gross amount with a separate commission still absorbs the fee on a buy", () => {
    const secId = seedSecurity({ symbol: "GRS1", securityType: "Stock" });
    // amount 1000 == 100 × $10 gross, commission $1 booked separately
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      fees: 1,
      amount: 1000,
    });
    computeTaxLots(db);
    expect(onlyLot().cost_basis).toBeCloseTo(1001, 2);
  });

  it("IBKR shape: a gross amount nets the commission OUT of sale proceeds", () => {
    const secId = seedSecurity({ symbol: "GRS2", securityType: "Stock" });
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      amount: -1000,
    });
    // amount 1200 == 100 × $12 gross, commission $1 booked separately
    addTxn({
      securityId: secId,
      type: "SELL",
      date: "2025-03-02",
      quantity: 100,
      price: 12,
      fees: 1,
      amount: 1200,
    });
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.proceeds).toBeCloseTo(1199, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(1000, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(199, 2);
  });

  it("Vanguard shape: an already-net amount is not fee-adjusted twice", () => {
    const optId = seedSecurity({
      symbol: "VGD  260619C00100000",
      securityType: "option",
      multiplier: 100,
      underlyingSymbol: "VGD",
      optionType: "CALL",
    });
    // gross = 1 × 20.20 × 100 = 2020; amount 2021 already includes the $1 fee
    addTxn({
      securityId: optId,
      type: "BUY_TO_OPEN",
      date: "2026-01-15",
      quantity: 1,
      price: 20.2,
      fees: 1,
      amount: 2021,
    });
    computeTaxLots(db);
    expect(onlyLot().cost_basis).toBeCloseTo(2021, 2); // NOT 2022
  });

  it("a zero-fee row is unambiguous — both readings agree", () => {
    const secId = seedSecurity({ symbol: "AMB", securityType: "Stock" });
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: 100,
      price: 10,
      fees: 0,
      amount: 1000, // exactly the gross, no fee to place on either side
    });
    computeTaxLots(db);
    expect(onlyLot().cost_basis).toBeCloseTo(1000, 2);
  });

  it("a reversal leg keeps its negative orientation on both paths", () => {
    const secId = seedSecurity({ symbol: "REV", securityType: "Stock" });
    // amount-present reversal: magnitude from amount, sign from the leg
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2025-01-02",
      quantity: -10,
      price: 100,
      amount: 1000,
    });
    const secId2 = seedSecurity({ symbol: "REV2", securityType: "Stock" });
    // amount-null reversal: the derivation's negative gross rides through
    addTxn({
      securityId: secId2,
      type: "BUY",
      date: "2025-01-02",
      quantity: -10,
      price: 100,
    });
    computeTaxLots(db);

    const all = lots();
    expect(all).toHaveLength(2);
    expect(all[0].cost_basis).toBeCloseTo(-1000, 2);
    expect(all[1].cost_basis).toBeCloseTo(-1000, 2);
  });
});

describe("option round-trip and exercise", () => {
  function seedOption(symbol = "AAPL  260619C00180000"): number {
    return seedSecurity({
      symbol,
      securityType: "option",
      multiplier: 100,
      underlyingSymbol: "AAPL",
      optionType: "CALL",
    });
  }

  it("plain option round-trip stores contract dollars (×100) on both legs", () => {
    const optId = seedOption();
    // BUY_TO_OPEN 1 contract @ $2.50 fees $1 → 1×2.50×100 + 1 = $251
    addTxn({
      securityId: optId,
      type: "BUY_TO_OPEN",
      date: "2026-01-15",
      quantity: 1,
      price: 2.5,
      fees: 1,
    });
    // SELL_TO_CLOSE @ $4.00 fees $1 → 1×4.00×100 − 1 = $399
    addTxn({
      securityId: optId,
      type: "SELL_TO_CLOSE",
      date: "2026-04-01",
      quantity: 1,
      price: 4,
      fees: 1,
    });
    computeTaxLots(db);

    expect(onlyLot().cost_basis).toBeCloseTo(251, 2);
    const sale = onlySale();
    expect(sale.sale_price).toBe(4); // per-unit, unchanged
    expect(sale.proceeds).toBeCloseTo(399, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(251, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(148, 2);
    expect(sale.premium_rollover).toBe(0);
  });

  it("EXERCISED option with a linked stock leg is a premium rollover: zero gain, flagged, premium lands once", () => {
    const stockId = seedSecurity({ symbol: "AAPL", securityType: "stock" });
    const optId = seedOption();
    // Long call 1x @ $3 premium → option lot $300
    addTxn({
      securityId: optId,
      type: "BUY_TO_OPEN",
      date: "2026-01-15",
      quantity: 1,
      price: 3,
    });
    addTxn({
      securityId: optId,
      type: "EXERCISED",
      date: "2026-05-01",
      quantity: 1,
      price: 3,
    });
    // Linked stock BUY the same day. Its broker `amount` predates the premium
    // roll-in, so the adjusted derivation must win here.
    addTxn({
      securityId: stockId,
      type: "BUY",
      date: "2026-05-01",
      quantity: 100,
      price: 100,
      amount: -10000,
    });
    computeTaxLots(db);

    const optionSale = db
      .prepare(
        `SELECT tls.* FROM tax_lot_sales tls
           JOIN tax_lots tl ON tl.id = tls.tax_lot_id
          WHERE tl.security_id = ?`
      )
      .get(optId) as SaleRow;
    expect(optionSale.premium_rollover).toBe(1);
    expect(optionSale.proceeds).toBeCloseTo(300, 2);
    expect(optionSale.cost_basis_allocated).toBeCloseTo(300, 2);
    expect(optionSale.realized_gain_loss).toBeCloseTo(0, 2);

    // Premium lands exactly once — in the stock lot: 100×100 + 3×100 = $10,300
    const stockLot = db
      .prepare("SELECT * FROM tax_lots WHERE security_id = ?")
      .get(stockId) as LotRow;
    expect(stockLot.acquisition_price).toBeCloseTo(103, 6);
    expect(stockLot.cost_basis).toBeCloseTo(10300, 2);
  });

  it("EXERCISED option with NO linkable stock leg keeps its realized loss (premium must not vanish)", () => {
    seedSecurity({ symbol: "AAPL", securityType: "stock" }); // exists, but never traded
    const optId = seedOption();
    addTxn({
      securityId: optId,
      type: "BUY_TO_OPEN",
      date: "2026-01-15",
      quantity: 1,
      price: 3,
    });
    addTxn({
      securityId: optId,
      type: "EXERCISED",
      date: "2026-05-01",
      quantity: 1,
      price: 3,
    });
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.premium_rollover).toBe(0);
    expect(sale.proceeds).toBeCloseTo(0, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(300, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(-300, 2);
  });
});

describe("long-term anniversary boundary", () => {
  it("2024-02-28 → 2025-02-28 is NOT long-term; 2025-03-01 IS (leap year span)", () => {
    expect(isLongTermHolding("2024-02-28", "2025-02-28")).toBe(false); // exactly 1yr = not MORE than
    expect(isLongTermHolding("2024-02-28", "2025-03-01")).toBe(true);
    expect(isLongTermHolding("2024-02-29", "2025-03-01")).toBe(true); // Feb 29 anniversary → Mar 1
  });

  it("a plain anniversary sale is short-term, the next day is long-term", () => {
    expect(isLongTermHolding("2025-01-15", "2026-01-15")).toBe(false);
    expect(isLongTermHolding("2025-01-15", "2026-01-16")).toBe(true);
  });

  it("the engine uses the anniversary rule on a real sale pair", () => {
    const secId = seedSecurity({ symbol: "ANNIV", securityType: "Stock" });
    addTxn({
      securityId: secId,
      type: "BUY",
      date: "2024-02-28",
      quantity: 20,
      price: 10,
    });
    // Sale exactly one calendar year later — 366 days across the leap day,
    // which the old > 365 day count wrongly called long-term.
    addTxn({
      securityId: secId,
      type: "SELL",
      date: "2025-02-28",
      quantity: 10,
      price: 12,
    });
    computeTaxLots(db);

    const sale = onlySale();
    expect(sale.holding_period_days).toBe(366);
    expect(sale.is_long_term).toBe(0);
  });
});

describe("recompute idempotence and marker", () => {
  const BUSINESS_LOT_COLS = `account_id, security_id, acquisition_date, acquisition_price,
    quantity_acquired, quantity_remaining, cost_basis, is_short`;
  const BUSINESS_SALE_COLS = `quantity_sold, sale_price, proceeds, cost_basis_allocated,
    realized_gain_loss, is_long_term, holding_period_days, sale_date, premium_rollover`;

  function snapshot() {
    return {
      lots: db
        .prepare(
          `SELECT ${BUSINESS_LOT_COLS} FROM tax_lots
            ORDER BY account_id, security_id, acquisition_date, acquisition_price, cost_basis`
        )
        .all(),
      sales: db
        .prepare(
          `SELECT ${BUSINESS_SALE_COLS} FROM tax_lot_sales
            ORDER BY sale_date, quantity_sold, proceeds, cost_basis_allocated`
        )
        .all(),
    };
  }

  it("second run is semantically identical over business columns and stamps the marker", () => {
    const stockId = seedSecurity({ symbol: "IDEM", securityType: "Stock" });
    const bondId = seedSecurity({ symbol: "IDEMB", securityType: "Bond" });
    const optId = seedSecurity({
      symbol: "IDEM  260619C00100000",
      securityType: "option",
      multiplier: 100,
      underlyingSymbol: "IDEM",
      optionType: "CALL",
    });
    addTxn({ securityId: stockId, type: "BUY", date: "2025-01-02", quantity: 100, price: 10, fees: 2 });
    addTxn({ securityId: stockId, type: "SELL", date: "2025-06-02", quantity: 40, price: 12, fees: 1 });
    addTxn({ securityId: bondId, type: "BUY", date: "2025-01-05", quantity: 20000, price: 99.4 });
    addTxn({
      securityId: bondId, type: "REDEMPTION", date: "2025-07-05",
      quantity: 20000, price: null, amount: 19900,
    });
    addTxn({ securityId: optId, type: "SELL_TO_OPEN", date: "2025-02-01", quantity: 3, price: 4, fees: 1 });
    addTxn({ securityId: optId, type: "BUY_TO_CLOSE", date: "2025-03-01", quantity: 3, price: 1, fees: 1 });

    computeTaxLots(db);
    const first = snapshot();
    computeTaxLots(db);
    const second = snapshot();

    expect(second).toEqual(first);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);
  });

  it("does not throw on a minimal DB with no settings table", () => {
    const secId = seedSecurity({ symbol: "NOSET", securityType: "Stock" });
    addTxn({ securityId: secId, type: "BUY", date: "2025-01-02", quantity: 10, price: 10 });
    db.exec("DROP TABLE settings");
    expect(() => computeTaxLots(db)).not.toThrow();
    expect(onlyLot().cost_basis).toBeCloseTo(100, 2);
  });
});
