/**
 * Filing summary store: the only reader and writer of the migration 099
 * tables. Every function takes `db` first and is synchronous.
 *
 * Section claims follow the print-watch read pattern: a section is claimed
 * with a caller token (compare-and-set inside an IMMEDIATE transaction), kept
 * alive by heartbeats, and any write after the claim is conditioned on the
 * token, so a worker that lost its claim writes nothing. Instants the caller
 * passes as `nowMs` are stored as ISO strings and compared with `datetime()`
 * on both sides.
 */
import type Database from "better-sqlite3";
import { DELIVERY_UNKNOWN, SENDING } from "@/lib/earnings/email-states";
import { DEFAULT_SUMMARY_CHOICE } from "./choice";
import type { SummaryChoice, SummaryEffort, SummaryFamily } from "./types";

// ---------------------------------------------------------------- row types

export type PollState =
  | "waiting"
  | "found"
  | "past_cutoff"
  | "sec_unreachable"
  | "cancelled"
  | "no_cik"
  | "manual_only"
  | "ambiguous";
export type FilingRole = "earnings" | "companion";
export type IdentityVerdict = "accepted" | "ambiguous" | "rejected" | "time_unconfirmed";
export type FetchState = "pending" | "fetched" | "failed";
export type DocumentStatus = "fetched" | "skipped" | "failed";
export type RunTrigger = "auto" | "rerun" | "manual_run";
export type RunStatus = "running" | "done" | "failed";
export type SectionStatus = "pending" | "running" | "done" | "failed";
export type SectionErrorClass =
  | "model_error"
  | "timeout"
  | "refusal"
  | "truncated"
  | "invalid_output"
  | "model_unavailable"
  | "input_too_large"
  | "attempt_cap"
  | "takeover"
  | "cancelled";
/**
 * Push send states. `sending` and `delivery_unknown` reuse the send-state
 * vocabulary of `lib/earnings/email-states.ts` (same meaning: a send in flight,
 * and one a crash left unknowable), so those two words keep one spelling.
 */
export type PushState = "pending" | typeof SENDING | "sent" | typeof DELIVERY_UNKNOWN | "failed";

