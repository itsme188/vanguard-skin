// Reads and callouts rows (spec §4.4 "Identity and concurrency"; plan M-D8,
// M-D11, M-D12; Codex round 1 #8/#10/#12/#14/#15/#17). Every state change
// is compare-and-set on the claim token, and the ONLY path that writes a
// callout is finalizeReadDone, inside the same IMMEDIATE transaction that
// verifies the live claim and finalises the read.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ELIGIBLE_SQL } from "./store";
import type { ReadRow, ReadFact, ReadProse, ReadErrorCode, CalloutRow, CalloutView, CalloutUnit } from "./first-pass-types";

export const READ_HEARTBEAT_STALE_MS = 3 * 60_000;
export const READ_MAX_ATTEMPTS = 3;
export const READ_RETRY_BACKOFF_MS = 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

export type ClaimResult =
  | { kind: "claimed"; row: ReadRow; token: string }
  /** #8: the inputs moved under the caller between building the DTO and asking
   *  for the claim — nothing is written, and the caller re-plans on `fingerprint`. */
  | { kind: "drifted"; fingerprint: string }
  | { kind: "already_generating"; row: ReadRow }
  | { kind: "done_exists"; row: ReadRow }
  /** #17: the newest row failed and its retry is still in the future. */
  | { kind: "backoff"; row: ReadRow }
  | { kind: "failed_cap"; row: ReadRow };

function getRead(db: Database.Database, id: number): ReadRow {
  return db.prepare(`SELECT * FROM print_watch_reads WHERE id = ?`).get(id) as ReadRow;
}

/** The row that owns this (print, fingerprint) right now: highest nonce wins. */
function newestFor(db: Database.Database, printId: number, fingerprint: string): ReadRow | undefined {
  return db
    .prepare(`SELECT * FROM print_watch_reads WHERE print_id = ? AND fingerprint = ? ORDER BY nonce DESC, id DESC LIMIT 1`)
    .get(printId, fingerprint) as ReadRow | undefined;
}

/** Attempts are counted per FINGERPRINT, not per row: a stale takeover bumps the
 *  row it took over, a post-backoff retry opens a new nonce, and the cap is the
 *  sum across both shapes (#16/#17). */
function totalAttempts(db: Database.Database, printId: number, fingerprint: string): number {
  return (
    db
      .prepare(`SELECT COALESCE(SUM(attempts), 0) AS n FROM print_watch_reads WHERE print_id = ? AND fingerprint = ?`)
      .get(printId, fingerprint) as { n: number }
  ).n;
}

/** A failure that must never be retried on the same inputs.
 *
 *  F2: the attempt CAP is no longer judged from the error code — the code now
 *  always names the CAUSE (`cites`, `timeout`, …) and the cap is recorded in the
 *  `error` text instead. Every caller that cared about the cap already checks
 *  `totalAttempts >= READ_MAX_ATTEMPTS` next to this call, so terminal-ness is
 *  judged from the attempt count plus `next_retry_at IS NULL`, never from a
 *  marker that overwrote the reason. `'attempt_cap'` stays in the union (and in
 *  the CHECK) for rows written before this change, and for the one place that
 *  has no cause of its own: a generating row ABANDONED at the cap. */
function isTerminal(code: ReadErrorCode | null): boolean {
  return code === "attempt_cap" || code === "model_drift";
}

/** The prefix `finalizeReadFailed` puts on the error text when the attempt that
 *  just failed was the one that reached the cap. Written and read here only —
 *  `cappedAttempt` is the single reader. */
export const ATTEMPT_CAP_PREFIX = "attempt cap reached";

/** F2: did this failed row give up for good? Derived, so no migration: the cap
 *  prefix is written exactly when the cap was reached, and a terminal row never
 *  carries a retry time. */
export function cappedAttempt(row: Pick<ReadRow, "status" | "next_retry_at" | "error">): boolean {
  return row.status === "failed" && row.next_retry_at === null && (row.error ?? "").startsWith(ATTEMPT_CAP_PREFIX);
}

