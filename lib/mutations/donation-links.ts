import type Database from "better-sqlite3";
import type { DonationRow } from "@/lib/queries/donations";
import { getOpenLotsForDonation } from "@/lib/queries/giving-view";
import { bumpTaxGenerationIfPresent } from "@/lib/compute/tax-convention";

/** Every invariant rejection in this file throws DonationLinkError with a
 * domain-language message naming the violated concept. */
export class DonationLinkError extends Error {}

export const ARTIFACT_NOTE_SUFFIX = " [routing artifact of DAF donation; excluded from flows]";

const EPS = 1e-9;

const LOT_CREATING_TYPES = new Set(["buy", "reinvestment", "buy_to_open", "sell_to_open", "transfer_in"]);

interface TransactionRow {
  id: number;
  account_id: number;
  security_id: number | null;
  trade_date: string;
  type: string;
  quantity: number | null;
  amount: number | null;
  notes: string | null;
}

/** Appends ARTIFACT_NOTE_SUFFIX to existing notes (NULL notes -> suffix alone, trimmed).
 *  Idempotent: notes that already carry the suffix are returned unchanged — a
 *  second demotion (e.g. lib/import/recovery.ts re-applying the demotion when
 *  restoring an undone routing_artifact link) must not double-append.
 *  linkDonationLegs itself never hits the already-suffixed branch in normal
 *  operation (donation_leg_links.transaction_id is UNIQUE, so a transaction
 *  can't be linked — and thus demoted — twice), so this is a no-op there. */
export function appendArtifactSuffix(notes: string | null): string {
  const suffixAlone = ARTIFACT_NOTE_SUFFIX.trim();
  if (notes != null && (notes === suffixAlone || notes.endsWith(ARTIFACT_NOTE_SUFFIX))) {
    return notes;
  }
  return ((notes ?? "") + ARTIFACT_NOTE_SUFFIX).trim();
}

/** Exact inverse of appendArtifactSuffix: strips the suffix, restoring NULL if it was the whole note. */
export function stripArtifactSuffix(notes: string | null): string | null {
  if (notes == null) return null;
  const suffixAlone = ARTIFACT_NOTE_SUFFIX.trim();
  if (notes === suffixAlone) return null;
  if (notes.endsWith(ARTIFACT_NOTE_SUFFIX)) return notes.slice(0, notes.length - ARTIFACT_NOTE_SUFFIX.length);
  return notes; // not demoted by this code path — leave untouched
}

function fetchDonation(db: Database.Database, donationId: number): DonationRow {
  const donation = db.prepare("SELECT * FROM donations WHERE id = ?").get(donationId) as DonationRow | undefined;
  if (!donation) throw new DonationLinkError(`donation ${donationId}: not found`);
  return donation;
}

function isUsdSecurity(db: Database.Database, securityId: number | null): boolean {
  if (securityId == null) return false;
  const security = db.prepare("SELECT currency FROM securities WHERE id = ?").get(securityId) as
    | { currency: string | null }
    | undefined;
  if (!security) return false;
  return (security.currency ?? "USD") === "USD";
}

/** Confirms a donation<->legs pair (spec §7). outTransactionId required; artifactTransactionId
 * optional (pair-form donations). Validates atomically (spec §4 invariants); on success writes
 * links, stamps the OUT leg amount if amountForOutLeg != null, and demotes the artifact leg
 * (is_external_flow=0 + note suffix). Caller triggers recompute. */
