/**
 * The earnings event-merge registry (live print v2, slice A §4.1).
 *
 * When an earnings event's date is corrected — by the user, or by the
 * automatic date reconciler — a DONOR event is folded into a surviving TARGET
 * event and then deleted (or merely superseded). Every table that hangs off
 * `calendar_events(id)` with ON DELETE CASCADE therefore has to be told where
 * its rows now live, BEFORE the donor row goes away.
 *
 * This module is the single place that knows how. Slice A ships built-in rules
 * for the tables it owns (`earnings_worksheet_flags`, `earnings_prepare_steps`,
 * `earnings_bogey_scans`, `earnings_bogeys`, plus the `earnings_emails` /
 * `earnings_email_skips` audit merge); sibling slices register their own
 * handler through `registerEventMergeHandler` so a new table can never be
 * silently forgotten by a correction path.
 *
 * Contract:
 *  - SYNCHRONOUS and SQL-only. It must run INSIDE an already-open transaction
 *    (it throws otherwise) and BEFORE the donor row is deleted.
 *  - It NEVER writes `cloud_outbox` itself. [C-13] The CALLER writes one row
 *    per outer transaction when the report says `changed` — otherwise a
 *    correction that dooms five rows would publish five generations.
 *  - Handlers run in registration order, AFTER the built-ins; duplicate names
 *    throw at registration time.
 */
import type Database from "better-sqlite3";
// Lazy on purpose: the bootstrap is CALLED from inside a function body, never
// evaluated into this module's top level — the cycle
// merge → registry-bootstrap → (slice handlers) → merge must only be
// traversed at call time.
import { bootstrapEarningsRegistries, __isBootstrapSuppressedForTests } from "./registry-bootstrap";

export interface EventMergeContext {
  db: Database.Database;
  donorEventId: number;
  targetEventId: number;
}

export interface EventMergeTableResult {
  table: string;
  moved: number;
  merged: number;
  deleted: number;
  notes: string[];
}

export type EventMergeHandler = (ctx: EventMergeContext) => EventMergeTableResult[];

export interface EventMergeReport {
  donorEventId: number;
  targetEventId: number;
  handlers: Array<{ name: string; tables: EventMergeTableResult[] }>;
  changed: boolean;
}

const handlers = new Map<string, EventMergeHandler>();

export function registerEventMergeHandler(name: string, handler: EventMergeHandler): void {
  if (handlers.has(name)) throw new Error(`event-merge: duplicate handler "${name}"`);
  handlers.set(name, handler);
}

export function listEventMergeHandlers(): string[] {
  return [...handlers.keys()];
}

/** Clears the registry AND suppresses the lazy bootstrap for this process (tests own the registry). */
export function __resetEventMergeHandlersForTests(): void {
  handlers.clear();
  __isBootstrapSuppressedForTests(true);
}

// [C-12] Full lattice: a live claim on the target outranks a donor's failure; done outranks all.
// A moved donor-only row keeps the donor's fingerprint on purpose: the runner recomputes the
// fingerprint against the TARGET event on its next pass and resets the row when it differs.
const STATUS_RANK: Record<string, number> = { pending: 0, failed: 1, claimed: 2, done: 3 };
/** Terminal precedence for the per-article scan ledger — a donor hit is never lost. */
const SCAN_RANK: Record<string, number> = { claimed: 0, error: 1, no_numbers: 2, hit: 3 };
/**
 * The bogey columns the collision rule carries across, split by role.
 *
 * EXPORTED so `tests/repo/bogey-merge-columns.test.ts` can pin them against
 * the live `earnings_bogeys` schema. The collision rule writes
 * `UPDATE <these columns>` and then DELETEs the donor row, so a future
 * migration that adds a bogey column without adding it here would silently
 * destroy that column's donor value on every collision. The guard fails the
 * suite instead of losing the number.
 *
 * `lib/mutations/earnings-bogeys.ts::CONTENT_COLUMNS` is a related but DISTINCT
 * list (it drives `hasAnyContent` and the preserve-mode COALESCE); the two are
 * deliberately not merged — the schema, not the other list, is the shared
 * source of truth both are checked against.
 */
