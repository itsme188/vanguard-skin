/**
 * repair-option-sectors.ts — reset the stored sector of option rows to the
 * sector of their underlying.
 *
 * Why it exists (owner ruling 2026-10-06): an option is counted in the sector
 * of its underlying. Before that ruling `classifyOptionSectors` asked the AI
 * for a single GICS sector for every blank-sector option, so an option on a
 * broad index fund was stored under whichever sector the AI named for the
 * fund, and the sector breakdown added the option's delta exposure to that
 * sector. The classifier now inherits, but it only ever fills a BLANK sector,
 * so the rows stored before the ruling need this one-time reset.
 *
 * What it changes: `securities.sector` and `securities.sector_source`, on
 * option rows only, and only where ALL of these hold:
 *   - the row names an underlying, and that underlying (or a share-class
 *     sibling) is a non-option security row whose stored sector
 *     `normalizeSector` accepts;
 *   - the option's stored sector differs from that inherited sector;
 *   - the option's sector is derived, i.e. its `sector_source` is empty,
 *     `ai_classify` or `underlying_inherited`, and it carries no
 *     `sector_verified_at` stamp. A sector an import (`csv_import`), the
 *     verification sweep (`gics_verified`) or the broker (`tws_bloomberg`) put
 *     on the option row is listed as skipped and left alone. `--include-broker`
 *     opts the broker-stamped rows in; nothing opts the other two in.
 * An option whose underlying is unknown or has no sector is left alone: there
 * is nothing to prove its stored sector wrong. No row is ever deleted.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-option-sectors.ts
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-option-sectors.ts --apply
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-option-sectors.ts --include-broker
 *
 * Dry run is the default and opens the database read-only. `--apply` writes
 * every change in one transaction. Running it again changes nothing.
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 *
 * The output names security ids, sector labels, source labels and counts. It
 * prints no symbol, quantity or dollar figure.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  resolveUnderlyingSector,
  OPTION_SECTOR_SOURCE_AI,
  OPTION_SECTOR_SOURCE_INHERITED,
} from "@/lib/securities/classify-option-sectors";

// ─── Shapes ─────────────────────────────────────────────────────────

export interface RepairOptionSectorsOptions {
  apply?: boolean;
  /** Also reset option rows whose sector the broker sync stamped. */
  includeBroker?: boolean;
}

export interface OptionSectorChange {
  optionId: number;
  /** The security row the sector is inherited from. */
  underlyingId: number;
  fromSector: string | null;
  toSector: string;
  fromSource: string | null;
  toSource: string;
}

export interface OptionSectorRepairPlan {
  /** Every option row examined. */
  optionRows: number;
  changes: OptionSectorChange[];
  /** Stored sector already equals the underlying's. */
  alreadyCorrect: number;
  /** Differs from the underlying, but the stored sector was set deliberately. */
  skippedProtected: Array<{ optionId: number; source: string }>;
  /** Underlying unknown, or known with no usable sector: left alone. */
  underlyingWithoutSector: number;
  /** The option row names no underlying: left alone. */
  noUnderlyingSymbol: number;
}

const BROKER_SOURCE = "tws_bloomberg";

// ─── Plan ───────────────────────────────────────────────────────────

/** Read-only. Decides, row by row, what an apply would write. */
export function planOptionSectorRepair(
  db: Database.Database,
  opts: RepairOptionSectorsOptions = {},
): OptionSectorRepairPlan {
  const derivedSources = new Set<string>([OPTION_SECTOR_SOURCE_AI, OPTION_SECTOR_SOURCE_INHERITED]);
  if (opts.includeBroker) derivedSources.add(BROKER_SOURCE);

  const options = db
    .prepare(
      `SELECT id, sector, sector_source, sector_verified_at, underlying_symbol
         FROM securities
        WHERE LOWER(security_type) = 'option'
        ORDER BY id`,
    )
    .all() as Array<{
      id: number;
      sector: string | null;
      sector_source: string | null;
      sector_verified_at: string | null;
      underlying_symbol: string | null;
    }>;

  const plan: OptionSectorRepairPlan = {
    optionRows: options.length,
    changes: [],
    alreadyCorrect: 0,
    skippedProtected: [],
    underlyingWithoutSector: 0,
    noUnderlyingSymbol: 0,
  };

  for (const option of options) {
    if (option.underlying_symbol == null || option.underlying_symbol.trim() === "") {
      plan.noUnderlyingSymbol += 1;
      continue;
    }
    const underlying = resolveUnderlyingSector(db, option.underlying_symbol);
    if (!underlying) {
      plan.underlyingWithoutSector += 1;
      continue;
    }
    if (option.sector === underlying.sector) {
      plan.alreadyCorrect += 1;
      continue;
    }

    const source = option.sector_source != null && option.sector_source.trim() !== "" ? option.sector_source : null;
    const hasSector = option.sector != null && option.sector.trim() !== "";
    // A blank sector holds nothing deliberate to preserve.
    if (hasSector) {
      if (source != null && !derivedSources.has(source)) {
        plan.skippedProtected.push({ optionId: option.id, source });
        continue;
      }
      if (option.sector_verified_at != null) {
        plan.skippedProtected.push({ optionId: option.id, source: source ?? "sector_verified_at" });
        continue;
      }
    }

    plan.changes.push({
      optionId: option.id,
      underlyingId: underlying.securityId,
      fromSector: option.sector,
      toSector: underlying.sector,
      fromSource: option.sector_source,
      toSource: OPTION_SECTOR_SOURCE_INHERITED,
    });
  }

  return plan;
}