export function linkDonationLegs(
  db: Database.Database,
  args: {
    donationId: number;
    outTransactionId: number;
    artifactTransactionId?: number | null;
    amountForOutLeg?: number | null;
  }
): void {
  const { donationId, outTransactionId, artifactTransactionId, amountForOutLeg } = args;

  if (artifactTransactionId != null && artifactTransactionId === outTransactionId) {
    throw new DonationLinkError(
      `donation ${donationId}: OUT and artifact transaction ids must differ — the same transaction cannot serve both roles`
    );
  }

  const run = db.transaction(() => {
    const donation = fetchDonation(db, donationId);

    if (donation.kind !== "stock") {
      throw new DonationLinkError(`donation ${donationId}: kind '${donation.kind}' is not 'stock' — leg linking applies to stock donations only`);
    }
    if (donation.security_id == null) {
      throw new DonationLinkError(`donation ${donationId}: has no security_id — cannot link legs`);
    }
    if (donation.reversed_date != null) {
      throw new DonationLinkError(`donation ${donationId}: has been reversed — cannot link legs`);
    }
    if (!isUsdSecurity(db, donation.security_id)) {
      throw new DonationLinkError(`donation ${donationId}: security is not USD-denominated — leg linking requires a USD security`);
    }

    const outTxn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(outTransactionId) as
      | TransactionRow
      | undefined;
    if (!outTxn) {
      throw new DonationLinkError(`donation ${donationId}: OUT transaction ${outTransactionId} not found`);
    }
    if (outTxn.type !== "TRANSFER_OUT") {
      throw new DonationLinkError(
        `donation ${donationId}: OUT transaction ${outTransactionId} type '${outTxn.type}' is not TRANSFER_OUT`
      );
    }
    if (outTxn.security_id !== donation.security_id) {
      throw new DonationLinkError(
        `donation ${donationId}: OUT transaction ${outTransactionId} is a different security than the donation`
      );
    }
    if (outTxn.quantity == null || Math.abs(outTxn.quantity - (donation.quantity ?? NaN)) > EPS) {
      throw new DonationLinkError(
        `donation ${donationId}: OUT transaction ${outTransactionId} quantity does not match the donation quantity`
      );
    }

    let artifactTxn: TransactionRow | undefined;
    if (artifactTransactionId != null) {
      artifactTxn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(artifactTransactionId) as
        | TransactionRow
        | undefined;
      if (!artifactTxn) {
        throw new DonationLinkError(`donation ${donationId}: artifact transaction ${artifactTransactionId} not found`);
      }
      if (artifactTxn.type !== "TRANSFER_IN") {
        throw new DonationLinkError(
          `donation ${donationId}: artifact transaction ${artifactTransactionId} type '${artifactTxn.type}' is not TRANSFER_IN`
        );
      }
      if (artifactTxn.security_id !== outTxn.security_id) {
        throw new DonationLinkError(
          `donation ${donationId}: artifact transaction ${artifactTransactionId} is a different security than the OUT leg`
        );
      }
      if (artifactTxn.account_id !== outTxn.account_id) {
        throw new DonationLinkError(
          `donation ${donationId}: artifact transaction ${artifactTransactionId} is in a different account than the OUT leg`
        );
      }
      if (artifactTxn.trade_date !== outTxn.trade_date) {
        throw new DonationLinkError(
          `donation ${donationId}: artifact transaction ${artifactTransactionId} trade date does not match the OUT leg trade date`
        );
      }
      const outQty = outTxn.quantity ?? NaN;
      const inQty = artifactTxn.quantity ?? NaN;
      if (!(Math.abs(outQty - inQty) < EPS)) {
        throw new DonationLinkError(
          `donation ${donationId}: artifact transaction ${artifactTransactionId} quantity is not zero-net against the OUT leg quantity`
        );
      }
    }

    const candidateIds = artifactTransactionId != null ? [outTransactionId, artifactTransactionId] : [outTransactionId];
    const placeholders = candidateIds.map(() => "?").join(",");
    const alreadyLinked = db
      .prepare(`SELECT transaction_id FROM donation_leg_links WHERE transaction_id IN (${placeholders})`)
      .all(...candidateIds) as { transaction_id: number }[];
    if (alreadyLinked.length > 0) {
      throw new DonationLinkError(
        `donation ${donationId}: transaction ${alreadyLinked[0].transaction_id} is already linked to a donation`
      );
    }

    db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'out')").run(
      donationId,
      outTransactionId
    );

    if (artifactTransactionId != null && artifactTxn) {
      db.prepare(
        "INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'routing_artifact')"
      ).run(donationId, artifactTransactionId);
      db.prepare("UPDATE transactions SET is_external_flow = 0, notes = ? WHERE id = ?").run(
        appendArtifactSuffix(artifactTxn.notes),
        artifactTransactionId
      );
    }

    if (amountForOutLeg != null) {
      db.prepare("UPDATE transactions SET amount = ? WHERE id = ?").run(amountForOutLeg, outTransactionId);
    }

    bumpTaxGenerationIfPresent(db);
  });
  run();
}

