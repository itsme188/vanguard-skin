/**
 * The wire contract between the donation-mutation routes and the Giving
 * screens for the whole-ledger recompute (owner ruling 2026-10-06: disclose
 * and confirm). Pure constants, types and readers with no imports, so a
 * client component can use it without pulling the tax-lot engine into the
 * browser bundle.
 *
 * Every donation mutation ends in `recomputeAfterDonationMutation`, which
 * rebuilds EVERY tax lot and realized-sale row in the book. A route therefore
 * refuses the mutation unless the request body carries
 * `acknowledgeLedgerRecompute: true`, and answers the refusal with a census of
 * what the recompute would rebuild so the screen can say so before asking.
 */

/** Body field a caller must set to literal `true`. */
export const LEDGER_RECOMPUTE_ACK_FIELD = "acknowledgeLedgerRecompute";

/** `code` on the 409 a route returns when the acknowledgement is missing. */
export const LEDGER_RECOMPUTE_UNACKNOWLEDGED = "ledger_recompute_unacknowledged";

export const LEDGER_RECOMPUTE_UNACKNOWLEDGED_MESSAGE =
  "This change recomputes the entire tax-lot ledger. Confirm to continue.";

/** Row counts of the computed ledger, read straight from the tables. */
export interface LedgerCensus {
  /** Rows in `tax_lot_sales` (every realized close, estimated closes included). */
  closedSales: number;
  /** `tax_lots` rows with shares still open, long and short. */
  openLots: number;
  /** Estimated closes: the engine-made stand-ins the Tax Lots page chips "Estimated". */
  engineCloses: number;
}

/** What a refusal tells the screen before it asks. */
export interface LedgerRecomputeRefusal {
  ledger: LedgerCensus;
  /**
   * Broker-accepted (account, tax year) records that a confirmed run sends
   * back to not-for-filing. 0 when none are accepted, or when this mutation
   * does not move the tax input generation.
   */
  acceptedTaxYearsAffected: number;
}

/** What a confirmed run moved. */
export interface LedgerRecomputeReport {
  before: LedgerCensus;
  after: LedgerCensus;
  /** Sale rows in the rebuilt ledger with no identical row before the run. */
  saleRowsAddedOrChanged: number;
  /** Sale rows from before the run with no identical row in the rebuilt ledger. */
  saleRowsRemovedOrChanged: number;
  /**
   * Lots whose open quantity or basis differs from before the run. A gift
   * re-pointed from one lot to another moves no count and no sale row; it
   * shows up here.
   */
  openLotsChanged: number;
}

/** Only the literal boolean `true` acknowledges. */
export function hasLedgerRecomputeAck(body: unknown): boolean {
  return (
    body != null &&
    typeof body === "object" &&
    (body as Record<string, unknown>)[LEDGER_RECOMPUTE_ACK_FIELD] === true
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A census from an untrusted JSON value, or null when any count is not a whole number. */
export function readLedgerCensus(value: unknown): LedgerCensus | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.closedSales) || !isCount(v.openLots) || !isCount(v.engineCloses)) return null;
  return { closedSales: v.closedSales, openLots: v.openLots, engineCloses: v.engineCloses };
}

/** A recompute report from an untrusted JSON value, or null when malformed. */
export function readLedgerRecomputeReport(value: unknown): LedgerRecomputeReport | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const before = readLedgerCensus(v.before);
  const after = readLedgerCensus(v.after);
  if (!before || !after) return null;
  if (!isCount(v.saleRowsAddedOrChanged) || !isCount(v.saleRowsRemovedOrChanged) || !isCount(v.openLotsChanged))
    return null;
  return {
    before,
    after,
    saleRowsAddedOrChanged: v.saleRowsAddedOrChanged,
    saleRowsRemovedOrChanged: v.saleRowsRemovedOrChanged,
    openLotsChanged: v.openLotsChanged,
  };
}

/**
 * What a refusal body carries, or null when the body is not this
 * refusal. A 409 from these routes also means "already linked" or "already
 * resolved", so the `code` is the discriminator, never the status alone.
 */
export function readLedgerRecomputeRefusal(body: unknown): LedgerRecomputeRefusal | null {
  if (body == null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.code !== LEDGER_RECOMPUTE_UNACKNOWLEDGED) return null;
  const data = b.data;
  if (data == null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ledger = readLedgerCensus(d.ledger);
  if (!ledger || !isCount(d.acceptedTaxYearsAffected)) return null;
  return { ledger, acceptedTaxYearsAffected: d.acceptedTaxYearsAffected };
}
