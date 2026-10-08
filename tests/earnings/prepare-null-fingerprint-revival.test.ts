/**
 * Prepare runner — a CAPPED row with no stored fingerprint.
 *
 * A row reaches the attempt cap without ever storing a fingerprint when the
 * fingerprint itself threw on every attempt (or its owner died on every
 * claim). Drift is what revives a spent row, and drift was only ever judged
 * against a stored fingerprint, so such a row was terminal forever — even
 * after the fingerprint became readable again.
 *
 * The rule pinned here: for a CAPPED, not-done row, "no stored fingerprint"
 * counts as drifted. The revival writes the real fingerprint in the same
 * statement, which is the bound: a second revival needs a real change.
 * Every identifier is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  registerPrepareStep,
  __resetPrepareStepsForTests,
  enqueuePrepareSteps,
  runPrepareSteps,
  PREPARE_MAX_ATTEMPTS,
  type PrepareStepOutcome,
} from "@/lib/earnings/prepare-armed-event";

let db: Database.Database;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  __resetPrepareStepsForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  __resetPrepareStepsForTests();
  warn.mockRestore();
});

const seedArmed = () => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-03','AAA','k-aaa','AAA')`,
      )
      .run().lastInsertRowid,
  );
  armWorksheet(db, id);
  return id;
};

const row = (eventId: number) =>
  db
    .prepare(
      `SELECT status, attempts, input_fingerprint, claim_token, last_error FROM earnings_prepare_steps WHERE event_id = ? AND step = 's'`,
    )
    .get(eventId) as {
    status: string;
    attempts: number;
    input_fingerprint: string | null;
    claim_token: string | null;
    last_error: string | null;
  };

/** One step "s" whose fingerprint and outcome the test controls. */
function harness(initial: PrepareStepOutcome = { status: "done" }) {
  const h = { runs: 0, fpThrows: false, fp: "v1", outcome: initial };
  registerPrepareStep("s", {
    fingerprint: () => {
      if (h.fpThrows) throw new Error("unreadable");
      return h.fp;
    },
    run: async () => {
      h.runs += 1;
      return h.outcome;
    },
  });
  return h;
}

const setRow = (id: number, sql: string, ...args: unknown[]) =>
  db.prepare(`UPDATE earnings_prepare_steps SET ${sql} WHERE event_id = ?`).run(...args, id);

const SKIPPED_ONLY = { ran: 0, done: 0, pending: 0, failed: 0, skipped: 1 };

