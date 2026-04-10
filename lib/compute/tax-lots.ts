import type Database from "better-sqlite3";

interface TaxLotComputeResult {
  lotsCreated: number;
  salesProcessed: number;
  totalRealizedGain: number;
}

interface TransactionRow {
  id: number;
  account_id: number;
  security_id: number;
  trade_date: string;
  type: string;
  quantity: number;
  price_per_share: number;
  amount: number;
  fees: number;
}

interface OpenLot {
  id: number;
  acquisition_date: string;
  acquisition_price: number;
  quantity_remaining: number;
}

interface OptionExerciseRow {
  id: number;
  account_id: number;
  security_id: number;
  trade_date: string;
  type: string;
  quantity: number;
  price_per_share: number;
  underlying_symbol: string;
  option_type: string;
  multiplier: number;
}

/** Premium adjustment to apply to a stock transaction's effective price. */
interface PremiumAdjustment {
  /** Per-share premium to add to (buy) or subtract from (sell) the stock price. */
  premiumPerShare: number;
  /**
   * 'increase_cost' — add to stock cost basis (long call exercise, short put assignment)
   * 'increase_proceeds' — add to stock sale proceeds (short call assignment)
   * 'decrease_proceeds' — subtract from stock sale proceeds (long put exercise)
   */
  adjustmentType: "increase_cost" | "increase_proceeds" | "decrease_proceeds";
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export function computeTaxLots(db: Database.Database): TaxLotComputeResult {
  return db.transaction(() => {
    // Clear existing computed data
    db.prepare("DELETE FROM tax_lot_sales").run();
    db.prepare("DELETE FROM tax_lots").run();

    // ── Pre-processing: Compute premium adjustments for exercise/assignment ──
    const premiumAdjustments = computePremiumAdjustments(db);

    // ── Create tax lots from BUY-like transactions ──
    // Includes: BUY, REINVESTMENT, BUY_TO_OPEN (long option), SELL_TO_OPEN (short option)
    const buys = db
      .prepare(
        `SELECT id, account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees
         FROM transactions
         WHERE LOWER(type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open')
           AND security_id IS NOT NULL
           AND price_per_share IS NOT NULL AND quantity IS NOT NULL
         ORDER BY trade_date, id`
      )
      .all() as TransactionRow[];

    const insertLot = db.prepare(
      `INSERT INTO tax_lots
       (account_id, security_id, acquisition_transaction_id, acquisition_date,
        acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let lotsCreated = 0;
    for (const buy of buys) {
      // Apply premium adjustment if this stock buy is linked to an option exercise
      let effectivePrice = buy.price_per_share;
      const adj = premiumAdjustments.get(buy.id);
      if (adj && adj.adjustmentType === "increase_cost") {
        effectivePrice += adj.premiumPerShare;
      }

      const costBasis = buy.quantity * effectivePrice;
      insertLot.run(
        buy.account_id,
        buy.security_id,
        buy.id,
        buy.trade_date,
        effectivePrice,
        buy.quantity,
        buy.quantity,
        costBasis
      );
      lotsCreated++;
    }

    // ── Process SELL-like transactions ──
    // Includes: SELL, SELL_TO_CLOSE, REDEMPTION, BUY_TO_COVER, EXPIRED,
    //           EXERCISED, ASSIGNED, BUY_TO_CLOSE
    const sells = db
      .prepare(
        `SELECT id, account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees
         FROM transactions
         WHERE LOWER(type) IN ('sell', 'sell_to_close', 'redemption', 'buy_to_cover',
                                'expired', 'exercised', 'assigned', 'buy_to_close')
           AND security_id IS NOT NULL
           AND price_per_share IS NOT NULL AND quantity IS NOT NULL
         ORDER BY trade_date, id`
      )
      .all() as TransactionRow[];

    const insertSale = db.prepare(
      `INSERT INTO tax_lot_sales
       (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds,
        cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const updateLotRemaining = db.prepare(
      "UPDATE tax_lots SET quantity_remaining = ? WHERE id = ?"
    );

    let salesProcessed = 0;
    let totalRealizedGain = 0;

    for (const sell of sells) {
      let remainingToSell = sell.quantity;

      // For EXERCISED/ASSIGNED, the option closes at $0 (premium rolls into stock)
      const lowerType = sell.type.toLowerCase();
      const isExerciseOrAssignment =
        lowerType === "exercised" || lowerType === "assigned";
      let effectiveSalePrice = sell.price_per_share;

      if (isExerciseOrAssignment) {
        // Option lot closes at $0 — no gain/loss on the option itself
        effectiveSalePrice = 0;
      }

      // Apply premium adjustment for stock sales linked to put exercise / call assignment
      const adj = premiumAdjustments.get(sell.id);
      if (adj) {
        if (adj.adjustmentType === "increase_proceeds") {
          effectiveSalePrice += adj.premiumPerShare;
        } else if (adj.adjustmentType === "decrease_proceeds") {
          effectiveSalePrice -= adj.premiumPerShare;
        }
      }

      // Get open lots for this account+security, FIFO order
      const openLots = db
        .prepare(
          `SELECT id, acquisition_date, acquisition_price, quantity_remaining
           FROM tax_lots
           WHERE account_id = ? AND security_id = ? AND quantity_remaining > 0
           ORDER BY acquisition_date, id`
        )
        .all(sell.account_id, sell.security_id) as OpenLot[];

      for (const lot of openLots) {
        if (remainingToSell <= 0) break;

        const quantitySold = Math.min(remainingToSell, lot.quantity_remaining);
        const costBasisAllocated = quantitySold * lot.acquisition_price;
        const proceeds = quantitySold * effectiveSalePrice;
        const realizedGainLoss = proceeds - costBasisAllocated;
        const holdingDays = daysBetween(lot.acquisition_date, sell.trade_date);
        const isLongTerm = holdingDays > 365 ? 1 : 0;

        insertSale.run(
          lot.id,
          sell.id,
          quantitySold,
          effectiveSalePrice,
          proceeds,
          costBasisAllocated,
          realizedGainLoss,
          isLongTerm,
          holdingDays,
          sell.trade_date
        );

        const newRemaining = lot.quantity_remaining - quantitySold;
        updateLotRemaining.run(newRemaining, lot.id);

        remainingToSell -= quantitySold;
        totalRealizedGain += realizedGainLoss;
      }

      salesProcessed++;
    }

    return { lotsCreated, salesProcessed, totalRealizedGain };
  })();
}

/**
 * Pre-processing: find EXERCISED/ASSIGNED option transactions and compute
 * premium adjustments for the linked stock transactions.
 *
 * IRS rules:
 * - Long call exercised → stock cost basis += option premium per share
 * - Long put exercised → stock sale proceeds -= option premium per share
 * - Short call assigned → stock sale proceeds += option premium per share
 * - Short put assigned → stock cost basis -= option premium per share
 */
function computePremiumAdjustments(
  db: Database.Database
): Map<number, PremiumAdjustment> {
  const adjustments = new Map<number, PremiumAdjustment>();

  // Find all EXERCISED/ASSIGNED transactions on option securities
  const exerciseRows = db
    .prepare(
      `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type,
              t.quantity, t.price_per_share,
              s.underlying_symbol, s.option_type,
              COALESCE(s.multiplier, 1) AS multiplier
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       WHERE LOWER(t.type) IN ('exercised', 'assigned')
         AND LOWER(s.security_type) = 'option'
         AND s.underlying_symbol IS NOT NULL
         AND s.option_type IS NOT NULL`
    )
    .all() as OptionExerciseRow[];

  for (const ex of exerciseRows) {
    const isLong = ex.type.toLowerCase() === "exercised";
    const isCall = ex.option_type.toUpperCase() === "CALL";
    const premiumPerShare = ex.price_per_share; // already per-share for the underlying

    // Determine what stock transaction to look for and how to adjust
    // Long call exercise → stock BUY → increase cost basis
    // Long put exercise → stock SELL → decrease proceeds
    // Short call assigned → stock SELL → increase proceeds
    // Short put assigned → stock BUY → decrease cost basis (reduce cost)
    let stockType: string;
    let adjustmentType: PremiumAdjustment["adjustmentType"];

    if (isLong && isCall) {
      stockType = "buy";
      adjustmentType = "increase_cost";
    } else if (isLong && !isCall) {
      stockType = "sell";
      adjustmentType = "decrease_proceeds";
    } else if (!isLong && isCall) {
      stockType = "sell";
      adjustmentType = "increase_proceeds";
    } else {
      // Short put assigned → forced buy
      stockType = "buy";
      // Premium RECEIVED reduces cost basis — we subtract
      adjustmentType = "increase_cost"; // but with negative premium (see below)
    }

    // Find the linked stock transaction: same account, same underlying, same date (±1 day)
    const underlying = db
      .prepare(
        "SELECT id FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' LIMIT 1"
      )
      .get(ex.underlying_symbol) as { id: number } | undefined;

    if (!underlying) continue;

    const stockTx = db
      .prepare(
        `SELECT id FROM transactions
         WHERE account_id = ? AND security_id = ?
           AND LOWER(type) = ?
           AND ABS(julianday(trade_date) - julianday(?)) <= 1
         ORDER BY ABS(julianday(trade_date) - julianday(?))
         LIMIT 1`
      )
      .get(
        ex.account_id,
        underlying.id,
        stockType,
        ex.trade_date,
        ex.trade_date
      ) as { id: number } | undefined;

    if (!stockTx) continue;

    // For short put assignment, premium received REDUCES cost, so negate
    const effectivePremium =
      !isLong && !isCall ? -premiumPerShare : premiumPerShare;

    adjustments.set(stockTx.id, {
      premiumPerShare: effectivePremium,
      adjustmentType,
    });
  }

  return adjustments;
}
