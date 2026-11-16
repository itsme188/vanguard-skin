import type Database from "better-sqlite3";
import { getDonations, type DonationRow } from "@/lib/queries/donations";
import { reconcileDonations, type ReconciliationReport } from "@/lib/compute/donation-reconciliation";
import { isLongTermHolding } from "@/lib/compute/tax-lots";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import { IMPORT_SPLIT_ACTION_TYPES_SQL } from "@/lib/compute/synthetic-close-guards";

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
  /**
   * Non-reversed stock donations of a non-USD security (status
   * "unsupported"), left out of `gainAvoided` and of its pending check. Not
   * included in `gainAvoidedRowsLeftOut`, which counts implausible bases only.
   */
  gainAvoidedRowsUnsupported: number;
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
 *    and the lot's cost basis and quantity acquired are still what they were.
 *  - `verified-stale`: the rule fires and a marker exists, but the lot's
 *    cost basis or quantity acquired has changed since, or the lot is no
 *    longer in the ledger. Treated like `implausible`.
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
  /**
   * Every gift this lot is flagged on, this row's own gift included, oldest
   * first. A marker belongs to the LOT, so marking it verified (or undoing
   * that) changes all of these rows in one save; the verify dialog lists
   * them. Left out: a reversed gift (it is in no total), and a gift whose
   * own fair market value does not trip the 1% rule on this lot (nothing
   * about it changes).
   */
  giftsFed: GivingLotGift[];
}

