/**
 * repair-duplicate-option-securities.ts — Merge duplicate option
 * securities that were created under two (or three) different symbol
 * spellings for the exact same contract
 * (qa:security-detail-transactions--same-option-trade-duplicated-across-
 * two-symbol-spellings, 2026-08-12).
 *
 * Root cause: lib/mutations/securities.ts's upsertSecurity() had no
 * symbol canonicalization step, so the SAME option contract got a fresh
 * securities row for every spelling a writer happened to produce:
 *   - OCC canonical:        "NVDA  260618C00175000"
 *   - Vanguard-compact:     "NVDA 260618 C 175.00"   (Claude PDF extraction
 *                            emits the symbol as free text without fully
 *                            populating the separate underlying/strike/
 *                            expiration/type fields ensureOCCSymbol()
 *                            needs to build OCC form itself)
 *   - IBKR human-readable:  "NVDA 18JUN26 175 C"     (parseIBKROptionSymbol
 *                            converts this at IBKR-activity import time —
 *                            these rows predate that conversion or came in
 *                            through a writer that bypassed it)
 * Every trade/holding/tax-lot recorded against the "wrong" spelling
 * silently double-counted that option's history, counts, and cost basis.
 * lib/mutations/securities.ts now canonicalizes on write (parseOptionSymbol
 * + formatOccSymbol from lib/import/occ-symbol.ts), so new imports can't
 * recreate this — this script cleans up what already accumulated.
 *
 * Identity: NEVER same-day/qty/price trade coincidence — that misses real
 * duplicates and can wrongly match two DIFFERENT contracts that happened
 * to fill the same day (a GOOG put vs an SPY put). Every option-typed
 * security's SYMBOL is parsed into (root, expiry, right, strike) —
 * trying OCC/Vanguard-compact first, then the IBKR human-readable form as
 * a fallback (both spellings observed live in this DB) — and grouped on
 * that tuple, the only reliable identity for an options contract.
 *
 * Survivor selection: within a group, the row already spelled in
 * canonical OCC form wins. If no member is already canonical, the
 * lowest-id row is kept and renamed to canonical OCC.
 *
 * Merge = repoint every table with a security_id (or new_security_id) FK
 * from the duplicate id(s) to the survivor id, then delete the duplicate
 * securities row(s):
 *   - "Blanket" tables (no UNIQUE constraint on the FK combo — safe to
 *     have many rows per security_id): calendar_events, corporate_actions
 *     (new_security_id), earnings_call_notes, earnings_transcripts,
 *     level_alerts, notes, security_levels, tax_lots, trade_roundtrips,
 *     transactions. Denormalized display-symbol columns
 *     (calendar_events.symbol, trade_roundtrips.symbol,
 *     earnings_call_notes.symbol) are updated to the survivor's canonical
 *     symbol alongside the FK repoint.
 *   - "Collision-checked" tables (a UNIQUE constraint could collide on
 *     repoint): holdings, prices, ohlcv_bars, corporate_actions
 *     (security_id), research_article_securities, security_betas,
 *     suggested_level_narratives, security_regressions, watchlist,
 *     security_factors, security_quotes. If the survivor already has a
 *     row for the same natural key, the survivor's row wins and the
 *     duplicate's colliding row is DISCARDED (deleted) rather than
 *     repointed — logged as a collision for review.
 *   - securities metadata (name/underlying_symbol/strike_price/
 *     expiration_date/option_type/multiplier/currency): any column NULL
 *     on the survivor is backfilled from a duplicate that has it, same
 *     COALESCE philosophy as upsertSecurity's own ON CONFLICT clause.
 *
 * transactions.source_key embeds the OLD symbol spelling — repointing
 * transactions.security_id is safe (a future re-import of the same
 * statement recomputes the same source_key and is a no-op either way;
 * see lib/mutations/securities.ts's new canonicalization for why a fresh
 * import can no longer recreate the duplicate).
 *
 * Dry-run by default (writes nothing). --apply wraps every merge in ONE
 * transaction, takes a VACUUM INTO backup first (ensureBackup, same
 * helper scripts/repair-split-basis-2024-year-end.ts uses), and
 * recomputes tax lots afterward (computeTaxLots — the standard rebuild
 * path, same as scripts/repair-option-roundtrip-dollars.ts).
 *
 * Idempotent by construction: after a merge, exactly one securities row
 * remains per (root, expiry, right, strike), so a second --apply run
 * finds zero groups.
 *
 * KNOWN LIMITATION: collision detection for tables with 3+ members in one
 * group re-checks live DB state per row, so in dry-run (no writes) it
 * cannot see a would-be collision between two duplicates that only
 * collide with EACH OTHER (not with the survivor). No group in this DB
 * has 3+ members as of the 2026-08-12 audit; if that ever changes, re-run
 * with --apply and inspect the printed per-table results — apply mode
 * sees each write as it happens and catches these correctly.
 *
 * Usage:
 *   npx tsx scripts/repair-duplicate-option-securities.ts            # dry-run
 *   npx tsx scripts/repair-duplicate-option-securities.ts --apply    # write
 *   npx tsx scripts/repair-duplicate-option-securities.ts --db <path>
 */

