// All DB reads/writes for the live print-watch subsystem (spec 2026-08-20
// §5, migration 085). Every function takes `db` first (DI for tests).

import type Database from "better-sqlite3";
import { reconcile } from "./reconcile";
import type {
  PrintWatchState,
  PrintWatchLine,
  LineContract,
  LineStateKind,
  PrintRow,
  DocumentRow,
  DocumentRoadRow,
  IrBaselineRow,
  PrintWatchSourceRow,
  TaggedCandidate,
  GoInputKind,
  GoRequestRow,
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
       (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, audit_json, updated_at)
     VALUES (@print_id, @metric_id, @contract_json, @expected_json, @state, @value, @value_high, @snippet, @source_doc_id, @candidates_json, @audit_json, datetime('now'))
     ON CONFLICT(print_id, metric_id) DO UPDATE SET
       contract_json = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.contract_json ELSE excluded.contract_json END,
       expected_json = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.expected_json ELSE excluded.expected_json END,
       candidates_json = excluded.candidates_json,
       state = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.state ELSE excluded.state END,
       value = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.value ELSE excluded.value END,
       value_high = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.value_high ELSE excluded.value_high END,
       snippet = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.snippet ELSE excluded.snippet END,
       source_doc_id = CASE WHEN print_watch_lines.state = 'accepted' THEN print_watch_lines.source_doc_id ELSE excluded.source_doc_id END,
       audit_json = COALESCE(excluded.audit_json, print_watch_lines.audit_json),
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
        // undefined/null from the caller means "not supplied": the COALESCE in
        // the conflict clause keeps whatever trail the row already carries.
        audit_json: line.audit_json ?? null,
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
    audit_json: string | null;
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
    audit_json: r.audit_json,
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
 *
 * EXPORTED (R-B8 fix round 1): evidence retraction re-derives lines the same
 * way un-accept does and hits the same hazard — migration 089 deliberately
 * PRESERVES candidates whose `doc_id` names no document row, so `reconcile()`
 * can hand back a dangling id. Both callers must resolve through this one
 * function; a second copy is how the two paths drift apart.
 */
export function resolveSourceDocId(db: Database.Database, docId: number | null): number | null {
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

// ---------------------------------------------------------------------------
// documents (migration 089): content identity, per-road provenance, parse CAS
//
// Writes go through `recordDelivery` (lib/print-watch/delivery.ts) — the ONE
// transactional entry every road records through. What lives here is the read
// side plus the parse-claim compare-and-set, which is a pure row-state
// transition and has no business being inside the delivery transaction.
// ---------------------------------------------------------------------------

/** How long a parse claim may sit untouched before another worker may take it
 *  over. Long enough to cover a slow model call, short enough that a crashed
 *  worker does not strand a document for the whole print window. */
export const PARSE_CLAIM_STALE_MS = 5 * 60_000;

/**
 * Eligibility is CONTENT **and** ROAD (spec §4.2): the bytes must belong to
 * this event AND at least one road that delivered them must be trusted for
 * this event. A document accepted on content but delivered only by a road the
 * gate refused (a months-old IR newsroom post) is stored, visible, and never
 * parsed — until a road that does accept it delivers the same bytes.
 */
export const ELIGIBLE_SQL = `d.gate_verdict = 'accepted'
       AND EXISTS (SELECT 1 FROM print_watch_document_roads r WHERE r.document_id = d.id AND r.road_verdict = 'accepted')`;

/**
 * ONE definition of "eligible", asked about one document.
 *
 * Exported because four call sites ask the same question — the parse queue and
 * `hasParsableDocuments` (in SQL, above), `recordDelivery` before and after a
 * verdict, the watcher's post-model re-check and its stale-claim takeover, and
 * the event-merge re-verdict. Hand-rolled copies drifted apart once already
 * (the merge retracted on a content flip but not a road flip), so every one of
 * them now reads through this or through `ELIGIBLE_SQL` itself.
 */
export function isDocumentEligible(db: Database.Database, docId: number): boolean {
  return (
    db
      .prepare(`SELECT 1 AS one FROM print_watch_documents d WHERE d.id = ? AND ${ELIGIBLE_SQL} LIMIT 1`)
      .get(docId) !== undefined
  );
}

/** Documents this print may parse right now: content accepted, >=1 road accepted, state queued. */
export function listParseQueue(db: Database.Database, printId: number): DocumentRow[] {
  return db
    .prepare(
      `SELECT d.* FROM print_watch_documents d
        WHERE d.print_id = ? AND d.parse_state = 'queued' AND ${ELIGIBLE_SQL}
        ORDER BY d.id`,
    )
    .all(printId) as DocumentRow[];
}

/** Anything eligible that is not yet parsed or failed (queued OR claimed) —
 *  the "is there still work to do for this print?" question. A document held
 *  by another worker's live claim counts: the work exists, it is just not ours. */
export function hasParsableDocuments(db: Database.Database, printId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS one FROM print_watch_documents d
        WHERE d.print_id = ? AND d.parse_state IN ('queued','claimed') AND ${ELIGIBLE_SQL}
        LIMIT 1`,
    )
    .get(printId);
  return row !== undefined;
}

/**
 * Take ownership of a document's parse, compare-and-set.
 *
 * The claim IS the attempt (M15): `parse_attempts` increments HERE, durably,
 * so a crash mid-parse never resets the budget and a second process sees the
 * same count. One statement decides ownership — a caller whose read of the
 * row happened before the winner's write simply matches nothing and is told
 * it lost, rather than clobbering the winner (the same CAS shape as
 * `acquireWatcherLease`). A claim older than PARSE_CLAIM_STALE_MS is takeable.
 */
export function claimDocumentParse(
  db: Database.Database,
  docId: number,
  token: string,
  nowMs: number,
): boolean {
  const nowIso = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - PARSE_CLAIM_STALE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE print_watch_documents
          SET parse_state = 'claimed', parse_claim_token = ?, parse_claimed_at = ?,
              parse_attempts = parse_attempts + 1
        WHERE id = ?
          AND (parse_state = 'queued'
               OR (parse_state = 'claimed' AND datetime(parse_claimed_at) < datetime(?)))`,
    )
    .run(token, nowIso, docId, staleBefore);
  return r.changes > 0;
}

/**
 * Release a claim with an outcome. Guarded by the claim token: a worker whose
 * claim was taken over while it was still running finalises NOTHING (returns
 * false) instead of stamping its stale result over the live worker's.
 *
 * 'parsed' stamps `parsed_at` and clears the error; 'queued' returns the
 * document to the queue for another attempt; 'failed' retires it (only an
 * explicit user re-delivery re-queues it — see `recordDelivery`).
 */
export function finalizeDocumentParse(
  db: Database.Database,
  docId: number,
  token: string,
  state: "parsed" | "queued" | "failed",
  error: string | null = null,
): boolean {
  const r = db
    .prepare(
      `UPDATE print_watch_documents
          SET parse_state = ?, parse_claim_token = NULL, parse_claimed_at = NULL,
              parse_last_error = ?,
              parsed_at = CASE WHEN ? = 'parsed' THEN datetime('now') ELSE parsed_at END
        WHERE id = ? AND parse_claim_token = ?`,
    )
    .run(state, state === "parsed" ? null : error, state, docId, token);
  return r.changes > 0;
}

export function getDocument(db: Database.Database, docId: number): DocumentRow | null {
  return (
    (db.prepare(`SELECT * FROM print_watch_documents WHERE id = ?`).get(docId) as DocumentRow | undefined) ?? null
  );
}

export function listDocumentRoads(db: Database.Database, printId: number): DocumentRoadRow[] {
  return db
    .prepare(
      `SELECT r.* FROM print_watch_document_roads r
         JOIN print_watch_documents d ON d.id = r.document_id
        WHERE d.print_id = ? ORDER BY r.document_id, r.kind, r.source`,
    )
    .all(printId) as DocumentRoadRow[];
}

export function anyRoadAccepted(db: Database.Database, docId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS one FROM print_watch_document_roads WHERE document_id = ? AND road_verdict = 'accepted' LIMIT 1`,
      )
      .get(docId) !== undefined
  );
}

// ---------------------------------------------------------------------------
// per-symbol IR sources
// ---------------------------------------------------------------------------

export function upsertPrintWatchSource(
  db: Database.Database,
  input: { symbol: string; irPageUrl: string; linkMustContain: string | null },
): PrintWatchSourceRow {
  const symbol = input.symbol.trim().toUpperCase();
  db.prepare(
    `INSERT INTO print_watch_sources (symbol, ir_page_url, link_must_contain) VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       ir_page_url = excluded.ir_page_url,
       link_must_contain = excluded.link_must_contain,
       updated_at = datetime('now')`,
  ).run(symbol, input.irPageUrl, input.linkMustContain);
  return getPrintWatchSource(db, symbol)!;
}

export function getPrintWatchSource(db: Database.Database, symbol: string): PrintWatchSourceRow | null {
  return (
    (db.prepare(`SELECT * FROM print_watch_sources WHERE symbol = ?`).get(symbol.trim().toUpperCase()) as
      | PrintWatchSourceRow
      | undefined) ?? null
  );
}

export function deletePrintWatchSource(db: Database.Database, symbol: string): boolean {
  return db.prepare(`DELETE FROM print_watch_sources WHERE symbol = ?`).run(symbol.trim().toUpperCase()).changes > 0;
}

// ---------------------------------------------------------------------------
// IR-page seen links + baseline
// ---------------------------------------------------------------------------

export function listIrSeenLinks(
  db: Database.Database,
  eventId: number,
): Array<{ link: string; baseline: boolean }> {
  return (
    db.prepare(`SELECT link, baseline FROM print_watch_ir_seen WHERE event_id = ? ORDER BY link`).all(eventId) as {
      link: string;
      baseline: number;
    }[]
  ).map((r) => ({ link: r.link, baseline: r.baseline === 1 }));
}

/**
 * Record links as seen; returns how many were NEW.
 *
 * `ON CONFLICT(event_id, link) DO NOTHING` rather than `INSERT OR IGNORE`
 * ON PURPOSE: the only violation we want to swallow is "already seen". OR
 * IGNORE also swallows NOT NULL and CHECK failures, which would let a
 * malformed link vanish silently and — worse — let `recordIrBaseline` stamp a
 * COMPLETED marker over a baseline that never captured that link, so the
 * missing link would look like a new post forever after.
 */
export function recordIrSeenLinks(
  db: Database.Database,
  eventId: number,
  links: string[],
  baseline: boolean,
): number {
  const stmt = db.prepare(
    `INSERT INTO print_watch_ir_seen (event_id, link, baseline) VALUES (?, ?, ?)
     ON CONFLICT(event_id, link) DO NOTHING`,
  );
  let n = 0;
  for (const link of links) n += stmt.run(eventId, link, baseline ? 1 : 0).changes;
  return n;
}

/** ONE transaction for the links AND the completion marker (M5): a crash
 *  between them leaves no marker, so the baseline is re-taken rather than
 *  trusted half-done. */
export function recordIrBaseline(
  db: Database.Database,
  eventId: number,
  sourceFingerprint: string,
  links: string[],
): number {
  return db
    .transaction((): number => {
      const inserted = recordIrSeenLinks(db, eventId, links, true);
      db.prepare(
        `INSERT INTO print_watch_ir_baseline (event_id, source_fingerprint, link_count, completed_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(event_id) DO UPDATE SET
           source_fingerprint = excluded.source_fingerprint,
           link_count = excluded.link_count,
           completed_at = datetime('now')`,
      ).run(eventId, sourceFingerprint, links.length);
      return inserted;
    })
    .immediate();
}

export function getIrBaseline(db: Database.Database, eventId: number): IrBaselineRow | null {
  return (
    (db.prepare(`SELECT * FROM print_watch_ir_baseline WHERE event_id = ?`).get(eventId) as
      | IrBaselineRow
      | undefined) ?? null
  );
}

/**
 * True only when a COMPLETED baseline exists for THIS fingerprint — a changed
 * IR page URL is a new baseline, not a page full of new posts.
 *
 * The fingerprint is the stored page URL ALONE (`irBaselineFingerprint`), and
 * `link_must_contain` is deliberately NOT part of it: the match rule narrows
 * what we NOTICE on the page, it does not make last quarter's posts new. Were
 * it in the key, a desk edit to the filter mid-window would drift the
 * fingerprint, discard a live baseline, and re-baseline the page — marking
 * tonight's already-posted release "seen" and blinding the road for the night.
 */
export function hasIrBaseline(db: Database.Database, eventId: number, sourceFingerprint: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS one FROM print_watch_ir_baseline WHERE event_id = ? AND source_fingerprint = ? LIMIT 1`,
      )
      .get(eventId, sourceFingerprint) !== undefined
  );
}

