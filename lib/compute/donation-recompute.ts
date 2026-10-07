import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import {
  LEDGER_RECOMPUTE_UNACKNOWLEDGED,
  LEDGER_RECOMPUTE_UNACKNOWLEDGED_MESSAGE,
  hasLedgerRecomputeAck,
  type LedgerCensus,
  type LedgerRecomputeReport,
} from "@/lib/compute/donation-recompute-contract";

export interface DonationRecomputeResult {
  recomputed: boolean;
  recomputeError?: string;
  donationsConsumed?: number;
  replayWarnings?: string[];
  /**
   * Row counts before and after the run, and how many sale rows differ.
   * Absent only when the counts themselves could not be read.
   */
  ledger?: LedgerRecomputeReport;
}

/**
 * Counts the computed ledger. Three COUNTs — cheap enough to answer a
 * refused request with, and never a recompute (which takes minutes on a real
 * book).
 */
export function getLedgerCensus(db: Database.Database): LedgerCensus {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    closedSales: count("SELECT COUNT(*) AS n FROM tax_lot_sales"),
    openLots: count("SELECT COUNT(*) AS n FROM tax_lots WHERE quantity_remaining > 0"),
    engineCloses: count("SELECT COUNT(*) AS n FROM transactions WHERE type = 'RECONCILE_CLOSE'"),
  };
}

/**
 * Broker-accepted (account, tax year) records that are current right now.
 * A donation mutation that bumps the tax input generation sends every one of
 * them back to not-for-filing until it is reconciled again. Read through the
 * one acceptance reader (`getTaxConventionState`), never re-derived. A schema
 * with no `settings` table (minimal test databases) models no acceptance: 0.
 * (tax-convention.ts keeps its own settings-table probe private, so the same
 * one-line check is repeated here rather than exported from a file this unit
 * does not own.)
 */
export function countAcceptedTaxYears(db: Database.Database): number {
  const hasSettings =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() != null;
  if (!hasSettings) return 0;
  const { acceptance } = getTaxConventionState(db);
  if (!acceptance.current) return 0;
  return new Set(acceptance.coverage.map((c) => `${c.accountId}:${c.taxYear}`)).size;
}

/**
 * The notice a command-line caller prints BEFORE it recomputes. Pass the
 * accepted-year count taken BEFORE the caller's own mutations (they bump the
 * tax input generation, after which nothing reads as accepted any more).
 */
export function wholeLedgerRecomputeNotice(acceptedTaxYearsBefore: number): string {
  const base = "About to recompute the ENTIRE tax-lot ledger for all accounts: every tax lot and closed sale is rebuilt.";
  return acceptedTaxYearsBefore > 0
    ? `${base} ${acceptedTaxYearsBefore} accepted account tax year(s) will go back to not-for-filing until they are reconciled again.`
    : base;
}

/** True when the request body carries the acknowledgement. */
export function isLedgerRecomputeAcknowledged(body: unknown): boolean {
  return hasLedgerRecomputeAck(body);
}

class RehearsalRollback extends Error {}

/**
 * Runs a donation mutation for real when the request is acknowledged, and as
 * a REHEARSAL when it is not: inside a transaction that is always rolled
 * back. Either way the mutation's own errors propagate, so the route maps
 * them to the same 400/409 it always did. That is what lets the route check
 * everything first — a missing donation, a bad lot, an over-assignment — and
 * only then ask the user to confirm, while still writing nothing without the
 * flag.
 */
export function applyOrRehearse(db: Database.Database, acknowledged: boolean, mutate: () => void): void {
  if (acknowledged) {
    mutate();
    return;
  }
  try {
    db.transaction(() => {
      mutate();
      throw new RehearsalRollback();
    })();
  } catch (error) {
    if (!(error instanceof RehearsalRollback)) throw error;
  }
}

/**
 * The 409 a route sends after a clean rehearsal of an unacknowledged
 * request. `bumpsTaxGeneration` says whether THIS mutation moves the tax
 * input generation (every donation mutation except resolve-security does);
 * only then are accepted tax years at stake.
 */
export function ledgerRecomputeRefusal(
  db: Database.Database,
  opts: { bumpsTaxGeneration: boolean }
): Response {
  return Response.json(
    {
      success: false,
      error: LEDGER_RECOMPUTE_UNACKNOWLEDGED_MESSAGE,
      code: LEDGER_RECOMPUTE_UNACKNOWLEDGED,
      data: {
        ledger: getLedgerCensus(db),
        acceptedTaxYearsAffected: opts.bumpsTaxGeneration ? countAcceptedTaxYears(db) : 0,
      },
    },
    { status: 409 }
  );
}

interface SaleRow {
  sale_transaction_id: number;
  sale_type: string | null;
  account_id: number | null;
  security_id: number | null;
  acquisition_transaction_id: number | null;
  sale_date: string;
  quantity_sold: number;
  proceeds: number;
  cost_basis_allocated: number;
  realized_gain_loss: number;
  is_long_term: number;
  premium_rollover: number;
}

