import type Database from "better-sqlite3";
import { getDonations, type DonationRow } from "@/lib/queries/donations";
import { reconcileDonations, type ReconciliationReport } from "@/lib/compute/donation-reconciliation";
import { isLongTermHolding } from "@/lib/compute/tax-lots";
import { getTaxConventionState } from "@/lib/compute/tax-convention";

/**
 * Giving view assembly (Task 12) — the single read the Analysis > Giving
 * page (Task 13, server component) and GET /api/donations share. Basis/gain
 * math, LT/ST split and status precedence are spec'd in
 * .superpowers/sdd/2026-08-17-donation-tracking/task-12-brief.md.
 */

export interface GivingYear {
  year: string;
  totalGiven: number;
  stockGiven: number;
  cashGiven: number;
  /**
   * null when any (non-reversed) stock donation in the year lacks lot
   * assignments. Otherwise the sum over the stock donations whose basis is
   * plausible — a row flagged `basisImplausible` is LEFT OUT (owner ruling
   * 2026-10-06), so this can be 0 with every row left out. A row whose
   * flagged lots are all marked "basis verified" is not flagged and counts.
   */
  gainAvoided: number | null;
  /** Non-reversed stock donations left out of `gainAvoided` for an implausible basis. */
  gainAvoidedRowsLeftOut: number;
  /** Non-reversed stock donations whose avoided gain IS in `gainAvoided`. */
  gainAvoidedRowsCounted: number;
  donations: GivingDonation[];
}

export interface GivingDonation {
  donation: DonationRow;
  accountName: string | null;
  basis: number | null;
  gainAvoided: number | null;
  /**
   * THE left-out rule for a gift row: true when at least one assigned lot's
   * basis state (`donatedLotBasisState`) is `implausible` or `verified-stale`.
   * Such a row's avoided gain is left out of the year total. A row whose
   * flagged lots are all `verified` is false here and counts exactly as if
   * it had never been flagged. Always false with no lots assigned.
   */
  basisImplausible: boolean;
  /**
   * The assigned lots whose basis trips the 1% rule, in assignment order,
   * each with its state. A `plausible` lot is never listed, marker or not.
   * The page draws one chip and one control per entry.
   */
  flaggedLots: GivingFlaggedLot[];
  longTermQuantity: number | null;
  shortTermQuantity: number | null;
  /** Precedence (Codex plan-review #8): reversed > unsupported (non-USD) > pending-lots
   * (stock, linked, no assignments) > completed > received. */
  status: "reversed" | "unsupported" | "pending-lots" | "completed" | "received";
  needsLots: boolean;
  linked: boolean;
  symbolResolved: boolean;
}

/**
 * A donated lot's basis, as the Giving page treats it:
 *  - `plausible`: the 1% rule does not fire. Any marker is ignored.
 *  - `implausible`: the rule fires and nobody has verified the lot.
 *  - `verified`: the rule fires, the owner marked the lot's basis verified,
 *    and the acquisition row still says what it said then.
 *  - `verified-stale`: the rule fires and a marker exists, but the row's
 *    amount or quantity has changed since. Treated like `implausible`.
 */
export type DonatedLotBasisState = "plausible" | "implausible" | "verified" | "verified-stale";

export interface GivingFlaggedLot {
  acquisitionTransactionId: number;
  acquisitionDate: string;
  state: Exclude<DonatedLotBasisState, "plausible">;
  /** What the owner checked the basis against; null with no marker. */
  sourceNote: string | null;
  /** When the marker was written (`datetime('now')`, UTC); null with no marker. */
  verifiedAt: string | null;
}

interface OutLegRow {
  donation_id: number;
  account_id: number;
  account_name: string;
  trade_date: string;
}

interface AssignmentRow {
  donation_id: number;
  acquisition_transaction_id: number;
  quantity: number;
  acquisition_date: string;
  quantity_acquired: number;
  cost_basis: number;
  /** The acquisition transaction's stored amount and quantity, as of now. */
  txn_amount: number | null;
  txn_quantity: number | null;
  /** 1 when a `lot_basis_verifications` row exists for the acquisition transaction. */
  has_verification: number;
  verified_amount: number | null;
  verified_quantity: number | null;
  source_note: string | null;
  verified_at: string | null;
}