export function claimRead(
  db: Database.Database,
  printId: number,
  opts: { fingerprint: string; recompute: () => string | null; nowMs: number; modelId: string; regenerate?: boolean },
): ClaimResult {
  return db
    .transaction((): ClaimResult => {
      // #8: recompute the fingerprint from the live inputs INSIDE the claim
      // transaction. If it moved, the DTO the caller holds is already stale —
      // write nothing and hand back the fingerprint it should have used.
      const fresh = opts.recompute();
      if (fresh !== opts.fingerprint) return { kind: "drifted", fingerprint: fresh ?? "" };

      const newest = newestFor(db, printId, opts.fingerprint);
      const token = randomUUID();
      const insert = (nonce: number, attempts: number): ClaimResult => {
        const id = Number(
          db
            .prepare(
              `INSERT INTO print_watch_reads (print_id, fingerprint, nonce, status, claim_token, claimed_at, heartbeat_at, attempts, model_id)
               VALUES (?, ?, ?, 'generating', ?, ?, ?, ?, ?)`,
            )
            .run(printId, opts.fingerprint, nonce, token, iso(opts.nowMs), iso(opts.nowMs), attempts, opts.modelId).lastInsertRowid,
        );
        return { kind: "claimed", row: getRead(db, id), token };
      };

      if (!newest) return insert(0, 1);
      if (opts.regenerate) return insert(newest.nonce + 1, 1);
      if (newest.status === "done") return { kind: "done_exists", row: newest };
      if (newest.status === "superseded") return insert(newest.nonce + 1, 1);
      if (newest.status === "failed") {
        if (isTerminal(newest.error_code) || totalAttempts(db, printId, opts.fingerprint) >= READ_MAX_ATTEMPTS) {
          return { kind: "failed_cap", row: newest };
        }
        if (newest.next_retry_at && Date.parse(newest.next_retry_at) > opts.nowMs) return { kind: "backoff", row: newest };
        return insert(newest.nonce + 1, 1);
      }

      // generating: only a heartbeat that has gone stale may be taken over.
      const hb = newest.heartbeat_at ? Date.parse(newest.heartbeat_at) : 0;
      if (opts.nowMs - hb <= READ_HEARTBEAT_STALE_MS) return { kind: "already_generating", row: newest };
      if (totalAttempts(db, printId, opts.fingerprint) >= READ_MAX_ATTEMPTS) {
        // The ONLY row that legitimately carries `attempt_cap` as its code: it
        // was still generating, so it has no failure of its own to name.
        db.prepare(
          `UPDATE print_watch_reads SET status = 'failed', error = ?, error_code = 'attempt_cap', next_retry_at = NULL
            WHERE id = ? AND status = 'generating'`,
        ).run(
          `${ATTEMPT_CAP_PREFIX} (${totalAttempts(db, printId, opts.fingerprint)}/${READ_MAX_ATTEMPTS}): abandoned mid-generation`,
          newest.id,
        );
        return { kind: "failed_cap", row: getRead(db, newest.id) };
      }
      // CAS on the token we read: whoever wins the compare owns the row, and the
      // loser's token stops finalising anything from this moment on.
      const took = db
        .prepare(
          `UPDATE print_watch_reads SET claim_token = ?, claimed_at = ?, heartbeat_at = ?, attempts = attempts + 1, model_id = ?
            WHERE id = ? AND claim_token IS ?`,
        )
        .run(token, iso(opts.nowMs), iso(opts.nowMs), opts.modelId, newest.id, newest.claim_token).changes;
      if (took !== 1) return { kind: "already_generating", row: getRead(db, newest.id) };
      return { kind: "claimed", row: getRead(db, newest.id), token };
    })
    .immediate();
}

export function heartbeatRead(db: Database.Database, readId: number, token: string, nowMs: number): boolean {
  return (
    db
      .prepare(`UPDATE print_watch_reads SET heartbeat_at = ? WHERE id = ? AND claim_token = ? AND status = 'generating'`)
      .run(iso(nowMs), readId, token).changes === 1
  );
}

export interface VerifiedCalloutInput {
  label: string;
  label_norm: string;
  value: number;
  value_high: number | null;
  unit: CalloutUnit;
  value_text: string;
  snippet: string;
  doc_id: number;
  doc_sha256: string;
  evidence_sha256: string;
  verifier_version: number;
  vs_bogey_text: string | null;
}

export type FinalizeDoneResult = { ok: true; upserted: number; superseded: number } | { ok: false; reason: "claim_lost" };

export type AcceptCalloutResult =
  | { ok: true; callout: CalloutRow }
  | { ok: false; reason: "not_found" | "revoked" | "superseded" | "stale_verifier" | "changed" };