import type Database from "better-sqlite3";
import {
  formatOccSymbol,
  parseOptionSymbol,
} from "@/lib/import/occ-symbol";
import { parseIBKROptionSymbol } from "@/lib/import/parsers/ibkr-activity";
import { computeTaxLots } from "@/lib/compute/tax-lots";

// ─── Identity ───────────────────────────────────────────────────────

export interface OptionIdentity {
  root: string;
  expirationDate: string; // YYYY-MM-DD
  optionType: "CALL" | "PUT";
  strike: number;
}

export function identityKey(id: OptionIdentity): string {
  return `${id.root}|${id.expirationDate}|${id.optionType}|${Math.round(id.strike * 1000)}`;
}

/** formatOccSymbol expects ParsedOptionSymbol's field name `underlying`;
 *  OptionIdentity (this script's own shape) calls the same concept `root`.
 *  Adapt between the two here rather than aliasing field names throughout. */
function canonicalSymbolFor(identity: OptionIdentity): string {
  return formatOccSymbol({
    underlying: identity.root,
    expirationDate: identity.expirationDate,
    optionType: identity.optionType,
    strike: identity.strike,
  });
}

/**
 * Parse ANY currently-known option symbol spelling into an identity. Tries
 * OCC + Vanguard-compact first (parseOptionSymbol — the same parser
 * lib/mutations/securities.ts uses on write), then falls back to the IBKR
 * human-readable form (parseIBKROptionSymbol, e.g. "AAPL 21MAR25 150.0
 * C") which appears live in this DB from writers/eras that predate its
 * own OCC pre-conversion. Returns null (never throws) for anything
 * unparseable — bare tickers, bonds, mutual funds, etc.
 */
export function identifyOptionSymbol(symbol: string): OptionIdentity | null {
  const parsed = parseOptionSymbol(symbol);
  if (parsed) {
    return {
      root: parsed.underlying,
      expirationDate: parsed.expirationDate,
      optionType: parsed.optionType,
      strike: parsed.strike,
    };
  }
  const ibkr = parseIBKROptionSymbol(symbol);
  if (ibkr) {
    return {
      root: ibkr.underlying.trim(),
      expirationDate: ibkr.expiry,
      optionType: ibkr.optionType,
      strike: ibkr.strike,
    };
  }
  return null;
}

// ─── Grouping ───────────────────────────────────────────────────────

export interface OptionSecurityRow {
  id: number;
  symbol: string;
  name: string | null;
  underlying_symbol: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_type: string | null;
  multiplier: number | null;
  currency: string | null;
}

export interface DuplicateGroup {
  identity: OptionIdentity;
  canonicalSymbol: string;
  members: OptionSecurityRow[];
}

const SECURITY_COLUMNS =
  "id, symbol, name, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency";

