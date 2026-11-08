/**
 * Derive and store `securities.leverage_factor` for every leveraged or
 * inverse fund (theme T2; migration 102).
 *
 * The same pass the TWS sync runs at Step 2.4 and the Classify button runs —
 * this script is how it is REHEARSED against a copy before it ever touches
 * the live database, and how the assignments are shown to the owner.
 *
 * It prints, for every flagged row: the symbol, the stored fields the rule
 * read, the factor it produced and where the factor came from (the name, or
 * the hand-checked seed table). A flagged row the rule could not sign is
 * listed separately: it stays NULL and keeps the stopgap behaviour.
 *
 * Usage (from the repo root; dry run is the default):
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/apply-leverage-factors.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/apply-leverage-factors.ts --apply
 *   npx tsx scripts/apply-leverage-factors.ts --db /path/to/copy.db [--apply]
 *
 * Rehearse --apply on a VACUUM copy first. A run against the live database
 * needs the owner's go. The pass writes nothing but `leverage_factor` and, for
 * a flagged fund whose sector the AI guessed, `sector` / `sector_source`.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "../lib/db/migrate";
import { applyLeverageFactors, type LeverageFactorPassResult } from "../lib/securities/apply-leverage-factors";

function resolveDbPath(argv: string[]): string {
  const i = argv.indexOf("--db");
  if (i >= 0) {
    const p = argv[i + 1];
    if (!p || p.startsWith("--")) throw new Error("--db needs a path");
    return path.resolve(p);
  }
  return process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function printResult(result: LeverageFactorPassResult, apply: boolean): void {
  console.log(`\nCandidate rows read (stock / ETF / mutual fund): ${result.candidates}`);
  console.log(`Flagged as leveraged or inverse:                 ${result.flagged.length}`);
  console.log(`Factors written:                                 ${result.factorsWritten}`);
  console.log(`Factors cleared:                                 ${result.factorsCleared}`);
  console.log(`Sectors corrected from the tracked index:        ${result.sectorsRewritten}`);

  const signedRows = result.flagged.filter((a) => a.factor !== null);
  console.log(`\nFACTOR ASSIGNMENTS (${signedRows.length})`);
  for (const a of signedRows) {
    const was = a.previousFactor === null ? "was NULL" : `was ${signed(a.previousFactor)}`;
    const sector = a.sectorRewrittenTo ? `, sector ${a.previousSector ?? "(blank)"} -> ${a.sectorRewrittenTo}` : "";
    console.log(
      `  ${a.symbol.padEnd(8)} ${signed(a.factor!).padEnd(4)} from ${String(a.source).padEnd(4)}` +
        ` (${was})  type=${a.securityType ?? "?"} cat=${a.fundCategory ?? "-"} name=${a.name ?? "(blank)"}${sector}`,
    );
  }

  console.log(`\nFLAGGED BUT NOT SIGNED (${result.unsigned.length}) — these stay NULL and keep the stopgap`);
  for (const a of result.unsigned) {
    console.log(
      `  ${a.symbol.padEnd(8)} type=${a.securityType ?? "?"} cat=${a.fundCategory ?? "-"} name=${a.name ?? "(blank)"}`,
    );
  }

  console.log(
    apply
      ? "\nApplied."
      : "\nDry run (default). Re-run with --apply on a rehearsed copy to write.",
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbPath = resolveDbPath(argv);
  // Printed BEFORE the database is opened (rehearsable-repair rule).
  console.log(`[apply-leverage-factors] mode=${apply ? "APPLY" : "dry-run"}, db: ${dbPath}`);

  // The pass reads `leverage_factor`, so migration 102 has to be present. A
  // dry run therefore needs a WRITABLE copy: it migrates the schema it reads.
  const db = new BetterSqlite3(dbPath, { fileMustExist: true, timeout: 60_000 });
  try {
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    printResult(applyLeverageFactors(db, { dryRun: !apply }), apply);
  } finally {
    db.close();
  }
}

main();