/** Removes links for a donation, restoring is_external_flow=1 (+ stripping the note suffix)
 * on a demoted artifact leg. Does NOT touch amounts (a stamped FMV is a data correction that
 * stands on its own evidence). */
export function unlinkDonationLegs(db: Database.Database, donationId: number): void {
  const run = db.transaction(() => {
    const artifactLink = db
      .prepare("SELECT transaction_id FROM donation_leg_links WHERE donation_id = ? AND role = 'routing_artifact'")
      .get(donationId) as { transaction_id: number } | undefined;
    if (artifactLink) {
      const txn = db.prepare("SELECT notes FROM transactions WHERE id = ?").get(artifactLink.transaction_id) as {
        notes: string | null;
      };
      db.prepare("UPDATE transactions SET is_external_flow = 1, notes = ? WHERE id = ?").run(
        stripArtifactSuffix(txn.notes),
        artifactLink.transaction_id
      );
    }
    db.prepare("DELETE FROM donation_leg_links WHERE donation_id = ?").run(donationId);

    bumpTaxGenerationIfPresent(db);
  });
  run();
}

/** Replaces the donation's lot assignments atomically after validating spec §4 invariants
 * (a)-(f). Empty array = clear. */
export function assignDonationLots(
  db: Database.Database,
  donationId: number,
  assignments: { acquisitionTransactionId: number; quantity: number }[]
): void {
  const run = db.transaction(() => {
    const donation = fetchDonation(db, donationId);

    const outLink = db
      .prepare(
        `SELECT t.account_id AS account_id, t.trade_date AS trade_date
         FROM donation_leg_links l JOIN transactions t ON t.id = l.transaction_id
         WHERE l.donation_id = ? AND l.role = 'out'`
      )
      .get(donationId) as { account_id: number; trade_date: string } | undefined;
    if (!outLink) {
      throw new DonationLinkError(`donation ${donationId}: no confirmed out link — link the OUT leg before assigning lots`);
    }

    if (!isUsdSecurity(db, donation.security_id)) {
      throw new DonationLinkError(`donation ${donationId}: security is not USD-denominated — lot assignment requires a USD security`);
    }

    // Pre-replace snapshot: this donation's own existing assignments (replace semantics —
    // a lot's own prior claim by this donation counts back toward its available capacity).
    const existingRows = db
      .prepare("SELECT acquisition_transaction_id, quantity FROM donation_lots WHERE donation_id = ?")
      .all(donationId) as { acquisition_transaction_id: number; quantity: number }[];
    const existingByTxn = new Map(existingRows.map((r) => [r.acquisition_transaction_id, r.quantity]));

    // As-of-donation-date availability per acquisition transaction — the SAME
    // computation the lot drawer shows (getOpenLotsForDonation.remainingAsOfDonationDate,
    // which already counts this donation's own claim back toward capacity). Shared, not
    // forked, so drawer and gate can never disagree on this basis.
    const asOfDateAvailability = new Map(
      getOpenLotsForDonation(db, donationId).map((l) => [l.acquisitionTransactionId, l.remainingAsOfDonationDate])
    );

    let sum = 0;
    const seenAcquisitionIds = new Set<number>();
    for (const a of assignments) {
      // Duplicates are never legitimate under replace semantics — reject up front rather
      // than accumulate a running total per lot (simpler and stricter) or let the
      // donation_lots UNIQUE(donation_id, acquisition_transaction_id) constraint fire.
      if (seenAcquisitionIds.has(a.acquisitionTransactionId)) {
        throw new DonationLinkError(
          `donation ${donationId}: acquisition transaction ${a.acquisitionTransactionId} appears more than once in this assignment call`
        );
      }
      seenAcquisitionIds.add(a.acquisitionTransactionId);

      const txn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(a.acquisitionTransactionId) as
        | TransactionRow
        | undefined;
      if (!txn) {
        throw new DonationLinkError(`donation ${donationId}: acquisition transaction ${a.acquisitionTransactionId} not found`);
      }
      if (!LOT_CREATING_TYPES.has(txn.type.toLowerCase())) {
        throw new DonationLinkError(
          `donation ${donationId}: acquisition transaction ${a.acquisitionTransactionId} type '${txn.type}' is not a lot-creating type`
        );
      }
      if (txn.security_id !== donation.security_id) {
        throw new DonationLinkError(
          `donation ${donationId}: acquisition transaction ${a.acquisitionTransactionId} is a different security than the donation`
        );
      }
      if (txn.account_id !== outLink.account_id) {
        throw new DonationLinkError(
          `donation ${donationId}: acquisition transaction ${a.acquisitionTransactionId} is in a different account than the OUT leg`
        );
      }
      if (!(txn.trade_date < outLink.trade_date)) {
        throw new DonationLinkError(
          `donation ${donationId}: acquisition transaction ${a.acquisitionTransactionId} trade date is not before the donation's OUT-leg trade date`
        );
      }

      const lot = db
        .prepare("SELECT quantity_remaining FROM tax_lots WHERE acquisition_transaction_id = ?")
        .get(a.acquisitionTransactionId) as { quantity_remaining: number } | undefined;
      if (!lot) {
        throw new DonationLinkError(
          `donation ${donationId}: no lot found for acquisition transaction ${a.acquisitionTransactionId}`
        );
      }
      // Design boundary: this check is best-effort against tax_lots' state as of the LAST
      // recompute, not a live cross-donation ledger. donation_lots carries no marker for
      // "already folded into quantity_remaining by a recompute," so subtracting other
      // donations' outstanding donation_lots claims here would double-count any claim that
      // WAS already recomputed (permanently, since the ledger row is never cleared) —
      // strictly worse than the write-time race it would close. Cross-donation
      // over-commitment between recomputes (two assignDonationLots calls in a row with no
      // recompute between them) IS accepted at write time by design; it is caught and
      // clamped by computeTaxLots with a replay warning (tests/compute/tax-lots-donations.test.ts
      // case 7), and closed in practice by the route-level recompute-after-write (Task 12).
      //
      // UNION basis (2026-08-18): the current-state basis alone rejected every donation
      // whose lot was consumed by a LATER sell (or the RECONCILE_CLOSE that stands in for
      // it) in the last recompute — a replay that necessarily ran WITHOUT the donation,
      // since its lots weren't assigned yet. The drawer (getOpenLotsForDonation) offers
      // as-of-donation-date availability, so the gate must also accept that basis or the
      // drawer suggests picks the gate refuses. Acceptance = EITHER basis covers the
      // request — a pure relaxation: nothing previously legal became illegal, and the
      // chronological replay's clamp-and-warn remains the authority for over-commitment.
      const ownExisting = existingByTxn.get(a.acquisitionTransactionId) ?? 0;
      const availableCurrent = lot.quantity_remaining + ownExisting;
      const availableAsOfDate = asOfDateAvailability.get(a.acquisitionTransactionId) ?? 0;
      const available = Math.max(availableCurrent, availableAsOfDate);
      if (a.quantity > available + EPS) {
        throw new DonationLinkError(
          `donation ${donationId}: requested quantity ${a.quantity} for acquisition transaction ${a.acquisitionTransactionId} exceeds the lot's available quantity (${available} = max of current remaining ${availableCurrent}, as-of-donation-date ${availableAsOfDate})`
        );
      }

      sum += a.quantity;
    }

    if (sum > (donation.quantity ?? 0) + EPS) {
      throw new DonationLinkError(
        `donation ${donationId}: total assigned quantity ${sum} exceeds the donation's quantity (${donation.quantity})`
      );
    }

    db.prepare("DELETE FROM donation_lots WHERE donation_id = ?").run(donationId);
    for (const a of assignments) {
      db.prepare(
        "INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, ?)"
      ).run(donationId, a.acquisitionTransactionId, a.quantity);
    }

    bumpTaxGenerationIfPresent(db);
  });
  run();
}
