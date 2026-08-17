import type Database from "better-sqlite3";

export interface NewDonation {
  sourceKey: string;
  kind: "stock" | "cash";
  securityId: number | null;
  symbolRaw: string | null;
  quantity: number | null;
  fmvUsd: number;
  unitValuation: number | null;
  createdDate: string | null;
  receivedDate: string;
  completedDate: string | null;
  notes: string | null;
}

export class DonationIdentityConflictError extends Error {
  constructor(public sourceKey: string, public field: string) {
    super(`donation ${sourceKey}: authoritative identity field '${field}' changed — refusing silent update`);
  }
}

const IDENTITY_FIELDS: [keyof NewDonation, string][] = [
  ["kind", "kind"], ["securityId", "security_id"], ["symbolRaw", "symbol_raw"],
  ["quantity", "quantity"], ["fmvUsd", "fmv_usd"], ["receivedDate", "received_date"],
];

export function insertDonation(db: Database.Database, d: NewDonation, importBatchId: number | null): number {
  const r = db.prepare(
    `INSERT INTO donations (source_key, import_batch_id, kind, security_id, symbol_raw, quantity,
       fmv_usd, unit_valuation, created_date, received_date, completed_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(d.sourceKey, importBatchId, d.kind, d.securityId, d.symbolRaw, d.quantity,
        d.fmvUsd, d.unitValuation, d.createdDate, d.receivedDate, d.completedDate, d.notes);
  return r.lastInsertRowid as number;
}

export function upsertDonationMetadata(db: Database.Database, d: NewDonation): "updated" | "unchanged" {
  const existing = db.prepare("SELECT * FROM donations WHERE source_key = ?").get(d.sourceKey) as Record<string, unknown> | undefined;
  if (!existing) throw new Error(`upsertDonationMetadata: no donation for source_key ${d.sourceKey}`);
  for (const [k, col] of IDENTITY_FIELDS) {
    const incoming = d[k] ?? null;
    if ((existing[col] ?? null) !== incoming) throw new DonationIdentityConflictError(d.sourceKey, col);
  }
  const r = db.prepare(
    `UPDATE donations SET completed_date = ?, unit_valuation = ?, notes = ?
     WHERE source_key = ?
       AND (COALESCE(completed_date,'') != COALESCE(?,'')
         OR COALESCE(unit_valuation,-1) != COALESCE(?,-1)
         OR COALESCE(notes,'') != COALESCE(?,''))`
  ).run(d.completedDate, d.unitValuation, d.notes, d.sourceKey, d.completedDate, d.unitValuation, d.notes);
  return r.changes > 0 ? "updated" : "unchanged";
}

/** Domain errors for resolve-security (Task 12): DonationResolveError -> 400
 * (not found / target security missing / non-USD), DonationAlreadyResolvedError
 * -> 409 (donation.security_id already set — resolve-security only fires
 * once, same "409 on a state that already holds" shape as approveLevelGuarded). */
export class DonationResolveError extends Error {}
export class DonationAlreadyResolvedError extends Error {}

/** Sets donations.security_id when it's currently NULL — the one-time symbol
 * resolution for a donation whose import-time symbol_raw didn't match a known
 * security. Refuses (409-mapped by the route) when security_id is already
 * set; refuses (400-mapped) when the target security doesn't exist or isn't
 * USD-denominated (leg linking/lot assignment both require USD — Task 3). */
export function resolveDonationSecurity(db: Database.Database, donationId: number, securityId: number): void {
  const donation = db.prepare("SELECT id, security_id FROM donations WHERE id = ?").get(donationId) as
    | { id: number; security_id: number | null }
    | undefined;
  if (!donation) {
    throw new DonationResolveError(`donation ${donationId}: not found`);
  }
  if (donation.security_id != null) {
    throw new DonationAlreadyResolvedError(`donation ${donationId}: security already resolved`);
  }
  const security = db.prepare("SELECT id, currency FROM securities WHERE id = ?").get(securityId) as
    | { id: number; currency: string | null }
    | undefined;
  if (!security) {
    throw new DonationResolveError(`security ${securityId}: not found`);
  }
  if ((security.currency ?? "USD") !== "USD") {
    throw new DonationResolveError(`security ${securityId}: is not USD-denominated`);
  }
  db.prepare("UPDATE donations SET security_id = ? WHERE id = ?").run(securityId, donationId);
}

export function markDonationReversed(db: Database.Database, donationId: number, reversedDate: string): void {
  const run = db.transaction(() => {
    const exists = db.prepare("SELECT id FROM donations WHERE id = ?").get(donationId);
    if (!exists) throw new Error(`markDonationReversed: donation ${donationId} not found`);
    // Restore flow flag on any demoted artifact leg BEFORE dropping the link.
    db.prepare(
      `UPDATE transactions SET is_external_flow = 1
       WHERE id IN (SELECT transaction_id FROM donation_leg_links WHERE donation_id = ? AND role = 'routing_artifact')`
    ).run(donationId);
    db.prepare("DELETE FROM donation_leg_links WHERE donation_id = ?").run(donationId);
    db.prepare("DELETE FROM donation_lots WHERE donation_id = ?").run(donationId);
    db.prepare("UPDATE donations SET reversed_date = ? WHERE id = ?").run(reversedDate, donationId);
  });
  run();
}
