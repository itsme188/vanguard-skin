// Packaged-app trust boundary (#35, task 20) — batch-bound import-undo
// recovery manifest + restore.
//
// WHY: `undoImport` (lib/import/engine.ts -> deleteImportBatch) is
// destructive and unrecoverable: it deletes the batch's rows across every
// source table it wrote AND clears the derived tax-lot / valuation layer
// before recompute. This module writes a complete, self-verifying JSON
// snapshot of the batch's source rows BEFORE that delete, and can re-insert
// them faithfully afterward.
//
// BLAST-RADIUS ENUMERATION (from deleteImportBatch, not guessed):
//   deleteImportBatch touches THREE classes of table:
//     1. GLOBAL derived caches, cleared wholesale then recomputed by the
//        caller: tax_lot_sales, tax_lots, daily_valuations. These are a pure
//        function of the source rows (computeTaxLots + computeDailyValuations)
//        — NOT batch-owned data. They are deliberately NOT in the manifest;
//        restore regenerates them via the same recompute undoImport runs.
//     2. BATCH-OWNED source rows (DELETE ... WHERE import_batch_id = ?):
//        raw_imports, prices, holdings, transactions, monthly_snapshots,
//        corporate_actions. These ARE the manifest payload.
//     3. The import_batches METADATA row (DELETE ... WHERE id = ?).
//   securities / security_factors are NOT deleted by undo, so they survive
//   and need no capture.
//
// This is why a batch-bound manifest CAN reproduce the pre-undo state even
// though undo clears global tables: the cleared tables are recomputable.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { undoImport } from "./engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { LIVE_HOLDING_SOURCE_PREFIXES } from "@/lib/db/holding-sources";

/**
 * The batch-owned source tables the manifest captures. Enumerated directly
 * from deleteImportBatch's `WHERE import_batch_id = ?` deletes — the
 * import_batches metadata row is captured separately (see RecoveryPayload).
 */
export const RECOVERY_SOURCE_TABLES = [
  "transactions",
  "holdings",
  "prices",
  "monthly_snapshots",
  "corporate_actions",
  "raw_imports",
] as const;

export type RecoverySourceTable = (typeof RECOVERY_SOURCE_TABLES)[number];

export const MANIFEST_VERSION = 1;
export const DEFAULT_MANIFEST_DIR = join(process.cwd(), "data", "undo-recovery");
export const DEFAULT_MANIFEST_RETENTION = 25;

type Row = Record<string, unknown>;

export interface RecoveryPayload {
  importBatch: Row;
  tables: Record<RecoverySourceTable, Row[]>;
}

export interface RecoveryManifest {
  version: number;
  batchId: number;
  createdAt: string;
  /** sha256 over the canonical serialization of `payload`. */
  checksum: string;
  payload: RecoveryPayload;
}

// ── Checksum ─────────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively so the digest is
 *  stable regardless of column/row insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function computeManifestChecksum(payload: RecoveryPayload): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** True iff the manifest's stored checksum matches its payload. */
export function verifyManifest(manifest: RecoveryManifest): boolean {
  return computeManifestChecksum(manifest.payload) === manifest.checksum;
}

// ── Build ────────────────────────────────────────────────────────────

/**
 * Snapshot every batch-owned source row + the import_batches metadata row
 * into a checksum-sealed manifest. Throws if the batch does not exist.
 */
export function buildRecoveryManifest(db: Database.Database, batchId: number): RecoveryManifest {
  const importBatch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batchId) as Row | undefined;
  if (!importBatch) {
    throw new Error(`Cannot build recovery manifest: import batch ${batchId} not found`);
  }

  const tables = {} as Record<RecoverySourceTable, Row[]>;
  for (const table of RECOVERY_SOURCE_TABLES) {
    tables[table] = db
      .prepare(`SELECT * FROM ${table} WHERE import_batch_id = ? ORDER BY id`)
      .all(batchId) as Row[];
  }

  const payload: RecoveryPayload = { importBatch, tables };
  return {
    version: MANIFEST_VERSION,
    batchId,
    createdAt: new Date().toISOString(),
    checksum: computeManifestChecksum(payload),
    payload,
  };
}

// ── Write (atomic) + retention ───────────────────────────────────────

/**
 * Atomically write a manifest to `<dir>/<batchId>-<ts>.json` (temp file +
 * rename), then prune to the newest `retention` manifests. Returns the final
 * path.
 */
export function writeRecoveryManifest(
  manifest: RecoveryManifest,
  dir: string = DEFAULT_MANIFEST_DIR,
  retention: number = DEFAULT_MANIFEST_RETENTION,
): string {
  mkdirSync(dir, { recursive: true });
  const tsSlug = manifest.createdAt.replace(/[:.]/g, "-");
  const basename = `${manifest.batchId}-${tsSlug}.json`;
  const finalPath = join(dir, basename);
  const tmpPath = join(dir, `.${basename}.tmp`);

  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmpPath, finalPath); // atomic on same filesystem

  pruneManifests(dir, retention);
  return finalPath;
}

