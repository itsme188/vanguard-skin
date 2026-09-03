// All DB reads/writes for the live print-watch subsystem (spec 2026-08-20
// §5, migration 085). Every function takes `db` first (DI for tests).

import type Database from "better-sqlite3";
import { reconcile } from "./reconcile";
import type {
  PrintWatchState,
  PrintWatchDocKind,
  PrintWatchLine,
  LineContract,
  LineStateKind,
  PrintRow,
  DocumentRow,
  TaggedCandidate,
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

/**
 * Prints whose window has closed but whose event is still TODAY.
 *
 * Deliberately separate from `listActivePrints` rather than folded into it:
 * `ensurePrintWatch`'s stale-print pass iterates the active list and treats
 * every row it finds without an armed flag as a disarm/expire candidate —
 * widening that query would drag expired rows back through the state machine
 * on every sweep. The panel, on the other hand, must keep showing today's
 * expired prints: the release landed, the window merely ran out, and the drop
 * zone is exactly the recovery road for "the wire missed it, here's the file".
 */
export function listTodaysExpiredPrints(db: Database.Database, todayEt: string): PrintRow[] {
  return db
    .prepare(
      `SELECT * FROM print_watch_prints
       WHERE state = 'expired' AND event_date = ?
       ORDER BY event_date, id`,
    )
    .all(todayEt) as PrintRow[];
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

/**
 * Locks a line to ONE named candidate — the per-candidate accept the desk
 * uses to resolve a conflict row ("this figure, from this document").
 *
 * `markLineAccepted` flips state and keeps whatever the reconciler last
 * wrote; that is useless on a 'conflict' line, which by definition carries no
 * top-level number. Here the caller has picked a specific candidate out of
 * `candidates_json`, so its value / snippet / document become the line's
 * verified reading. `candidates_json` is deliberately NOT touched: the rivals
 * stay on the sheet as the audit trail of what was rejected.
 *
 * `source_doc_id` is a real FK to print_watch_documents(id) — the caller must
 * pass a document that exists (the accept route checks) or null.
 */
export function acceptLineCandidate(
  db: Database.Database,
  printId: number,
  metricId: string,
  chosen: {
    value: number | null;
    value_high: number | null;
    snippet: string | null;
    source_doc_id: number | null;
  },
): void {
  db.prepare(
    `UPDATE print_watch_lines
        SET state = 'accepted',
            value = ?,
            value_high = ?,
            snippet = ?,
            source_doc_id = ?,
            updated_at = datetime('now')
      WHERE print_id = ? AND metric_id = ?`,
  ).run(
    chosen.value,
    chosen.value_high,
    chosen.snippet,
    chosen.source_doc_id,
    printId,
    metricId,
  );
}

/**
 * The flash sentinel doc id (parity with watcher.ts's own constant): flash
 * candidates come off the wire with no document, and `source_doc_id` is a real
 * FK — 0 is not a row, so it is nulled before any write.
 */
const FLASH_DOC_ID = 0;

/**
 * A doc id fit to be written into `source_doc_id`, or null.
 *
 * `source_doc_id` is a real FK, so anything the reconciler hands back has to
 * name a row that exists: the flash sentinel (0) never does, and neither would
 * a candidate whose document row was never written (a legacy sheet, hand-built
 * evidence). Nulling those keeps an un-accept CLICK from turning into a
 * foreign-key exception — the line simply reports no document of record.
 */
function resolveSourceDocId(db: Database.Database, docId: number | null): number | null {
  if (docId === null || docId === FLASH_DOC_ID) return null;
  const row = db.prepare(`SELECT 1 AS ok FROM print_watch_documents WHERE id = ?`).get(docId) as
    | { ok: number }
    | undefined;
  return row ? docId : null;
}

/**
 * Un-accept — RELEASE THE LOCK AND RE-DERIVE THE LINE (QA finding
 * `today-print-watch--unaccept-after-supersede-keeps-old-value-hides-newer-
 * candidate`, HIGH; user ruling 2026-09-02 option 1).
 *
 * This used to be a one-column UPDATE (state → 'pending') on the theory that
 * "the next reconcile will recompute it" (Codex #15). It never did: reconcile
 * runs when a DOCUMENT arrives, and the whole reason to un-accept is that the
 * last document already arrived and disagreed. So the line sat on 'pending'
 * still rendering the superseded document's value, value_high, snippet and
 * source_doc_id — with the newer, disagreeing figure invisible inside
 * `candidates_json` — and the only control left ('accept') re-locked the stale
 * number. On a sheet whose figures get promoted into the recap scoreboard,
 * that is a money-critical lie.
 *
 * Un-accept now re-runs the SAME pure reconciler the watcher uses over this
 * line's own candidate pool (rules 1-5; `acceptedLines` empty, because the
 * point is to stop treating this line as accepted):
 *   - unanimous pool with an independent pair  → 'agreed', number intact
 *   - unanimous pool without one, or a single candidate → 'single_source'
 *   - ANY value disagreement → 'conflict': the stale number is cleared and
 *     every rival stays visible in `candidates_json` for the desk to pick
 *     from (per-candidate accept, POST /api/print-watch/accept).
 *
 * THREE deliberate carve-outs:
 *   - EMPTY pool → the old behaviour (state 'pending', number left in place).
 *     There is nothing to re-derive from, and wiping the figure would make an
 *     accidental un-accept unrecoverable: the accept route only re-admits a
 *     'pending' line that still carries a value (the recovery path from QA
 *     finding `…unaccept-one-way-no-per-line-accept…`).
 *   - `contract_json`'s `metric_id` doesn't match this row's own `metric_id`
 *     (a drifted/corrupted contract) → same fallback. `reconcile()` buckets
 *     candidates by their OWN metric_id and looks the bucket up by
 *     `contract.metric_id`; a mismatch finds nothing and resolves to an EMPTY
 *     pool (`state: 'pending', value: null`) even when real evidence for THIS
 *     metric is sitting right there under a different key in the same
 *     `candidates_json` — writing that would clear a verified figure on a
 *     bug in a DIFFERENT column, so this is checked BEFORE calling
 *     `reconcile()` at all.
 *   - `reconcile()` itself lands on `{state: 'pending', value: null}` for any
 *     other reason (belt-and-braces for the same empty-pool outcome reached a
 *     different way) → same fallback, checked AFTER the call.
 *   - `candidates_json` is never rewritten. Evidence is append-only; the
 *     reconciler's sign guard drops candidates from its own working set, and
 *     persisting that filtered set here would silently delete evidence.
 */
export function clearLineAccepted(db: Database.Database, printId: number, metricId: string): void {
  const releaseOnly = db.prepare(
    `UPDATE print_watch_lines SET state = 'pending', updated_at = datetime('now')
     WHERE print_id = ? AND metric_id = ? AND state = 'accepted'`,
  );

  // ONE transaction: the read that decides the new state and the write that
  // applies it must not straddle another writer. Nested inside the accept
  // route's own transaction this degrades to a SAVEPOINT, so a later refusal
  // in that request still rolls this back.
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT contract_json, candidates_json FROM print_watch_lines
          WHERE print_id = ? AND metric_id = ? AND state = 'accepted'`,
      )
      .get(printId, metricId) as { contract_json: string; candidates_json: string } | undefined;
    if (!row) return; // not accepted — same no-op as before

    let candidates: TaggedCandidate[] = [];
    let contract: LineContract | null = null;
    try {
      const parsed: unknown = JSON.parse(row.candidates_json);
      if (Array.isArray(parsed)) candidates = parsed as TaggedCandidate[];
      contract = JSON.parse(row.contract_json) as LineContract;
    } catch {
      // Unreadable JSON costs this line its re-derivation, never the unaccept:
      // fall through to the plain release so the desk is not stuck accepted.
      candidates = [];
      contract = null;
    }

    if (candidates.length === 0 || contract === null || contract.metric_id !== metricId) {
      releaseOnly.run(printId, metricId);
      return;
    }

    const [rederived] = reconcile([contract], {}, candidates, []);
    if (!rederived || (rederived.state === "pending" && rederived.value === null)) {
      releaseOnly.run(printId, metricId);
      return;
    }

    db.prepare(
      `UPDATE print_watch_lines
          SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?,
              updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    ).run(
      rederived.state,
      rederived.value,
      rederived.value_high,
      rederived.snippet,
      resolveSourceDocId(db, rederived.source_doc_id),
      printId,
      metricId,
    );
  });

  tx();
}

