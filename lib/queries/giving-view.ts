import type Database from "better-sqlite3";
import { getDonations, type DonationRow } from "@/lib/queries/donations";
import { reconcileDonations, type ReconciliationReport } from "@/lib/compute/donation-reconciliation";
import { isLongTermHolding } from "@/lib/compute/tax-lots";

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
  /** null when any (non-reversed) stock donation in the year lacks lot assignments. */
  gainAvoided: number | null;
  donations: GivingDonation[];
}

export interface GivingDonation {
  donation: DonationRow;
  accountName: string | null;
  basis: number | null;
  gainAvoided: number | null;
  longTermQuantity: number | null;
  shortTermQuantity: number | null;
  /** Precedence (Codex plan-review #8): reversed > unsupported (non-USD) > pending-lots
   * (stock, linked, no assignments) > completed > received. */
  status: "reversed" | "unsupported" | "pending-lots" | "completed" | "received";
  needsLots: boolean;
  linked: boolean;
  symbolResolved: boolean;
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
 * relies on (assignDonationLots' own lot lookup uses .get(), not .all()). */
function fetchAssignmentsByDonation(db: Database.Database): Map<number, AssignmentRow[]> {
  const rows = db
    .prepare(
      `SELECT dl.donation_id AS donation_id, dl.acquisition_transaction_id AS acquisition_transaction_id,
              dl.quantity AS quantity, tl.acquisition_date AS acquisition_date,
              tl.quantity_acquired AS quantity_acquired, tl.cost_basis AS cost_basis
         FROM donation_lots dl
         JOIN tax_lots tl ON tl.acquisition_transaction_id = dl.acquisition_transaction_id
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

  if (d.kind === "stock" && outLeg != null && assignments.length > 0) {
    let basisSum = 0;
    let lt = 0;
    let st = 0;
    for (const a of assignments) {
      const perShare = a.quantity_acquired !== 0 ? a.cost_basis / a.quantity_acquired : 0;
      basisSum += a.quantity * perShare;
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
      const gainAvoided = anyMissingBasis
        ? null
        : stockDonations.reduce((sum, gd) => sum + (gd.gainAvoided ?? 0), 0);
      return { year, totalGiven, stockGiven, cashGiven, gainAvoided, donations: yearDonations };
    });

  return { years, reconciliation };
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
