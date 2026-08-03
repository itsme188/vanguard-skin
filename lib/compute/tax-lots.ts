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
  is_short: number;
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
    // Clear existing computed data — including the engine-owned synthetic
    // RECONCILE_CLOSE transactions from prior runs. They are regenerated at
    // the end of this run only where an orphan open lot still exists, so a
    // later-imported real SELL naturally supersedes its synthetic stand-in.
    db.prepare("DELETE FROM tax_lot_sales").run();
    db.prepare("DELETE FROM tax_lots").run();
    db.prepare("DELETE FROM transactions WHERE type = 'RECONCILE_CLOSE'").run();

    // ── Pre-processing: Compute premium adjustments for exercise/assignment ──
    const premiumAdjustments = computePremiumAdjustments(db);

    // ── Create tax lots from BUY-like transactions ──
    // Includes: BUY, REINVESTMENT, BUY_TO_OPEN (long option), SELL_TO_OPEN (short option),
    // TRANSFER_IN (ACATS in-kind arrival — the security physically arrived from another
    // broker, so it opens a real FIFO lot at its transferred cost basis). Deliberately
    // does NOT include TRANSFER_OUT on the sell side below — outbound security transfers
    // (e.g. donated-in-kind shares) are the R4 donation-tracking workstream, not a sale.
    const buys = db
      .prepare(
        `SELECT id, account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees
         FROM transactions
         WHERE LOWER(type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open', 'transfer_in')
           AND security_id IS NOT NULL
           AND price_per_share IS NOT NULL AND quantity IS NOT NULL
         ORDER BY trade_date, id`
      )
      .all() as TransactionRow[];

    const insertLot = db.prepare(
      `INSERT INTO tax_lots
       (account_id, security_id, acquisition_transaction_id, acquisition_date,
        acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let lotsCreated = 0;
    for (const buy of buys) {
      // Apply premium adjustment if this stock buy is linked to an option exercise
      let effectivePrice = buy.price_per_share;
      const adj = premiumAdjustments.get(buy.id);
      if (adj && adj.adjustmentType === "increase_cost") {
        effectivePrice += adj.premiumPerShare;
      }

      const isShort = buy.type.toLowerCase() === "sell_to_open" ? 1 : 0;
      const costBasis = buy.quantity * effectivePrice;
      insertLot.run(
        buy.account_id,
        buy.security_id,
        buy.id,
        buy.trade_date,
        effectivePrice,
        buy.quantity,
        buy.quantity,
        costBasis,
        isShort
      );
      lotsCreated++;
    }

    // ── Process SELL-like transactions ──
    // Includes: SELL, SELL_TO_CLOSE, REDEMPTION, BUY_TO_COVER, EXPIRED,
    //           EXERCISED, ASSIGNED, BUY_TO_CLOSE
    const sells = db
      .prepare(
        `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity,
                t.price_per_share, t.amount, t.fees,
                COALESCE(s.multiplier, 1) AS multiplier
         FROM transactions t
         JOIN securities s ON s.id = t.security_id
         WHERE LOWER(t.type) IN ('sell', 'sell_to_close', 'redemption', 'buy_to_cover',
                                'expired', 'exercised', 'assigned', 'buy_to_close')
           AND t.security_id IS NOT NULL
           AND t.quantity IS NOT NULL
           AND (t.price_per_share IS NOT NULL
                OR LOWER(t.type) IN ('expired', 'exercised', 'assigned'))
         ORDER BY t.trade_date, t.id`
      )
      .all() as Array<TransactionRow & { multiplier: number }>;

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

    const processSell = (sell: TransactionRow & { multiplier: number }) => {
      let remainingToSell = sell.quantity;

      // For EXERCISED/ASSIGNED/EXPIRED, the option closes at $0
      const lowerType = sell.type.toLowerCase();
      const isZeroPriceClose =
        lowerType === "exercised" || lowerType === "assigned" || lowerType === "expired";
      let effectiveSalePrice = sell.price_per_share ?? 0;

      if (isZeroPriceClose) {
        // Option lot closes at $0 — expired worthless or premium rolls into stock
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
          `SELECT id, acquisition_date, acquisition_price, quantity_remaining, is_short
           FROM tax_lots
           WHERE account_id = ? AND security_id = ? AND quantity_remaining > 0
           ORDER BY acquisition_date, id`
        )
        .all(sell.account_id, sell.security_id) as OpenLot[];

      for (const lot of openLots) {
        if (remainingToSell <= 0) break;

        const quantitySold = Math.min(remainingToSell, lot.quantity_remaining);
        // Prices are per-unit; the contract multiplier (100 for options, 1
        // otherwise) converts to real dollars. sale_price stays per-unit.
        const costBasisAllocated =
          quantitySold * lot.acquisition_price * sell.multiplier;
        const proceeds = quantitySold * effectiveSalePrice * sell.multiplier;
        // For short positions (SELL_TO_OPEN), the standard formula produces
        // inverted signs. Negate to get correct economic P&L.
        let realizedGainLoss = proceeds - costBasisAllocated;
        if (lot.is_short) realizedGainLoss = -realizedGainLoss;
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
    };

    for (const sell of sells) {
      processSell(sell);
    }

    // ── Broker-close reconciliation pass ──
    // A position the broker snapshot says is CLOSED (explicit quantity-0
    // holdings row — the reconcileClosedEquityHoldings family writes these)
    // can still carry open FIFO lots when the closing SELL hasn't been
    // imported yet (statements lag). Synthesize an engine-owned
    // RECONCILE_CLOSE transaction at the zero-row date and run it through
    // the same FIFO path, so Open Tax Lots stops contradicting Positions
    // with a phantom unrealized gain. Scope mirrors the equity reconciler:
    // stocks/ETFs only (options expire via EXPIRED, bonds mature via
    // REDEMPTION — their purge paths own those lifecycles). Skipped when the
    // ledger is fresher than the snapshot (any position-changing transaction
    // after the zero row means the snapshot is stale, not the ledger).
    const hasHoldings = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'holdings'")
      .get();
    if (hasHoldings) {
      const orphans = db
        .prepare(
          `SELECT tl.account_id, tl.security_id,
                  SUM(tl.quantity_remaining) AS open_qty,
                  SUM(tl.quantity_remaining * tl.acquisition_price) AS open_cost,
                  h.as_of_date AS zero_date,
                  COALESCE(s.multiplier, 1) AS multiplier
             FROM tax_lots tl
             JOIN securities s ON s.id = tl.security_id
             JOIN holdings h
               ON h.account_id = tl.account_id AND h.security_id = tl.security_id
              AND h.as_of_date = (
                SELECT MAX(h2.as_of_date) FROM holdings h2
                 WHERE h2.account_id = tl.account_id AND h2.security_id = tl.security_id
              )
            WHERE tl.quantity_remaining > 0
              AND h.quantity = 0
              AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'etf')
              AND NOT EXISTS (
                SELECT 1 FROM transactions t2
                 WHERE t2.account_id = tl.account_id
                   AND t2.security_id = tl.security_id
                   AND t2.trade_date > h.as_of_date
                   AND LOWER(t2.type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open',
                                          'sell', 'sell_to_close', 'redemption', 'buy_to_cover',
                                          'expired', 'exercised', 'assigned', 'buy_to_close')
              )
            GROUP BY tl.account_id, tl.security_id`
        )
        .all() as Array<{
        account_id: number;
        security_id: number;
        open_qty: number;
        open_cost: number;
        zero_date: string;
        multiplier: number;
      }>;

      const latestPriceStmt = db.prepare(
        `SELECT close_price FROM prices
          WHERE security_id = ? AND date <= ?
          ORDER BY date DESC LIMIT 1`
      );
      const insertSynthetic = db.prepare(
        `INSERT INTO transactions
           (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees,
            is_external_flow, source_key, notes)
         VALUES (?, ?, ?, 'RECONCILE_CLOSE', ?, ?, ?, 0, 0, ?, ?)`
      );

      for (const orphan of orphans) {
        const priceRow = latestPriceStmt.get(orphan.security_id, orphan.zero_date) as
          | { close_price: number }
          | undefined;
        // No price at all → breakeven close at the open lots' weighted-average
        // cost (records zero net gain rather than fabricating one).
        const salePrice =
          priceRow?.close_price ?? (orphan.open_qty > 0 ? orphan.open_cost / orphan.open_qty : 0);
        const txnResult = insertSynthetic.run(
          orphan.account_id,
          orphan.security_id,
          orphan.zero_date,
          orphan.open_qty,
          salePrice,
          orphan.open_qty * salePrice * orphan.multiplier,
          `reconcile:close:${orphan.account_id}:${orphan.security_id}:${orphan.zero_date}`,
          "Synthesized close — broker snapshot shows this position flat with no matching SELL imported yet; superseded automatically when the real statement lands."
        );
        processSell({
          id: txnResult.lastInsertRowid as number,
          account_id: orphan.account_id,
          security_id: orphan.security_id,
          trade_date: orphan.zero_date,
          type: "RECONCILE_CLOSE",
          quantity: orphan.open_qty,
          price_per_share: salePrice,
          amount: orphan.open_qty * salePrice * orphan.multiplier,
          fees: 0,
          multiplier: orphan.multiplier,
        });
      }
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
