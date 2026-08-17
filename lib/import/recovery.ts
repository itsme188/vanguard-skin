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
import { ARTIFACT_NOTE_SUFFIX } from "@/lib/mutations/donation-links";

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

// v2 (Task 6, donation tracking): the manifest additionally captures a
// batch's `donations` rows plus RELATION rows for their links/lots.
// Donations are batch-owned (donations.import_batch_id), so they slot in
// alongside the source tables above — but donation_leg_links/donation_lots
// are NOT batch-owned (they carry no import_batch_id of their own; the
// referenced OUT/artifact/acquisition transaction routinely belongs to a
// DIFFERENT batch entirely). A verbatim id-based capture would dangle the
// moment restore reassigns fresh child ids (see stripRowId below) — so
// relations are captured RELATION-BASED instead: serialized with the STABLE
// source_key of the transaction and donation they reference, and remapped
// back to real ids at restore time via source_key lookups. v1 manifest files
// on disk predate this and simply lack these three payload keys — readers
// must treat their absence as empty, never throw.
export const MANIFEST_VERSION = 2;
export const DEFAULT_MANIFEST_DIR = join(process.cwd(), "data", "undo-recovery");
export const DEFAULT_MANIFEST_RETENTION = 25;

type Row = Record<string, unknown>;

/** A captured donation_leg_links or donation_lots row, minus its own `id`
 *  (autoincrement — never restored verbatim, see stripRowId), plus the
 *  stable source_key identities of the two rows it references. Restore
 *  remaps to real ids via these two keys — never the row's own (stale)
 *  donation_id / transaction_id / acquisition_transaction_id columns, which
 *  are still present in the row for debugging but must not be trusted. */
export type DonationRelationRow = Row & {
  transaction_source_key: string;
  donation_source_key: string;
};

export interface RecoveryPayload {
  importBatch: Row;
  tables: Record<RecoverySourceTable, Row[]>;
  donations: Row[];
  donationLinkRelations: DonationRelationRow[];
  donationLotRelations: DonationRelationRow[];
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

  // Donations owned by this batch (batch-owned, like the tables above).
  const donations = (
    db.prepare("SELECT * FROM donations WHERE import_batch_id = ? ORDER BY id").all(batchId) as Row[]
  ).map(stripRowId);

  // Their links/lots, relation-based (see the DonationRelationRow doc comment
  // above): joined to the CURRENT transaction/donation rows to capture the
  // stable source_key each side resolves to, since the referenced
  // transaction routinely belongs to a different batch than this one.
  const donationLinkRelations = (
    db
      .prepare(
        `SELECT l.*, t.source_key AS transaction_source_key, d.source_key AS donation_source_key
         FROM donation_leg_links l
         JOIN transactions t ON t.id = l.transaction_id
         JOIN donations d ON d.id = l.donation_id
         WHERE d.import_batch_id = ?
         ORDER BY l.id`
      )
      .all(batchId) as DonationRelationRow[]
  ).map(stripRowId) as DonationRelationRow[];

  const donationLotRelations = (
    db
      .prepare(
        `SELECT dl.*, t.source_key AS transaction_source_key, d.source_key AS donation_source_key
         FROM donation_lots dl
         JOIN transactions t ON t.id = dl.acquisition_transaction_id
         JOIN donations d ON d.id = dl.donation_id
         WHERE d.import_batch_id = ?
         ORDER BY dl.id`
      )
      .all(batchId) as DonationRelationRow[]
  ).map(stripRowId) as DonationRelationRow[];