// ---------------------------------------------------------------------------
// slice C (migration 090): forced window + go requests
//
// Timestamps on these columns are ISO-8601 UTC strings written by CODE
// (`toISOString()`), never `datetime('now')` text — the window arithmetic
// (extend, stale-claim math) happens in JS against `nowMs`. SQL comparisons
// against them use `datetime()` on BOTH sides (repo rule) so a stored ISO
// string and a `datetime(?)`-bound parameter compare as the same instant
// regardless of literal formatting.
// ---------------------------------------------------------------------------

// `GO_CLAIM_STALE_MS` is 60_000ms, but every staleness comparison below wraps
// both sides in SQLite's `datetime()`, which compares at ONE-SECOND
// resolution (fractional seconds are truncated away). The effective stale
// window is therefore 60-61s, not exactly 60s — a claim made at `t0` is not
// yet stale at `t0 + 60.999s` and is stale at `t0 + 61.000s`. Test fixtures
// against these predicates need >=1s margins, not millisecond ones (review
// finding #7 — this cost two test failures during Task 1's own TDD pass).
export const GO_CLAIM_STALE_MS = 60_000;
export const GO_MAX_ATTEMPTS = 3;

export function getPrintById(db: Database.Database, printId: number): PrintRow | null {
  const row = db.prepare(`SELECT * FROM print_watch_prints WHERE id = ?`).get(printId) as PrintRow | undefined;
  return row ?? null;
}

