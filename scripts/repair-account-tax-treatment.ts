/**
 * repair-account-tax-treatment.ts — stamp one account's `tax_treatment`.
 *
 * Why this is a separate, user-run step (ruling 2026-09-14): migration 094
 * adds `accounts.tax_treatment` with a 'taxable' default and NO data change —
 * a schema migration must never guess which of your accounts is an IRA, and a
 * name heuristic is exactly the wrong tool (an "Admiral" account contains
 * "ira"; a Roth can be named anything). Until an account is stamped here, the
 * tax report keeps including its sales and says so in its banner.
 *
 * What changes once an account is stamped non-taxable: its sales leave the
 * Form 8949 rows, the taxable ST/LT totals and the wash-sale scan; the
 * all-accounts CSV/TXF drop them; the account's own pill on /dashboard/tax-lots
 * renders "retirement account — no Form 8949" with no export buttons, and a
 * CSV/TXF request scoped to it is refused with 409.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-account-tax-treatment.ts --account "<account name>" --treatment roth_ira
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-account-tax-treatment.ts --account "<account name>" --treatment roth_ira --apply
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-account-tax-treatment.ts --list
 *
 * Dry run is the default: it prints current -> proposed plus how many closed
 * sales move out of the tax report, and writes nothing.
 *
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  TAX_TREATMENTS,
  TAX_TREATMENT_LABELS,
  DEFAULT_TAX_TREATMENT,
  normalizeTaxTreatment,
  isTaxableAccount,
  type TaxTreatment,
} from "../lib/compute/tax-treatment";

// ─── Shapes ─────────────────────────────────────────────────────────

export interface RepairAccountTaxTreatmentOptions {
  /** `accounts.name` (exact) or a numeric `accounts.id`. */
  account: string;
  /** One of TAX_TREATMENTS; anything else is refused before any read. */
  treatment: string;
  apply?: boolean;
}

export interface AccountTaxTreatmentRow {
  id: number;
  name: string;
  treatment: TaxTreatment;
}

export interface AccountTaxTreatmentPlan {
  account: AccountTaxTreatmentRow;
  proposed: TaxTreatment;
  /** Current value already equals the proposed one — applying is a no-op. */
  alreadySet: boolean;
  /**
   * Closed sales recorded in this account (any year). Blast radius: stamping
   * the account non-taxable removes exactly these from the Form 8949
   * surfaces; stamping it back to taxable returns them.
   */
  closedSalesCount: number;
}

// ─── Read ───────────────────────────────────────────────────────────

/** Every account with its current treatment — the `--list` output and the
 *  "did you mean" hint when a name does not resolve. */
export function listAccountTaxTreatments(db: Database.Database): AccountTaxTreatmentRow[] {
  const rows = db
    .prepare("SELECT id, name, tax_treatment FROM accounts ORDER BY id")
    .all() as { id: number; name: string; tax_treatment: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    // A row read from a pre-094 copy has no stamp; that reads as taxable
    // everywhere else, so report it the same way here.
    treatment: (r.tax_treatment ?? DEFAULT_TAX_TREATMENT) as TaxTreatment,
  }));
}

/**
 * Resolve `--account` to exactly one row. An all-digits argument is an id;
 * anything else is an exact `accounts.name` match (names are UNIQUE). Throws
 * when nothing matches — never guesses with a LIKE.
 */
export function resolveAccount(db: Database.Database, ref: string): AccountTaxTreatmentRow {
  const accounts = listAccountTaxTreatments(db);
  const trimmed = ref.trim();
  const byId = /^\d+$/.test(trimmed)
    ? accounts.find((a) => a.id === Number(trimmed))
    : undefined;
  const match = byId ?? accounts.find((a) => a.name === trimmed);
  if (!match) {
    throw new Error(
      `no account matches "${ref}" — pass an exact accounts.name or an accounts.id (${accounts.length} account(s) in this database; run with --list to see them)`
    );
  }
  return match;
}

