// All DB reads/writes for the live print-watch subsystem (spec 2026-08-20
// §5, migration 085). Every function takes `db` first (DI for tests).

import type Database from "better-sqlite3";
import type {
  PrintWatchState,
  PrintWatchDocKind,
  PrintWatchLine,
  LineStateKind,
  PrintRow,
  DocumentRow,
} from "./types";

const LEASE_SETTINGS_KEY = "print_watch_lease";

export function upsertPrint(
  db: Database.Database,
  eventId: number,
  symbol: string,
  eventDate: string,
  releaseTimeEt: string | null,
): number {
  db.prepare(
    `INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       symbol = excluded.symbol,
       event_date = excluded.event_date,
       release_time_et = excluded.release_time_et,
       updated_at = datetime('now')`,
  ).run(eventId, symbol, eventDate, releaseTimeEt);

  const row = db
    .prepare(`SELECT id FROM print_watch_prints WHERE event_id = ?`)
    .get(eventId) as { id: number };
  return row.id;
}

export function setPrintState(db: Database.Database, printId: number, state: PrintWatchState): void {
  db.prepare(
    `UPDATE print_watch_prints SET state = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(state, printId);
}

export function getPrintByEventId(db: Database.Database, eventId: number): PrintRow | null {
  const row = db
    .prepare(`SELECT * FROM print_watch_prints WHERE event_id = ?`)
    .get(eventId) as PrintRow | undefined;
  return row ?? null;
}

export function listActivePrints(db: Database.Database): PrintRow[] {
  return db
    .prepare(
      `SELECT * FROM print_watch_prints
       WHERE state IN ('scheduled','window_open','acquired','parsed')
       ORDER BY event_date, id`,
    )
    .all() as PrintRow[];
}

export function insertDocument(
  db: Database.Database,
  printId: number,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  sha256: string,
  bytesPath: string,
): { id: number; isNew: boolean } {
  // SELECT-then-INSERT is non-atomic (a race could double-insert between the
  // two statements), but every writer to this table runs under the single
  // watcher lease (acquireWatcherLease) — no concurrent caller exists in v1,
  // so the UNIQUE(print_id, kind, sha256) constraint is a backstop, not the
  // primary dedupe path.
  const existing = db
    .prepare(
      `SELECT id FROM print_watch_documents WHERE print_id = ? AND kind = ? AND sha256 = ?`,
    )
    .get(printId, kind, sha256) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };

  const result = db
    .prepare(
      `INSERT INTO print_watch_documents (print_id, kind, source, url, sha256, bytes_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(printId, kind, source, url, sha256, bytesPath);
  return { id: Number(result.lastInsertRowid), isNew: true };
}

export function markDocumentParsed(db: Database.Database, docId: number): void {
  db.prepare(`UPDATE print_watch_documents SET parsed_at = datetime('now') WHERE id = ?`).run(docId);
}

export function listUnparsedDocuments(db: Database.Database, printId: number): DocumentRow[] {
  return db
    .prepare(
      `SELECT * FROM print_watch_documents WHERE print_id = ? AND parsed_at IS NULL ORDER BY id`,
    )
    .all(printId) as DocumentRow[];
}

export function listDocuments(db: Database.Database, printId: number): DocumentRow[] {
  return db
    .prepare(`SELECT * FROM print_watch_documents WHERE print_id = ? ORDER BY id`)
    .all(printId) as DocumentRow[];
}

/** NEVER downgrades 'accepted': an accepted row refreshes candidates_json
 *  ONLY — every other column (contract_json, expected_json, state, value,
 *  value_high, snippet, source_doc_id) stays locked to what the user
 *  accepted until clearLineAccepted() releases the lock. This is
 *  defense-in-depth for Task 5's reconciler, which is expected to skip
 *  accepted lines itself — the store enforces the invariant either way. */
export function upsertLines(db: Database.Database, printId: number, lines: PrintWatchLine[]): void {
  const upsert = db.prepare(
    `INSERT INTO print_watch_lines
       (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, updated_at)
     VALUES (@print_id, @metric_id, @contract_json, @expected_json, @state, @value, @value_high, @snippet, @source_doc_id, @candidates_json, datetime('now'))
     ON CONFLICT(print_id, metric_id) DO UPDATE SET
       contract_json = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.contract_json ELSE excluded.contract_json END,
       expected_json = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.expected_json ELSE excluded.expected_json END,
       candidates_json = excluded.candidates_json,
       state = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.state ELSE excluded.state END,
       value = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.value ELSE excluded.value END,
       value_high = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.value_high ELSE excluded.value_high END,
       snippet = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.snippet ELSE excluded.snippet END,
       source_doc_id = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.source_doc_id ELSE excluded.source_doc_id END,
       updated_at = datetime('now')`,
  );

  const tx = db.transaction((rows: PrintWatchLine[]) => {
    for (const line of rows) {
      upsert.run({
        print_id: printId,
        metric_id: line.metric_id,
        contract_json: JSON.stringify(line.contract),
        expected_json: line.expected ? JSON.stringify(line.expected) : null,
        state: line.state,
        value: line.value,
        value_high: line.value_high,
        snippet: line.snippet,
        source_doc_id: line.source_doc_id,
        candidates_json: line.candidates_json,
      });
    }
  });
  tx(lines);
}

export function getSheet(db: Database.Database, printId: number): PrintWatchLine[] {
  const rows = db
    .prepare(`SELECT * FROM print_watch_lines WHERE print_id = ? ORDER BY metric_id`)
    .all(printId) as Array<{
    metric_id: string;
    contract_json: string;
    expected_json: string | null;
    state: string;
    value: number | null;
    value_high: number | null;
    snippet: string | null;
    source_doc_id: number | null;
    candidates_json: string;
  }>;

  return rows.map((r) => ({
    metric_id: r.metric_id,
    contract: JSON.parse(r.contract_json),
    expected: r.expected_json ? JSON.parse(r.expected_json) : null,
    state: r.state as LineStateKind,
    value: r.value,
    value_high: r.value_high,
    snippet: r.snippet,
    source_doc_id: r.source_doc_id,
    candidates_json: r.candidates_json,
  }));
}

export function markLineAccepted(db: Database.Database, printId: number, metricId: string): void {
  db.prepare(
    `UPDATE print_watch_lines SET state = 'accepted', updated_at = datetime('now')
     WHERE print_id = ? AND metric_id = ?`,
  ).run(printId, metricId);
}

/** Unaccept → state recomputed by next reconcile (Codex #15): this only
 *  releases the accepted lock back to 'pending'; it does not itself
 *  recompute agreed/conflict/single_source — that is reconcile.ts's job
 *  (Task 5) the next time it upserts this line. */
export function clearLineAccepted(db: Database.Database, printId: number, metricId: string): void {
  db.prepare(
    `UPDATE print_watch_lines SET state = 'pending', updated_at = datetime('now')
     WHERE print_id = ? AND metric_id = ? AND state = 'accepted'`,
  ).run(printId, metricId);
}

interface WatcherLeaseValue {
  holder: string;
  expiresAt: number;
}

/** settings-table row 'print_watch_lease' = JSON {holder, expiresAt}; true
 *  when acquired/renewed; stale (expired) leases are taken over (Codex #7). */
export function acquireWatcherLease(
  db: Database.Database,
  holder: string,
  nowMs: number,
  ttlMs: number,
): boolean {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(LEASE_SETTINGS_KEY) as
    | { value: string }
    | undefined;

  if (row) {
    let lease: WatcherLeaseValue | null = null;
    try {
      lease = JSON.parse(row.value) as WatcherLeaseValue;
    } catch {
      lease = null;
    }
    if (lease && lease.holder !== holder && lease.expiresAt > nowMs) {
      return false; // held live by a different holder
    }
  }

  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(LEASE_SETTINGS_KEY, JSON.stringify({ holder, expiresAt: nowMs + ttlMs } satisfies WatcherLeaseValue));
  return true;
}
