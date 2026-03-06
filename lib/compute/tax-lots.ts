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

    // Get all BUY-like transactions ordered by date
    // Includes: BUY, buy, reinvestment (dividend reinvested as shares)
    const buys = db
      .prepare(
        `SELECT id, account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees
         FROM transactions
         WHERE LOWER(type) IN ('buy', 'reinvestment', 'buy_to_open')
           AND security_id IS NOT NULL
           AND price_per_share IS NOT NULL AND quantity IS NOT NULL
         ORDER BY trade_date, id`
      )
      .all() as TransactionRow[];

    // Create tax lots from buys
    const insertLot = db.prepare(
      `INSERT INTO tax_lots
       (account_id, security_id, acquisition_transaction_id, acquisition_date,
        acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let lotsCreated = 0;
    for (const buy of buys) {
      const costBasis = buy.quantity * buy.price_per_share;
      insertLot.run(
        buy.account_id,
        buy.security_id,
        buy.id,
        buy.trade_date,
        buy.price_per_share,
        buy.quantity,
        buy.quantity, // initially, all shares remain
        costBasis
      );
      lotsCreated++;
    }

    // Get all SELL-like transactions ordered by date
    // Includes: SELL, sell, sell_to_close, redemption, buy_to_cover (closing short), expired
    const sells = db
      .prepare(
        `SELECT id, account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees
         FROM transactions
         WHERE LOWER(type) IN ('sell', 'sell_to_close', 'redemption', 'buy_to_cover', 'expired')
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
        const proceeds = quantitySold * sell.price_per_share;
        const realizedGainLoss = proceeds - costBasisAllocated;
        const holdingDays = daysBetween(lot.acquisition_date, sell.trade_date);
        const isLongTerm = holdingDays > 365 ? 1 : 0;

        insertSale.run(
          lot.id,
          sell.id,
          quantitySold,
          sell.price_per_share,
          proceeds,
          costBasisAllocated,
          realizedGainLoss,
          isLongTerm,
          holdingDays,
          sell.trade_date
        );

        // Update remaining quantity on the lot
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