/** The row iff `token` still owns it and it is still generating. */
function liveClaim(db: Database.Database, readId: number, token: string): ReadRow | null {
  const row = db
    .prepare(`SELECT * FROM print_watch_reads WHERE id = ? AND claim_token = ? AND status = 'generating'`)
    .get(readId, token) as ReadRow | undefined;
  return row ?? null;
}

/**
 * #10: ONE immediate transaction — live token → callout upserts → supersede
 * stale proposals → finalise the read → supersede older generating rows.
 *
 * A worker that lost its claim returns `claim_lost` before touching anything,
 * so a callout can never be written outside a live claim. If the final UPDATE
 * somehow changes 0 rows the whole transaction throws and rolls back rather
 * than leaving callouts behind for a read that never completed.
 */
export function finalizeReadDone(
  db: Database.Database,
  args: { readId: number; token: string; facts: ReadFact[]; prose: ReadProse; callouts: VerifiedCalloutInput[]; nowMs: number },
): FinalizeDoneResult {
  return db
    .transaction((): FinalizeDoneResult => {
      const row = liveClaim(db, args.readId, args.token);
      if (!row) return { ok: false, reason: "claim_lost" };

      // #13/#14: identity is semantic — (print, document content, normalised
      // label, unit). A regeneration UPSERTS the same figure rather than
      // duplicating it, and a human's accept survives the rewrite.
      const upsert = db.prepare(
        `INSERT INTO print_watch_callouts (print_id, read_id, label, label_norm, value, value_high, unit, value_text, snippet, doc_id, doc_sha256, evidence_sha256, verifier_version, vs_bogey_text, state, updated_at)
         VALUES (@print_id, @read_id, @label, @label_norm, @value, @value_high, @unit, @value_text, @snippet, @doc_id, @doc_sha256, @evidence_sha256, @verifier_version, @vs_bogey_text, 'proposed', @now)
         ON CONFLICT(print_id, doc_sha256, label_norm, unit) DO UPDATE SET
           read_id = excluded.read_id, label = excluded.label, value = excluded.value, value_high = excluded.value_high, value_text = excluded.value_text,
           snippet = excluded.snippet, doc_id = excluded.doc_id, evidence_sha256 = excluded.evidence_sha256, verifier_version = excluded.verifier_version,
           vs_bogey_text = excluded.vs_bogey_text, updated_at = excluded.updated_at,
           state = CASE WHEN print_watch_callouts.state = 'accepted' THEN 'accepted' ELSE 'proposed' END,
           superseded_by_read_id = NULL, revoked_at = NULL`,
      );
      let upserted = 0;
      for (const c of args.callouts) {
        upserted += upsert.run({ ...c, print_id: row.print_id, read_id: args.readId, now: iso(args.nowMs) }).changes;
      }

      // A proposal this read did not re-propose is stale. An ACCEPTED row is a
      // human decision and is never superseded by a later generation.
      const superseded = db
        .prepare(
          `UPDATE print_watch_callouts SET state = 'superseded', superseded_by_read_id = ?, updated_at = ?
            WHERE print_id = ? AND state = 'proposed' AND (read_id IS NULL OR read_id <> ?)`,
        )
        .run(args.readId, iso(args.nowMs), row.print_id, args.readId).changes;

      const fin = db
        .prepare(
          `UPDATE print_watch_reads SET status = 'done', facts_json = ?, prose_json = ?, error = NULL, error_code = NULL, next_retry_at = NULL, generated_at = ?, heartbeat_at = ?
            WHERE id = ? AND claim_token = ? AND status = 'generating'`,
        )
        .run(JSON.stringify(args.facts), JSON.stringify(args.prose), iso(args.nowMs), iso(args.nowMs), args.readId, args.token).changes;
      if (fin !== 1) throw new Error("finalizeReadDone: claim vanished inside the transaction");

      db.prepare(`UPDATE print_watch_reads SET status = 'superseded' WHERE print_id = ? AND status = 'generating' AND id < ?`).run(
        row.print_id,
        args.readId,
      );
      return { ok: true, upserted, superseded };
    })
    .immediate();
}