export function findDuplicateGroups(db: Database.Database): {
  groups: DuplicateGroup[];
  unparseable: OptionSecurityRow[];
} {
  const rows = db
    .prepare(
      `SELECT ${SECURITY_COLUMNS} FROM securities WHERE LOWER(security_type) = 'option' ORDER BY id`,
    )
    .all() as OptionSecurityRow[];

  const byKey = new Map<string, DuplicateGroup>();
  const unparseable: OptionSecurityRow[] = [];

  for (const row of rows) {
    const identity = identifyOptionSymbol(row.symbol);
    if (!identity) {
      unparseable.push(row);
      continue;
    }
    const key = identityKey(identity);
    let group = byKey.get(key);
    if (!group) {
      group = { identity, canonicalSymbol: canonicalSymbolFor(identity), members: [] };
      byKey.set(key, group);
    }
    group.members.push(row);
  }

  const groups = [...byKey.values()].filter((g) => g.members.length > 1);
  return { groups, unparseable };
}

// ─── Survivor selection ─────────────────────────────────────────────

export interface SurvivorPlan {
  survivor: OptionSecurityRow;
  wouldRename: boolean; // true if no member is already spelled canonically
  duplicates: OptionSecurityRow[];
}

export function planSurvivor(group: DuplicateGroup): SurvivorPlan {
  const canonical = group.members.find((m) => m.symbol === group.canonicalSymbol);
  if (canonical) {
    return {
      survivor: canonical,
      wouldRename: false,
      duplicates: group.members.filter((m) => m.id !== canonical.id),
    };
  }
  const sorted = [...group.members].sort((a, b) => a.id - b.id);
  return { survivor: sorted[0], wouldRename: true, duplicates: sorted.slice(1) };
}

// ─── FK table specs ─────────────────────────────────────────────────

interface BlanketTableSpec {
  table: string;
  fkColumn: string;
  symbolColumn?: string; // denormalized display column to also update
}

/** Tables with no UNIQUE constraint touching the FK column — always safe
 *  to have many rows per security_id, so every duplicate's row is simply
 *  repointed. */
const BLANKET_TABLES: BlanketTableSpec[] = [
  { table: "calendar_events", fkColumn: "security_id", symbolColumn: "symbol" },
  { table: "corporate_actions", fkColumn: "new_security_id" },
  { table: "earnings_call_notes", fkColumn: "security_id", symbolColumn: "symbol" },
  { table: "earnings_transcripts", fkColumn: "security_id" },
  { table: "level_alerts", fkColumn: "security_id" },
  { table: "notes", fkColumn: "security_id" },
  { table: "security_levels", fkColumn: "security_id" },
  { table: "tax_lots", fkColumn: "security_id" },
  { table: "trade_roundtrips", fkColumn: "security_id", symbolColumn: "symbol" },
  { table: "transactions", fkColumn: "security_id" },
];

interface CollisionTableSpec {
  table: string;
  fkColumn: string;
  /** Columns besides the FK that make up the table's UNIQUE/PK constraint.
   *  Empty array means the FK column ALONE is unique/PK (at most one row
   *  per security_id in this table). */
  otherKeyColumns: string[];
}

/** Tables whose UNIQUE constraint (see PRAGMA foreign_key_list /
 *  CREATE TABLE) could collide when two rows are repointed to the same
 *  survivor security_id. */
const COLLISION_TABLES: CollisionTableSpec[] = [
  { table: "holdings", fkColumn: "security_id", otherKeyColumns: ["account_id", "as_of_date"] },
  { table: "prices", fkColumn: "security_id", otherKeyColumns: ["date"] },
  { table: "ohlcv_bars", fkColumn: "security_id", otherKeyColumns: ["bar_date", "bar_size"] },
  {
    table: "corporate_actions",
    fkColumn: "security_id",
    otherKeyColumns: ["action_type", "effective_date"],
  },
  {
    table: "research_article_securities",
    fkColumn: "security_id",
    otherKeyColumns: ["article_id"],
  },
  { table: "security_betas", fkColumn: "security_id", otherKeyColumns: ["lookback_days"] },
  {
    table: "suggested_level_narratives",
    fkColumn: "security_id",
    otherKeyColumns: ["level_price", "direction", "computed_at_day"],
  },
  {
    table: "security_regressions",
    fkColumn: "security_id",
    otherKeyColumns: ["benchmark_symbol", "computed_at_day"],
  },
  { table: "watchlist", fkColumn: "security_id", otherKeyColumns: [] },
  { table: "security_factors", fkColumn: "security_id", otherKeyColumns: [] },
  { table: "security_quotes", fkColumn: "security_id", otherKeyColumns: [] },
];

