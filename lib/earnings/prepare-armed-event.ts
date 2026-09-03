/**
 * Live print v2 slice A, spec §4.1 — "armed is as good as held".
 *
 * Arming an earnings worksheet must kick off the preparation a HELD name gets
 * for free: the newsletter bogey rescan, the vendor consensus row, the intel
 * pass, the IBKR contract id. This module is the registry those steps plug
 * into (Tasks 10/11 register the concrete four) plus the durable runner that
 * drives them off `earnings_prepare_steps`.
 *
 * Durability shape:
 *   - the ROUTE enqueues + kicks a pass for one event (fire-and-forget, D6);
 *   - the 15-minute SWEEP tick re-reconciles and re-runs everything runnable,
 *     so a crashed kick, a step registered after the arm, or an arm whose
 *     enqueue never happened is picked up within one tick [C-10];
 *   - work is claimed by compare-and-set on a fresh token and finalised by
 *     CAS on that same token, so a timed-out worker's outcome can never land
 *     on top of its successor's [C-11];
 *   - every step invocation carries a DEADLINE (`PREPARE_STEP_TIMEOUT_MS`,
 *     deliberately inside `PREPARE_CLAIM_STALE_MS` so the owner always
 *     finalises before any other runner could take the row over), because the
 *     sweep awaits this pass and a hung model call or TWS fetch would
 *     otherwise block the 15-minute earnings tick indefinitely [R13];
 *   - one bad row never starves the others: a step whose FINGERPRINT throws is
 *     failed on its own row and the pass carries on.
 *
 * Contract for step authors:
 *   - a long step MUST check `ctx.signal.aborted` between units of work (and
 *     forward `ctx.signal` to any fetch it makes) and bail promptly — the
 *     runner aborts the signal at the deadline and books the row `failed`
 *     whether or not the step notices;
 *   - side effects MUST stay idempotent upserts, because an aborted or
 *     superseded invocation can have written before it was cut off, and the
 *     row will be retried.
 *
 * This file is a CROSS-SLICE CONTRACT: slice B calls `registerPrepareStep`
 * and `stableHash` through a shim. Export names and signatures are pinned;
 * `PrepareStepContext.signal` is the one ADDITIVE extension (R13) — a step
 * declaring only `{ now }` stays assignable.
 */

import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { todayET } from "@/lib/calendar/date-utils";
import { bootstrapEarningsRegistries, __isBootstrapSuppressedForTests } from "./registry-bootstrap"; // lazy: called, never evaluated-into

export type PrepareStepStatus = "pending" | "claimed" | "done" | "failed";
export type PrepareStepOutcome =
  | { status: "done"; note?: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string };
export interface PrepareStepContext {
  now: () => number;
  /**
   * [R13] Aborted when the invocation blows `PREPARE_STEP_TIMEOUT_MS`. Steps
   * that do real I/O must forward it (fetch `{ signal }`) and/or check
   * `signal.aborted` between units of work; the runner books the row `failed`
   * at the deadline regardless.
   */
  signal: AbortSignal;
}
export interface PrepareStepDefinition {
  fingerprint: (db: Database.Database, eventId: number) => string;
  run: (db: Database.Database, eventId: number, ctx: PrepareStepContext) => Promise<PrepareStepOutcome>;
}
export interface PrepareStepRow { event_id: number; step: string; status: PrepareStepStatus; input_fingerprint: string | null; attempts: number; last_error: string | null; updated_at: string; }
/**
 * `ran` counts step INVOCATIONS; `done`/`pending`/`failed` count row outcomes.
 * They can disagree by design: a row whose fingerprint threw is booked
 * `failed` without the step ever being invoked.
 */
export interface PrepareRunReport {
  ran: number; done: number; pending: number; failed: number; skipped: number;
  /**
   * [F3] Present (and `true`) only when the pass-level budget stopped the run
   * before every runnable row had been reached. The rows it never started are
   * untouched — pending and unclaimed — so the next tick resumes them; the
   * field exists so a sweep summary can say so out loud instead of looking
   * like a quiet pass.
   */
  budgetExhausted?: true;
}

export const PREPARE_MAX_ATTEMPTS = 5;
export const PREPARE_CLAIM_STALE_MS = 5 * 60_000;
/**
 * [R13] Per-invocation deadline. Strictly INSIDE PREPARE_CLAIM_STALE_MS: the
 * owner always finalises (or is cut off and finalises `failed`) before its own
 * claim could look stale to another runner, so the deadline can never manufacture
 * the double-run the token CAS exists to prevent.
 */