export const BOGEY_PROVENANCE = [
  "source_url",
  "raw_pdf_r2_key",
  "research_document_id",
  "research_article_id",
  "ai_extraction_model",
] as const;
export const BOGEY_CONTENT = [
  "eps_consensus",
  "eps_whisper",
  "revenue_consensus_usd",
  "revenue_whisper_usd",
  "expected_move_pct",
  "segment_breakdown_json",
  "guidance_notes",
  "notes",
  "eps_consensus_vendor",
  "extra_metrics_json",
] as const;

const empty = (table: string): EventMergeTableResult => ({
  table,
  moved: 0,
  merged: 0,
  deleted: 0,
  notes: [],
});

function mergeWorksheetFlags({
  db,
  donorEventId,
  targetEventId,
}: EventMergeContext): EventMergeTableResult {
  const donor = db
    .prepare(`SELECT printed_at FROM earnings_worksheet_flags WHERE event_id = ?`)
    .get(donorEventId) as { printed_at: string | null } | undefined;
  if (!donor) return empty("earnings_worksheet_flags");
  const target = db
    .prepare(`SELECT printed_at FROM earnings_worksheet_flags WHERE event_id = ?`)
    .get(targetEventId) as { printed_at: string | null } | undefined;
  if (target) {
    // A print already fired for this cluster on either side — keep the stamp so
    // the auto-pass cannot double-print onto the surviving row.
    db.prepare(
      `UPDATE earnings_worksheet_flags SET printed_at = COALESCE(printed_at, ?) WHERE event_id = ?`,
    ).run(donor.printed_at, targetEventId);
    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(donorEventId);
    return { table: "earnings_worksheet_flags", moved: 0, merged: 1, deleted: 1, notes: [] };
  }
  db.prepare(`UPDATE earnings_worksheet_flags SET event_id = ? WHERE event_id = ?`).run(
    targetEventId,
    donorEventId,
  );
  return { table: "earnings_worksheet_flags", moved: 1, merged: 0, deleted: 0, notes: [] };
}

function mergePrepareSteps({
  db,
  donorEventId,
  targetEventId,
}: EventMergeContext): EventMergeTableResult {
  const rows = db
    .prepare(
      `SELECT step, status, input_fingerprint, attempts, last_error
         FROM earnings_prepare_steps WHERE event_id = ?`,
    )
    .all(donorEventId) as Array<{
    step: string;
    status: string;
    input_fingerprint: string | null;
    attempts: number;
    last_error: string | null;
  }>;
  let moved = 0;
  let merged = 0;
  for (const d of rows) {
    const t = db
      .prepare(
        `SELECT status, input_fingerprint FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`,
      )
      .get(targetEventId, d.step) as
      | { status: string; input_fingerprint: string | null }
      | undefined;
    if (!t) {
      db.prepare(
        `UPDATE earnings_prepare_steps SET event_id = ? WHERE event_id = ? AND step = ?`,
      ).run(targetEventId, donorEventId, d.step);
      moved += 1;
      continue;
    }
    if (t.input_fingerprint === d.input_fingerprint) {
      if ((STATUS_RANK[d.status] ?? 0) > (STATUS_RANK[t.status] ?? 0)) {
        db.prepare(
          `UPDATE earnings_prepare_steps
              SET status = ?, attempts = ?, last_error = ?, claim_token = NULL, claimed_at = NULL,
                  updated_at = datetime('now')
            WHERE event_id = ? AND step = ?`,
        ).run(d.status, d.attempts, d.last_error, targetEventId, d.step);
      }
    } else {
      // Two different inputs produced these two rows; neither describes the
      // merged event. Reset so the runner recomputes from scratch.
      db.prepare(
        `UPDATE earnings_prepare_steps
            SET status = 'pending', attempts = 0, input_fingerprint = NULL, last_error = NULL,
                claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ?`,
      ).run(targetEventId, d.step);
    }
    db.prepare(`DELETE FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`).run(
      donorEventId,
      d.step,
    );
    merged += 1;
  }
  return { table: "earnings_prepare_steps", moved, merged, deleted: merged, notes: [] };
}