// ─── Per-table merge ────────────────────────────────────────────────

export interface CollisionDetail {
  rowid: number;
  reason: string;
}

export interface TableMergeResult {
  table: string;
  column: string;
  repointed: number;
  collisions: number;
  collisionDetail: CollisionDetail[];
}

function mergeBlanketTable(
  db: Database.Database,
  spec: BlanketTableSpec,
  duplicateIds: number[],
  survivorId: number,
  survivorSymbol: string,
  apply: boolean,
): TableMergeResult {
  const empty: TableMergeResult = {
    table: spec.table,
    column: spec.fkColumn,
    repointed: 0,
    collisions: 0,
    collisionDetail: [],
  };
  if (duplicateIds.length === 0) return empty;

  const placeholders = duplicateIds.map(() => "?").join(",");
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM ${spec.table} WHERE ${spec.fkColumn} IN (${placeholders})`)
    .get(...duplicateIds) as { c: number };

  if (apply && countRow.c > 0) {
    if (spec.symbolColumn) {
      db.prepare(
        `UPDATE ${spec.table} SET ${spec.fkColumn} = ?, ${spec.symbolColumn} = ? WHERE ${spec.fkColumn} IN (${placeholders})`,
      ).run(survivorId, survivorSymbol, ...duplicateIds);
    } else {
      db.prepare(
        `UPDATE ${spec.table} SET ${spec.fkColumn} = ? WHERE ${spec.fkColumn} IN (${placeholders})`,
      ).run(survivorId, ...duplicateIds);
    }
  }

  return { ...empty, repointed: countRow.c };
}

function mergeCollisionTable(
  db: Database.Database,
  spec: CollisionTableSpec,
  duplicateIds: number[],
  survivorId: number,
  apply: boolean,
): TableMergeResult {
  const result: TableMergeResult = {
    table: spec.table,
    column: spec.fkColumn,
    repointed: 0,
    collisions: 0,
    collisionDetail: [],
  };
  if (duplicateIds.length === 0) return result;

  const otherCols = spec.otherKeyColumns;
  const placeholders = duplicateIds.map(() => "?").join(",");
  // Alias explicitly: SQLite reports a bare "rowid" SELECT under the
  // table's actual INTEGER PRIMARY KEY column name when one exists (e.g.
  // "id", or even the FK column itself for security_factors/security_quotes
  // where security_id IS the rowid alias) — an unambiguous alias keeps the
  // JS-side property name stable across every table shape.
  const selectCols = ["rowid AS _repair_rowid", ...otherCols].join(", ");
  const rows = db
    .prepare(`SELECT ${selectCols} FROM ${spec.table} WHERE ${spec.fkColumn} IN (${placeholders})`)
    .all(...duplicateIds) as Array<Record<string, unknown>>;
  if (rows.length === 0) return result;

  const existsSql =
    otherCols.length > 0
      ? `SELECT 1 FROM ${spec.table} WHERE ${spec.fkColumn} = ? AND ${otherCols
          .map((c) => `${c} IS ?`)
          .join(" AND ")} LIMIT 1`
      : `SELECT 1 FROM ${spec.table} WHERE ${spec.fkColumn} = ? LIMIT 1`;
  const existsStmt = db.prepare(existsSql);
  const updateStmt = db.prepare(`UPDATE ${spec.table} SET ${spec.fkColumn} = ? WHERE rowid = ?`);
  const deleteStmt = db.prepare(`DELETE FROM ${spec.table} WHERE rowid = ?`);

  for (const row of rows) {
    const rowid = row._repair_rowid as number;
    const otherVals = otherCols.map((c) => row[c]);
    const collision = existsStmt.get(survivorId, ...otherVals);
    if (collision) {
      const reason =
        otherCols.length > 0
          ? `survivor already has a row with ${otherCols.map((c, i) => `${c}=${String(otherVals[i])}`).join(", ")}`
          : `survivor already has a row in ${spec.table}`;
      result.collisionDetail.push({ rowid, reason });
      if (apply) deleteStmt.run(rowid);
    } else {
      result.repointed++;
      if (apply) updateStmt.run(survivorId, rowid);
    }
  }
  result.collisions = result.collisionDetail.length;
  return result;
}

// ─── Securities metadata backfill ───────────────────────────────────

const METADATA_COLUMNS = [
  "name",
  "underlying_symbol",
  "strike_price",
  "expiration_date",
  "option_type",
  "multiplier",
  "currency",
] as const;

/** Any of METADATA_COLUMNS that is NULL on the survivor gets backfilled
 *  from the first duplicate that has a non-null value — same COALESCE
 *  philosophy as upsertSecurity's own ON CONFLICT clause. Returns a
 *  human-readable list of what was (or, in dry-run, would be) backfilled. */
function backfillSurvivorMetadata(
  db: Database.Database,
  survivor: OptionSecurityRow,
  duplicates: OptionSecurityRow[],
  apply: boolean,
): string[] {
  if (duplicates.length === 0) return [];

  const backfilled: string[] = [];
  const setParts: string[] = [];
  const setValues: unknown[] = [];

  for (const col of METADATA_COLUMNS) {
    const survivorVal = (survivor as unknown as Record<string, unknown>)[col];
    if (survivorVal !== null && survivorVal !== undefined) continue;
    const fromDup = duplicates.find((d) => {
      const v = (d as unknown as Record<string, unknown>)[col];
      return v !== null && v !== undefined;
    });
    if (fromDup) {
      const val = (fromDup as unknown as Record<string, unknown>)[col];
      backfilled.push(`${col}=${String(val)} (from id=${fromDup.id})`);
      setParts.push(`${col} = ?`);
      setValues.push(val);
    }
  }

  if (setParts.length > 0 && apply) {
    db.prepare(`UPDATE securities SET ${setParts.join(", ")} WHERE id = ?`).run(
      ...setValues,
      survivor.id,
    );
  }
  return backfilled;
}

// ─── Group merge orchestration ──────────────────────────────────────

export interface GroupReport {
  identity: OptionIdentity;
  canonicalSymbol: string;
  survivorId: number;
  survivorSymbolBefore: string;
  wouldRename: boolean;
  mergedIds: number[];
  mergedSymbols: string[];
  metadataBackfilled: string[];
  tableResults: TableMergeResult[];
}

export function planAndMergeGroup(
  db: Database.Database,
  group: DuplicateGroup,
  apply: boolean,
): GroupReport {
  const { survivor, wouldRename, duplicates } = planSurvivor(group);
  const duplicateIds = duplicates.map((d) => d.id);

  const tableResults: TableMergeResult[] = [
    ...BLANKET_TABLES.map((spec) =>
      mergeBlanketTable(db, spec, duplicateIds, survivor.id, group.canonicalSymbol, apply),
    ),
    ...COLLISION_TABLES.map((spec) =>
      mergeCollisionTable(db, spec, duplicateIds, survivor.id, apply),
    ),
  ];

  const metadataBackfilled = backfillSurvivorMetadata(db, survivor, duplicates, apply);

  if (apply && wouldRename) {
    db.prepare("UPDATE securities SET symbol = ? WHERE id = ?").run(
      group.canonicalSymbol,
      survivor.id,
    );
  }

  if (apply && duplicateIds.length > 0) {
    const placeholders = duplicateIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM securities WHERE id IN (${placeholders})`).run(...duplicateIds);
  }

  return {
    identity: group.identity,
    canonicalSymbol: group.canonicalSymbol,
    survivorId: survivor.id,
    survivorSymbolBefore: survivor.symbol,
    wouldRename,
    mergedIds: duplicateIds,
    mergedSymbols: duplicates.map((d) => d.symbol),
    metadataBackfilled,
    tableResults,
  };
}