export const PREPARE_STEP_TIMEOUT_MS = 4 * 60_000;
/**
 * [F3] Whole-pass wall-clock budget, checked BETWEEN rows. The per-invocation
 * deadline caps one step; it does nothing about N hung rows in a row, which at
 * 4 minutes each would run the 15-minute sweep tick into the next one. The row
 * in flight is never cut off by this (its claim is live and its finalisation
 * has to land) — the pass simply stops starting new ones, so a single
 * pathological step can still overrun by up to PREPARE_STEP_TIMEOUT_MS.
 */
export const PREPARE_PASS_BUDGET_MS = 5 * 60_000;

const steps = new Map<string, PrepareStepDefinition>();

export function registerPrepareStep(name: string, def: PrepareStepDefinition): void {
  if (steps.has(name)) throw new Error(`prepare: duplicate step "${name}"`);
  steps.set(name, def);
}
export function listPrepareSteps(): string[] { return [...steps.keys()]; }
/** Clears the registry AND suppresses the lazy bootstrap for this process (tests own the registry). */
export function __resetPrepareStepsForTests(): void { steps.clear(); __isBootstrapSuppressedForTests(true); }

export function stableHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function enqueuePrepareSteps(db: Database.Database, eventId: number): number {
  bootstrapEarningsRegistries();                                            // [C-14] self-bootstrap
  const ins = db.prepare(`INSERT INTO earnings_prepare_steps (event_id, step) VALUES (?, ?) ON CONFLICT(event_id, step) DO NOTHING`);
  let n = 0;
  for (const name of steps.keys()) n += ins.run(eventId, name).changes;
  return n;
}

export function getPrepareStepRows(db: Database.Database, eventId: number): PrepareStepRow[] {
  return db.prepare(`SELECT event_id, step, status, input_fingerprint, attempts, last_error, updated_at FROM earnings_prepare_steps WHERE event_id = ? ORDER BY step`).all(eventId) as PrepareStepRow[];
}

/** [C-10] One pending row per (armed future event, registered step) that is missing. Idempotent. */
export function reconcileMissingPrepareSteps(db: Database.Database, today: string): number {
  const ins = db.prepare(
    `INSERT INTO earnings_prepare_steps (event_id, step)
     SELECT f.event_id, ? FROM earnings_worksheet_flags f JOIN calendar_events ce ON ce.id = f.event_id
      WHERE ce.event_date >= ? AND COALESCE(ce.superseded, 0) = 0
     ON CONFLICT(event_id, step) DO NOTHING`,
  );
  let n = 0;
  for (const name of steps.keys()) n += ins.run(name, today).changes;
  return n;
}

// [C-11] Step side effects are idempotent upserts by construction (consensus_row upsert keyed
// on the finnhub label, newsletter bogeys preserve-upserted per issue, intel behind its TTL,
// contract-id enrich), so a stale runner whose finalisation is rejected can only REPEAT a
// write, never corrupt one — the token guards status and attempts, the upserts guard the data.

interface Runnable { event_id: number; step: string; status: PrepareStepStatus; input_fingerprint: string | null; attempts: number; claimed_at: string | null; }

/** SQLite `datetime()`-comparable UTC stamp ("YYYY-MM-DD HH:MM:SS") for an epoch-ms instant. */
function sqlUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function humanMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** Every row in scope; the loop then decides. Runnable in practice: pending, failed and
 *  stale-claimed rows under the attempt cap, plus done rows whose fingerprint drifted
 *  (drift is checked in JS because the fingerprint is code-defined, not a column). */
function selectRunnable(db: Database.Database, opts: { eventId?: number; today: string }): Runnable[] {
  const where = opts.eventId != null ? `p.event_id = ?` : `ce.event_date >= ? AND COALESCE(ce.superseded, 0) = 0 AND EXISTS (SELECT 1 FROM earnings_worksheet_flags f WHERE f.event_id = ce.id)`;
  const arg = opts.eventId != null ? opts.eventId : opts.today;
  return db.prepare(
    `SELECT p.event_id, p.step, p.status, p.input_fingerprint, p.attempts, p.claimed_at
       FROM earnings_prepare_steps p JOIN calendar_events ce ON ce.id = p.event_id
      WHERE ${where}
      ORDER BY p.event_id, p.step`,
  ).all(arg) as Runnable[];
}

