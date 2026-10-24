/**
 * Ghost securities — rows in `securities` that nothing points at any more.
 *
 * An import creates the securities its rows name; undoing the import deleted
 * the rows but left the securities, searchable forever with no way to remove
 * them (2026-10-24 QA). `deleteImportBatch` now calls `removeGhostSecurities`
 * for the securities the batch's own rows pointed at, and the repair script
 * (`scripts/repair-ghost-securities.ts`) uses the same reader for the ones
 * already stranded.
 *
 * What anchors a security: every table with a foreign key onto `securities`,
 * read from the schema at run time so a new table is covered without an edit
 * here — EXCEPT the derived tables below, which hold figures computed FROM a
 * security (classification, beta, quote cache, narrative, regression) and
 * can never be the reason it exists. Their rows go with the ghost.
 */
import type Database from "better-sqlite3";

/** Derived from a security, never a reason to keep one. */
const DERIVED_TABLES = new Set([
  "security_factors",
  "security_betas",
  "security_quotes",
  "suggested_level_narratives",
  "security_regressions",
]);

interface FkRef {
  table: string;
  column: string;
}

function referencesToSecurities(db: Database.Database): FkRef[] {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  const refs: FkRef[] = [];
  for (const table of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${table.replace(/"/g, '""')}")`).all() as Array<{
      table: string;
      from: string;
    }>;
    for (const fk of fks) {
      if (fk.table === "securities") refs.push({ table, column: fk.from });
    }
  }
  return refs;
}

export interface GhostSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
}

/**
 * Securities no anchoring table points at. With `candidateIds` the search is
 * limited to those ids (the undo path); without it every security is checked
 * (the repair script).
 */
export function findGhostSecurities(
  db: Database.Database,
  candidateIds?: readonly number[],
): GhostSecurity[] {
  if (candidateIds !== undefined && candidateIds.length === 0) return [];
  const anchors = referencesToSecurities(db).filter((r) => !DERIVED_TABLES.has(r.table));
  const notAnchored = anchors
    .map((r) => `NOT EXISTS (SELECT 1 FROM "${r.table}" x WHERE x."${r.column}" = s.id)`)
    .join("\n           AND ");
  const scope =
    candidateIds === undefined
      ? ""
      : `AND s.id IN (${candidateIds.map(() => "?").join(",")})`;
  return db
    .prepare(
      `SELECT s.id, s.symbol, s.name, s.security_type
         FROM securities s
        WHERE ${notAnchored || "1 = 1"}
          ${scope}
        ORDER BY s.id ASC`,
    )
    .all(...(candidateIds ?? [])) as GhostSecurity[];
}

/**
 * Delete the ghosts among `candidateIds` (derived rows first, so a NO ACTION
 * foreign key cannot refuse). Returns the rows removed. Runs inside the
 * caller's transaction when there is one.
 */
export function removeGhostSecurities(
  db: Database.Database,
  candidateIds: readonly number[],
): GhostSecurity[] {
  const ghosts = findGhostSecurities(db, candidateIds);
  if (ghosts.length === 0) return ghosts;
  const derived = referencesToSecurities(db).filter((r) => DERIVED_TABLES.has(r.table));
  const del = db.prepare(`DELETE FROM securities WHERE id = ?`);
  for (const g of ghosts) {
    for (const r of derived) {
      db.prepare(`DELETE FROM "${r.table}" WHERE "${r.column}" = ?`).run(g.id);
    }
    del.run(g.id);
  }
  return ghosts;
}

/**
 * The securities a batch's own rows point at, read BEFORE the rows go — only
 * the row kinds whose import CREATES a security (transactions, holdings,
 * prices, donations go through upsertSecurity). A corporate-action import
 * never creates one ("import the trades/holdings that establish it first"),
 * so a security it merely references is not a candidate: undoing a split
 * file must leave the name in place for the re-import.
 */
export function securitiesTouchedByBatch(db: Database.Database, batchId: number): number[] {
  const rows = db
    .prepare(
      `SELECT security_id AS id FROM transactions WHERE import_batch_id = ? AND security_id IS NOT NULL
       UNION SELECT security_id FROM holdings WHERE import_batch_id = ? AND security_id IS NOT NULL
       UNION SELECT security_id FROM prices WHERE import_batch_id = ? AND security_id IS NOT NULL
       UNION SELECT security_id FROM donations WHERE import_batch_id = ? AND security_id IS NOT NULL`,
    )
    .all(batchId, batchId, batchId, batchId) as { id: number }[];
  return rows.map((r) => r.id);
}