/** One gift a flagged lot feeds: enough to name it and its year. */
export interface GivingLotGift {
  donationId: number;
  receivedDate: string;
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
  quantity_remaining: number;
  /** The acquisition transaction's own quantity (split-unit conversion). */
  acquisition_quantity: number | null;
  /** 1 for a short lot: never a gift source (G1, 2026-11-15). */
  is_short: number;
  cost_basis: number;
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

/** Two dollar figures that are both present and equal to the cent. */
function sameCents(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Two share counts that are both present and equal within the tolerance. */
function sameQuantity(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= QUANTITY_EPS;
}

export interface DonatedLotBasisStateInput extends DonatedLotBasisInput {
  /**
   * The lot's `lot_basis_verifications` snapshot, or null when it has no
   * marker: the lot's cost basis and quantity acquired when it was verified.
   */
  verification: { verifiedAmount: number | null; verifiedQuantity: number | null } | null;
  /**
   * The lot's `tax_lots.quantity_acquired` AS STORED, which the marker
   * snapshot is compared with. Omitted, it is `lotQuantityAcquired`. It
   * differs only when a split dated after the gift scaled the stored lot:
   * `lotQuantityAcquired` is then the gift-date figure the 1% rule needs.
   */
  ledgerQuantityAcquired?: number | null;
}

/**
 * THE one reader of a donated lot's basis state (owner request 2026-10-07).
 * The row chips, the row's left-out flag, the year total and the year's
 * left-out count all come from here.
 *
 * A marker only ever matters on a lot the 1% rule flags. The snapshot is
 * compared with `lotCostBasis` and `lotQuantityAcquired`, the very figures
 * the 1% rule itself reads, so the two cannot drift: whatever moves the
 * lot's basis (the row's amount, price or fees, an option premium rolled
 * into it, a split) makes the marker stale. Basis is compared in cents and
 * quantity with the share tolerance. A lot that is not in the ledger, or a
 * snapshot with a missing figure, never matches.
 */
export function donatedLotBasisState(input: DonatedLotBasisStateInput): DonatedLotBasisState {
  if (!isDonatedLotBasisImplausible(input)) return "plausible";
  const { verification } = input;
  if (verification == null) return "implausible";
  // The marker snapshots the STORED lot (`readDonatedLotBasisFigures`), so it
  // is compared with the stored quantity, not the gift-date one.
  const storedQuantity =
    input.ledgerQuantityAcquired === undefined ? input.lotQuantityAcquired : input.ledgerQuantityAcquired;
  const unchanged =
    sameCents(verification.verifiedAmount, input.lotCostBasis) &&
    sameQuantity(verification.verifiedQuantity, storedQuantity);
  return unchanged ? "verified" : "verified-stale";
}

// ── Split units (G2, 2026-11-15) ──────────────────────────────────────────
//
// The lot engine replays an import-mode split by multiplying every still-open
// lot's `quantity_acquired` and `quantity_remaining` (lib/compute/tax-lots.ts,
// `applySplitEvent`), while `donations.quantity`, `donation_lots.quantity` and
// `tax_lot_sales.quantity_sold` stay in the units of their own date. Every
// share count the Giving view compares is therefore put on the GIFT DATE's
// basis first. Without this a 2:1 split after a gift halved its basis.

interface ReplaySplit {
  effectiveDate: string;
  ratio: number;
}

/**
 * Import-mode (replay) splits per security, read the way the engine reads
 * them: `source = 'import'`, SPLIT / REVERSE_SPLIT only, in (date, id) order,
 * every row applied (no de-duplication). 'manual' rows are legacy rewrite
 * mode and already rewrote history, so they are not read here either.
 */
function fetchReplaySplitsBySecurity(db: Database.Database): Map<number, ReplaySplit[]> {
  const rows = db
    .prepare(
      `SELECT security_id, effective_date,
              CAST(ratio_numerator AS REAL) / ratio_denominator AS ratio
         FROM corporate_actions
        WHERE source = 'import'
          AND UPPER(action_type) IN (${IMPORT_SPLIT_ACTION_TYPES_SQL})
        ORDER BY effective_date, id`
    )
    .all() as { security_id: number; effective_date: string; ratio: number | null }[];
  const map = new Map<number, ReplaySplit[]>();
  for (const r of rows) {
    if (typeof r.ratio !== "number" || !Number.isFinite(r.ratio) || r.ratio <= 0) continue;
    const list = map.get(r.security_id);
    const split = { effectiveDate: r.effective_date, ratio: r.ratio };
    if (list) list.push(split);
    else map.set(r.security_id, [split]);
  }
  return map;
}

/**
 * The share-count factor between an event dated `from` and one dated `to`:
 * the product of the splits with `from <= effective date < to`. On a split's
 * own date the engine replays trades and gifts BEFORE the split (end-of-day
 * rule), so a split dated `from` comes after that event and one dated `to`
 * comes after the later event too. `to = null` means "up to now".
 */
function splitFactorBetween(splits: readonly ReplaySplit[], from: string, to: string | null): number {
  let factor = 1;
  for (const s of splits) {
    if (s.effectiveDate >= from && (to == null || s.effectiveDate < to)) factor *= s.ratio;
  }
  return factor;
}

interface StoredLotQuantities {
  acquisition_date: string;
  quantity_acquired: number;
  quantity_remaining: number;
  /** The acquisition transaction's own quantity (what the engine opened the lot with). */
  acquisition_quantity: number | null;
}

/**
 * A lot's quantity acquired on the gift date's share basis. Exact when no
 * split is dated on or after the gift (the stored figure, unchanged) and for
 * a lot still open (an open lot took every split since it was acquired).
 *
 * A lot that has since closed stopped taking splits when it closed, so it
 * took only the first k of them. Its acquisition transaction's quantity
 * times those first k ratios must equal the stored figure for some k; when
 * it does, the gift-date figure is that quantity times the splits before the
 * gift. KNOWN LIMIT: a lot opened by only part of its transaction (an IBKR
 * mixed open/close trade) never matches, and keeps the stored figure.
 */
function quantityAcquiredInGiftUnits(
  lot: StoredLotQuantities,
  splits: readonly ReplaySplit[],
  giftDate: string
): number {
  const sinceAcquisition = splits.filter((s) => s.effectiveDate >= lot.acquisition_date);
  const afterGift = sinceAcquisition.filter((s) => s.effectiveDate >= giftDate);
  if (afterGift.length === 0) return lot.quantity_acquired;
  // The engine's own condition for taking a split is `quantity_remaining > 0`.
  if (lot.quantity_remaining > 0) {
    return lot.quantity_acquired / splitFactorBetween(afterGift, giftDate, null);
  }
  const opened = lot.acquisition_quantity;
  if (typeof opened === "number" && Number.isFinite(opened) && opened !== 0) {
    let factor = 1;
    const tolerance = QUANTITY_EPS * Math.max(1, Math.abs(lot.quantity_acquired));
    for (let k = 0; k <= sinceAcquisition.length; k++) {
      if (k > 0) factor *= sinceAcquisition[k - 1].ratio;
      if (Math.abs(opened * factor - lot.quantity_acquired) <= tolerance) {
        return opened * splitFactorBetween(sinceAcquisition, lot.acquisition_date, giftDate);
      }
    }
  }
  return lot.quantity_acquired;
}

/** Splits for one security, or none. */
function splitsFor(splitsBySecurity: Map<number, ReplaySplit[]>, securityId: number | null): ReplaySplit[] {
  return securityId == null ? [] : splitsBySecurity.get(securityId) ?? [];
}

/**
 * Lot quantities on the gift date's basis, for the write gate in
 * lib/mutations/donation-links.ts: today's `quantity_remaining` divided by
 * the splits dated on or after the gift (a lot with shares left took every
 * one of them). Null when the acquisition transaction has no lot.
 */
export function readLotRemainingInGiftUnits(
  db: Database.Database,
  acquisitionTransactionId: number,
  giftDate: string
): { quantityRemaining: number; isShort: boolean } | null {
  const lot = db
    .prepare(
      `SELECT security_id, acquisition_date, quantity_remaining, is_short
         FROM tax_lots WHERE acquisition_transaction_id = ?`
    )
    .get(acquisitionTransactionId) as
    | { security_id: number; acquisition_date: string; quantity_remaining: number; is_short: number }
    | undefined;
  if (!lot) return null;
  const splits = splitsFor(fetchReplaySplitsBySecurity(db), lot.security_id).filter(
    (s) => s.effectiveDate >= lot.acquisition_date
  );
  const factor = lot.quantity_remaining > 0 ? splitFactorBetween(splits, giftDate, null) : 1;
  return { quantityRemaining: lot.quantity_remaining / factor, isShort: lot.is_short === 1 };
}

/**
 * The two figures a "basis verified" marker snapshots: the lot's cost basis
 * and quantity acquired, read from the same `tax_lots` row the Giving view
 * joins each assignment to. Null when the acquisition transaction has no lot
 * in the ledger. One acquisition transaction opens exactly one lot (the
 * engine's `createLot` runs once per transaction; a test asserts it), so
 * anything else is also answered null rather than guessed at.
 */
export function readDonatedLotBasisFigures(
  db: Database.Database,
  acquisitionTransactionId: number
): { costBasis: number; quantityAcquired: number } | null {
  const rows = db
    .prepare(
      `SELECT cost_basis AS costBasis, quantity_acquired AS quantityAcquired
         FROM tax_lots WHERE acquisition_transaction_id = ?`
    )
    .all(acquisitionTransactionId) as { costBasis: number; quantityAcquired: number }[];
  return rows.length === 1 ? rows[0] : null;
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
 * Each row also carries the lot's "basis verified" marker, if any (a LEFT
 * JOIN: it cannot drop an assignment from the basis math). */
function fetchAssignmentsByDonation(db: Database.Database): Map<number, AssignmentRow[]> {
  const rows = db
    .prepare(
      `SELECT dl.donation_id AS donation_id, dl.acquisition_transaction_id AS acquisition_transaction_id,
              dl.quantity AS quantity, tl.acquisition_date AS acquisition_date,
              tl.quantity_acquired AS quantity_acquired, tl.cost_basis AS cost_basis,
              tl.quantity_remaining AS quantity_remaining, tl.is_short AS is_short,
              at.quantity AS acquisition_quantity,
              v.id IS NOT NULL AS has_verification,
              v.verified_amount AS verified_amount, v.verified_quantity AS verified_quantity,
              v.source_note AS source_note, v.verified_at AS verified_at
         FROM donation_lots dl
         JOIN tax_lots tl ON tl.acquisition_transaction_id = dl.acquisition_transaction_id
         LEFT JOIN transactions at ON at.id = dl.acquisition_transaction_id
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

interface OrphanMarkerRow {
  donation_id: number;
  acquisition_transaction_id: number;
  trade_date: string;
  verified_amount: number | null;
  verified_quantity: number | null;
  source_note: string;
  verified_at: string;
}

/**
 * Assigned lots that carry a marker but have NO `tax_lots` row (the ledger
 * was rebuilt without them). The assignment query above cannot see these
 * (its join to `tax_lots` drops them, as it always has), so they are read
 * separately: a marker whose lot is gone must show as stale, not vanish.
 */
function fetchOrphanMarkersByDonation(db: Database.Database): Map<number, OrphanMarkerRow[]> {
  const rows = db
    .prepare(
      `SELECT dl.donation_id AS donation_id, dl.acquisition_transaction_id AS acquisition_transaction_id,
              t.trade_date AS trade_date,
              v.verified_amount AS verified_amount, v.verified_quantity AS verified_quantity,
              v.source_note AS source_note, v.verified_at AS verified_at
         FROM donation_lots dl
         JOIN lot_basis_verifications v ON v.acquisition_transaction_id = dl.acquisition_transaction_id
         JOIN transactions t ON t.id = dl.acquisition_transaction_id
        WHERE NOT EXISTS (
                SELECT 1 FROM tax_lots tl WHERE tl.acquisition_transaction_id = dl.acquisition_transaction_id)
        ORDER BY dl.donation_id, dl.id`
    )
    .all() as OrphanMarkerRow[];
  const map = new Map<number, OrphanMarkerRow[]>();
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
  orphanMarkersByDonation: Map<number, OrphanMarkerRow[]>,
  currencies: Map<number, string>,
  splitsBySecurity: Map<number, ReplaySplit[]>
): GivingDonation {
  const outLeg = outLegs.get(d.id) ?? null;
  const linked = outLeg != null;
  // A short position cannot be given (G1, 2026-11-15): a gift drawn on a
  // short lot (an assignment written before the write gate refused one) has
  // no believable basis, so the row asks for its lots again, as if it had none.
  const assigned = assignmentsByDonation.get(d.id) ?? [];
  const assignments = assigned.some((a) => a.is_short === 1) ? [] : assigned;
  const symbolResolved = d.kind !== "stock" || d.security_id != null;
  const needsLots = d.kind === "stock" && linked && assignments.length === 0;
  const splits = splitsFor(splitsBySecurity, d.security_id);

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
      // On the gift date's share basis, the units `a.quantity` is in (G2).
      const acquiredInGiftUnits = quantityAcquiredInGiftUnits(a, splits, outLeg.trade_date);
      const perShare = acquiredInGiftUnits !== 0 ? a.cost_basis / acquiredInGiftUnits : 0;
      basisSum += a.quantity * perShare;
      // Judged per LOT, not on the blended row: one penny-basis lot among
      // ordinary ones still overstates the avoided gain by its whole value.
      const hasMarker = a.has_verification === 1;
      const state = donatedLotBasisState({
        lotCostBasis: a.cost_basis,
        lotQuantityAcquired: acquiredInGiftUnits,
        ledgerQuantityAcquired: a.quantity_acquired,
        donationFmvUsd: d.fmv_usd,
        donationQuantity: d.quantity,
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
          giftsFed: [], // filled by attachGiftsFed once every row is built
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

  // A marked lot that is no longer in the ledger: the same reader, with no
  // lot figures, answers "verified-stale" and the row is left out.
  if (d.kind === "stock" && outLeg != null) {
    for (const o of orphanMarkersByDonation.get(d.id) ?? []) {
      const state = donatedLotBasisState({
        lotCostBasis: null,
        lotQuantityAcquired: null,
        donationFmvUsd: d.fmv_usd,
        donationQuantity: d.quantity,
        verification: { verifiedAmount: o.verified_amount, verifiedQuantity: o.verified_quantity },
      });
      if (state === "plausible") continue;
      flaggedLots.push({
        acquisitionTransactionId: o.acquisition_transaction_id,
        acquisitionDate: o.trade_date,
        state,
        sourceNote: o.source_note,
        verifiedAt: o.verified_at,
        giftsFed: [], // filled by attachGiftsFed once every row is built
      });
      if (leavesRowOut(state)) basisImplausible = true;
    }
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

/**
 * Fills `giftsFed` on every flagged lot: the unreversed gifts on which that
 * same lot is flagged. Reads only the rows already built (the flag itself is
 * never re-derived here), so the list and the chips cannot disagree.
 */
function attachGiftsFed(rows: GivingDonation[]): void {
  const byLot = new Map<number, GivingLotGift[]>();
  for (const gd of rows) {
    if (gd.donation.reversed_date != null) continue;
    for (const lot of gd.flaggedLots) {
      const gift = { donationId: gd.donation.id, receivedDate: gd.donation.received_date };
      const list = byLot.get(lot.acquisitionTransactionId);
      // One gift is listed once, even if it somehow drew on the lot twice.
      if (!list) byLot.set(lot.acquisitionTransactionId, [gift]);
      else if (!list.some((g) => g.donationId === gift.donationId)) list.push(gift);
    }
  }
  for (const list of byLot.values()) {
    list.sort((a, b) =>
      a.receivedDate === b.receivedDate ? a.donationId - b.donationId : a.receivedDate < b.receivedDate ? -1 : 1
    );
  }
  for (const gd of rows) {
    for (const lot of gd.flaggedLots) {
      lot.giftsFed = [...(byLot.get(lot.acquisitionTransactionId) ?? [])];
    }
  }
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
  const orphanMarkersByDonation = fetchOrphanMarkersByDonation(db);
  const currencies = fetchSecurityCurrencies(db);
  const splitsBySecurity = fetchReplaySplitsBySecurity(db);

  const byYear = new Map<string, GivingDonation[]>();
  const built: GivingDonation[] = [];
  for (const d of donations) {
    const year = d.received_date.slice(0, 4);
    const gd = buildGivingDonation(
      d,
      outLegs,
      assignmentsByDonation,
      orphanMarkersByDonation,
      currencies,
      splitsBySecurity
    );
    built.push(gd);
    const list = byYear.get(year);
    if (list) list.push(gd);
    else byYear.set(year, [gd]);
  }
  attachGiftsFed(built);

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
      // A gift of a non-USD security ("unsupported") is left out of "Gain
      // avoided" and counted (G3, 2026-11-15): its lot basis is in the
      // security's own currency, and lots can never be assigned to it, so it
      // must neither add a native-currency figure nor hold the total pending.
      const allStockDonations = active.filter((gd) => gd.donation.kind === "stock");
      const gainAvoidedRowsUnsupported = allStockDonations.filter((gd) => gd.status === "unsupported").length;
      const stockDonations = allStockDonations.filter((gd) => gd.status !== "unsupported");
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
        gainAvoidedRowsUnsupported,
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
  /** The lot's quantity acquired on the gift date's share basis (a split
   * dated on or after the gift is taken back out; G2, 2026-11-15). */
  quantityAcquired: number;
  /** quantity_acquired minus sales before the donation's OUT-leg date minus
   * OTHER (unreversed) donations' assignments dated before it — NOT today's
   * quantity_remaining, which would price the gift in the wrong basis if a
   * split happened after the donation date. */
  remainingAsOfDonationDate: number;
  isLongTerm: boolean;
  gainPerShare: number | null;
  /**
   * This lot's basis state FOR THIS GIFT, from the one reader
   * (`donatedLotBasisState`): the same answer the Giving row would show if
   * the lot were assigned. The suggestion takes an `implausible` or
   * `verified-stale` lot last within its holding period.
   */
  basisState: DonatedLotBasisState;
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
 * for the lot-assignment drawer. Long lots only: a short position cannot be
 * given (G1, 2026-11-15). Also flags a greedy long-term/highest-gain
 * preselection covering the donation's full quantity — the drawer's
 * "Suggest highest-gain long-term" button uses these flags as its default;
 * the user can still override.
 *
 * Suggestion order (2026-10-08): long-term lots first; within a holding
 * period, a lot whose basis is flagged for this gift (implausible, or a
 * marker gone stale) comes AFTER every lot that is not; then the highest
 * gain per share. A penny-basis lot has the largest gain per share by
 * construction, so ranking by gain alone picked the very lot the Giving row
 * then flags and leaves out of "Gain avoided". A flagged lot is demoted,
 * never dropped: the suggestion still covers the whole gift when the other
 * lots cannot. A lot the owner marked verified is not flagged.
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
      `SELECT tl.id AS id, tl.acquisition_transaction_id AS acquisition_transaction_id,
              tl.acquisition_date AS acquisition_date, tl.cost_basis AS cost_basis,
              tl.quantity_acquired AS quantity_acquired, tl.quantity_remaining AS quantity_remaining,
              at.quantity AS acquisition_quantity,
              v.id IS NOT NULL AS has_verification,
              v.verified_amount AS verified_amount, v.verified_quantity AS verified_quantity
         FROM tax_lots tl
         LEFT JOIN transactions at ON at.id = tl.acquisition_transaction_id
         LEFT JOIN lot_basis_verifications v ON v.acquisition_transaction_id = tl.acquisition_transaction_id
        WHERE tl.account_id = ? AND tl.security_id = ? AND tl.acquisition_date < ?
          AND tl.is_short = 0
        ORDER BY tl.acquisition_date, tl.id`
    )
    .all(outLeg.account_id, donation.security_id, outLeg.trade_date) as Array<{
    id: number;
    acquisition_transaction_id: number;
    acquisition_date: string;
    cost_basis: number;
    quantity_acquired: number;
    quantity_remaining: number;
    acquisition_quantity: number | null;
    has_verification: number;
    verified_amount: number | null;
    verified_quantity: number | null;
  }>;

  // Per date, so each figure can be put on the gift date's share basis: a
  // sale or an earlier gift is in the units of its own date (G2).
  const salesBeforeStmt = db.prepare(
    `SELECT ts.sale_date AS date, COALESCE(SUM(ts.quantity_sold), 0) AS qty
       FROM tax_lot_sales ts WHERE ts.tax_lot_id = ? AND ts.sale_date < ?
      GROUP BY ts.sale_date`
  );
  const otherDonationsBeforeStmt = db.prepare(
    `SELECT t2.trade_date AS date, COALESCE(SUM(dl.quantity), 0) AS qty
       FROM donation_lots dl
       JOIN donations d2 ON d2.id = dl.donation_id
       JOIN donation_leg_links l2 ON l2.donation_id = d2.id AND l2.role = 'out'
       JOIN transactions t2 ON t2.id = l2.transaction_id
      WHERE dl.acquisition_transaction_id = ?
        AND dl.donation_id != ?
        AND d2.reversed_date IS NULL
        AND t2.trade_date < ?
      GROUP BY t2.trade_date`
  );
  const salesTotalBeforeStmt = db.prepare(
    `SELECT NULL AS date, COALESCE(SUM(ts.quantity_sold), 0) AS qty
       FROM tax_lot_sales ts WHERE ts.tax_lot_id = ? AND ts.sale_date < ?`
  );
  const otherDonationsTotalBeforeStmt = db.prepare(
    `SELECT NULL AS date, COALESCE(SUM(dl.quantity), 0) AS qty
       FROM donation_lots dl
       JOIN donations d2 ON d2.id = dl.donation_id
       JOIN donation_leg_links l2 ON l2.donation_id = d2.id AND l2.role = 'out'
       JOIN transactions t2 ON t2.id = l2.transaction_id
      WHERE dl.acquisition_transaction_id = ?
        AND dl.donation_id != ?
        AND d2.reversed_date IS NULL
        AND t2.trade_date < ?`
  );
  const splits = splitsFor(fetchReplaySplitsBySecurity(db), donation.security_id);
  /** A sum of dated share counts, each put on the gift date's basis. */
  const inGiftUnits = (rows: { date: string; qty: number }[]) =>
    rows.reduce((sum, r) => sum + r.qty * splitFactorBetween(splits, r.date, outLeg.trade_date), 0);
  // With no split on the security, one SQL sum over every date: every unit
  // is already the gift date's, so nothing is converted.
  const totalOf = (rows: { date: string; qty: number }[]) => (rows.length === 0 ? 0 : rows[0].qty);

  const fmvPerShare =
    donation.quantity != null && donation.quantity > 0 ? donation.fmv_usd / donation.quantity : null;

  const currentAssignmentRows = db
    .prepare(`SELECT acquisition_transaction_id, quantity FROM donation_lots WHERE donation_id = ?`)
    .all(donationId) as { acquisition_transaction_id: number; quantity: number }[];
  const currentAssignments = new Map(currentAssignmentRows.map((r) => [r.acquisition_transaction_id, r.quantity]));

  const rows: OpenLotForDonation[] = lotRows.map((lot) => {
    const salesRows = (splits.length === 0 ? salesTotalBeforeStmt : salesBeforeStmt).all(
      lot.id,
      outLeg.trade_date
    ) as { date: string; qty: number }[];
    const otherRows = (splits.length === 0 ? otherDonationsTotalBeforeStmt : otherDonationsBeforeStmt).all(
      lot.acquisition_transaction_id,
      donationId,
      outLeg.trade_date
    ) as { date: string; qty: number }[];
    const salesBefore = splits.length === 0 ? totalOf(salesRows) : inGiftUnits(salesRows);
    const otherAssigned = splits.length === 0 ? totalOf(otherRows) : inGiftUnits(otherRows);
    const acquiredInGiftUnits = quantityAcquiredInGiftUnits(lot, splits, outLeg.trade_date);
    const remaining = Math.max(0, acquiredInGiftUnits - salesBefore - otherAssigned);
    const isLongTerm = isLongTermHolding(lot.acquisition_date, outLeg.trade_date);
    const costPerShare = acquiredInGiftUnits !== 0 ? lot.cost_basis / acquiredInGiftUnits : 0;
    const gainPerShare = fmvPerShare != null ? fmvPerShare - costPerShare : null;
    const basisState = donatedLotBasisState({
      lotCostBasis: lot.cost_basis,
      lotQuantityAcquired: acquiredInGiftUnits,
      ledgerQuantityAcquired: lot.quantity_acquired,
      donationFmvUsd: donation.fmv_usd,
      donationQuantity: donation.quantity,
      verification:
        lot.has_verification === 1
          ? { verifiedAmount: lot.verified_amount, verifiedQuantity: lot.verified_quantity }
          : null,
    });
    return {
      acquisitionTransactionId: lot.acquisition_transaction_id,
      acquisitionDate: lot.acquisition_date,
      costBasis: lot.cost_basis,
      quantityAcquired: acquiredInGiftUnits,
      remainingAsOfDonationDate: remaining,
      isLongTerm,
      gainPerShare,
      basisState,
      suggested: false,
      suggestedQuantity: 0,
      currentlyAssignedQuantity: currentAssignments.get(lot.acquisition_transaction_id) ?? 0,
    };
  });

  const ranked = [...rows].sort((a, b) => {
    if (a.isLongTerm !== b.isLongTerm) return a.isLongTerm ? -1 : 1;
    // The same two states that leave a Giving row out of "Gain avoided".
    const fa = leavesRowOut(a.basisState);
    const fb = leavesRowOut(b.basisState);
    if (fa !== fb) return fa ? 1 : -1;
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
