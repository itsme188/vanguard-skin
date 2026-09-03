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
 *     on top of its successor's [C-11].
 *
 * This file is a CROSS-SLICE CONTRACT: slice B calls `registerPrepareStep`
 * and `stableHash` through a shim. Export names and signatures are pinned.
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
export interface PrepareStepContext { now: () => number; }
export interface PrepareStepDefinition {
  fingerprint: (db: Database.Database, eventId: number) => string;
  run: (db: Database.Database, eventId: number, ctx: PrepareStepContext) => Promise<PrepareStepOutcome>;
}
export interface PrepareStepRow { event_id: number; step: string; status: PrepareStepStatus; input_fingerprint: string | null; attempts: number; last_error: string | null; updated_at: string; }
export interface PrepareRunReport { ran: number; done: number; pending: number; failed: number; skipped: number; }

export const PREPARE_MAX_ATTEMPTS = 5;
export const PREPARE_CLAIM_STALE_MS = 5 * 60_000;

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

/** Rows that could run now: pending, failed (< max attempts), stale claims, and done rows whose
 *  fingerprint drifted (checked in JS because the fingerprint is code-defined). */
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

export async function runPrepareSteps(db: Database.Database, opts: { eventId?: number; now?: () => number } = {}): Promise<PrepareRunReport> {
  bootstrapEarningsRegistries();                                            // [C-14] self-bootstrap
  const now = opts.now ?? (() => Date.now());
  const report: PrepareRunReport = { ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 };
  const ctx: PrepareStepContext = { now };
  const today = todayET(new Date(now()));
  // [C-10] Durable path: a sweep-style run (no eventId) first inserts any missing registered
  // step for every armed, unsuperseded, not-yet-past event, so an arm whose route-side enqueue
  // never happened (crash, or a step registered later) is picked up within one tick.
  if (opts.eventId == null) reconcileMissingPrepareSteps(db, today);
  for (const r of selectRunnable(db, { eventId: opts.eventId, today })) {
    const def = steps.get(r.step);
    if (!def) { report.skipped += 1; continue; }
    const fp = def.fingerprint(db, r.event_id);
    const staleBefore = sqlUtc(now() - PREPARE_CLAIM_STALE_MS);
    // Fingerprint drift resets status + attempts atomically, then the row is runnable again.
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
    if (r.status === "failed" && r.attempts >= PREPARE_MAX_ATTEMPTS) { report.skipped += 1; continue; }
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
    let outcome: PrepareStepOutcome;
    try { outcome = await def.run(db, r.event_id, ctx); }
    catch (err) { outcome = { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }; }
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