/** A donated lot's per-share basis below this percent of the gift's per-share
 *  fair market value is not believable (owner ruling 2026-10-06). */
export const DONATED_BASIS_FLOOR_PERCENT = 1;

export interface DonatedLotBasisInput {
  /** `tax_lots.cost_basis` of the assigned lot (whole lot, dollars). */
  lotCostBasis: number | null | undefined;
  /** `tax_lots.quantity_acquired` of the assigned lot. */
  lotQuantityAcquired: number | null | undefined;
  /** `donations.fmv_usd` (whole gift, dollars). */
  donationFmvUsd: number | null | undefined;
  /** `donations.quantity` (shares given). */
  donationQuantity: number | null | undefined;
}

function positiveFinite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * THE one plausibility predicate for a donated lot's basis. Its only caller
 * is `donatedLotBasisState` below, which adds the "basis verified" marker;
 * the row chips and the year total read that state, never this directly.
 *
 * True when the lot's per-share basis is STRICTLY under 1% of the gift's
 * per-share fair market value. Exactly 1% is plausible.
 *
 * - No per-share fair market value (the gift's value or share count is
 *   missing, zero, negative or not a number): false. There is nothing to
 *   compare against, so nothing is flagged and nothing is divided.
 * - No per-share basis (the lot has no shares, or its basis is not a number):
 *   true. The view prices such a lot at zero a share, which publishes the
 *   whole fair market value as avoided gain — the same defect the rule is for.
 * - A zero or negative basis: true.
 *
 * Compared by cross-multiplication, so a share price that does not divide
 * evenly cannot tip the boundary through a rounding error.
 */
export function isDonatedLotBasisImplausible(input: DonatedLotBasisInput): boolean {
  const { lotCostBasis, lotQuantityAcquired, donationFmvUsd, donationQuantity } = input;
  if (!positiveFinite(donationFmvUsd) || !positiveFinite(donationQuantity)) return false;
  if (!positiveFinite(lotQuantityAcquired)) return true;
  if (typeof lotCostBasis !== "number" || !Number.isFinite(lotCostBasis)) return true;
  // basis/lotQty < (floor/100) × fmv/giftQty, with every divisor positive.
  return lotCostBasis * 100 * donationQuantity < DONATED_BASIS_FLOOR_PERCENT * donationFmvUsd * lotQuantityAcquired;
}

/** Share-count tolerance, the same one lib/mutations/donation-links.ts uses. */
const QUANTITY_EPS = 1e-9;

function sameCents(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.round(a * 100) === Math.round(b * 100);
}

function sameQuantity(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= QUANTITY_EPS;
}

export interface DonatedLotBasisStateInput extends DonatedLotBasisInput {
  /** The acquisition transaction's `amount` and `quantity` as stored now. */
  currentAmount: number | null | undefined;
  currentQuantity: number | null | undefined;
  /** The lot's `lot_basis_verifications` snapshot, or null when it has no marker. */
  verification: { verifiedAmount: number | null; verifiedQuantity: number | null } | null;
}

/**
 * THE one reader of a donated lot's basis state (owner request 2026-10-07).
 * The row chips, the row's left-out flag, the year total and the year's
 * left-out count all come from here.
 *
 * A marker only ever matters on a lot the 1% rule flags. It is stale when the
 * acquisition row's amount (compared in cents) or quantity (compared with the
 * share tolerance) is no longer what was verified; a missing figure equals a
 * missing figure and differs from any number.
 */
export function donatedLotBasisState(input: DonatedLotBasisStateInput): DonatedLotBasisState {
  if (!isDonatedLotBasisImplausible(input)) return "plausible";
  const { verification } = input;
  if (verification == null) return "implausible";
  const unchanged =
    sameCents(verification.verifiedAmount, input.currentAmount) &&
    sameQuantity(verification.verifiedQuantity, input.currentQuantity);
  return unchanged ? "verified" : "verified-stale";
}

