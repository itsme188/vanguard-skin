import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";

export interface TaxLotRecomputeYearSummary {
  taxYear: number;
  realizedGainBefore: number;
  realizedGainAfter: number;
  lotsOpened: number;
  lotsClosed: number;
  lotsChanged: number;
  engineClosesAdded: number;
  engineClosesRemoved: number;
}

export interface TaxLotRecomputeSummary {
  years: TaxLotRecomputeYearSummary[];
}

interface LedgerSnapshot {
  realizedByYear: Map<number, number>;
  lotsByYear: Map<number, Map<string, number>>;
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
  const realizedRows = db
    .prepare(
      `SELECT sale_date, realized_gain_loss
       FROM tax_lot_sales`
    )
    .all() as { sale_date: string; realized_gain_loss: number }[];
  const realizedByYear = new Map<number, number>();
  for (const row of realizedRows) {
    const year = yearOf(row.sale_date);
    if (year == null) continue;
    realizedByYear.set(year, (realizedByYear.get(year) ?? 0) + row.realized_gain_loss);
  }

  const lotRows = db
    .prepare(
      `SELECT tl.acquisition_transaction_id, tl.acquisition_date, tl.quantity_acquired,
              tl.quantity_remaining, tl.cost_basis, tl.is_short
       FROM tax_lots tl`
    )
    .all() as Array<{
      acquisition_transaction_id: number | null;
      acquisition_date: string;
      quantity_acquired: number;
      quantity_remaining: number;
      cost_basis: number;
      is_short: number;
    }>;
  const lotsByYear = new Map<number, Map<string, number>>();
  for (const lot of lotRows) {
    const year = yearOf(lot.acquisition_date);
    if (year == null) continue;
    addKey(
      byYearMap(lotsByYear, year),
      [
        lot.acquisition_transaction_id ?? "none",
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

  return { realizedByYear, lotsByYear, engineClosesByYear };
}

function summarize(before: LedgerSnapshot, after: LedgerSnapshot): TaxLotRecomputeSummary {
  const years = new Set<number>([
    ...before.realizedByYear.keys(),
    ...after.realizedByYear.keys(),
    ...before.lotsByYear.keys(),
    ...after.lotsByYear.keys(),
    ...before.engineClosesByYear.keys(),
    ...after.engineClosesByYear.keys(),
  ]);

  return {
    years: Array.from(years)
      .sort((a, b) => b - a)
      .map((taxYear) => {
        const beforeLots = before.lotsByYear.get(taxYear) ?? new Map();
        const afterLots = after.lotsByYear.get(taxYear) ?? new Map();
        const beforeCloses = before.engineClosesByYear.get(taxYear) ?? new Map();
        const afterCloses = after.engineClosesByYear.get(taxYear) ?? new Map();
        const lotsOpened = unmatched(afterLots, beforeLots);
        const lotsClosed = unmatched(beforeLots, afterLots);
        return {
          taxYear,
          realizedGainBefore: (before.realizedByYear.get(taxYear) ?? 0),
          realizedGainAfter: (after.realizedByYear.get(taxYear) ?? 0),
          lotsOpened,
          lotsClosed,
          lotsChanged: Math.max(lotsOpened, lotsClosed),
          engineClosesAdded: unmatched(afterCloses, beforeCloses),
          engineClosesRemoved: unmatched(beforeCloses, afterCloses),
        };
      }),
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