function mergeBogeyScans({
  db,
  donorEventId,
  targetEventId,
}: EventMergeContext): EventMergeTableResult {
  const rows = db
    .prepare(
      `SELECT article_id, extractor_version, status, model_id, attempts, scanned_at
         FROM earnings_bogey_scans WHERE event_id = ?`,
    )
    .all(donorEventId) as Array<{
    article_id: number;
    extractor_version: number;
    status: string;
    model_id: string | null;
    attempts: number;
    scanned_at: string | null;
  }>;
  let moved = 0;
  let merged = 0;
  for (const d of rows) {
    const t = db
      .prepare(
        `SELECT status FROM earnings_bogey_scans
          WHERE event_id = ? AND article_id = ? AND extractor_version = ?`,
      )
      .get(targetEventId, d.article_id, d.extractor_version) as { status: string } | undefined;
    if (!t) {
      db.prepare(
        `UPDATE earnings_bogey_scans SET event_id = ?
          WHERE event_id = ? AND article_id = ? AND extractor_version = ?`,
      ).run(targetEventId, donorEventId, d.article_id, d.extractor_version);
      moved += 1;
      continue;
    }
    if ((SCAN_RANK[d.status] ?? 0) > (SCAN_RANK[t.status] ?? 0)) {
      db.prepare(
        `UPDATE earnings_bogey_scans
            SET status = ?, model_id = ?, attempts = ?, scanned_at = ?, claim_token = NULL,
                updated_at = datetime('now')
          WHERE event_id = ? AND article_id = ? AND extractor_version = ?`,
      ).run(
        d.status,
        d.model_id,
        d.attempts,
        d.scanned_at,
        targetEventId,
        d.article_id,
        d.extractor_version,
      );
    }
    db.prepare(
      `DELETE FROM earnings_bogey_scans
        WHERE event_id = ? AND article_id = ? AND extractor_version = ?`,
    ).run(donorEventId, d.article_id, d.extractor_version);
    merged += 1;
  }
  return { table: "earnings_bogey_scans", moved, merged, deleted: merged, notes: [] };
}

function mergeBogeys({ db, donorEventId, targetEventId }: EventMergeContext): EventMergeTableResult {
  // Existing rule first: plain repoint where no (source, source_label) collision exists.
  // [C-4] This is the SAME statement createDependentRepointer runs, so when the
  // reconciler has already repointed there is simply nothing left to move here.
  const moved = db
    .prepare(`UPDATE OR IGNORE earnings_bogeys SET event_id = ? WHERE event_id = ?`)
    .run(targetEventId, donorEventId).changes;
  // Collisions: donor rows still on donorEventId. Newer uploaded_at wins field-by-field
  // where the other is null.
  const leftovers = db
    .prepare(`SELECT * FROM earnings_bogeys WHERE event_id = ?`)
    .all(donorEventId) as Array<Record<string, unknown>>;
  let merged = 0;
  const notes: string[] = [];
  // Timestamps are compared with datetime() on BOTH sides: `uploaded_at`
  // defaults to the space-separated `datetime('now')` form, but a row written
  // from JS can carry the ISO `T` form, and a raw string compare mis-orders
  // those two against each other.
  const donorIsNewer = db.prepare(`SELECT datetime(?) > datetime(?) AS newer`);
  for (const d of leftovers) {
    const t = db
      .prepare(`SELECT * FROM earnings_bogeys WHERE event_id = ? AND source = ? AND source_label IS ?`)
      .get(targetEventId, d.source, d.source_label) as Record<string, unknown> | undefined;
    if (!t) {
      // The repoint skipped it for a reason other than the (source, source_label)
      // UNIQUE — leave it alone rather than guessing.
      notes.push(`bogey #${String(d.id)} left on the donor (no matching target row)`);
      continue;
    }
    const newer =
      (donorIsNewer.get(d.uploaded_at, t.uploaded_at) as { newer: number }).newer === 1 ? d : t;
    const older = newer === d ? t : d;
    // [C-6] The two halves are treated DIFFERENTLY, on purpose:
    //   content    — a union, newer ?? older ?? null: a figure only one side
    //                published still survives the merge.
    //   provenance — newer ONLY (never COALESCEd forward): the surviving row
    //                names exactly one document, the newest one, so no stale
    //                PDF key / URL / research id outlives the figures it
    //                described.
    // The consequence is deliberate: a value contributed by the OLDER row is
    // published under the newer row's provenance. The plan takes that over the
    // alternative (a row whose provenance columns name two different
    // documents, with no way to tell which figure came from which).
    const cols = [...BOGEY_CONTENT, ...BOGEY_PROVENANCE];
    const sets = cols.map((c) => `${c} = ?`).join(", ");
    const values = [
      ...BOGEY_CONTENT.map((c) => newer[c] ?? older[c] ?? null),
      ...BOGEY_PROVENANCE.map((c) => newer[c] ?? null),
    ];
    db.prepare(`UPDATE earnings_bogeys SET ${sets}, uploaded_at = ? WHERE id = ?`).run(
      ...values,
      newer.uploaded_at,
      t.id,
    );
    db.prepare(`DELETE FROM earnings_bogeys WHERE id = ?`).run(d.id);
    merged += 1;
  }
  return { table: "earnings_bogeys", moved, merged, deleted: merged, notes };
}

