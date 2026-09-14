/**
 * repair-fx-rate.ts — write a single currency's fx_rates row by hand, for
 * when the automated sources haven't produced (or produced a wrong) rate.
 *
 * Root cause this exists for (2026-09-14): the TWS sync used to DERIVE a
 * USD-per-unit rate from `Position.marketValue ÷ (marketPrice × qty ×
 * multiplier)` and write it as source `tws_derived`. That derive assumed
 * TWS's `marketValue` was USD-base; it is NOT — it's native currency, so the
 * derive landed at ≈1.0. A live JPY position hit exactly this: no
 * `ibkr_ledger` rate existed yet for JPY, so nothing stopped the bogus 1.0
 * write, and the yen position was valued at one yen = one dollar. The derive
 * was removed from lib/tws/positions.ts (see its comment there); this script
 * is the manual-repair path for a currency the automated sources haven't
 * covered — either type the correct rate in by hand (`--usd-per-unit`,
 * source `manual`) or pull it from the IBKR Web API ledger the same way
 * lib/ibkr/refresh.ts does (`--from-ibkr`, source `ibkr_ledger`).
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig
 * it finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-fx-rate.ts --currency JPY --usd-per-unit <usd per unit>
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-fx-rate.ts --currency JPY --usd-per-unit <usd per unit> --apply
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-fx-rate.ts --currency JPY --from-ibkr --apply
 *
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { upsertFxRate } from "../lib/mutations/fx-rates";
import { latestHoldingsPredicate } from "../lib/queries/latest-holdings";
import { todayET } from "../lib/calendar/date-utils";
import { loadIbkrConfig } from "../lib/ibkr/config";
import { fetchIbkrPortfolio } from "../lib/ibkr/refresh";
import type { IbkrOAuthConfig } from "../lib/ibkr/oauth-client";

// ─── Shapes ─────────────────────────────────────────────────────────

export interface RepairFxRateOptions {
  currency: string;
  mode: "manual" | "from-ibkr";
  /** Required when mode === "manual". */
  usdPerUnit?: number;
  asOf?: string;
  apply?: boolean;
}

export interface RepairFxRateDeps {
  /** Injectable network seam — tests never touch the real IBKR API. Defaults
   *  to the SAME snapshot-building function lib/ibkr/refresh.ts uses
   *  (fetchIbkrPortfolio), so this stays in lockstep with the auto-refresh
   *  path instead of re-implementing a second ledger fetch. */
  fetchIbkrFxRates?: (cfg: IbkrOAuthConfig) => Promise<Record<string, number>>;
  loadIbkrConfig?: () => IbkrOAuthConfig | null;
}

export interface FxRateRow {
  usdPerUnit: number;
  asOf: string;
  source: string;
}

export interface RepairFxRatePlan {
  currency: string;
  current: FxRateRow | null;
  proposed: FxRateRow;
  /** Latest holdings (per latestHoldingsPredicate) in this currency. */
  latestHoldingsCount: number;
}

const DEFAULT_DEPS: Required<RepairFxRateDeps> = {
  fetchIbkrFxRates: async (cfg) => (await fetchIbkrPortfolio(cfg)).fxRates ?? {},
  loadIbkrConfig,
};

// ─── Validation ─────────────────────────────────────────────────────

/** Same 1%-of-1.0 band as upsertFxRate's defense-in-depth guard — the
 *  native-currency-mistaken-for-USD-base bug always lands near 1.0. */
const NEAR_ONE_EPSILON = 0.01 + 1e-9;

export function validateManualRate(currency: string, usdPerUnit: number): void {
  if (!Number.isFinite(usdPerUnit)) {
    throw new Error(`--usd-per-unit must be a finite number, got ${usdPerUnit}`);
  }
  if (usdPerUnit <= 0) {
    throw new Error(`--usd-per-unit must be positive, got ${usdPerUnit}`);
  }
  if (currency !== "USD" && Math.abs(usdPerUnit - 1) < NEAR_ONE_EPSILON) {
    throw new Error(
      `--usd-per-unit ${usdPerUnit} is within 1% of 1.0 for non-USD currency ${currency} — ` +
        `this is the native-currency-as-USD-base bug shape this script exists to fix, refusing`,
    );
  }
}

// ─── Read ───────────────────────────────────────────────────────────

function currentFxRow(db: Database.Database, currency: string): FxRateRow | null {
  const row = db
    .prepare("SELECT usd_per_unit, as_of, source FROM fx_rates WHERE currency = ?")
    .get(currency) as { usd_per_unit: number; as_of: string; source: string } | undefined;
  if (!row) return null;
  return { usdPerUnit: row.usd_per_unit, asOf: row.as_of, source: row.source };
}

/** Latest holdings (per latestHoldingsPredicate — never a hand-rolled
 *  MAX(as_of_date)) in this currency, joined to securities.currency. */
