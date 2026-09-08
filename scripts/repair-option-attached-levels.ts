/**
 * repair-option-attached-levels.ts — re-point standing price levels that are
 * attached to an OCC OPTION row but were quoted in SHARE dollars.
 *
 * Root cause: newsletter level extraction was the only symbol-string ->
 * security_id resolution that creates levels, and its tracked-symbol query had
 * no option filter. So a held contract such as "GOOGL 270115C00220000" was
 * offered to the model as a tracked symbol, and an author saying "trimmed at
 * $388" produced an exit level on the CALL. There it is compared against the
 * option PREMIUM (it can only fire if the premium reaches $388) and the
 * deliberate option exemption from the plausibility band
 * (lib/levels/scan-range.ts) hides the absurdity instead of flagging it.
 *
 * lib/alerts/option-level-resolution.ts now folds options into their
 * underlying equity BEFORE extraction, so no new level can land this way.
 * This script is the one-time cleanup for rows created before that fix.
 *
 * It classifies rather than blanket-moves, because some option-attached levels
 * are GENUINE premium levels ("enter this call at 8.25" with the premium at
 * 8.58). classifyOptionAttachedLevel judges each row against BOTH readings
 * using the scanner's own band predicate:
 *
 *   move      in band as a share price, out of band as a premium -> re-point
 *   leave     in band as a premium -> a real option level, untouched
 *   review    ambiguous (both in band, neither in band, or a missing price)
 *   duplicate would move, but the equity already carries the identical
 *             (level_type, direction, price) row
 *
 * Only "move" rows are written, inside ONE transaction (all-or-nothing), and
 * only the `security_id` + a provenance line appended to `notes` change —
 * never review_status, never is_active. Re-running finds nothing to do,
 * because a moved level is no longer attached to an option.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-option-attached-levels.ts
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-option-attached-levels.ts --apply
 *
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 */

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  appendProvenance,
  classifyOptionAttachedLevel,
  repairProvenanceNote,
  resolveEquityForUnderlying,
  underlyingSymbolOf,
  type OptionLevelVerdict,
} from "../lib/alerts/option-level-resolution";
import { todayET } from "../lib/calendar/date-utils";

// ─── Row + plan shapes ──────────────────────────────────────────────

export interface OptionAttachedLevelRow {
  level_id: number;
  option_security_id: number;
  option_symbol: string;
  underlying_symbol: string | null;
  level_type: string;
  direction: string | null;
  price: number;
  notes: string | null;
  option_price: number | null;
}

export interface OptionLevelRepairPlanRow {
  levelId: number;
  optionSymbol: string;
  optionSecurityId: number;
  optionPrice: number | null;
  levelType: string;
  direction: string | null;
  price: number;
  /** Resolved underlying equity, null when none exists. */
  targetSymbol: string | null;
  targetSecurityId: number | null;
  targetPrice: number | null;
  verdict: OptionLevelVerdict;
  reason: string;
  /** notes value that --apply would write (move rows only). */
  nextNotes: string | null;
}

/** Float equality tolerance for "the equity already carries this level". */
const PRICE_EPSILON = 0.0001;

// ─── Read ───────────────────────────────────────────────────────────

/**
 * Every level whose security is an option, with the option's latest close.
 * Includes rejected / inactive rows: their attachment is wrong regardless of
 * review state, and re-pointing one does not arm it.
 */
export function collectOptionAttachedLevels(
  db: Database.Database,
): OptionAttachedLevelRow[] {
  return db
    .prepare(
      `SELECT l.id AS level_id,
              s.id AS option_security_id,
              s.symbol AS option_symbol,
              s.underlying_symbol,
              l.level_type,
              l.direction,
              l.price,
              l.notes,
              (SELECT p.close_price FROM prices p
                WHERE p.security_id = s.id
                ORDER BY p.date DESC LIMIT 1) AS option_price
         FROM security_levels l
         JOIN securities s ON s.id = l.security_id
        WHERE LOWER(COALESCE(s.security_type, '')) = 'option'
        ORDER BY l.id`,
    )
    .all() as OptionAttachedLevelRow[];
}

/** True when `equityId` already carries an identical level. */
function equityHasIdenticalLevel(
  db: Database.Database,
  equityId: number,
  levelType: string,
  direction: string | null,
  price: number,
): boolean {
  const hit = db
    .prepare(
      `SELECT 1 FROM security_levels
        WHERE security_id = ?
          AND level_type = ?
          AND COALESCE(direction, '') = COALESCE(?, '')
          AND ABS(price - ?) < ?
        LIMIT 1`,
    )
    .get(equityId, levelType, direction, price, PRICE_EPSILON);
  return hit !== undefined;
}

// ─── Plan ───────────────────────────────────────────────────────────

/**
 * Read-only classification of every option-attached level. Pure with respect
 * to the DB — writes nothing. `opts.today` pins the provenance date so tests
 * (and a dry-run/apply pair) are deterministic.
 */