/** #17: a retryable failure books a 60 s backoff; the attempt that reaches the
 *  cap simply gets no retry time, which is what stops the gate asking.
 *
 *  F2: `error_code` ALWAYS names the cause. The cap used to overwrite it, so a
 *  read that died six times on prose validation reported `attempt_cap` to the
 *  desk and told it nothing. The cap is recorded in the error TEXT instead
 *  (`cappedAttempt` reads it back). */
export function finalizeReadFailed(
  db: Database.Database,
  args: { readId: number; token: string; error: string; errorCode: ReadErrorCode; nowMs: number; retryable: boolean },
): boolean {
  return db
    .transaction((): boolean => {
      const row = liveClaim(db, args.readId, args.token);
      if (!row) return false;
      const attempts = totalAttempts(db, row.print_id, row.fingerprint);
      const capped = attempts >= READ_MAX_ATTEMPTS;
      const retry = args.retryable && !capped ? iso(args.nowMs + READ_RETRY_BACKOFF_MS) : null;
      const error =
        capped && args.retryable
          ? `${ATTEMPT_CAP_PREFIX} (${attempts}/${READ_MAX_ATTEMPTS}): ${args.error}`
          : args.error;
      return (
        db
          .prepare(
            `UPDATE print_watch_reads SET status = 'failed', error = ?, error_code = ?, next_retry_at = ?, heartbeat_at = ?
              WHERE id = ? AND claim_token = ? AND status = 'generating'`,
          )
          .run(
            error.slice(0, 500),
            args.errorCode,
            retry,
            iso(args.nowMs),
            args.readId,
            args.token,
          ).changes === 1
      );
    })
    .immediate();
}

/** #29: the inputs drifted mid-generation — retire our own claim without a failure. */
export function markReadSuperseded(db: Database.Database, readId: number, token: string): boolean {
  return (
    db
      .prepare(`UPDATE print_watch_reads SET status = 'superseded' WHERE id = ? AND claim_token = ? AND status = 'generating'`)
      .run(readId, token).changes === 1
  );
}

export function getLatestDoneRead(db: Database.Database, printId: number): ReadRow | null {
  return (
    (db.prepare(`SELECT * FROM print_watch_reads WHERE print_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1`).get(printId) as
      | ReadRow
      | undefined) ?? null
  );
}

/** #15: what the page shows BESIDE the done read — the newest row when it is
 *  still working or has failed (and therefore newer than any done row). */
export function getActiveRead(db: Database.Database, printId: number): ReadRow | null {
  const newest = db.prepare(`SELECT * FROM print_watch_reads WHERE print_id = ? ORDER BY id DESC LIMIT 1`).get(printId) as
    | ReadRow
    | undefined;
  if (!newest || (newest.status !== "generating" && newest.status !== "failed")) return null;
  return newest;
}

export function listReads(db: Database.Database, printId: number): ReadRow[] {
  return db.prepare(`SELECT * FROM print_watch_reads WHERE print_id = ? ORDER BY id`).all(printId) as ReadRow[];
}

/** #16/#17: the reconcile's gate — schedule only when nothing done or live-generating
 *  exists for this fingerprint and no backoff/cap applies. A generating row whose
 *  heartbeat has gone stale IS schedulable (claimRead takes it over). */
/** F10: LIVE work only — what the panel may call "reading…". A terminal or
 *  retry-pending failure is not live and belongs under `lastAttempt`. */
export function getGeneratingRead(db: Database.Database, printId: number): ReadRow | null {
  return (
    (db
      .prepare(`SELECT * FROM print_watch_reads WHERE print_id = ? AND status = 'generating' ORDER BY id DESC LIMIT 1`)
      .get(printId) as ReadRow | undefined) ?? null
  );
}

/** F10: the newest FAILED row, with the two things the panel cannot derive on
 *  its own — whether it gave up (`capped`) and how many attempts the cap
 *  actually counted (`totalAttempts`, summed across every row for this
 *  fingerprint, not just this row's). */
export function getLastFailedAttempt(
  db: Database.Database,
  printId: number,
): { row: ReadRow; capped: boolean; totalAttempts: number } | null {
  const row = db
    .prepare(`SELECT * FROM print_watch_reads WHERE print_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1`)
    .get(printId) as ReadRow | undefined;
  if (!row) return null;
  return { row, capped: cappedAttempt(row), totalAttempts: totalAttempts(db, printId, row.fingerprint) };
}