describe("prepare runner — capped row with a NULL fingerprint", () => {
  it("a row capped by a throwing fingerprint revives once the fingerprint is readable, and only once", async () => {
    const h = harness();
    const id = seedArmed();
    enqueuePrepareSteps(db, id);

    h.fpThrows = true;
    for (let i = 0; i < PREPARE_MAX_ATTEMPTS; i++) await runPrepareSteps(db, { eventId: id });
    expect(row(id)).toMatchObject({ status: "failed", attempts: PREPARE_MAX_ATTEMPTS, input_fingerprint: null });
    // Still unreadable: still spent.
    expect(await runPrepareSteps(db, { eventId: id })).toEqual(SKIPPED_ONLY);
    expect(h.runs).toBe(0);

    h.fpThrows = false;
    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, done: 1 });
    expect(h.runs).toBe(1);
    expect(row(id)).toMatchObject({ status: "done", attempts: 1, input_fingerprint: "v1", last_error: null });

    // No loop: nothing changed, nothing runs.
    await runPrepareSteps(db, { eventId: id });
    await runPrepareSteps(db, { eventId: id });
    expect(h.runs).toBe(1);
  });

  it("a revived row that keeps failing is retired at the cap for good — one revival, not one per cap", async () => {
    const h = harness({ status: "failed", error: "boom" });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    setRow(id, `status = 'failed', attempts = ?, input_fingerprint = NULL, last_error = 'old'`, PREPARE_MAX_ATTEMPTS);

    for (let i = 0; i < PREPARE_MAX_ATTEMPTS * 3; i++) await runPrepareSteps(db, { eventId: id });
    expect(h.runs).toBe(PREPARE_MAX_ATTEMPTS);
    expect(row(id)).toMatchObject({ status: "failed", attempts: PREPARE_MAX_ATTEMPTS, input_fingerprint: "v1" });
    expect(await runPrepareSteps(db, { eventId: id })).toEqual(SKIPPED_ONLY);

    // A REAL change still revives it.
    h.fp = "v2";
    h.outcome = { status: "done" };
    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, done: 1 });
    expect(row(id)).toMatchObject({ status: "done", attempts: 1, input_fingerprint: "v2" });
  });

  it("the revival itself stores the fingerprint, so a 'pending' outcome or a dead owner cannot earn a second revival", async () => {
    const h = harness({ status: "pending", reason: "dependency down" });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    setRow(id, `status = 'failed', attempts = ?, input_fingerprint = NULL`, PREPARE_MAX_ATTEMPTS);

    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, pending: 1 });
    // 'pending' finalises with no fingerprint of its own; the revival wrote it.
    expect(row(id)).toMatchObject({ status: "pending", attempts: 0, input_fingerprint: "v1" });

    // The owner now dies on every claim until the cap: stale claim, spent.
    setRow(
      id,
      `status = 'claimed', claim_token = 'dead', claimed_at = datetime('now','-10 minutes'), attempts = ?`,
      PREPARE_MAX_ATTEMPTS,
    );
    const before = h.runs;
    expect(await runPrepareSteps(db, { eventId: id })).toEqual(SKIPPED_ONLY);
    expect(await runPrepareSteps(db, { eventId: id })).toEqual(SKIPPED_ONLY);
    expect(h.runs).toBe(before);
    expect(row(id)).toMatchObject({ status: "failed", attempts: PREPARE_MAX_ATTEMPTS, input_fingerprint: "v1" });
  });

  it("a stale-claimed capped row with a NULL fingerprint is revived too", async () => {
    const h = harness();
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    setRow(
      id,
      `status = 'claimed', claim_token = 'dead', claimed_at = datetime('now','-10 minutes'), attempts = ?, input_fingerprint = NULL`,
      PREPARE_MAX_ATTEMPTS,
    );
    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, done: 1 });
    expect(h.runs).toBe(1);
    expect(row(id)).toMatchObject({ status: "done", attempts: 1, input_fingerprint: "v1", claim_token: null });
  });

  it("a DONE row with a NULL fingerprint is never re-run — under the cap or at it", async () => {
    const h = harness();
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    for (const attempts of [1, PREPARE_MAX_ATTEMPTS, PREPARE_MAX_ATTEMPTS + 2]) {
      setRow(id, `status = 'done', attempts = ?, input_fingerprint = NULL`, attempts);
      expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 0, done: 0 });
      expect(row(id)).toMatchObject({ status: "done", attempts, input_fingerprint: null });
    }
    expect(h.runs).toBe(0);
  });

  it("a NULL fingerprint UNDER the cap is not drift: the row retries normally and keeps its attempt count", async () => {
    const h = harness({ status: "failed", error: "boom" });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    setRow(id, `status = 'failed', attempts = ?, input_fingerprint = NULL`, PREPARE_MAX_ATTEMPTS - 1);

    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, failed: 1 });
    expect(h.runs).toBe(1);
    // One below the cap + one counted attempt = the cap. No reset to zero.
    expect(row(id)).toMatchObject({ status: "failed", attempts: PREPARE_MAX_ATTEMPTS, input_fingerprint: "v1" });
    expect(await runPrepareSteps(db, { eventId: id })).toEqual(SKIPPED_ONLY);
    expect(h.runs).toBe(1);
  });

  it("a LIVE claim at the cap with a NULL fingerprint is left for its own worker", async () => {
    const h = harness();
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    setRow(
      id,
      `status = 'claimed', claim_token = 'alive', claimed_at = datetime('now'), attempts = ?, input_fingerprint = NULL`,
      PREPARE_MAX_ATTEMPTS,
    );
    await runPrepareSteps(db, { eventId: id });
    expect(h.runs).toBe(0);
    expect(row(id)).toMatchObject({ status: "claimed", claim_token: "alive", attempts: PREPARE_MAX_ATTEMPTS, input_fingerprint: null });
  });
});