/** True for the two states that keep a gift row out of "Gain avoided". */
function leavesRowOut(state: DonatedLotBasisState): boolean {
  return state === "implausible" || state === "verified-stale";
}

function fetchOutLegs(db: Database.Database): Map<number, OutLegRow> {
  const rows = db
    .prepare(
      `SELECT l.donation_id AS donation_id, t.account_id AS account_id, a.name AS account_name,
              t.trade_date AS trade_date
         FROM donation_leg_links l
         JOIN transactions t ON t.id = l.transaction_id
         JOIN accounts a ON a.id = t.account_id
        WHERE l.role = 'out'`
    )
    .all() as OutLegRow[];
  return new Map(rows.map((r) => [r.donation_id, r]));
}

/** Assigned lots joined to their tax_lots row (acquisition basis) — used for
 * both the basis/gain math and the LT/ST split. Assumes the 1:1
 * acquisition_transaction_id -> tax_lots relationship the engine itself
 * relies on (assignDonationLots' own lot lookup uses .get(), not .all()).
 * Each row also carries the acquisition transaction's current amount and
 * quantity and its "basis verified" marker, if any (LEFT JOINs: neither can
 * drop an assignment from the basis math). */
function fetchAssignmentsByDonation(db: Database.Database): Map<number, AssignmentRow[]> {
  const rows = db
    .prepare(
      `SELECT dl.donation_id AS donation_id, dl.acquisition_transaction_id AS acquisition_transaction_id,
              dl.quantity AS quantity, tl.acquisition_date AS acquisition_date,
              tl.quantity_acquired AS quantity_acquired, tl.cost_basis AS cost_basis,
              t.amount AS txn_amount, t.quantity AS txn_quantity,
              v.id IS NOT NULL AS has_verification,
              v.verified_amount AS verified_amount, v.verified_quantity AS verified_quantity,
              v.source_note AS source_note, v.verified_at AS verified_at
         FROM donation_lots dl
         JOIN tax_lots tl ON tl.acquisition_transaction_id = dl.acquisition_transaction_id
         LEFT JOIN transactions t ON t.id = dl.acquisition_transaction_id
         LEFT JOIN lot_basis_verifications v ON v.acquisition_transaction_id = dl.acquisition_transaction_id
        ORDER BY dl.donation_id, dl.id`
    )
    .all() as AssignmentRow[];
  const map = new Map<number, AssignmentRow[]>();
  for (const row of rows) {
    const list = map.get(row.donation_id);
    if (list) list.push(row);
    else map.set(row.donation_id, [row]);
  }
  return map;
}

function fetchSecurityCurrencies(db: Database.Database): Map<number, string> {
  const rows = db.prepare("SELECT id, currency FROM securities").all() as {
    id: number;
    currency: string | null;
  }[];
  return new Map(rows.map((r) => [r.id, r.currency ?? "USD"]));
}

function computeStatus(
  d: DonationRow,
  needsLots: boolean,
  currency: string | null
): GivingDonation["status"] {
  if (d.reversed_date != null) return "reversed";
  if (d.kind === "stock" && d.security_id != null && currency != null && currency !== "USD") {
    return "unsupported";
  }
  if (needsLots) return "pending-lots";
  if (d.completed_date != null) return "completed";
  return "received";
}