// ─── Reporting ──────────────────────────────────────────────────────

export function printReport(
  reports: GroupReport[],
  unparseable: OptionSecurityRow[],
  apply: boolean,
): void {
  console.log(`Found ${reports.length} duplicate option group(s).\n`);

  for (const r of reports) {
    console.log(
      `Group: ${r.identity.root} ${r.identity.expirationDate} ${r.identity.optionType} $${r.identity.strike}`,
    );
    console.log(`  Canonical OCC symbol: "${r.canonicalSymbol}"`);
    console.log(
      `  Survivor: id=${r.survivorId} symbol="${r.survivorSymbolBefore}"` +
        (r.wouldRename ? ` (${apply ? "renamed" : "would be renamed"} to canonical)` : ""),
    );
    console.log(
      `  ${apply ? "Merged" : "Would merge"} (${r.mergedIds.length}): ` +
        r.mergedIds.map((id, i) => `id=${id} symbol="${r.mergedSymbols[i]}"`).join(", "),
    );
    if (r.metadataBackfilled.length > 0) {
      console.log(
        `  Survivor metadata ${apply ? "backfilled" : "would be backfilled"}: ${r.metadataBackfilled.join(", ")}`,
      );
    }
    for (const t of r.tableResults) {
      if (t.repointed === 0 && t.collisions === 0) continue;
      console.log(
        `  ${t.table}.${t.column}: ${t.repointed} row(s) ${apply ? "repointed" : "to repoint"}` +
          (t.collisions > 0
            ? `, ${t.collisions} COLLISION(S) (survivor row wins, duplicate row ${apply ? "discarded" : "would be discarded"})`
            : ""),
      );
      for (const c of t.collisionDetail) {
        console.log(`    COLLISION rowid=${c.rowid}: ${c.reason}`);
      }
    }
    console.log("");
  }

  if (unparseable.length > 0) {
    console.log(
      `${unparseable.length} option-typed securities had unparseable symbols (left untouched, not part of duplicate detection):`,
    );
    for (const u of unparseable) console.log(`  id=${u.id} symbol="${u.symbol}"`);
    console.log("");
  }

  const totalMerged = reports.reduce((sum, r) => sum + r.mergedIds.length, 0);
  const totalCollisions = reports.reduce(
    (sum, r) => sum + r.tableResults.reduce((s, t) => s + t.collisions, 0),
    0,
  );
  console.log(
    `Summary: ${reports.length} group(s), ${totalMerged} duplicate securities row(s) ` +
      `${apply ? "merged and deleted" : "would be merged and deleted"}` +
      (totalCollisions > 0 ? `, ${totalCollisions} total collision(s) discarded` : "") +
      ".",
  );
  if (!apply) {
    console.log("\nDry-run (default). Re-run with --apply to write.");
  }
}