/** The FIRST go press stamps; every later press reads the stamp back (spec
 *  §9 ruling 2: "the first go stamps once … a repeat press never extends").
 *  Returns null for an unknown print id (never throws — review finding #3),
 *  so a caller can map it to a domain error instead of an opaque 500. */
export function stampForcedOpen(db: Database.Database, printId: number, nowIso: string): string | null {
  const updated = db
    .prepare(
      `UPDATE print_watch_prints SET forced_open_at = COALESCE(forced_open_at, ?), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(nowIso, printId);
  if (updated.changes === 0) return null; // no print with this id
  const row = db.prepare(`SELECT forced_open_at FROM print_watch_prints WHERE id = ?`).get(printId) as {
    forced_open_at: string;
  };
  return row.forced_open_at;
}

/** Writes `untilIso` verbatim — it does NOT enforce "an extension never
 *  lowers the end" (spec: every press writes `max(now, current end) + 30m`);
 *  that max() is the CALLER's obligation (review finding #4). A caller
 *  passing an earlier instant than the current `window_extended_until` will
 *  silently shorten a live window. */
export function extendPrintWindow(db: Database.Database, printId: number, untilIso: string): void {
  db.prepare(
    `UPDATE print_watch_prints SET window_extended_until = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(untilIso, printId);
}

export function insertGoRequest(
  db: Database.Database,
  req: {
    printId: number;
    inputKind: GoInputKind;
    inputUrl: string | null;
    inputSha256: string | null;
    inputBytesPath: string | null;
    requestedAt: string;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO print_watch_go_requests (print_id, status, requested_at, input_kind, input_url, input_sha256, input_bytes_path)
       VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
    )
    .run(req.printId, req.requestedAt, req.inputKind, req.inputUrl, req.inputSha256, req.inputBytesPath);
  return Number(r.lastInsertRowid);
}

export function getGoRequest(db: Database.Database, id: number): GoRequestRow | null {
  const row = db.prepare(`SELECT * FROM print_watch_go_requests WHERE id = ?`).get(id) as GoRequestRow | undefined;
  return row ?? null;
}

export function latestGoRequest(db: Database.Database, printId: number): GoRequestRow | null {
  const row = db
    .prepare(`SELECT * FROM print_watch_go_requests WHERE print_id = ? ORDER BY id DESC LIMIT 1`)
    .get(printId) as GoRequestRow | undefined;
  return row ?? null;
}

/** queued, or claimed with a stale claim, with attempts left. `datetime()` on
 *  both sides per the repo rule (Codex round 1 finding #6): the stored value
 *  is an ISO string written by code, not a `datetime('now')` text value, so a
 *  bare string compare against the bound stale-cutoff parameter would be
 *  comparing two different textual shapes rather than the same instant. */
const GO_TAKEABLE_SQL = `(status = 'queued' OR (status = 'claimed' AND datetime(claimed_at) < datetime(?))) AND attempts < ${GO_MAX_ATTEMPTS}`;

/** queued, or claimed with a stale claim, with attempts left — oldest first. */
export function listTakeableGoRequests(db: Database.Database, nowMs: number): GoRequestRow[] {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  return db
    .prepare(`SELECT * FROM print_watch_go_requests WHERE ${GO_TAKEABLE_SQL} ORDER BY id ASC`)
    .all(stale) as GoRequestRow[];
}

/** Compare-and-set claim: returns true when THIS token now owns the row;
 *  increments attempts. Mirrors `claimDocumentParse`'s CAS shape above. */
export function claimGoRequest(db: Database.Database, id: number, token: string, nowMs: number): boolean {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET status = 'claimed', claim_token = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND ${GO_TAKEABLE_SQL}`,
    )
    .run(token, new Date(nowMs).toISOString(), id, stale);
  return r.changes === 1;
}

/** Heartbeat: renews claimed_at under the token so a long phase (a PDF ingest
 *  with model calls) is never mistaken for an abandoned claim. False = the
 *  token no longer owns the row — the caller must stop. */
export function heartbeatGoRequest(db: Database.Database, id: number, token: string, nowMs: number): boolean {
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests SET claimed_at = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(new Date(nowMs).toISOString(), id, token);
  return r.changes === 1;
}

/** An ordinary failure below the cap: back to queued (attempts kept, partial
 *  reports kept) so the next dispatcher tick retries. Clears `claimed_at`
 *  alongside `claim_token` — matching `finalizeDocumentParse`'s sibling CAS
 *  above — so a queued row never carries a stale claim timestamp that a
 *  future query might read without also checking `status` (review #8). */
export function requeueGoRequest(db: Database.Database, id: number, token: string, resultJson: string): boolean {
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests SET status = 'queued', claim_token = NULL, claimed_at = NULL, result_json = ?
        WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(resultJson, id, token);
  return r.changes === 1;
}

/** CAS finalise: false when the token no longer owns the row (taken over).
 *  Clears `claimed_at` alongside `claim_token` (review #8), matching
 *  `finalizeDocumentParse`'s sibling CAS above. */
export function finalizeGoRequest(
  db: Database.Database,
  id: number,
  token: string,
  status: "done" | "failed",
  resultJson: string,
  nowMs: number,
): boolean {
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET status = ?, result_json = ?, finished_at = ?, claim_token = NULL, claimed_at = NULL
        WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(status, resultJson, new Date(nowMs).toISOString(), id, token);
  return r.changes === 1;
}

/** Rows that have spent their attempts — a stale claim OR a requeued row at
 *  the cap — become `failed`; nothing else could ever finalise them (spec:
 *  "stale claims that have spent their attempts become failed"). */
export function failCappedGoRequests(db: Database.Database, nowMs: number): number {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET status = 'failed', finished_at = ?, claim_token = NULL,
              result_json = COALESCE(result_json, '[{"road":"system","outcome":"failed","detail":"abandoned at the attempt cap"}]')
        WHERE attempts >= ${GO_MAX_ATTEMPTS} AND (status = 'queued' OR (status = 'claimed' AND datetime(claimed_at) < datetime(?)))`,
    )
    .run(new Date(nowMs).toISOString(), stale);
  return r.changes;
}