function buildGivingDonation(
  d: DonationRow,
  outLegs: Map<number, OutLegRow>,
  assignmentsByDonation: Map<number, AssignmentRow[]>,
  currencies: Map<number, string>
): GivingDonation {
  const outLeg = outLegs.get(d.id) ?? null;
  const linked = outLeg != null;
  const assignments = assignmentsByDonation.get(d.id) ?? [];
  const symbolResolved = d.kind !== "stock" || d.security_id != null;
  const needsLots = d.kind === "stock" && linked && assignments.length === 0;

  let basis: number | null = null;
  let gainAvoided: number | null = null;
  let longTermQuantity: number | null = null;
  let shortTermQuantity: number | null = null;
  let basisImplausible = false;
  const flaggedLots: GivingFlaggedLot[] = [];

  if (d.kind === "stock" && outLeg != null && assignments.length > 0) {
    let basisSum = 0;
    let lt = 0;
    let st = 0;
    for (const a of assignments) {
      const perShare = a.quantity_acquired !== 0 ? a.cost_basis / a.quantity_acquired : 0;
      basisSum += a.quantity * perShare;
      // Judged per LOT, not on the blended row: one penny-basis lot among
      // ordinary ones still overstates the avoided gain by its whole value.
      const hasMarker = a.has_verification === 1;
      const state = donatedLotBasisState({
        lotCostBasis: a.cost_basis,
        lotQuantityAcquired: a.quantity_acquired,
        donationFmvUsd: d.fmv_usd,
        donationQuantity: d.quantity,
        currentAmount: a.txn_amount,
        currentQuantity: a.txn_quantity,
        verification: hasMarker
          ? { verifiedAmount: a.verified_amount, verifiedQuantity: a.verified_quantity }
          : null,
      });
      if (state !== "plausible") {
        flaggedLots.push({
          acquisitionTransactionId: a.acquisition_transaction_id,
          acquisitionDate: a.acquisition_date,
          state,
          sourceNote: hasMarker ? a.source_note : null,
          verifiedAt: hasMarker ? a.verified_at : null,
        });
      }
      // One unverified (or stale) lot leaves the whole row out.
      if (leavesRowOut(state)) basisImplausible = true;
      if (isLongTermHolding(a.acquisition_date, outLeg.trade_date)) lt += a.quantity;
      else st += a.quantity;
    }
    basis = basisSum;
    gainAvoided = d.fmv_usd - basisSum;
    longTermQuantity = lt;
    shortTermQuantity = st;
  }

  const currency = d.security_id != null ? currencies.get(d.security_id) ?? "USD" : null;
  const status = computeStatus(d, needsLots, currency);

  return {
    donation: d,
    accountName: outLeg?.account_name ?? null,
    basis,
    gainAvoided,
    basisImplausible,
    flaggedLots,
    longTermQuantity,
    shortTermQuantity,
    status,
    needsLots,
    linked,
    symbolResolved,
  };
}

export function getGivingView(db: Database.Database): {
  years: GivingYear[];
  reconciliation: ReconciliationReport;
  /** True when the tax-input generation has moved past the last
   *  computeTaxLots recompute (Task 1's getTaxConventionState) — basis/
   *  gainAvoided above may still reflect a stale mutation. */
  conventionPending: boolean;
} {
  const donations = getDonations(db);
  const reconciliation = reconcileDonations(db);
  const outLegs = fetchOutLegs(db);
  const assignmentsByDonation = fetchAssignmentsByDonation(db);
  const currencies = fetchSecurityCurrencies(db);

  const byYear = new Map<string, GivingDonation[]>();
  for (const d of donations) {
    const year = d.received_date.slice(0, 4);
    const gd = buildGivingDonation(d, outLegs, assignmentsByDonation, currencies);
    const list = byYear.get(year);
    if (list) list.push(gd);
    else byYear.set(year, [gd]);
  }

  const years: GivingYear[] = [...byYear.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([year, yearDonations]) => {
      // Reversed donations are EXCLUDED from every yearly total (they still
      // appear in `donations` so the UI can render them struck-through).
      const active = yearDonations.filter((gd) => gd.donation.reversed_date == null);
      const totalGiven = active.reduce((sum, gd) => sum + gd.donation.fmv_usd, 0);
      const stockGiven = active
        .filter((gd) => gd.donation.kind === "stock")
        .reduce((sum, gd) => sum + gd.donation.fmv_usd, 0);
      const cashGiven = active
        .filter((gd) => gd.donation.kind === "cash")
        .reduce((sum, gd) => sum + gd.donation.fmv_usd, 0);
      const stockDonations = active.filter((gd) => gd.donation.kind === "stock");
      const anyMissingBasis = stockDonations.some((gd) => gd.basis == null);
      // A row with an implausible basis is left out of the total (owner
      // ruling 2026-10-06); the header says how many were. The row flag is
      // the single source — the total never re-derives it. A row whose
      // flagged lots are all marked verified is not flagged (2026-10-07).
      const counted = stockDonations.filter((gd) => gd.basis != null && !gd.basisImplausible);
      const gainAvoidedRowsLeftOut = stockDonations.filter((gd) => gd.basisImplausible).length;
      const gainAvoided = anyMissingBasis
        ? null
        : counted.reduce((sum, gd) => sum + (gd.gainAvoided ?? 0), 0);
      return {
        year,
        totalGiven,
        stockGiven,
        cashGiven,
        gainAvoided,
        gainAvoidedRowsLeftOut,
        gainAvoidedRowsCounted: counted.length,
        donations: yearDonations,
      };
    });

  const conventionPending = !getTaxConventionState(db).recomputeCurrent;
  return { years, reconciliation, conventionPending };
}