export function planOptionLevelRepairs(
  db: Database.Database,
  opts: { today?: string } = {},
): OptionLevelRepairPlanRow[] {
  const today = opts.today ?? todayET();
  const rows = collectOptionAttachedLevels(db);
  const plan: OptionLevelRepairPlanRow[] = [];
  // Identical rows moving to the same equity within ONE run would create the
  // twin the duplicate guard exists to prevent, so track what we plan to add.
  const plannedOnEquity = new Set<string>();

  for (const row of rows) {
    const underlying = underlyingSymbolOf({
      symbol: row.option_symbol,
      underlying_symbol: row.underlying_symbol,
    });
    const equity = underlying ? resolveEquityForUnderlying(db, underlying) : null;

    const dupKey = equity
      ? `${equity.security_id}|${row.level_type}|${row.direction ?? ""}|${row.price.toFixed(4)}`
      : "";
    const duplicateOnEquity = equity
      ? plannedOnEquity.has(dupKey) ||
        equityHasIdenticalLevel(
          db,
          equity.security_id,
          row.level_type,
          row.direction,
          row.price,
        )
      : false;

    const { verdict, reason } = classifyOptionAttachedLevel({
      levelPrice: row.price,
      optionPrice: row.option_price,
      equity,
      duplicateOnEquity,
    });

    if (verdict === "move" && equity) plannedOnEquity.add(dupKey);

    plan.push({
      levelId: row.level_id,
      optionSymbol: row.option_symbol,
      optionSecurityId: row.option_security_id,
      optionPrice: row.option_price,
      levelType: row.level_type,
      direction: row.direction,
      price: row.price,
      targetSymbol: equity?.symbol ?? null,
      targetSecurityId: equity?.security_id ?? null,
      targetPrice: equity?.current_price ?? null,
      verdict,
      reason:
        !underlying && verdict === "review"
          ? "cannot parse an underlying ticker off the contract symbol"
          : reason,
      nextNotes:
        verdict === "move"
          ? appendProvenance(row.notes, repairProvenanceNote(row.option_symbol, today))
          : null,
    });
  }

  return plan;
}

// ─── Apply ──────────────────────────────────────────────────────────

/**
 * Re-plan and write, all inside ONE transaction. Re-planning inside the
 * transaction (rather than trusting a plan computed earlier) means the rows
 * written are exactly the rows classified, even if something changed between
 * the dry run and the apply.
 *
 * Only `security_id` and `notes` move. review_status / is_active / price /
 * direction / level_type are never touched — this repair fixes WHICH security
 * a level belongs to, nothing about the level itself.
 */
export function applyOptionLevelRepairs(
  db: Database.Database,
  opts: { today?: string } = {},
): { plan: OptionLevelRepairPlanRow[]; moved: number } {
  let plan: OptionLevelRepairPlanRow[] = [];
  let moved = 0;

  const update = db.prepare(
    `UPDATE security_levels
        SET security_id = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );

  const tx = db.transaction(() => {
    plan = planOptionLevelRepairs(db, opts);
    for (const row of plan) {
      if (row.verdict !== "move" || row.targetSecurityId == null) continue;
      update.run(row.targetSecurityId, row.nextNotes, row.levelId);
      moved++;
    }
  });
  tx();

  return { plan, moved };
}

// ─── CLI ────────────────────────────────────────────────────────────

// REPAIR_DB_PATH lets the rehearsal workflow point at a VACUUM copy instead of
// the live database — always rehearse --apply on a copy first.
const DB_PATH =
  process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

function fmtPrice(value: number | null): string {
  return value == null ? "-" : String(value);
}

function printPlan(plan: OptionLevelRepairPlanRow[]): void {
  const header = [
    "id",
    "option",
    "target",
    "level",
    "price",
    "premium",
    "equity px",
    "verdict",
  ];
  const rows = plan.map((r) => [
    String(r.levelId),
    r.optionSymbol.trim(),
    r.targetSymbol ?? "(none)",
    `${r.levelType}${r.direction ? `/${r.direction}` : ""}`,
    fmtPrice(r.price),
    fmtPrice(r.optionPrice),
    fmtPrice(r.targetPrice),
    r.verdict,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((cells) => cells[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (let i = 0; i < rows.length; i++) {
    console.log(line(rows[i]));
    console.log(`${" ".repeat(widths[0] + 2)}^ ${plan[i].reason}`);
  }
}

/** Timestamped `VACUUM INTO` backup next to the database being written. */
function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `pre-option-level-repair-${timestamp}.db`,
  );
  db.prepare("VACUUM INTO ?").run(backupPath);
  if (fs.statSync(backupPath).size === 0) {
    throw new Error(
      `backup at ${backupPath} is 0 bytes — aborting, refusing to write without a verified backup`,
    );
  }
  return backupPath;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply }) as Database.Database;
  db.pragma("foreign_keys = ON");

  try {
    console.log(
      `Option-attached level repair ${apply ? "[APPLY]" : "[DRY RUN]"} — db: ${DB_PATH}\n`,
    );

    const preview = planOptionLevelRepairs(db);
    if (preview.length === 0) {
      console.log("No levels are attached to an option row. Nothing to do.");
      return;
    }
    printPlan(preview);

    const counts = preview.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `\n${preview.length} option-attached level(s): ` +
        (["move", "leave", "review", "duplicate"] as OptionLevelVerdict[])
          .map((v) => `${counts[v] ?? 0} ${v}`)
          .join(", "),
    );

    if (!apply) {
      console.log("\nDry run (default). Re-run with --apply to write.");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply",
      );
      return;
    }

    if ((counts.move ?? 0) === 0) {
      console.log("\nNothing to move. No write performed.");
      return;
    }

    const backupPath = backupDatabase(db);
    console.log(`\nBackup written: ${backupPath}`);

    const { moved } = applyOptionLevelRepairs(db);
    console.log(
      `Re-pointed ${moved} level(s) to their underlying equity (one transaction).`,
    );
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-etf-types.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-option-attached-levels.ts") ||
    process.argv[1].endsWith("repair-option-attached-levels.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