/** Prints whose FORCED window is live right now, whatever their event date —
 *  ensurePrintWatch runs these beside the ±1-day armed set (finding #18). The
 *  4-hour lookback is a backstop only: forced opens and their extensions are
 *  meant to be closed out (expired/parsed/disarmed) well inside that span; it
 *  exists so a crashed sweep does not lose track of a print stamped just
 *  before it went down. */
export function listForcedLivePrints(db: Database.Database, nowMs: number): PrintRow[] {
  const since = new Date(nowMs - 4 * 60 * 60_000).toISOString();
  return db
    .prepare(
      `SELECT * FROM print_watch_prints
        WHERE forced_open_at IS NOT NULL AND datetime(forced_open_at) >= datetime(?) AND state NOT IN ('disarmed')`,
    )
    .all(since) as PrintRow[];
}

/** Merge support (slice C's event-merge handler): go rows follow the surviving
 *  print, and any IN-FLIGHT claim on a donor row is invalidated (status →
 *  queued, token cleared, attempts kept) rather than carried over — the old
 *  worker's next token check against the (now repointed) row fails, and the
 *  dispatcher picks the request back up against the target print on its next
 *  tick (finding #8). The forced stamp keeps the EARLIEST press and the
 *  extension the LATEST end, so a merge can only widen what the desk already
 *  opened.
 *
 *  Runs as two UPDATEs plus two reads, NOT wrapped in its own transaction
 *  (review #9): the caller MUST invoke this from inside the merge
 *  transaction (slice B's event-merge handler already does), so a crash
 *  mid-call rolls back everything together rather than leaving go rows
 *  repointed with the forced/extension carry unapplied. */