/** True when a donation row with this id exists. */
export function donationExists(db: Database.Database, donationId: number): boolean {
  return db.prepare("SELECT 1 FROM donations WHERE id = ?").get(donationId) != null;
}

// ── Per-donation open-lots listing (drawer support, Task 13) ──────────────

export class DonationLotsQueryError extends Error {}

export interface OpenLotForDonation {
  acquisitionTransactionId: number;
  acquisitionDate: string;
  costBasis: number;
  quantityAcquired: number;
  /** quantity_acquired minus sales before the donation's OUT-leg date minus
   * OTHER (unreversed) donations' assignments dated before it — NOT today's
   * quantity_remaining, which would price the gift in the wrong basis if a
   * split happened after the donation date. */
  remainingAsOfDonationDate: number;
  isLongTerm: boolean;
  gainPerShare: number | null;
  suggested: boolean;
  suggestedQuantity: number;
  /** This donation's OWN current claim on this lot (donation_lots.quantity
   * for THIS donation_id), 0 when unassigned. Lets the drawer pre-fill
   * "Edit lots" with the existing picks instead of always starting blank
   * (controller ruling, 2026-08-17) — does not affect
   * remainingAsOfDonationDate, which already counts this donation's own
   * claim back toward capacity (see otherDonationsBeforeStmt below). */
  currentlyAssignedQuantity: number;
}

/**
 * Lists open lots AS OF the donation's OUT-leg date, in that date's units,
 * for the lot-assignment drawer. Also flags a greedy long-term/highest-gain
 * preselection (LT lots first, then highest gain-per-share) covering the
 * donation's full quantity — the drawer's "Suggest highest-gain long-term"
 * button uses these flags as its default; the user can still override.
 */