/** Keep only the newest `retention` .json manifests (by filename, which
 *  encodes the ISO timestamp); delete older ones and any stale temp files. */
export function pruneManifests(dir: string, retention: number): void {
  const entries = readdirSync(dir);
  // Sweep abandoned temp files (a crash between write and rename).
  for (const f of entries) {
    if (f.endsWith(".tmp")) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* best-effort */
      }
    }
  }
  const jsons = entries.filter((f) => f.endsWith(".json"));
  if (jsons.length <= retention) return;
  // Newest first, CHRONOLOGICALLY. Filenames are `<batchId>-<isoSlug>.json`
  // and batchId is NOT zero-padded, so a raw filename sort orders by batchId
  // ("9-" > "10-") — which could prune a freshly-written low-batchId manifest.
  // Sort by the embedded zero-padded ISO timestamp instead (batch-independent),
  // with mtime as the tie-breaker.
  const slug = (f: string) => f.replace(/^\d+-/, "").replace(/\.json$/, "");
  jsons.sort((a, b) => {
    const cmp = slug(b).localeCompare(slug(a));
    if (cmp !== 0) return cmp;
    return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs;
  });
  for (const stale of jsons.slice(retention)) {
    try {
      unlinkSync(join(dir, stale));
    } catch {
      /* best-effort */
    }
  }
}

export function readRecoveryManifest(filePath: string): RecoveryManifest {
  return JSON.parse(readFileSync(filePath, "utf-8")) as RecoveryManifest;
}

// ── Restore ──────────────────────────────────────────────────────────

/**
 * Per-table restore semantics. Idempotent-keyed tables re-insert with OR
 * IGNORE (source_key / collision dedup). The three end-of-day authority
 * tables (holdings, prices, monthly_snapshots) re-insert with the SAME
 * conflict guards commitImport uses, so a restore preserves the
 * statement-authoritative invariant: a manifested statement row overwrites a
 * live row that occupies its slot, but never the reverse.
 */
const LIVE_HOLDING_GUARD = LIVE_HOLDING_SOURCE_PREFIXES.map(
  (p) => `holdings.source_key LIKE '${p}%'`,
).join(" OR ");

// Mirror of commitImport step 5's source-priority CASE (lib/import/engine.ts).
// Parity-pinned: if that CASE changes, this must change with it.
const PRICE_PRIORITY_CASE = (col: string) => `CASE ${col}
    WHEN 'tws' THEN 1
    WHEN 'ibkr-activity' THEN 2
    WHEN 'ibkr-holdings' THEN 2
    WHEN 'vanguard-pdf' THEN 3
    WHEN 'vanguard-export' THEN 3
    WHEN 'vanguard-holdings' THEN 3
    WHEN 'plaid' THEN 3
    ELSE 4
  END`;

interface RestoreSpec {
  /** INSERT prefix — "OR IGNORE" for idempotent-keyed tables, "" otherwise. */
  prefix: string;
  /** Trailing ON CONFLICT clause (empty for OR IGNORE tables). */
  conflict: string;
}

function restoreSpec(table: RecoverySourceTable): RestoreSpec {
  switch (table) {
    case "holdings":
      return {
        prefix: "",
        conflict: `ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
            quantity = excluded.quantity,
            cost_basis = excluded.cost_basis,
            import_batch_id = excluded.import_batch_id,
            source_key = excluded.source_key
          WHERE ${LIVE_HOLDING_GUARD}`,
      };
    case "prices":
      return {
        prefix: "",
        conflict: `ON CONFLICT(security_id, date) DO UPDATE SET
            close_price = excluded.close_price,
            source = excluded.source,
            import_batch_id = excluded.import_batch_id
          WHERE ${PRICE_PRIORITY_CASE("excluded.source")} <= ${PRICE_PRIORITY_CASE("prices.source")}`,
      };
    case "monthly_snapshots":
      return {
        prefix: "",
        conflict: `ON CONFLICT(account_id, month_end_date) DO UPDATE SET
            total_value = excluded.total_value,
            source = excluded.source,
            starting_value = excluded.starting_value,
            mark_to_market = excluded.mark_to_market,
            deposits_withdrawals = excluded.deposits_withdrawals,
            dividends = excluded.dividends,
            interest = excluded.interest,
            commissions = excluded.commissions,
            fees = excluded.fees,
            other_pnl = excluded.other_pnl,
            twr = excluded.twr,
            investment_gain = excluded.investment_gain,
            import_batch_id = excluded.import_batch_id
          WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')`,
      };
    default:
      // transactions, corporate_actions, raw_imports — idempotent by source_key
      // / collision index / batch ownership; OR IGNORE re-insert is safe.
      return { prefix: "OR IGNORE", conflict: "" };
  }
}

/** Build + run a parameterized INSERT that re-inserts one captured row. */
function insertCapturedRow(
  db: Database.Database,
  table: string,
  row: Row,
  spec: RestoreSpec,
): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  const sql = `INSERT ${spec.prefix} INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders}) ${spec.conflict}`;
  db.prepare(sql).run(...cols.map((c) => row[c] as never));
}