const cents = (n: number) => Math.round(n * 100);
const micro = (n: number) => Math.round(n * 1e6);

/**
 * One content key per sale row, counted as a multiset. The key never uses a
 * `tax_lots` / `tax_lot_sales` id (every recompute re-mints them) nor an
 * engine-made close's transaction id (re-minted too): a real sale is keyed by
 * its transaction, an engine-made close by its account and security, and the
 * lot by the transaction that opened it.
 */
function saleRowKeys(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT tls.sale_transaction_id, t.type AS sale_type, t.account_id, t.security_id,
              tl.acquisition_transaction_id, tls.sale_date, tls.quantity_sold, tls.proceeds,
              tls.cost_basis_allocated, tls.realized_gain_loss, tls.is_long_term, tls.premium_rollover
         FROM tax_lot_sales tls
         LEFT JOIN tax_lots tl ON tl.id = tls.tax_lot_id
         LEFT JOIN transactions t ON t.id = tls.sale_transaction_id`
    )
    .all() as SaleRow[];
  const keys = new Map<string, number>();
  for (const r of rows) {
    const sale =
      r.sale_type === "RECONCILE_CLOSE" ? `engine:${r.account_id}:${r.security_id}` : `txn:${r.sale_transaction_id}`;
    const key = [
      sale,
      r.acquisition_transaction_id ?? "none",
      r.sale_date,
      micro(r.quantity_sold),
      cents(r.proceeds),
      cents(r.cost_basis_allocated),
      cents(r.realized_gain_loss),
      r.is_long_term,
      r.premium_rollover,
    ].join("|");
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return keys;
}

/** Rows of `a` with no identical partner in `b` (multiset difference size). */
function unmatched(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [key, count] of a) n += Math.max(0, count - (b.get(key) ?? 0));
  return n;
}

/**
 * One key per lot: the transaction that opened it, the quantity still open
 * and the lot's basis in cents. Lot ids are re-minted by every recompute, so
 * they are not in the key.
 */
function lotKeys(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare(`SELECT acquisition_transaction_id, quantity_remaining, cost_basis, is_short FROM tax_lots`)
    .all() as {
    acquisition_transaction_id: number | null;
    quantity_remaining: number;
    cost_basis: number;
    is_short: number;
  }[];
  const keys = new Map<string, number>();
  for (const r of rows) {
    const key = [r.acquisition_transaction_id ?? "none", micro(r.quantity_remaining), cents(r.cost_basis), r.is_short].join("|");
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return keys;
}

interface LedgerSnapshot {
  census: LedgerCensus;
  sales: Map<string, number>;
  lots: Map<string, number>;
}

function snapshotLedger(db: Database.Database): LedgerSnapshot {
  return { census: getLedgerCensus(db), sales: saleRowKeys(db), lots: lotKeys(db) };
}

function reportSince(db: Database.Database, before: LedgerSnapshot): LedgerRecomputeReport {
  const after = snapshotLedger(db);
  return {
    before: before.census,
    after: after.census,
    saleRowsAddedOrChanged: unmatched(after.sales, before.sales),
    saleRowsRemovedOrChanged: unmatched(before.sales, after.sales),
    // A changed lot is one "before" row and one "after" row with no partner;
    // a lot that appears or disappears is one of the two. The larger side is
    // the number of lots that differ.
    openLotsChanged: Math.max(unmatched(after.lots, before.lots), unmatched(before.lots, after.lots)),
  };
}

/**
 * Runs computeTaxLots(db) after a donation-mutation route's write succeeds
 * (Task 12, spec §10 recompute-failure feedback). A recompute failure never
 * turns a saved write into a 500 — the route still returns 200 with
 * `saved:true`; this only reports `recomputed:false` + `recomputeError`
 * alongside it. Every donation-mutation route (links POST/DELETE, lots
 * POST, reverse POST, resolve-security POST) calls this only for an
 * acknowledged request (`applyOrRehearse` + `ledgerRecomputeRefusal`) and
 * after the mutation's own try/catch has already succeeded.
 *
 * The recompute is the whole ledger, in one transaction: a throw half-way
 * rolls every lot and sale row back, so a failed run reports `after` equal
 * to `before`. The counts are read from the tables, never inferred.
 */
export function recomputeAfterDonationMutation(db: Database.Database): DonationRecomputeResult {
  let before: LedgerSnapshot | undefined;
  try {
    before = snapshotLedger(db);
    const result = computeTaxLots(db);
    return {
      recomputed: true,
      donationsConsumed: result.donationsConsumed,
      replayWarnings: result.replayWarnings,
      ledger: reportSince(db, before),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const failed: DonationRecomputeResult = { recomputed: false, recomputeError: message };
    if (before) {
      try {
        failed.ledger = reportSince(db, before);
      } catch {
        // The counts could not be read either; the failure message stands alone.
      }
    }
    return failed;
  }
}