interface WatcherLeaseValue {
  holder: string;
  expiresAt: number;
}

/**
 * settings-table row 'print_watch_lease' = JSON {holder, expiresAt}; true when
 * acquired/renewed; stale (expired) leases are taken over (Codex #7).
 *
 * COMPARE-AND-SWAP, not read-then-write (fix wave, finding D). The lease is
 * the ONE thing standing between the always-on Electron server and a launchd
 * sweep tick polling the SEC and the DJ wire in parallel — and the old
 * SELECT-then-`INSERT OR REPLACE` pair could not enforce that across
 * processes: two callers could both read an expired lease, both decide they
 * had won, and both write, leaving the loser's stale value on top of the
 * winner's. Ownership is now decided by ONE statement and its `changes` count:
 *
 *   - `INSERT OR IGNORE` seeds the row. A non-zero `changes` means no lease
 *     existed and this caller created it — an outright win, no race possible.
 *   - Otherwise the `UPDATE` takes the lease only where the stored row still
 *     says it is takeable (we already hold it, it has expired, or the value is
 *     unreadable). SQLite evaluates that predicate against the row it locks,
 *     so a caller whose read happened before the winner's write simply matches
 *     nothing and is told it lost, instead of clobbering.
 *
 * `json_valid` guards the corrupt-value case the same way the old JSON.parse
 * try/catch did (an unparseable lease is takeable), and it short-circuits
 * before json_extract, which would otherwise raise on malformed JSON.
 */
export function acquireWatcherLease(
  db: Database.Database,
  holder: string,
  nowMs: number,
  ttlMs: number,
): boolean {
  const value = JSON.stringify({ holder, expiresAt: nowMs + ttlMs } satisfies WatcherLeaseValue);

  const seeded = db
    .prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(LEASE_SETTINGS_KEY, value);
  if (seeded.changes > 0) return true;

  const swapped = db
    .prepare(
      `UPDATE settings
          SET value = ?, updated_at = datetime('now')
        WHERE key = ?
          AND (
            json_valid(value) = 0
            OR json_extract(value, '$.holder') = ?
            OR json_extract(value, '$.expiresAt') IS NULL
            OR CAST(json_extract(value, '$.expiresAt') AS INTEGER) <= ?
          )`,
    )
    .run(value, LEASE_SETTINGS_KEY, holder, nowMs);

  return swapped.changes > 0;
}