export async function runPrepareSteps(
  db: Database.Database,
  opts: {
    eventId?: number;
    now?: () => number;
    /** [R13] Per-invocation deadline override. Tests only — production uses the constant. */
    stepTimeoutMs?: number;
    /** [F3] Whole-pass budget override. Tests only — production uses the constant. */
    passBudgetMs?: number;
  } = {},
): Promise<PrepareRunReport> {
  bootstrapEarningsRegistries();                                            // [C-14] self-bootstrap
  const now = opts.now ?? (() => Date.now());
  const stepTimeoutMs = opts.stepTimeoutMs ?? PREPARE_STEP_TIMEOUT_MS;
  const passBudgetMs = opts.passBudgetMs ?? PREPARE_PASS_BUDGET_MS;
  const passStart = now();
  const report: PrepareRunReport = { ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 };
  const today = todayET(new Date(now()));
  // [C-10] Durable path: a sweep-style run (no eventId) first inserts any missing registered
  // step for every armed, unsuperseded, not-yet-past event, so an arm whose route-side enqueue
  // never happened (crash, or a step registered later) is picked up within one tick.
  if (opts.eventId == null) reconcileMissingPrepareSteps(db, today);
  for (const r of selectRunnable(db, { eventId: opts.eventId, today })) {
    // [F3] Budget check BEFORE claiming the next row, never mid-row: a claimed
    // row must reach its finalisation, and a row we simply never start stays
    // pending with its attempts intact for the next tick. Nothing is counted
    // as skipped here — skipped means "considered and declined", and these
    // were not considered at all.
    if (now() - passStart > passBudgetMs) {
      report.budgetExhausted = true;
      console.warn(
        `[prepare] pass budget ${humanMs(passBudgetMs)} exhausted — stopping before ${r.step} on event ${r.event_id}; the remaining rows resume next tick`,
      );
      break;
    }
    const def = steps.get(r.step);
    if (!def) { report.skipped += 1; continue; }
    const staleBefore = sqlUtc(now() - PREPARE_CLAIM_STALE_MS);
    /** Mark the row spent. Guarded like every other out-of-band write here: a LIVE
     *  claim belongs to its worker. Nulls the token so no stale worker can finalise
     *  by CAS on a token that outlived its window. */
    const retireRow = (lastError: string): number =>
      db.prepare(
        `UPDATE earnings_prepare_steps
            SET status = 'failed', last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ?
            AND NOT (status = 'claimed' AND datetime(claimed_at) >= datetime(?))`,
      ).run(lastError, r.event_id, r.step, staleBefore).changes;

    // ORDER MATTERS, and it is fingerprint-FIRST. Drift is what revives a spent row
    // ("a change of inputs resets the row to pending", and Task 7's merge moves a
    // donor row keeping its status/attempts precisely so this pass can re-derive the
    // fingerprint against the TARGET event and reset it). Checking the cap ahead of
    // the fingerprint would make a row that failed five ticks terminal FOREVER — the
    // newsletter lands, the fingerprint drifts, and nothing ever notices.
    //
    // The fingerprint is the STEP's own code (it reads columns, parses JSON, derefs
    // rows), so a throw is that row's failure — never the pass's. Booking it here
    // instead of letting it reject runPrepareSteps is what stops one malformed row
    // from starving every other step on every armed event, tick after tick.
    let fp: string;
    try {
      fp = def.fingerprint(db, r.event_id);
    } catch (err) {
      const msg = errText(err);
      if (r.attempts >= PREPARE_MAX_ATTEMPTS) {
        // Already spent. Don't keep counting: a fingerprint that throws can never
        // drift (computing it is exactly what fails), so there is nothing left to
        // revive this row and nothing to learn from a sixth identical error.
        if (r.status !== "failed") retireRow(`retired: ${PREPARE_MAX_ATTEMPTS} attempts exhausted; fingerprint: ${msg}`);
        report.skipped += 1;
        continue;
      }
      const lastError =
        r.attempts + 1 >= PREPARE_MAX_ATTEMPTS
          ? `retired: ${PREPARE_MAX_ATTEMPTS} attempts exhausted; fingerprint: ${msg}`
          : `fingerprint: ${msg}`;
      const marked = db.prepare(
        `UPDATE earnings_prepare_steps
            SET status = 'failed', attempts = attempts + 1, last_error = ?,
                claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ?
            AND NOT (status = 'claimed' AND datetime(claimed_at) >= datetime(?))`,
      ).run(lastError, r.event_id, r.step, staleBefore).changes;
      if (marked > 0) report.failed += 1; else report.skipped += 1;
      console.warn(`[prepare] ${r.step} for event ${r.event_id}: fingerprint failed: ${msg}`);
      continue;
    }
    // Fingerprint drift resets status + attempts atomically, then the row is runnable
    // again — INCLUDING a row that had reached the attempt cap, which is the whole
    // point of doing this before the cap check below.
    // [C-11] Never clears a LIVE claim: a fresh 'claimed' row is left for its worker to finish.
    if (r.input_fingerprint != null && r.input_fingerprint !== fp) {
      const reset = db.prepare(
        `UPDATE earnings_prepare_steps SET status = 'pending', attempts = 0, last_error = NULL, claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ? AND NOT (status = 'claimed' AND datetime(claimed_at) >= datetime(?))`,
      ).run(r.event_id, r.step, staleBefore).changes;
      if (reset === 0) { report.skipped += 1; continue; }
      r.status = "pending"; r.attempts = 0;
    }
    if (r.status === "done") { continue; }
    // [R14] The cap retires ANY spent row, not just an already-'failed' one — a row
    // stuck at 'claimed' (its owner died) was otherwise taken over every tick forever:
    // attempts climbed past the cap with no effect while the step's side effect was
    // re-invoked each time. Read against the row's CURRENT attempts, so a drift reset
    // just above (attempts = 0) has already revived it. A LIVE claim is exempt via
    // retireRow's guard — its owner is still working and will finalise it.
    if (r.attempts >= PREPARE_MAX_ATTEMPTS) {
      if (r.status !== "failed" && retireRow(`retired: ${PREPARE_MAX_ATTEMPTS} attempts exhausted`) > 0) {
        console.warn(
          `[prepare] ${r.step} for event ${r.event_id}: retired after ${PREPARE_MAX_ATTEMPTS} attempts`,
        );
      }
      report.skipped += 1;
      continue;
    }
    const token = randomUUID();
    const claimed = db.prepare(
      `UPDATE earnings_prepare_steps
          SET status = 'claimed', claim_token = ?, claimed_at = datetime(?), updated_at = datetime('now'),
              attempts = attempts + CASE WHEN status = 'claimed' THEN 1 ELSE 0 END   -- [C-11] a stale-claim takeover counts the dead attempt
        WHERE event_id = ? AND step = ?
          AND (status IN ('pending','failed') OR (status = 'claimed' AND datetime(claimed_at) < datetime(?)))`,
    ).run(token, sqlUtc(now()), r.event_id, r.step, staleBefore).changes;
    if (claimed === 0) { report.skipped += 1; continue; }
    report.ran += 1;
    // [R13] Race the step against its deadline. The sweep AWAITS this pass, so a
    // step that never settles (a hung model call, a TWS socket that stalls) would
    // otherwise wedge the 15-minute earnings tick forever.
    let outcome: PrepareStepOutcome;
    const controller = new AbortController();
    const ctx: PrepareStepContext = { now, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = def.run(db, r.event_id, ctx);
      // A late rejection (the step throws AFTER the deadline won the race) must not
      // surface as an unhandled rejection — the race already has its verdict.
      running.catch(() => {});
      const TIMED_OUT = "__prepare_timeout__" as const;
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), stepTimeoutMs);
      });
      const raced = await Promise.race([running, deadline]);
      if (raced === TIMED_OUT) {
        controller.abort();
        outcome = { status: "failed", error: `timed out after ${humanMs(stepTimeoutMs)}` };
      } else {
        outcome = raced;
      }
    } catch (err) {
      outcome = { status: "failed", error: errText(err) };
    } finally {
      // Always clear it: an uncleared 4-minute timer per fast step would keep the
      // process (and a short-lived tsx sweep) alive for no reason.
      clearTimeout(timer);
    }
    // Compare-and-set on the token: a superseded worker's outcome never lands.
    const finalize = (status: PrepareStepStatus, attemptsDelta: number, lastError: string | null, fingerprint: string | null) =>
      db.prepare(
        `UPDATE earnings_prepare_steps
            SET status = ?, attempts = attempts + ?, last_error = ?, input_fingerprint = COALESCE(?, input_fingerprint),
                claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ? AND claim_token = ?`,
      ).run(status, attemptsDelta, lastError, fingerprint, r.event_id, r.step, token).changes;
    let landed = 0;
    if (outcome.status === "done") { landed = finalize("done", 1, null, fp); report.done += 1; }
    else if (outcome.status === "pending") { landed = finalize("pending", 0, outcome.reason.slice(0, 300), null); report.pending += 1; }
    else { landed = finalize("failed", 1, outcome.error.slice(0, 300), fp); report.failed += 1; }
    if (landed === 0) console.warn(`[prepare] ${r.step} for event ${r.event_id}: finalisation rejected (claim superseded)`);
  }
  return report;
}
