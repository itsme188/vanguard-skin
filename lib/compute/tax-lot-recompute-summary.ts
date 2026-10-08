import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";

/**
 * One row per TAX YEAR, and a tax year is always the year of the sale (the
 * year the gain is taxed). Every figure in a row is on that one basis:
 * realized gain by `tax_lot_sales.sale_date`, lot sales by the same date,
 * engine closes by their trade date. A lot bought in one year and sold in the
 * next appears only under the sale year.
 */
export interface TaxLotRecomputeYearSummary {
  taxYear: number;
  realizedGainBefore: number;
  realizedGainAfter: number;
  /** Sale-to-lot matches (`tax_lot_sales` rows) dated in this year that the recompute adds. */
  lotSalesAdded: number;
  /** Sale-to-lot matches dated in this year that the recompute removes. */
  lotSalesRemoved: number;
  engineClosesAdded: number;
  engineClosesRemoved: number;
}

/**
 * Lots still open (`quantity_remaining > 0`). An open lot has not been sold,
 * so it belongs to no tax year and is reported outside the year rows. A lot
 * whose remaining quantity or basis changes counts once in `added` and once
 * in `removed`.
 */
export interface TaxLotRecomputeOpenLotSummary {
  before: number;
  after: number;
  added: number;
  removed: number;
}

export interface TaxLotRecomputeSummary {
  years: TaxLotRecomputeYearSummary[];
  openLots: TaxLotRecomputeOpenLotSummary;
}

interface LedgerSnapshot {
  realizedByYear: Map<number, number>;
  lotSalesByYear: Map<number, Map<string, number>>;
  openLots: Map<string, number>;
  engineClosesByYear: Map<number, Map<string, number>>;
}

class RecomputeRehearsalRollback extends Error {}

function cents(n: number): number {
  return Math.round(n * 100);
}

function micros(n: number): number {
  return Math.round(n * 1e6);
}