/**
 * [C-5] Spec: "a sent phase on either side counts as sent for the target, so nothing refires";
 * a skip on either side counts as skipped. UPDATE OR IGNORE alone would keep a target's
 * FAILED row over a donor's DELIVERED one and re-open the send. Live 'in_progress' claims
 * are never touched (tri-state rule).
 *
 * The PREVIEW plausibility gate from createDependentRepointer applies here too, and is not
 * optional: a preview is a promise about ONE print, and findEmailCandidates treats any
 * preview-phase row on an event as "already handled". Dragging a preview sent for a phantom
 * date onto a print it could not have covered both fabricates history and blocks the genuine
 * preview forever (qa/NBIS 2026-08-10). Recap rows are post-print audit and follow their
 * print unconditionally.
 */
function mergeEmailAudit({
  db,
  donorEventId,
  targetEventId,
}: EventMergeContext): EventMergeTableResult[] {
  const target = db
    .prepare(`SELECT event_date FROM calendar_events WHERE id = ?`)
    .get(targetEventId) as { event_date: string } | undefined;
  const targetDate = target?.event_date ?? null;
  // Same comparison the repointer makes, in SQL, so ET/UTC date handling is identical
  // on both sides (`date()` on both operands — never a JS string compare).
  const coversStmt = db.prepare(`SELECT date(?) >= date(?, '-1 day') AS ok`);
  const covers = (stamp: string | null): boolean => {
    if (targetDate === null) return true; // no target date to test against
    if (!stamp) return false;
    return (coversStmt.get(stamp, targetDate) as { ok: number }).ok === 1;
  };

  const out: EventMergeTableResult[] = [];
  let moved = 0;
  let merged = 0;
  let deleted = 0;
  const notes: string[] = [];

  const donorEmails = db
    .prepare(
      `SELECT id, phase, sent_at, error FROM earnings_emails
        WHERE event_id = ? AND (error IS NULL OR error != 'in_progress')`,
    )
    .all(donorEventId) as Array<{
    id: number;
    phase: string;
    sent_at: string | null;
    error: string | null;
  }>;
  for (const d of donorEmails) {
    if (d.phase === "preview" && !covers(d.sent_at)) {
      notes.push(`preview email #${d.id} stayed behind (send date could not cover the target print)`);
      continue;
    }
    const t = db
      .prepare(`SELECT id, error FROM earnings_emails WHERE event_id = ? AND phase = ?`)
      .get(targetEventId, d.phase) as { id: number; error: string | null } | undefined;
    if (!t) {
      db.prepare(`UPDATE earnings_emails SET event_id = ? WHERE id = ?`).run(targetEventId, d.id);
      moved += 1;
      continue;
    }
    if (t.error === "in_progress") continue; // live claim on the target: leave both
    const donorDelivered = d.error === null || d.error === "sent-by-cloud";
    const targetDelivered = t.error === null || t.error === "sent-by-cloud";
    if (donorDelivered && !targetDelivered) {
      // delivered history wins — the target must not re-fire a send that already happened
      db.prepare(`DELETE FROM earnings_emails WHERE id = ?`).run(t.id);
      db.prepare(`UPDATE earnings_emails SET event_id = ? WHERE id = ?`).run(targetEventId, d.id);
      merged += 1;
      deleted += 1;
    }
    // else: the target keeps its row; the donor's dies with the cascade
  }
  out.push({ table: "earnings_emails", moved, merged, deleted, notes });

  const donorSkips = db
    .prepare(`SELECT id, phase, skipped_at FROM earnings_email_skips WHERE event_id = ?`)
    .all(donorEventId) as Array<{ id: number; phase: string; skipped_at: string | null }>;
  let skipMoved = 0;
  const skipNotes = ["skip on either side → target skipped (the target's own row wins)"];
  for (const s of donorSkips) {
    if (s.phase === "preview" && !covers(s.skipped_at)) {
      skipNotes.push(`preview skip #${s.id} stayed behind (skip date could not cover the target print)`);
      continue;
    }
    const t = db
      .prepare(`SELECT id FROM earnings_email_skips WHERE event_id = ? AND phase = ?`)
      .get(targetEventId, s.phase) as { id: number } | undefined;
    if (t) continue; // already skipped on the target — nothing to add
    db.prepare(`UPDATE earnings_email_skips SET event_id = ? WHERE id = ?`).run(targetEventId, s.id);
    skipMoved += 1;
  }
  out.push({
    table: "earnings_email_skips",
    moved: skipMoved,
    merged: 0,
    deleted: 0,
    notes: skipNotes,
  });
  return out;
}