  const payload: RecoveryPayload = {
    importBatch,
    tables,
    donations,
    donationLinkRelations,
    donationLotRelations,
  };
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

/**
 * Reads a manifest file verbatim (no field defaulting here — see below for
 * why). Accepts v1 files: their JSON simply predates `donations` /
 * `donationLinkRelations` / `donationLotRelations`, so those three keys come
 * back `undefined` on the parsed object. Deliberately NOT backfilled to `[]`
 * here: `verifyManifest`/`computeManifestChecksum` hash the payload object
 * exactly as read, and a v1 file's stored checksum was computed BEFORE these
 * keys existed — injecting them here would make every legitimate v1
 * checksum fail to validate. Consumers (restoreImportBatch) default with
 * `?? []` at the point of use, AFTER the checksum check has already passed
 * on the untouched payload.
 */
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
 * Re-applies the routing_artifact demotion (is_external_flow=0 + the
 * ARTIFACT_NOTE_SUFFIX note) that linkDonationLegs originally performed.
 * Reversible-provenance symmetry (spec §9): undo reverted this flag/note
 * because the link was dying; restore resurrects the link, so the demotion
 * must resurrect with it — link state and flow flag must never disagree.
 * Idempotent: a note that already carries the suffix (a double-restore, or a
 * relation whose transaction was somehow never un-demoted) is left alone
 * rather than double-appended.
 */
function demoteArtifactLeg(db: Database.Database, transactionId: number): void {
  const txn = db.prepare("SELECT notes FROM transactions WHERE id = ?").get(transactionId) as
    | { notes: string | null }
    | undefined;
  if (!txn) return; // defensive — the caller only reaches here after confirming the row exists
  const suffixAlone = ARTIFACT_NOTE_SUFFIX.trim();
  const alreadySuffixed = txn.notes != null && (txn.notes === suffixAlone || txn.notes.endsWith(ARTIFACT_NOTE_SUFFIX));
  const notes = alreadySuffixed ? txn.notes : ((txn.notes ?? "") + ARTIFACT_NOTE_SUFFIX).trim();
  db.prepare("UPDATE transactions SET is_external_flow = 0, notes = ? WHERE id = ?").run(notes, transactionId);
}

/**
 * Restores one donation relation table (donation_leg_links or
 * donation_lots). Each captured relation row was serialized (see
 * DonationRelationRow) with the STABLE source_key of the transaction and
 * donation it references, rather than their (stale, restore-reassigned)
 * ids — this remaps both back to real ids via those keys. A relation whose
 * transaction_source_key isn't found is the expected cross-batch case: that
 * transaction's own batch was never part of this restore (or was itself
 * restored under a different flow). Per the design doc, that's a skip with
 * a warning, never a synthesized row and never a thrown error — one
 * dangling relation must not abort restoring everything else.
 */
function restoreDonationRelations(
  db: Database.Database,
  table: "donation_leg_links" | "donation_lots",
  transactionColumn: "transaction_id" | "acquisition_transaction_id",
  extraColumns: string[],
  relations: DonationRelationRow[],
): number {
  const findTransactionId = db.prepare("SELECT id FROM transactions WHERE source_key = ?");
  const findDonationId = db.prepare("SELECT id FROM donations WHERE source_key = ?");
  let n = 0;
  for (const rel of relations) {
    const txn = findTransactionId.get(rel.transaction_source_key) as { id: number } | undefined;
    const donation = findDonationId.get(rel.donation_source_key) as { id: number } | undefined;
    if (!txn || !donation) {
      console.warn(
        `[restore] Skipping ${table} relation for donation ${rel.donation_source_key}: ` +
          `${!donation ? `donation source_key ${rel.donation_source_key}` : `transaction source_key ${rel.transaction_source_key}`} ` +
          `not found in the restored database (cross-batch row not present)`,
      );
      continue;
    }
    const cols = ["donation_id", transactionColumn, ...extraColumns];
    const placeholders = cols.map(() => "?").join(", ");
    const values: unknown[] = [donation.id, txn.id, ...extraColumns.map((c) => rel[c])];
    db.prepare(
      `INSERT OR IGNORE INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    ).run(...(values as never[]));
    n++;

    // A restored routing_artifact leg must resurrect its demotion — see
    // demoteArtifactLeg's doc comment. donation_lots relations have no
    // "role" concept, so this only ever fires for donation_leg_links.
    if (table === "donation_leg_links" && rel.role === "routing_artifact") {
      demoteArtifactLeg(db, txn.id);
    }
  }
  return n;
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

    // Donations owned by this batch, then their links/lots (v2 payload — see
    // MANIFEST_VERSION doc comment). A v1 manifest simply has these three
    // keys absent from its payload; `?? []` treats that as nothing to
    // restore rather than throwing. source_key is UNIQUE on donations, so OR
    // IGNORE makes a double-restore of the same batch a no-op, matching
    // every other table here.
    let donationsRestored = 0;
    for (const row of manifest.payload.donations ?? []) {
      insertCapturedRow(db, "donations", row, { prefix: "OR IGNORE", conflict: "" });
      donationsRestored++;
    }
    restored.donations = donationsRestored;

    restored.donation_leg_links = restoreDonationRelations(
      db,
      "donation_leg_links",
      "transaction_id",
      ["role", "created_at"],
      manifest.payload.donationLinkRelations ?? [],
    );
    restored.donation_lots = restoreDonationRelations(
      db,
      "donation_lots",
      "acquisition_transaction_id",
      ["quantity", "created_at"],
      manifest.payload.donationLotRelations ?? [],
    );
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