/**
 * Plan, then (only with `apply`) write. The plan is resolved INSIDE the write
 * transaction, so what is written is what that same read decided; any row
 * that does not update exactly once rolls the whole run back.
 */
export function runOptionSectorRepair(
  db: Database.Database,
  opts: RepairOptionSectorsOptions = {},
): { plan: OptionSectorRepairPlan; applied: boolean; written: number } {
  if (!opts.apply) return { plan: planOptionSectorRepair(db, opts), applied: false, written: 0 };

  const update = db.prepare(
    `UPDATE securities SET sector = ?, sector_source = ?
      WHERE id = ? AND LOWER(security_type) = 'option'`,
  );
  const result = db.transaction(() => {
    const plan = planOptionSectorRepair(db, opts);
    let written = 0;
    for (const change of plan.changes) {
      const { changes } = update.run(change.toSector, change.toSource, change.optionId);
      if (changes !== 1) {
        throw new Error(`option id ${change.optionId}: expected to update 1 row, updated ${changes}; nothing was written`);
      }
      written += changes;
    }
    return { plan, written };
  })();
  return { ...result, applied: true };
}

// ─── Output ─────────────────────────────────────────────────────────

function label(value: string | null): string {
  return value == null || value.trim() === "" ? "<none>" : `"${value}"`;
}

/** Ids, sector labels, source labels and counts. Never a symbol or a figure. */
export function formatPlan(plan: OptionSectorRepairPlan, applied = false): string[] {
  const lines: string[] = [];
  const verb = applied ? "changed" : "would change";
  lines.push(`option rows examined:                    ${plan.optionRows}`);
  lines.push(`${verb}: ${plan.changes.length}`);
  lines.push(`already match their underlying:          ${plan.alreadyCorrect}`);
  lines.push(`skipped, sector set deliberately:        ${plan.skippedProtected.length}`);
  lines.push(`left alone, underlying has no sector:    ${plan.underlyingWithoutSector}`);
  lines.push(`left alone, no underlying named:         ${plan.noUnderlyingSymbol}`);

  if (plan.changes.length > 0) {
    lines.push("");
    lines.push(`Rows ${applied ? "changed" : "that would change"} (sector, then source):`);
    for (const c of plan.changes) {
      lines.push(
        `  option id ${c.optionId}: ${label(c.fromSector)} -> "${c.toSector}"; ` +
          `source ${label(c.fromSource)} -> "${c.toSource}" (underlying id ${c.underlyingId})`,
      );
    }
  }
  if (plan.skippedProtected.length > 0) {
    lines.push("");
    lines.push("Skipped (stored sector differs from the underlying, but was set deliberately):");
    for (const s of plan.skippedProtected) {
      lines.push(`  option id ${s.optionId}: source ${s.source}`);
    }
  }
  return lines;
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const KNOWN_FLAGS = new Set(["--apply", "--include-broker"]);

export function parseArgs(argv: string[]): RepairOptionSectorsOptions {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`unknown argument ${arg} (known: ${[...KNOWN_FLAGS].join(", ")})`);
    }
  }
  return { apply: argv.includes("--apply"), includeBroker: argv.includes("--include-broker") };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = new BetterSqlite3(DB_PATH, { readonly: !opts.apply, fileMustExist: true }) as Database.Database;

  try {
    console.log(
      `Option sector repair ${opts.apply ? "[APPLY]" : "[DRY RUN]"}` +
        `${opts.includeBroker ? " (broker-stamped rows included)" : ""}, db: ${DB_PATH}\n`,
    );
    const { plan, applied, written } = runOptionSectorRepair(db, opts);
    for (const line of formatPlan(plan, applied)) console.log(line);

    if (!applied) {
      console.log("\nDry run (default): nothing was written. Re-run with --apply to write.");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply",
      );
      return;
    }
    console.log(`\nWrote ${written} option row(s). Reload the Analysis page to see the sector breakdown.`);
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-fx-rate.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-option-sectors.ts") || process.argv[1].endsWith("repair-option-sectors.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