/**
 * Fold `donorEventId`'s state into `targetEventId`.
 *
 * MUST be called inside an open transaction, BEFORE the donor `calendar_events`
 * row is deleted (every one of these tables cascades on that delete).
 */
export function mergeEarningsEventState(
  db: Database.Database,
  donorEventId: number,
  targetEventId: number,
): EventMergeReport {
  if (!db.inTransaction) throw new Error("mergeEarningsEventState must run inside a transaction");
  // [C-14] Self-bootstrapping (aligned with slice B's M3): no entrypoint can forget to load
  // slice B's handler, so prints/documents/lines can never silently stay on a doomed event.
  bootstrapEarningsRegistries();
  const report: EventMergeReport = { donorEventId, targetEventId, handlers: [], changed: false };
  // Defensive: folding an event into itself would delete the very rows it is
  // meant to preserve (the flag merge would COALESCE then DELETE the one row).
  if (donorEventId === targetEventId) return report;

  const ctx: EventMergeContext = { db, donorEventId, targetEventId };
  report.handlers.push({ name: "builtin:worksheet_flags", tables: [mergeWorksheetFlags(ctx)] });
  report.handlers.push({ name: "builtin:prepare_steps", tables: [mergePrepareSteps(ctx)] });
  report.handlers.push({ name: "builtin:bogey_scans", tables: [mergeBogeyScans(ctx)] });
  report.handlers.push({ name: "builtin:bogeys", tables: [mergeBogeys(ctx)] });
  report.handlers.push({ name: "builtin:email_audit", tables: mergeEmailAudit(ctx) });
  for (const [name, fn] of handlers) report.handlers.push({ name, tables: fn(ctx) });
  // [C-13] The CALLER writes the outbox row — once per outer transaction, only when
  // something changed.
  report.changed = report.handlers.some((h) =>
    h.tables.some((t) => t.moved + t.merged + t.deleted > 0),
  );
  return report;
}
