/**
 * Account tax treatment — the single source for "is this account's activity
 * reportable on a Form 8949?".
 *
 * Ruling (docs/DECISIONS.md, 2026-09-14): "Retirement accounts leave the tax
 * report by a real `accounts.tax_treatment` column (migration shown first,
 * Roth stamped once), not a settings key or a name heuristic." Migration 094
 * adds the column (default 'taxable') and pins this same vocabulary in a
 * CHECK constraint; scripts/repair-account-tax-treatment.ts is the user-run
 * stamp.
 *
 * Never compare the literal strings anywhere else — import `isTaxableAccount`.
 */

export const TAX_TREATMENTS = [
  "taxable",
  "roth_ira",
  "traditional_ira",
  "other_tax_advantaged",
] as const;

export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/** What a column with no stamp means (and migration 094's DEFAULT). */
export const DEFAULT_TAX_TREATMENT: TaxTreatment = "taxable";

/** Human labels — the only place a treatment token becomes UI/CLI prose. */
export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  taxable: "Taxable",
  roth_ira: "Roth IRA",
  traditional_ira: "Traditional IRA",
  other_tax_advantaged: "Other tax-advantaged",
};

export function isTaxTreatment(value: unknown): value is TaxTreatment {
  return typeof value === "string" && (TAX_TREATMENTS as readonly string[]).includes(value);
}

/**
 * Parse a user-supplied token (CLI flag) into the vocabulary, case- and
 * whitespace-insensitive. Throws on anything else — the stamp script must
 * never write a value the CHECK constraint (or a later reader) rejects.
 */
export function normalizeTaxTreatment(value: string): TaxTreatment {
  const token = value.trim().toLowerCase();
  if (isTaxTreatment(token)) return token;
  throw new Error(
    `unknown tax treatment "${value}" — expected one of: ${TAX_TREATMENTS.join(", ")}`
  );
}

/**
 * Is this account's realized activity a taxable event?
 *
 * Two deliberate asymmetries:
 *  - null / undefined / "" reads as TAXABLE. That is the pre-094 shape (and
 *    the column's own default), so a database that has not migrated yet
 *    behaves exactly as it did before this column existed — nothing silently
 *    disappears from a Form 8949.
 *  - an UNRECOGNISED non-empty value reads as NOT taxable. The column is
 *    CHECK-constrained, so such a value can only arrive by hand-edit; between
 *    "put a possibly-sheltered sale on a filing form" and "leave it off and
 *    name the account in the report's excluded list", the second is the
 *    recoverable mistake.
 */
export function isTaxableAccount(treatment: string | null | undefined): boolean {
  if (treatment == null || treatment.trim() === "") return true;
  return treatment.trim().toLowerCase() === DEFAULT_TAX_TREATMENT;
}