export function latestHoldingsCountForCurrency(db: Database.Database, currency: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) c
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE ${latestHoldingsPredicate({ keyBy: "account_security" })}
          AND UPPER(s.currency) = ?`,
    )
    .get(currency) as { c: number };
  return row.c;
}

// ─── Plan ───────────────────────────────────────────────────────────

/**
 * Read-only: resolve the proposed rate (manual or from-ibkr) and report the
 * current row + blast radius (latest-holdings count) alongside it. Writes
 * nothing. Throws for a bad manual rate, a missing IBKR config, or a ledger
 * with no rate for this currency — the caller decides whether that's a CLI
 * exit or a test assertion.
 */
export async function planFxRateRepair(
  db: Database.Database,
  opts: RepairFxRateOptions,
  deps: RepairFxRateDeps = {},
): Promise<RepairFxRatePlan> {
  const { fetchIbkrFxRates, loadIbkrConfig: loadCfg } = { ...DEFAULT_DEPS, ...deps };
  const currency = opts.currency.toUpperCase();
  const asOf = opts.asOf ?? todayET();

  let proposed: FxRateRow;
  if (opts.mode === "manual") {
    if (opts.usdPerUnit == null) {
      throw new Error("--usd-per-unit is required in manual mode");
    }
    validateManualRate(currency, opts.usdPerUnit);
    proposed = { usdPerUnit: opts.usdPerUnit, asOf, source: "manual" };
  } else {
    const cfg = loadCfg();
    if (!cfg) {
      throw new Error(
        "IBKR Web API is not configured (data/ibkr-oauth/credentials.json missing or incomplete) — cannot use --from-ibkr",
      );
    }
    const rates = await fetchIbkrFxRates(cfg);
    const rate = rates[currency];
    if (rate == null) {
      throw new Error(
        `IBKR ledger has no exchange rate for ${currency} — the account may hold no ${currency} cash balance right now`,
      );
    }
    proposed = { usdPerUnit: rate, asOf, source: "ibkr_ledger" };
  }

  return {
    currency,
    current: currentFxRow(db, currency),
    proposed,
    latestHoldingsCount: latestHoldingsCountForCurrency(db, currency),
  };
}

/** Plan, then (only if opts.apply) write via upsertFxRate. Re-resolves the
 *  plan rather than trusting a pre-computed one, mirroring the other repair
 *  scripts' re-plan-inside-apply convention. */
export async function runFxRateRepair(
  db: Database.Database,
  opts: RepairFxRateOptions,
  deps: RepairFxRateDeps = {},
): Promise<{ plan: RepairFxRatePlan; applied: boolean }> {
  const plan = await planFxRateRepair(db, opts, deps);
  if (!opts.apply) return { plan, applied: false };

  upsertFxRate(db, {
    currency: plan.currency,
    usdPerUnit: plan.proposed.usdPerUnit,
    asOf: plan.proposed.asOf,
    source: plan.proposed.source,
  });
  return { plan, applied: true };
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

function parseArgs(argv: string[]): RepairFxRateOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const currency = get("--currency");
  if (!currency) throw new Error("--currency <CCY> is required");

  const usdPerUnitStr = get("--usd-per-unit");
  const fromIbkr = argv.includes("--from-ibkr");
  if (usdPerUnitStr != null && fromIbkr) {
    throw new Error("pass exactly one of --usd-per-unit or --from-ibkr, not both");
  }
  if (usdPerUnitStr == null && !fromIbkr) {
    throw new Error("pass exactly one of --usd-per-unit <number> or --from-ibkr");
  }

  return {
    currency: currency.toUpperCase(),
    mode: fromIbkr ? "from-ibkr" : "manual",
    usdPerUnit: usdPerUnitStr != null ? Number(usdPerUnitStr) : undefined,
    asOf: get("--as-of"),
    apply: argv.includes("--apply"),
  };
}

function fmtRow(row: FxRateRow | null): string {
  return row == null ? "none" : `${row.usdPerUnit} (as_of ${row.asOf}, source ${row.source})`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const db = new BetterSqlite3(DB_PATH, { readonly: !opts.apply }) as Database.Database;
  db.pragma("foreign_keys = ON");

  try {
    console.log(
      `FX rate repair ${opts.apply ? "[APPLY]" : "[DRY RUN]"} — currency ${opts.currency}, mode ${opts.mode}, db: ${DB_PATH}\n`,
    );

    const { plan, applied } = await runFxRateRepair(db, opts);

    console.log(`Current:  ${fmtRow(plan.current)}`);
    console.log(`Proposed: ${fmtRow(plan.proposed)}`);
    console.log(`Latest holdings in ${plan.currency}: ${plan.latestHoldingsCount}`);

    if (!applied) {
      console.log("\nDry run (default). Re-run with --apply to write.");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply",
      );
      return;
    }

    console.log(`\nWrote fx_rates row: ${fmtRow(currentFxRow(db, plan.currency))}`);
    console.log(
      "\nNext step: click Sync in the app (or wait for the 30-minute refresh) to recompute valuations.",
    );
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-option-attached-levels.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-fx-rate.ts") || process.argv[1].endsWith("repair-fx-rate.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