export interface EventStateRow {
  eventId: number;
  family: SummaryFamily | null;
  effort: SummaryEffort | null;
  pollState: PollState;
  pollDetail: string | null;
  cik: string | null;
  lastPolledAt: string | null;
  catchupDone: boolean;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewFiling {
  eventId: number;
  accession: string;
  cik: string;
  form: string;
  role: FilingRole;
  items: string | null;
  acceptedAt: string | null;
  discoveredAt: string;
  identityVerdict: IdentityVerdict;
  identityReason: string | null;
  fetchState?: FetchState;
}

export interface FilingRow {
  id: number;
  eventId: number;
  accession: string;
  cik: string;
  form: string;
  role: FilingRole;
  items: string | null;
  acceptedAt: string | null;
  discoveredAt: string;
  discoverySeq: number;
  identityVerdict: IdentityVerdict;
  identityReason: string | null;
  fetchState: FetchState;
}

export interface NewDocument {
  filingId: number;
  fileName: string;
  docType: string;
  sequence: number;
  status: DocumentStatus;
  skipReason: string | null;
  sha256: string | null;
  byteLen: number | null;
  storedPath: string | null;
}

export interface DocumentRow extends NewDocument {
  id: number;
}

export interface RunRow {
  id: number;
  eventId: number;
  runNo: number;
  trigger: RunTrigger;
  family: SummaryFamily;
  effort: SummaryEffort;
  modelId: string | null;
  fallbackNote: string | null;
  requestKey: string | null;
  status: RunStatus;
  bogeySnapshotJson: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface SectionRow {
  id: number;
  runId: number;
  filingId: number;
  seq: number;
  status: SectionStatus;
  attempts: number;
  claimToken: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  modelId: string | null;
  effort: string | null;
  inputFingerprint: string | null;
  outputJson: string | null;
  checkedJson: string | null;
  coverageJson: string | null;
  incomplete: boolean;
  countsJson: string | null;
  usageJson: string | null;
  versionsJson: string | null;
  errorClass: SectionErrorClass | null;
  errorText: string | null;
  finishedAt: string | null;
}

export interface SectionResult {
  status: "done" | "failed";
  modelId: string | null;
  effort: string | null;
  inputFingerprint: string | null;
  outputJson: string | null;
  checkedJson: string | null;
  coverageJson: string | null;
  incomplete: boolean;
  countsJson: string | null;
  usageJson: string | null;
  versionsJson: string | null;
  errorClass: SectionErrorClass | null;
  errorText: string | null;
}

// ---------------------------------------------------------------- mappers

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toEventState(r: Raw): EventStateRow {
  return {
    eventId: Number(r.event_id),
    family: str(r.family) as SummaryFamily | null,
    effort: str(r.effort) as SummaryEffort | null,
    pollState: String(r.poll_state) as PollState,
    pollDetail: str(r.poll_detail),
    cik: str(r.cik),
    lastPolledAt: str(r.last_polled_at),
    catchupDone: Number(r.catchup_done) === 1,
    lockedAt: str(r.locked_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toFiling(r: Raw): FilingRow {
  return {
    id: Number(r.id),
    eventId: Number(r.event_id),
    accession: String(r.accession),
    cik: String(r.cik),
    form: String(r.form),
    role: String(r.role) as FilingRole,
    items: str(r.items),
    acceptedAt: str(r.accepted_at),
    discoveredAt: String(r.discovered_at),
    discoverySeq: Number(r.discovery_seq),
    identityVerdict: String(r.identity_verdict) as IdentityVerdict,
    identityReason: str(r.identity_reason),
    fetchState: String(r.fetch_state) as FetchState,
  };
}

function toDocument(r: Raw): DocumentRow {
  return {
    id: Number(r.id),
    filingId: Number(r.filing_id),
    fileName: String(r.file_name),
    docType: String(r.doc_type),
    sequence: Number(r.sequence),
    status: String(r.status) as DocumentStatus,
    skipReason: str(r.skip_reason),
    sha256: str(r.sha256),
    byteLen: num(r.byte_len),
    storedPath: str(r.stored_path),
  };
}

function toRun(r: Raw): RunRow {
  return {
    id: Number(r.id),
    eventId: Number(r.event_id),
    runNo: Number(r.run_no),
    trigger: String(r.trigger) as RunTrigger,
    family: String(r.family) as SummaryFamily,
    effort: String(r.effort) as SummaryEffort,
    modelId: str(r.model_id),
    fallbackNote: str(r.fallback_note),
    requestKey: str(r.request_key),
    status: String(r.status) as RunStatus,
    bogeySnapshotJson: String(r.bogey_snapshot_json),
    createdAt: String(r.created_at),
    finishedAt: str(r.finished_at),
  };
}

function toSection(r: Raw): SectionRow {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    filingId: Number(r.filing_id),
    seq: Number(r.seq),
    status: String(r.status) as SectionStatus,
    attempts: Number(r.attempts),
    claimToken: str(r.claim_token),
    claimedAt: str(r.claimed_at),
    heartbeatAt: str(r.heartbeat_at),
    modelId: str(r.model_id),
    effort: str(r.effort),
    inputFingerprint: str(r.input_fingerprint),
    outputJson: str(r.output_json),
    checkedJson: str(r.checked_json),
    coverageJson: str(r.coverage_json),
    incomplete: Number(r.incomplete) === 1,
    countsJson: str(r.counts_json),
    usageJson: str(r.usage_json),
    versionsJson: str(r.versions_json),
    errorClass: str(r.error_class) as SectionErrorClass | null,
    errorText: str(r.error_text),
    finishedAt: str(r.finished_at),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------- event state

export function getEventState(db: Database.Database, eventId: number): EventStateRow | null {
  const r = db.prepare("SELECT * FROM filing_summary_events WHERE event_id = ?").get(eventId) as
    | Raw
    | undefined;
  return r ? toEventState(r) : null;
}

/** Patchable fields and their columns (identity and timestamps are not patchable). */
const EVENT_PATCH_COLUMNS = {
  family: "family",
  effort: "effort",
  pollState: "poll_state",
  pollDetail: "poll_detail",
  cik: "cik",
  lastPolledAt: "last_polled_at",
  catchupDone: "catchup_done",
  lockedAt: "locked_at",
} as const satisfies Partial<Record<keyof EventStateRow, string>>;

/** Creates the event row when absent, then writes the given fields. */
export function upsertEventState(
  db: Database.Database,
  eventId: number,
  patch: Partial<EventStateRow>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(EVENT_PATCH_COLUMNS)) {
    if (!(field in patch)) continue;
    const value = patch[field as keyof typeof EVENT_PATCH_COLUMNS];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO filing_summary_events (event_id) VALUES (?)").run(eventId);
    if (sets.length === 0) return;
    db.prepare(
      `UPDATE filing_summary_events SET ${sets.join(", ")}, updated_at = datetime('now')
       WHERE event_id = ?`,
    ).run(...params, eventId);
  })();
}

export function getChoice(
  db: Database.Database,
  eventId: number,
): { choice: SummaryChoice; isDefault: boolean; locked: boolean } {
  const s = getEventState(db, eventId);
  const locked = s?.lockedAt != null;
  if (s?.family && s.effort) {
    return { choice: { family: s.family, effort: s.effort }, isDefault: false, locked };
  }
  return { choice: { ...DEFAULT_SUMMARY_CHOICE }, isDefault: true, locked };
}

/** Stores the choice unless a run has already locked it (checked in the same statement). */
export function setChoice(
  db: Database.Database,
  eventId: number,
  choice: SummaryChoice,
): { ok: true } | { ok: false; reason: "locked" } {
  const info = db
    .prepare(
      `INSERT INTO filing_summary_events (event_id, family, effort) VALUES (?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         family = excluded.family, effort = excluded.effort, updated_at = datetime('now')
       WHERE filing_summary_events.locked_at IS NULL`,
    )
    .run(eventId, choice.family, choice.effort);
  return info.changes > 0 ? { ok: true } : { ok: false, reason: "locked" };
}

// ---------------------------------------------------------------- filings and documents

/** INSERT OR IGNORE on (event, accession); discovery_seq is the event's next number. */
export function insertFiling(
  db: Database.Database,
  f: NewFiling,
): { id: number; inserted: boolean } {
  return db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM filing_summary_filings WHERE event_id = ? AND accession = ?")
      .get(f.eventId, f.accession) as { id: number } | undefined;
    if (existing) return { id: existing.id, inserted: false };
    const { next } = db
      .prepare(
        "SELECT COALESCE(MAX(discovery_seq), 0) + 1 AS next FROM filing_summary_filings WHERE event_id = ?",
      )
      .get(f.eventId) as { next: number };
    const info = db
      .prepare(
        `INSERT INTO filing_summary_filings
           (event_id, accession, cik, form, role, items, accepted_at, discovered_at,
            discovery_seq, identity_verdict, identity_reason, fetch_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.eventId,
        f.accession,
        f.cik,
        f.form,
        f.role,
        f.items,
        f.acceptedAt,
        f.discoveredAt,
        next,
        f.identityVerdict,
        f.identityReason,
        f.fetchState ?? "pending",
      );
    return { id: Number(info.lastInsertRowid), inserted: true };
  }).immediate();
}

export function listFilings(db: Database.Database, eventId: number): FilingRow[] {
  return (
    db
      .prepare("SELECT * FROM filing_summary_filings WHERE event_id = ? ORDER BY discovery_seq")
      .all(eventId) as Raw[]
  ).map(toFiling);
}

/** Inserts or replaces the document's fields keyed on (filing, file name); returns its id. */
export function upsertDocument(db: Database.Database, d: NewDocument): number {
  const row = db
    .prepare(
      `INSERT INTO filing_summary_documents
         (filing_id, file_name, doc_type, sequence, status, skip_reason, sha256, byte_len, stored_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (filing_id, file_name) DO UPDATE SET
         doc_type = excluded.doc_type, sequence = excluded.sequence, status = excluded.status,
         skip_reason = excluded.skip_reason, sha256 = excluded.sha256,
         byte_len = excluded.byte_len, stored_path = excluded.stored_path
       RETURNING id`,
    )
    .get(
      d.filingId,
      d.fileName,
      d.docType,
      d.sequence,
      d.status,
      d.skipReason,
      d.sha256,
      d.byteLen,
      d.storedPath,
    ) as { id: number };
  return row.id;
}

export function listDocuments(db: Database.Database, filingId: number): DocumentRow[] {
  return (
    db
      .prepare("SELECT * FROM filing_summary_documents WHERE filing_id = ? ORDER BY sequence, id")
      .all(filingId) as Raw[]
  ).map(toDocument);
}

// ---------------------------------------------------------------- runs and sections

/**
 * One transaction: returns the existing run for a known request key, or
 * creates run `max+1` with one pending section per filing (seq 1..n in the
 * given order) and locks the event's choice.
 */
export function createRun(
  db: Database.Database,
  r: {
    eventId: number;
    trigger: RunTrigger;
    choice: SummaryChoice;
    modelId: string | null;
    fallbackNote: string | null;
    requestKey: string | null;
    bogeySnapshotJson: string;
    filingIds: number[];
  },
): { runId: number; created: boolean } {
  return db.transaction(() => {
    if (r.requestKey !== null) {
      const existing = db
        .prepare("SELECT id FROM filing_summary_runs WHERE request_key = ?")
        .get(r.requestKey) as { id: number } | undefined;
      if (existing) return { runId: existing.id, created: false };
    }
    const { next } = db
      .prepare(
        "SELECT COALESCE(MAX(run_no), 0) + 1 AS next FROM filing_summary_runs WHERE event_id = ?",
      )
      .get(r.eventId) as { next: number };
    const runId = Number(
      db
        .prepare(
          `INSERT INTO filing_summary_runs
             (event_id, run_no, trigger, family, effort, model_id, fallback_note, request_key,
              bogey_snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.eventId,
          next,
          r.trigger,
          r.choice.family,
          r.choice.effort,
          r.modelId,
          r.fallbackNote,
          r.requestKey,
          r.bogeySnapshotJson,
        ).lastInsertRowid,
    );
    const insertSection = db.prepare(
      "INSERT INTO filing_summary_sections (run_id, filing_id, seq) VALUES (?, ?, ?)",
    );
    r.filingIds.forEach((filingId, i) => insertSection.run(runId, filingId, i + 1));
    db.prepare(
      `INSERT INTO filing_summary_events (event_id, locked_at) VALUES (?, datetime('now'))
       ON CONFLICT (event_id) DO UPDATE SET
         locked_at = COALESCE(filing_summary_events.locked_at, excluded.locked_at),
         updated_at = datetime('now')`,
    ).run(r.eventId);
    return { runId, created: true };
  }).immediate();
}

/**
 * Adds a pending section for a filing found after the run started (next seq).
 * Null when the run already has that filing. A finished run goes back to
 * running, since it has work again.
 */
export function appendSection(
  db: Database.Database,
  runId: number,
  filingId: number,
): number | null {
  return db.transaction(() => {
    const has = db
      .prepare("SELECT 1 FROM filing_summary_sections WHERE run_id = ? AND filing_id = ?")
      .get(runId, filingId);
    if (has) return null;
    const { next } = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM filing_summary_sections WHERE run_id = ?")
      .get(runId) as { next: number };
    const id = Number(
      db
        .prepare("INSERT INTO filing_summary_sections (run_id, filing_id, seq) VALUES (?, ?, ?)")
        .run(runId, filingId, next).lastInsertRowid,
    );
    db.prepare(
      "UPDATE filing_summary_runs SET status = 'running', finished_at = NULL WHERE id = ?",
    ).run(runId);
    return id;
  }).immediate();
}

/**
 * Claims the event's next section: the lowest (run_id, seq) that is pending,
 * or running with a heartbeat older than `staleMs` (a takeover). Refuses while
 * another section of the event is running with a fresh heartbeat. Every claim
 * increments `attempts`; a takeover writes no error class (the runner records
 * 'takeover' only if the retaken attempt then fails).
 */
export function claimNextSection(
  db: Database.Database,
  eventId: number,
  token: string,
  nowMs: number,
  staleMs = 5 * 60_000,
): SectionRow | null {
  const now = iso(nowMs);
  const cutoff = iso(nowMs - staleMs);
  return db.transaction(() => {
    const fresh = db
      .prepare(
        `SELECT 1 FROM filing_summary_sections s
         JOIN filing_summary_runs r ON r.id = s.run_id
         WHERE r.event_id = ? AND s.status = 'running'
           AND datetime(COALESCE(s.heartbeat_at, s.claimed_at)) >= datetime(?)`,
      )
      .get(eventId, cutoff);
    if (fresh) return null;
    const candidate = db
      .prepare(
        `SELECT s.id FROM filing_summary_sections s
         JOIN filing_summary_runs r ON r.id = s.run_id
         WHERE r.event_id = ?
           AND (s.status = 'pending'
                OR (s.status = 'running'
                    AND datetime(COALESCE(s.heartbeat_at, s.claimed_at)) < datetime(?)))
         ORDER BY s.run_id, s.seq
         LIMIT 1`,
      )
      .get(eventId, cutoff) as { id: number } | undefined;
    if (!candidate) return null;
    const row = db
      .prepare(
        `UPDATE filing_summary_sections
         SET status = 'running', claim_token = ?, claimed_at = ?, heartbeat_at = ?,
             attempts = attempts + 1
         WHERE id = ?
         RETURNING *`,
      )
      .get(token, now, now, candidate.id) as Raw;
    return toSection(row);
  }).immediate();
}

export function heartbeatSection(
  db: Database.Database,
  sectionId: number,
  token: string,
  nowMs: number,
): boolean {
  return (
    db
      .prepare(
        `UPDATE filing_summary_sections SET heartbeat_at = ?
         WHERE id = ? AND claim_token = ? AND status = 'running'`,
      )
      .run(iso(nowMs), sectionId, token).changes > 0
  );
}

/** Run status from its sections: all done → done; any failed with none open → failed. */
function recomputeRunStatus(db: Database.Database, runId: number): void {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(status = 'done') AS done,
              SUM(status = 'failed') AS failed,
              SUM(status IN ('pending', 'running')) AS open
       FROM filing_summary_sections WHERE run_id = ?`,
    )
    .get(runId) as { total: number; done: number | null; failed: number | null; open: number | null };
  let status: RunStatus = "running";
  if (c.total > 0 && c.done === c.total) status = "done";
  else if ((c.failed ?? 0) > 0 && (c.open ?? 0) === 0) status = "failed";
  db.prepare(
    `UPDATE filing_summary_runs
     SET status = ?, finished_at = CASE WHEN ? = 'running' THEN NULL
                                        ELSE COALESCE(finished_at, datetime('now')) END
     WHERE id = ?`,
  ).run(status, status, runId);
}

/**
 * Writes the section's result only while the caller still holds the claim
 * (false = claim lost, nothing written), and recomputes the run status in the
 * same transaction.
 */
export function finalizeSection(
  db: Database.Database,
  sectionId: number,
  token: string,
  result: SectionResult,
): boolean {
  return db.transaction(() => {
    const row = db
      .prepare(
        `UPDATE filing_summary_sections
         SET status = ?, model_id = ?, effort = ?, input_fingerprint = ?, output_json = ?,
             checked_json = ?, coverage_json = ?, incomplete = ?, counts_json = ?,
             usage_json = ?, versions_json = ?, error_class = ?, error_text = ?,
             finished_at = datetime('now')
         WHERE id = ? AND claim_token = ? AND status = 'running'
         RETURNING run_id`,
      )
      .get(
        result.status,
        result.modelId,
        result.effort,
        result.inputFingerprint,
        result.outputJson,
        result.checkedJson,
        result.coverageJson,
        result.incomplete ? 1 : 0,
        result.countsJson,
        result.usageJson,
        result.versionsJson,
        result.errorClass,
        result.errorText,
        sectionId,
        token,
      ) as { run_id: number } | undefined;
    if (!row) return false;
    recomputeRunStatus(db, row.run_id);
    return true;
  }).immediate();
}

/** Returns a claimed section to pending with the attempt's error; false = claim lost. */
export function requeueSection(
  db: Database.Database,
  sectionId: number,
  token: string,
  errorClass: SectionErrorClass,
  errorText: string | null,
): boolean {
  return (
    db
      .prepare(
        `UPDATE filing_summary_sections
         SET status = 'pending', claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL,
             error_class = ?, error_text = ?
         WHERE id = ? AND claim_token = ? AND status = 'running'`,
      )
      .run(errorClass, errorText, sectionId, token).changes > 0
  );
}

export function listRuns(db: Database.Database, eventId: number): RunRow[] {
  return (
    db
      .prepare("SELECT * FROM filing_summary_runs WHERE event_id = ? ORDER BY run_no")
      .all(eventId) as Raw[]
  ).map(toRun);
}

export function listSections(db: Database.Database, runId: number): SectionRow[] {
  return (
    db
      .prepare("SELECT * FROM filing_summary_sections WHERE run_id = ? ORDER BY seq")
      .all(runId) as Raw[]
  ).map(toSection);
}

/**
 * Events with a section still to work: pending, or running (a running section
 * left by a crashed process needs its takeover pass; `claimNextSection`
 * decides whether it is stale).
 */
export function listEventsWithPendingSections(db: Database.Database): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT r.event_id FROM filing_summary_sections s
         JOIN filing_summary_runs r ON r.id = s.run_id
         WHERE s.status IN ('pending', 'running')
         ORDER BY r.event_id`,
      )
      .all() as { event_id: number }[]
  ).map((x) => x.event_id);
}

// ---------------------------------------------------------------- pushes

/** Records the push as pending before it is sent; false when the key already exists. */
export function beginPush(
  db: Database.Database,
  key: string,
  eventId: number,
  title: string,
  message: string,
): boolean {
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO filing_summary_pushes (push_key, event_id, state, title, message)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(key, eventId, title, message).changes > 0
  );
}

export function markPush(db: Database.Database, key: string, state: PushState): void {
  db.prepare(
    "UPDATE filing_summary_pushes SET state = ?, updated_at = datetime('now') WHERE push_key = ?",
  ).run(state, key);
}

/** Startup sweep (R16): a push left in `sending` may or may not have gone out. */
export function markSendingAsUnknown(db: Database.Database): number {
  return db
    .prepare(
      `UPDATE filing_summary_pushes SET state = ?, updated_at = datetime('now')
       WHERE state = ?`,
    )
    .run(DELIVERY_UNKNOWN, SENDING).changes;
}