function yearOf(date: string | null | undefined): number | null {
  if (!date || date.length < 4) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function addKey(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function unmatched(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [key, count] of a) n += Math.max(0, count - (b.get(key) ?? 0));
  return n;
}

function byYearMap(parent: Map<number, Map<string, number>>, year: number): Map<string, number> {
  let child = parent.get(year);
  if (!child) {
    child = new Map();
    parent.set(year, child);
  }
  return child;
}

function snapshotLedger(db: Database.Database): LedgerSnapshot {
  // Realized gain and lot sales share one read, so a year row can never mix
  // the sale year with the purchase year. The key carries no sale transaction
  // id: an engine close is deleted and re-minted under a new id on every
  // recompute, which would report an unchanged sale as removed and added.
  const saleRows = db
    .prepare(
      `SELECT tls.sale_date, tls.realized_gain_loss, tls.quantity_sold, tls.proceeds,
              tls.cost_basis_allocated, tl.acquisition_transaction_id, tl.account_id,
              tl.security_id, tl.acquisition_date, tl.is_short
       FROM tax_lot_sales tls
       JOIN tax_lots tl ON tl.id = tls.tax_lot_id`
    )
    .all() as Array<{
      sale_date: string;
      realized_gain_loss: number;
      quantity_sold: number;
      proceeds: number;
      cost_basis_allocated: number;
      acquisition_transaction_id: number | null;
      account_id: number;
      security_id: number;
      acquisition_date: string;
      is_short: number;
    }>;
  const realizedByYear = new Map<number, number>();
  const lotSalesByYear = new Map<number, Map<string, number>>();
  for (const row of saleRows) {
    const year = yearOf(row.sale_date);
    if (year == null) continue;
    realizedByYear.set(year, (realizedByYear.get(year) ?? 0) + row.realized_gain_loss);
    addKey(
      byYearMap(lotSalesByYear, year),
      [
        row.acquisition_transaction_id ?? "none",
        row.account_id,
        row.security_id,
        row.acquisition_date,
        row.sale_date,
        micros(row.quantity_sold),
        cents(row.proceeds),
        cents(row.cost_basis_allocated),
        row.is_short,
      ].join("|")
    );
  }

  const openLotRows = db
    .prepare(
      `SELECT tl.acquisition_transaction_id, tl.account_id, tl.security_id, tl.acquisition_date,
              tl.quantity_acquired, tl.quantity_remaining, tl.cost_basis, tl.is_short
       FROM tax_lots tl
       WHERE tl.quantity_remaining > 0`
    )
    .all() as Array<{
      acquisition_transaction_id: number | null;
      account_id: number;
      security_id: number;
      acquisition_date: string;
      quantity_acquired: number;
      quantity_remaining: number;
      cost_basis: number;
      is_short: number;
    }>;
  const openLots = new Map<string, number>();
  for (const lot of openLotRows) {
    addKey(
      openLots,
      [
        lot.acquisition_transaction_id ?? "none",
        lot.account_id,
        lot.security_id,
        lot.acquisition_date,
        micros(lot.quantity_acquired),
        micros(lot.quantity_remaining),
        cents(lot.cost_basis),
        lot.is_short,
      ].join("|")
    );
  }

  const closeRows = db
    .prepare(
      `SELECT account_id, security_id, trade_date, quantity, price_per_share, amount, source_key
       FROM transactions
       WHERE type = 'RECONCILE_CLOSE'`
    )
    .all() as Array<{
      account_id: number | null;
      security_id: number | null;
      trade_date: string;
      quantity: number | null;
      price_per_share: number | null;
      amount: number | null;
      source_key: string | null;
    }>;
  const engineClosesByYear = new Map<number, Map<string, number>>();
  for (const close of closeRows) {
    const year = yearOf(close.trade_date);
    if (year == null) continue;
    addKey(
      byYearMap(engineClosesByYear, year),
      [
        close.source_key ?? "none",
        close.account_id ?? "none",
        close.security_id ?? "none",
        close.trade_date,
        micros(close.quantity ?? 0),
        cents(close.price_per_share ?? 0),
        cents(close.amount ?? 0),
      ].join("|")
    );
  }

  return { realizedByYear, lotSalesByYear, openLots, engineClosesByYear };
}

function total(map: Map<string, number>): number {
  let n = 0;
  for (const count of map.values()) n += count;
  return n;
}

function summarize(before: LedgerSnapshot, after: LedgerSnapshot): TaxLotRecomputeSummary {
  const years = new Set<number>([
    ...before.realizedByYear.keys(),
    ...after.realizedByYear.keys(),
    ...before.lotSalesByYear.keys(),
    ...after.lotSalesByYear.keys(),
    ...before.engineClosesByYear.keys(),
    ...after.engineClosesByYear.keys(),
  ]);

  return {
    years: Array.from(years)
      .sort((a, b) => b - a)
      .map((taxYear) => {
        const beforeSales = before.lotSalesByYear.get(taxYear) ?? new Map();
        const afterSales = after.lotSalesByYear.get(taxYear) ?? new Map();
        const beforeCloses = before.engineClosesByYear.get(taxYear) ?? new Map();
        const afterCloses = after.engineClosesByYear.get(taxYear) ?? new Map();
        return {
          taxYear,
          realizedGainBefore: (before.realizedByYear.get(taxYear) ?? 0),
          realizedGainAfter: (after.realizedByYear.get(taxYear) ?? 0),
          lotSalesAdded: unmatched(afterSales, beforeSales),
          lotSalesRemoved: unmatched(beforeSales, afterSales),
          engineClosesAdded: unmatched(afterCloses, beforeCloses),
          engineClosesRemoved: unmatched(beforeCloses, afterCloses),
        };
      }),
    openLots: {
      before: total(before.openLots),
      after: total(after.openLots),
      added: unmatched(after.openLots, before.openLots),
      removed: unmatched(before.openLots, after.openLots),
    },
  };
}

export function rehearseTaxLotRecompute(db: Database.Database): TaxLotRecomputeSummary {
  const before = snapshotLedger(db);
  let summary: TaxLotRecomputeSummary | null = null;
  try {
    db.transaction(() => {
      computeTaxLots(db);
      summary = summarize(before, snapshotLedger(db));
      throw new RecomputeRehearsalRollback();
    })();
  } catch (error) {
    if (!(error instanceof RecomputeRehearsalRollback)) throw error;
  }
  if (!summary) throw new Error("Tax-lot recompute rehearsal did not run");
  return summary;
}

export function applyTaxLotRecompute(db: Database.Database): {
  summary: TaxLotRecomputeSummary;
  lotsCreated: number;
  salesProcessed: number;
  totalRealizedGain: number;
} {
  const before = snapshotLedger(db);
  const result = computeTaxLots(db);
  return {
    summary: summarize(before, snapshotLedger(db)),
    lotsCreated: result.lotsCreated,
    salesProcessed: result.salesProcessed,
    totalRealizedGain: result.totalRealizedGain,
  };
}