/**
 * Drop the autoincrement `id` from a captured CHILD row so restore never
 * re-inserts a verbatim PK. If an import lands BETWEEN undo and restore and a
 * freed id is in play, a verbatim id would either silently drop the row on an
 * OR-IGNORE table (partial restore counted as success) or ABORT the whole
 * transaction on an upsert table (PK conflict the natural-key ON CONFLICT
 * doesn't catch). Letting AUTOINCREMENT assign a fresh id is safe: the derived
 * layer is recomputed and every downstream key is natural (source_key,
 * account/security/date), never the child id. The FK to import_batches lives in
 * `import_batch_id`, which is preserved. Only the import_batches row itself
 * keeps its explicit id (its identity IS that id).
 */
function stripRowId(row: Row): Row {
  const { id: _id, ...rest } = row;
  void _id;
  return rest;
}

export interface RestoreResult {
  batchId: number;
  restored: Record<string, number>;
}

/**
 * Re-insert exactly the manifested rows. Verifies the checksum first (refuses
 * a tampered / truncated manifest). Inserts the import_batches parent row
 * first, then each source table with its authority-preserving conflict guard,
 * all in one transaction. Finally regenerates the derived layer (best-effort,
 * mirroring undoImport) so tax lots + valuations are consistent again.
 */
export function restoreImportBatch(db: Database.Database, manifest: RecoveryManifest): RestoreResult {
  if (!verifyManifest(manifest)) {
    throw new Error(
      `Refusing to restore import batch ${manifest.batchId}: manifest checksum does not validate (file corrupt or tampered)`,
    );
  }

  // The import_batches row keeps its explicit id (its identity IS that id, and
  // every child row's import_batch_id points at it). If that id is now occupied
  // by a DIFFERENT batch (a freed id reused since the undo), restoring would
  // silently re-parent the manifested children under the wrong batch — refuse
  // hard rather than corrupt provenance.
  const m = manifest.payload.importBatch;
  const existingBatch = db
    .prepare("SELECT source_type, filename, created_at FROM import_batches WHERE id = ?")
    .get(manifest.batchId) as { source_type: unknown; filename: unknown; created_at: unknown } | undefined;
  if (existingBatch) {
    const sameBatch =
      existingBatch.source_type === m.source_type &&
      (existingBatch.filename ?? null) === (m.filename ?? null) &&
      existingBatch.created_at === m.created_at;
    if (!sameBatch) {
      throw new Error(
        `Refusing to restore import batch ${manifest.batchId}: that id is occupied by a different batch (${String(existingBatch.source_type)}). Recover the conflicting batch's id first.`,
      );
    }
  }

  const restored: Record<string, number> = {};
  db.transaction(() => {
    // Parent metadata row first (children FK-reference it), keeping its id.
    // OR IGNORE so a double-restore (same batch) is a no-op rather than a PK
    // violation — a DIFFERENT batch on that id was already refused above.
    insertCapturedRow(db, "import_batches", m, { prefix: "OR IGNORE", conflict: "" });
    restored.import_batches = 1;

    for (const table of RECOVERY_SOURCE_TABLES) {
      const spec = restoreSpec(table);
      let n = 0;
      for (const row of manifest.payload.tables[table]) {
        // Strip the child id so AUTOINCREMENT assigns a fresh one (see
        // stripRowId) — the FK import_batch_id is preserved inside the row.
        insertCapturedRow(db, table, stripRowId(row), spec);
        n++;
      }
      restored[table] = n;
    }
  })();

  // Regenerate the derived cache from the now-restored source rows. Best-effort
  // (matches undoImport): a recompute failure must not undo the restore.
  try {
    computeTaxLots(db);
  } catch (err) {
    console.error("[restore] Tax lot recompute failed:", err instanceof Error ? err.message : err);
  }
  try {
    computeDailyValuations(db);
  } catch (err) {
    console.error("[restore] Valuation recompute failed:", err instanceof Error ? err.message : err);
  }

  return { batchId: manifest.batchId, restored };
}

// ── Undo with recovery (write manifest, THEN destructive delete) ──────

export interface UndoWithRecoveryOptions {
  manifestDir?: string;
  retention?: number;
}

/**
 * Defense-in-depth wrapper around undoImport: writes a complete recovery
 * manifest to disk BEFORE the destructive delete, so the batch is always
 * recoverable via restoreImportBatch. Throws if the batch does not exist
 * (caller maps to 404).
 */
export function undoImportWithRecovery(
  db: Database.Database,
  batchId: number,
  opts: UndoWithRecoveryOptions = {},
): { manifestPath: string } {
  const manifest = buildRecoveryManifest(db, batchId); // throws if batch missing
  const manifestPath = writeRecoveryManifest(manifest, opts.manifestDir ?? DEFAULT_MANIFEST_DIR, opts.retention ?? DEFAULT_MANIFEST_RETENTION);
  undoImport(db, batchId);
  return { manifestPath };
}
