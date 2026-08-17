/**
 * Task 5: engine-side commit/preview logic for donation imports, plus the
 * in-kind transfer-leg amount-conflict guard. Kept out of engine.ts to keep
 * that file's churn small (per plan) — engine.ts wires these three
 * functions into the commit transaction; nothing here talks to
 * ParsedImportResult directly.
 */

import type Database from "better-sqlite3";
import type { ParsedDonation, ParsedTransaction } from "./types";
import {
  insertDonation,
  upsertDonationMetadata,
  DonationIdentityConflictError,
  type NewDonation,
} from "@/lib/mutations/donations";
import {
  getDonationBySourceKey,
  getDonationsForYear,
  type DonationRow,
} from "@/lib/queries/donations";
import { getSecurityBySymbolCI } from "@/lib/queries/securities";

// The daf-contributions parser appends this literal marker to a donation's
// sourceKey when the row has no "created at" timestamp AND its
// (received_date, symbol|USD, qty|amount) identity collides with another
// such row in the same file (see
// lib/import/parsers/daf-contributions.ts's second pass). Those rows are
// KEPT by the parser — flagged with a warning containing "identity" — so
// preview can still show them, but they must never reach insertDonation:
// without a created-at component, source_key can't tell the colliding rows
// apart across re-imports, so committing either risks silently conflating
// two distinct contributions. This is the promise the parser's warning
// makes; blocking here is what fulfills it.
const NO_IDENTITY_MARKER = ":null-created:";

function lacksIdentity(d: ParsedDonation): boolean {
  return d.sourceKey.includes(NO_IDENTITY_MARKER);
}

export interface DonationCommitOutcome {
  newDonations: number;
  updatedDonations: number;
  identityConflicts: { sourceKey: string; field: string }[];
  blockedNoIdentity: string[]; // rows blocked for missing created-at identity
  unresolvedSymbols: string[]; // imported with security_id NULL
  absentPriorRows: string[]; // source_keys of prior-year DB donations missing from this file (Codex plan-review #6)
}

export function commitDonations(
  db: Database.Database,
  donations: ParsedDonation[],
  batchId: number,
): DonationCommitOutcome {
  const outcome: DonationCommitOutcome = {
    newDonations: 0,
    updatedDonations: 0,
    identityConflicts: [],
    blockedNoIdentity: [],
    unresolvedSymbols: [],
    absentPriorRows: [],
  };

  for (const d of donations) {
    if (lacksIdentity(d)) {
      outcome.blockedNoIdentity.push(d.sourceKey);
      continue;
    }

    let securityId: number | null = null;
    if (d.kind === "stock" && d.symbolRaw) {
      const sec = getSecurityBySymbolCI(db, d.symbolRaw);
      if (sec) {
        securityId = sec.id;
      } else {
        outcome.unresolvedSymbols.push(d.symbolRaw);
      }
    }

    const record: NewDonation = {
      sourceKey: d.sourceKey,
      kind: d.kind,
      securityId,
      symbolRaw: d.symbolRaw,
      quantity: d.quantity,
      fmvUsd: d.fmvUsd,
      unitValuation: d.unitValuation,
      createdDate: d.createdDate,
      receivedDate: d.receivedDate,
      completedDate: d.completedDate,
      notes: null,
    };

    const existing = getDonationBySourceKey(db, d.sourceKey);
    if (!existing) {
      insertDonation(db, record, batchId);
      outcome.newDonations++;
      continue;
    }

    try {
      const result = upsertDonationMetadata(db, record);
      if (result === "updated") outcome.updatedDonations++;
    } catch (err) {
      if (err instanceof DonationIdentityConflictError) {
        outcome.identityConflicts.push({ sourceKey: err.sourceKey, field: err.field });
      } else {
        throw err;
      }
    }
  }

  for (const row of findAbsentPriorDonations(db, donations)) {
    outcome.absentPriorRows.push(row.source_key);
  }

  return outcome;
}

/**
 * Cumulative-file reversal check (spec §5): donations already in the DB for
 * the years covered by this file that are ABSENT from the file. Pure read —
 * used by preview AND surfaced as commit warnings (via commitDonations,
 * which calls this and folds the result into `absentPriorRows`).
 */
export function findAbsentPriorDonations(
  db: Database.Database,
  donations: ParsedDonation[],
): DonationRow[] {
  if (donations.length === 0) return [];

  const years = new Set(donations.map((d) => d.receivedDate.slice(0, 4)));
  const fileKeys = new Set(donations.map((d) => d.sourceKey));

  const absent: DonationRow[] = [];
  for (const year of years) {
    for (const row of getDonationsForYear(db, year)) {
      if (!fileKeys.has(row.source_key)) {
        absent.push(row);
      }
    }
  }
  return absent;
}

/**
 * Transfer-leg conflict guard (spec §7): incoming in-kind TRANSFER legs
 * whose (account, date, security, type, quantity) matches an existing row
 * with a DIFFERENT amount. Returns the conflicting incoming rows' indices;
 * the engine skips them at commit and the preview surfaces them.
 *
 * "In-kind" = type TRANSFER_IN/TRANSFER_OUT AND the security resolves —
 * `securityIdFor` returning null (e.g. a cash leg with no symbol) excludes
 * the row. Matching is against EXISTING db rows only: a same-file pair of
 * incoming rows never conflicts with each other here (source_key already
 * bakes the amount in for canonical-csv, so a genuine re-authored leg is
 * the only case that would otherwise slip past dedupe as a brand-new row).
 */
export function findTransferAmountConflicts(
  db: Database.Database,
  txns: ParsedTransaction[],
  accountIdFor: (t: ParsedTransaction) => number | null,
  securityIdFor: (t: ParsedTransaction) => number | null,
): number[] {
  const stmt = db.prepare(
    `SELECT amount FROM transactions
     WHERE account_id = ? AND security_id = ? AND trade_date = ?
       AND UPPER(type) = ? AND quantity = ?`,
  );

  const conflicts: number[] = [];
  txns.forEach((t, i) => {
    const typeUpper = t.type.toUpperCase();
    if (typeUpper !== "TRANSFER_IN" && typeUpper !== "TRANSFER_OUT") return;
    if (t.quantity == null) return;

    const securityId = securityIdFor(t);
    if (securityId == null) return; // in-kind requires the security to resolve

    const accountId = accountIdFor(t);
    if (accountId == null) return;

    const rows = stmt.all(accountId, securityId, t.tradeDate, typeUpper, t.quantity) as {
      amount: number | null;
    }[];
    const incomingAmt = t.amount ?? 0;
    if (rows.some((r) => (r.amount ?? 0) !== incomingAmt)) {
      conflicts.push(i);
    }
  });
  return conflicts;
}