function closedSalesCount(db: Database.Database, accountId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) c
         FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
        WHERE tl.account_id = ?`
    )
    .get(accountId) as { c: number };
  return row.c;
}

// ─── Plan ───────────────────────────────────────────────────────────

/** Read-only: resolve the account and the proposed treatment, report the
 *  current value and the blast radius. Writes nothing. */
export function planAccountTaxTreatmentRepair(
  db: Database.Database,
  opts: RepairAccountTaxTreatmentOptions
): AccountTaxTreatmentPlan {
  const proposed = normalizeTaxTreatment(opts.treatment);
  const account = resolveAccount(db, opts.account);
  return {
    account,
    proposed,
    alreadySet: account.treatment === proposed,
    closedSalesCount: closedSalesCount(db, account.id),
  };
}

/**
 * Plan, then (only if opts.apply) write. Idempotent: re-running with the same
 * treatment resolves to `alreadySet` and writes nothing, so the stamp can sit
 * in a runbook and be repeated safely.
 */
export function runAccountTaxTreatmentRepair(
  db: Database.Database,
  opts: RepairAccountTaxTreatmentOptions
): { plan: AccountTaxTreatmentPlan; applied: boolean } {
  const plan = planAccountTaxTreatmentRepair(db, opts);
  if (!opts.apply || plan.alreadySet) return { plan, applied: false };

  db.prepare("UPDATE accounts SET tax_treatment = ? WHERE id = ?").run(
    plan.proposed,
    plan.account.id
  );
  return { plan, applied: true };
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

export function parseArgs(argv: string[]): RepairAccountTaxTreatmentOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const account = get("--account");
  if (!account) throw new Error('--account "<name>" (or an accounts.id) is required');

  const treatment = get("--treatment");
  if (!treatment) {
    throw new Error(`--treatment <${TAX_TREATMENTS.join("|")}> is required`);
  }
  // Fail before opening the database on a value the CHECK constraint would
  // reject anyway.
  normalizeTaxTreatment(treatment);

  return { account, treatment, apply: argv.includes("--apply") };
}

function describe(row: AccountTaxTreatmentRow | { treatment: TaxTreatment }): string {
  const t = row.treatment;
  return `${t} (${TAX_TREATMENT_LABELS[t]}${isTaxableAccount(t) ? "" : " — outside Form 8949"})`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes("--list");
  const opts = listOnly ? null : parseArgs(argv);
  const db = new BetterSqlite3(DB_PATH, { readonly: !opts?.apply }) as Database.Database;
  db.pragma("foreign_keys = ON");

  try {
    if (listOnly) {
      console.log(`Accounts in ${DB_PATH}:\n`);
      for (const a of listAccountTaxTreatments(db)) {
        console.log(`  [${a.id}] ${a.name} — ${describe(a)}`);
      }
      return;
    }

    console.log(
      `Account tax treatment ${opts!.apply ? "[APPLY]" : "[DRY RUN]"} — db: ${DB_PATH}\n`
    );

    const { plan, applied } = runAccountTaxTreatmentRepair(db, opts!);

    console.log(`Account:  [${plan.account.id}] ${plan.account.name}`);
    console.log(`Current:  ${describe(plan.account)}`);
    console.log(`Proposed: ${describe({ treatment: plan.proposed })}`);
    console.log(`Closed sales recorded in this account: ${plan.closedSalesCount}`);

    if (plan.alreadySet) {
      console.log("\nAlready set — nothing to do.");
      return;
    }
    if (!applied) {
      console.log("\nDry run (default). Re-run with --apply to write.");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply"
      );
      return;
    }

    console.log(`\nStamped. ${plan.account.name} is now ${describe({ treatment: plan.proposed })}.`);
    console.log(
      isTaxableAccount(plan.proposed)
        ? "Its sales are back in the Form 8949 report and exports."
        : "Its sales have left the Form 8949 report, the taxable ST/LT totals and the CSV/TXF exports."
    );
    console.log("Reload /dashboard/tax-lots to see it (no restart needed).");
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-fx-rate.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-account-tax-treatment.ts") ||
    process.argv[1].endsWith("repair-account-tax-treatment.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