export function canScheduleRead(db: Database.Database, printId: number, fingerprint: string, nowMs: number): boolean {
  const newest = newestFor(db, printId, fingerprint);
  if (!newest) return true;
  if (newest.status === "done") return false;
  if (newest.status === "generating") return nowMs - Date.parse(newest.heartbeat_at ?? "0") > READ_HEARTBEAT_STALE_MS;
  if (newest.status === "superseded") return true;
  if (isTerminal(newest.error_code)) return false;
  if (totalAttempts(db, printId, fingerprint) >= READ_MAX_ATTEMPTS) return false;
  return !newest.next_retry_at || Date.parse(newest.next_retry_at) <= nowMs;
}

// The documents table is aliased `d` because ELIGIBLE_SQL (store.ts) is written
// against that alias. M-D12: a callout whose document row was deleted (slice B's
// merge handler drops byte-twins, ON DELETE SET NULL) re-resolves through B's
// content identity, print_watch_documents.sha256.
const CALLOUT_VIEW_SQL = `
  SELECT c.*, d.kind AS doc_kind,
         CASE WHEN d.id IS NOT NULL AND ${ELIGIBLE_SQL} THEN 1 ELSE 0 END AS doc_ok
    FROM print_watch_callouts c
    LEFT JOIN print_watch_documents d
      ON d.id = COALESCE(c.doc_id, (SELECT d2.id FROM print_watch_documents d2 WHERE d2.print_id = c.print_id AND d2.sha256 = c.doc_sha256 ORDER BY d2.id LIMIT 1))`;

type CalloutViewRow = CalloutRow & { doc_kind: string | null; doc_ok: number };

function toView(r: CalloutViewRow): CalloutView {
  const { doc_ok, ...rest } = r;
  return {
    ...rest,
    effective_state: rest.state === "accepted" || rest.state === "proposed" ? (doc_ok ? rest.state : "revoked") : rest.state,
  };
}

/** M-D11 + #13: the document decides. A callout standing on a document that is
 *  gone or no longer eligible READS revoked before any row is rewritten. */
export function listCallouts(db: Database.Database, printId: number): CalloutView[] {
  return (db.prepare(`${CALLOUT_VIEW_SQL} WHERE c.print_id = ? ORDER BY c.id`).all(printId) as CalloutViewRow[]).map(toView);
}

/** #12: one immediate transaction — eligibility join + verifier version + state CAS. */
export function acceptCallout(
  db: Database.Database,
  calloutId: number,
  accept: boolean,
  opts: { nowMs: number; verifierVersion: number },
): AcceptCalloutResult {
  return db
    .transaction((): AcceptCalloutResult => {
      const row = db.prepare(`${CALLOUT_VIEW_SQL} WHERE c.id = ?`).get(calloutId) as CalloutViewRow | undefined;
      if (!row) return { ok: false, reason: "not_found" };
      const view = toView(row);
      if (view.effective_state === "revoked") return { ok: false, reason: "revoked" };
      if (view.effective_state === "superseded") return { ok: false, reason: "superseded" };
      if (view.verifier_version !== opts.verifierVersion) return { ok: false, reason: "stale_verifier" };
      const target = accept ? "accepted" : "proposed";
      const changes = db
        .prepare(`UPDATE print_watch_callouts SET state = ?, accepted_at = ?, updated_at = ? WHERE id = ? AND state = ?`)
        .run(target, accept ? iso(opts.nowMs) : null, iso(opts.nowMs), calloutId, view.state).changes;
      if (changes !== 1) return { ok: false, reason: "changed" };
      return { ok: true, callout: db.prepare(`SELECT * FROM print_watch_callouts WHERE id = ?`).get(calloutId) as CalloutRow };
    })
    .immediate();
}

/** Durably record what listCallouts already reads: the document went away or
 *  lost its verdict, so the figures standing on it are revoked. */
export function revokeCalloutsForIneligibleDocs(db: Database.Database, printId: number, nowMs: number): number {
  return db
    .transaction((): number => {
      const ids = listCallouts(db, printId)
        .filter((c) => c.effective_state === "revoked" && c.state !== "revoked")
        .map((c) => c.id);
      if (ids.length === 0) return 0;
      const stmt = db.prepare(`UPDATE print_watch_callouts SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?`);
      let n = 0;
      for (const id of ids) n += stmt.run(iso(nowMs), iso(nowMs), id).changes;
      return n;
    })
    .immediate();
}