export function movePrintGoState(
  db: Database.Database,
  donorPrintId: number,
  targetPrintId: number,
): { moved: number; forcedOpenAt: string | null; windowExtendedUntil: string | null } {
  const moved = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET print_id = ?,
              status = CASE WHEN status = 'claimed' THEN 'queued' ELSE status END,
              claim_token = CASE WHEN status = 'claimed' THEN NULL ELSE claim_token END
        WHERE print_id = ?`,
    )
    .run(targetPrintId, donorPrintId).changes;
  const donor = getPrintById(db, donorPrintId);
  const target = getPrintById(db, targetPrintId);
  if (!donor || !target) {
    return {
      moved,
      forcedOpenAt: target?.forced_open_at ?? null,
      windowExtendedUntil: target?.window_extended_until ?? null,
    };
  }
  const forced = [donor.forced_open_at, target.forced_open_at].filter((v): v is string => v !== null).sort()[0] ?? null;
  const extended =
    [donor.window_extended_until, target.window_extended_until].filter((v): v is string => v !== null).sort().at(-1) ??
    null;
  db.prepare(
    `UPDATE print_watch_prints SET forced_open_at = ?, window_extended_until = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(forced, extended, targetPrintId);
  return { moved, forcedOpenAt: forced, windowExtendedUntil: extended };
}