// ─── CLI driver ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbFlagIdx = args.indexOf("--db");
  const dbPath =
    dbFlagIdx !== -1 && args[dbFlagIdx + 1]
      ? args[dbFlagIdx + 1]
      : path.default.join(process.cwd(), "data", "vanguard.db");

  if (!fs.default.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
    return;
  }

  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    console.log(
      `Duplicate option securities repair ${apply ? "[APPLY]" : "[DRY RUN]"} — db: ${dbPath}\n`,
    );

    const { groups, unparseable } = findDuplicateGroups(db);

    if (groups.length === 0) {
      console.log("No duplicate option security groups found. Nothing to do.");
      if (unparseable.length > 0) {
        console.log(
          `\n(${unparseable.length} option-typed securities had unparseable symbols — informational only.)`,
        );
      }
      return;
    }

    if (apply) {
      const backupPath = path.default.join(
        process.cwd(),
        "data",
        "backups",
        `pre-duplicate-option-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.db`,
      );
      const backup = ensureBackup(db, backupPath);
      console.log(
        `Backup ${backup.created ? "created" : "already present"} at ${backup.path} (${backup.sizeBytes} bytes)\n`,
      );
    }

    const reports = apply
      ? db.transaction(() => groups.map((g) => planAndMergeGroup(db, g, true)))()
      : groups.map((g) => planAndMergeGroup(db, g, false));

    printReport(reports, unparseable, apply);

    if (apply) {
      console.log("\nRecomputing tax lots...");
      const taxResult = computeTaxLots(db);
      console.log(
        `  lots=${taxResult.lotsCreated} sales=${taxResult.salesProcessed} ` +
          `totalRealizedGain=$${taxResult.totalRealizedGain.toFixed(2)}`,
      );
      console.log(
        "\nDone. Recompute valuations next: curl -X POST http://localhost:3099/api/compute/valuations",
      );
    }
  } finally {
    db.close();
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-duplicate-option-securities.ts") ||
    process.argv[1].endsWith("repair-duplicate-option-securities.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