export function getOpenLotsForDonation(db: Database.Database, donationId: number): OpenLotForDonation[] {
  const donation = db.prepare("SELECT * FROM donations WHERE id = ?").get(donationId) as
    | DonationRow
    | undefined;
  if (!donation) {
    throw new DonationLotsQueryError(`donation ${donationId}: not found`);
  }
  if (donation.kind !== "stock" || donation.security_id == null) {
    throw new DonationLotsQueryError(`donation ${donationId}: not a resolved stock donation`);
  }
  const outLeg = db
    .prepare(
      `SELECT t.account_id AS account_id, t.trade_date AS trade_date
         FROM donation_leg_links l JOIN transactions t ON t.id = l.transaction_id
        WHERE l.donation_id = ? AND l.role = 'out'`
    )
    .get(donationId) as { account_id: number; trade_date: string } | undefined;
  if (!outLeg) {
    throw new DonationLotsQueryError(
      `donation ${donationId}: no confirmed out link — link the OUT leg before listing lots`
    );
  }

  const lotRows = db
    .prepare(
      `SELECT id, acquisition_transaction_id, acquisition_date, cost_basis, quantity_acquired
         FROM tax_lots
        WHERE account_id = ? AND security_id = ? AND acquisition_date < ?
        ORDER BY acquisition_date, id`
    )
    .all(outLeg.account_id, donation.security_id, outLeg.trade_date) as Array<{
    id: number;
    acquisition_transaction_id: number;
    acquisition_date: string;
    cost_basis: number;
    quantity_acquired: number;
  }>;

  const salesBeforeStmt = db.prepare(
    `SELECT COALESCE(SUM(ts.quantity_sold), 0) AS qty
       FROM tax_lot_sales ts WHERE ts.tax_lot_id = ? AND ts.sale_date < ?`
  );
  const otherDonationsBeforeStmt = db.prepare(
    `SELECT COALESCE(SUM(dl.quantity), 0) AS qty
       FROM donation_lots dl
       JOIN donations d2 ON d2.id = dl.donation_id
       JOIN donation_leg_links l2 ON l2.donation_id = d2.id AND l2.role = 'out'
       JOIN transactions t2 ON t2.id = l2.transaction_id
      WHERE dl.acquisition_transaction_id = ?
        AND dl.donation_id != ?
        AND d2.reversed_date IS NULL
        AND t2.trade_date < ?`
  );

  const fmvPerShare =
    donation.quantity != null && donation.quantity > 0 ? donation.fmv_usd / donation.quantity : null;

  const currentAssignmentRows = db
    .prepare(`SELECT acquisition_transaction_id, quantity FROM donation_lots WHERE donation_id = ?`)
    .all(donationId) as { acquisition_transaction_id: number; quantity: number }[];
  const currentAssignments = new Map(currentAssignmentRows.map((r) => [r.acquisition_transaction_id, r.quantity]));

  const rows: OpenLotForDonation[] = lotRows.map((lot) => {
    const salesBefore = (salesBeforeStmt.get(lot.id, outLeg.trade_date) as { qty: number }).qty;
    const otherAssigned = (
      otherDonationsBeforeStmt.get(lot.acquisition_transaction_id, donationId, outLeg.trade_date) as {
        qty: number;
      }
    ).qty;
    const remaining = Math.max(0, lot.quantity_acquired - salesBefore - otherAssigned);
    const isLongTerm = isLongTermHolding(lot.acquisition_date, outLeg.trade_date);
    const costPerShare = lot.quantity_acquired !== 0 ? lot.cost_basis / lot.quantity_acquired : 0;
    const gainPerShare = fmvPerShare != null ? fmvPerShare - costPerShare : null;
    return {
      acquisitionTransactionId: lot.acquisition_transaction_id,
      acquisitionDate: lot.acquisition_date,
      costBasis: lot.cost_basis,
      quantityAcquired: lot.quantity_acquired,
      remainingAsOfDonationDate: remaining,
      isLongTerm,
      gainPerShare,
      suggested: false,
      suggestedQuantity: 0,
      currentlyAssignedQuantity: currentAssignments.get(lot.acquisition_transaction_id) ?? 0,
    };
  });

  const ranked = [...rows].sort((a, b) => {
    if (a.isLongTerm !== b.isLongTerm) return a.isLongTerm ? -1 : 1;
    const ga = a.gainPerShare ?? -Infinity;
    const gb = b.gainPerShare ?? -Infinity;
    if (ga !== gb) return gb - ga;
    return a.acquisitionDate < b.acquisitionDate ? -1 : 1;
  });
  let remainingNeeded = donation.quantity ?? 0;
  for (const lot of ranked) {
    if (remainingNeeded <= 1e-9) break;
    if (lot.remainingAsOfDonationDate <= 0) continue;
    const take = Math.min(lot.remainingAsOfDonationDate, remainingNeeded);
    lot.suggested = true;
    lot.suggestedQuantity = take;
    remainingNeeded -= take;
  }

  return rows.sort((a, b) =>
    a.acquisitionDate === b.acquisitionDate
      ? a.acquisitionTransactionId - b.acquisitionTransactionId
      : a.acquisitionDate < b.acquisitionDate
        ? -1
        : 1
  );
}
