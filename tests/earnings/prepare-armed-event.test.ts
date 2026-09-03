/**
 * Live print v2 slice A, spec §4.1 — the prepare registry + runner.
 *
 * Arming an earnings worksheet must kick off the preparation a HELD name
 * gets for free. The registry is the seam the four concrete steps plug into
 * (Tasks 10/11); this file pins the runner's durability contract:
 *   - enqueue is idempotent, one row per registered step;
 *   - a "pending" outcome (a dependency is simply down) is NOT an attempt;
 *   - a "failed" outcome is, and five of them retire the row;
 *   - a fingerprint change re-runs a done step — but never steals a LIVE claim;
 *   - claims are compare-and-set on a fresh token, so a timed-out worker's
 *     finalisation can never land on top of its successor's.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  registerPrepareStep,
  listPrepareSteps,
  __resetPrepareStepsForTests,
  enqueuePrepareSteps,
  runPrepareSteps,
  getPrepareStepRows,
  stableHash,
  PREPARE_MAX_ATTEMPTS,
} from "@/lib/earnings/prepare-armed-event";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  __resetPrepareStepsForTests();
});
afterEach(() => __resetPrepareStepsForTests());

const seedArmed = (date = "2026-09-03") => {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings',?,'BETA','k'||?,'BETA')`,
      )
      .run(date, date).lastInsertRowid,
  );
  armWorksheet(db, id);
  return id;
};

const row = (eventId: number, step: string) =>
  db
    .prepare(
      `SELECT status, attempts, input_fingerprint, claim_token, last_error FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`,
    )
    .get(eventId, step) as {
    status: string;
    attempts: number;
    input_fingerprint: string | null;
    claim_token: string | null;
    last_error: string | null;
  };

describe("prepare registry + runner (spec §4.1 prepare work table)", () => {
  it("enqueue inserts one pending row per registered step and is idempotent", () => {
    registerPrepareStep("a", { fingerprint: () => "fa", run: async () => ({ status: "done" }) });
    registerPrepareStep("b", { fingerprint: () => "fb", run: async () => ({ status: "done" }) });
    expect(() =>
      registerPrepareStep("a", { fingerprint: () => "", run: async () => ({ status: "done" }) }),
    ).toThrow(/duplicate/);
    const id = seedArmed();
    expect(enqueuePrepareSteps(db, id)).toBe(2);
    expect(enqueuePrepareSteps(db, id)).toBe(0);
    expect(listPrepareSteps()).toEqual(["a", "b"]);
    expect(getPrepareStepRows(db, id).map((r) => [r.step, r.status])).toEqual([
      ["a", "pending"],
      ["b", "pending"],
    ]);
  });

  it("runs pending steps, records the fingerprint, and a 'pending' outcome does not count as an attempt", async () => {
    let twsUp = false;
    registerPrepareStep("con_id", {
      fingerprint: () => "f1",
      run: async () => (twsUp ? { status: "done" } : { status: "pending", reason: "TWS offline" }),
    });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({
      ran: 1,
      done: 0,
      pending: 1,
      failed: 0,
      skipped: 0,
    });
    expect(row(id, "con_id")).toMatchObject({
      status: "pending",
      attempts: 0,
      last_error: "TWS offline",
      claim_token: null,
    });
    twsUp = true;
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({
      ran: 1,
      done: 1,
      pending: 0,
      failed: 0,
      skipped: 0,
    });
    expect(row(id, "con_id")).toMatchObject({ status: "done", attempts: 1, input_fingerprint: "f1" });
  });

  it("a failed step retries up to PREPARE_MAX_ATTEMPTS then is skipped", async () => {
    registerPrepareStep("x", {
      fingerprint: () => "f",
      run: async () => ({ status: "failed", error: "boom" }),
    });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    for (let i = 1; i <= PREPARE_MAX_ATTEMPTS; i++) {
      expect((await runPrepareSteps(db, { eventId: id })).failed).toBe(1);
      expect(row(id, "x")).toMatchObject({ status: "failed", attempts: i, last_error: "boom" });
    }
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({
      ran: 0,
      done: 0,
      pending: 0,
      failed: 0,
      skipped: 1,
    });
  });

  it("a done step re-runs when its fingerprint changes (status and attempts reset atomically)", async () => {
    let fp = "v1";
    let runs = 0;
    registerPrepareStep("consensus_row", {
      fingerprint: () => fp,
      run: async () => {
        runs += 1;
        return { status: "done" };
      },
    });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    await runPrepareSteps(db, { eventId: id });
    await runPrepareSteps(db, { eventId: id });
    expect(runs).toBe(1);
    fp = "v2";
    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, done: 1 });
    expect(runs).toBe(2);
    expect(row(id, "consensus_row")).toMatchObject({
      status: "done",
      attempts: 1,
      input_fingerprint: "v2",
    });
  });

  it("a timed-out worker's finalisation is rejected by the claim token CAS", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    registerPrepareStep("slow", {
      fingerprint: () => "f",
      run: async () => {
        await gate;
        return { status: "done", note: "old worker" };
      },
    });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    let t = 0;
    const oldRun = runPrepareSteps(db, { eventId: id, now: () => t }); // claims with token T1 at t=0
    t = 6 * 60_000; // > PREPARE_CLAIM_STALE_MS
    __resetPrepareStepsForTests();
    registerPrepareStep("slow", {
      fingerprint: () => "f",
      run: async () => ({ status: "failed", error: "new worker" }),
    });
    await runPrepareSteps(db, { eventId: id, now: () => t }); // takes over: token T2, finalises failed
    release();
    await oldRun; // old finalisation must be a no-op
    // attempts = 1 (the dead claim, counted at takeover) + 1 (the new worker's failed run) [C-11]
    expect(row(id, "slow")).toMatchObject({
      status: "failed",
      last_error: "new worker",
      attempts: 2,
    });
  });

  it("[C-11] a fingerprint change never clears a LIVE claim", async () => {
    let fp = "v1";
    registerPrepareStep("s", { fingerprint: () => fp, run: async () => ({ status: "done" }) });
    const id = seedArmed();
    enqueuePrepareSteps(db, id);
    db.prepare(
      `UPDATE earnings_prepare_steps SET status = 'claimed', claim_token = 'live', claimed_at = datetime('now'), input_fingerprint = 'v1' WHERE event_id = ?`,
    ).run(id);
    fp = "v2";
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({
      ran: 0,
      done: 0,
      pending: 0,
      failed: 0,
      skipped: 1,
    });
    expect(row(id, "s")).toMatchObject({ status: "claimed", claim_token: "live" });
  });

  it("runs only events on/after today (ET) when no eventId is given; superseded and unarmed events are skipped", async () => {
    registerPrepareStep("a", { fingerprint: () => "f", run: async () => ({ status: "done" }) });
    const future = seedArmed("2026-09-05");
    const past = seedArmed("2026-08-20");
    // Same day as `future`, but non-canonical after a date cross-check.
    const superseded = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded) VALUES ('manual','earnings','2026-09-05','BETA','k-superseded','BETA',1)`,
        )
        .run().lastInsertRowid,
    );
    armWorksheet(db, superseded);
    // Future, never armed — rows can exist from a disarm, but must not run.
    const unarmed = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-05','GAMMA','k-unarmed','GAMMA')`,
        )
        .run().lastInsertRowid,
    );
    for (const id of [future, past, superseded, unarmed]) enqueuePrepareSteps(db, id);
    const out = await runPrepareSteps(db, { now: () => Date.parse("2026-09-02T18:00:00Z") });
    expect(out.done).toBe(1);
    expect(row(future, "a").status).toBe("done");
    expect(row(past, "a").status).toBe("pending");
    expect(row(superseded, "a").status).toBe("pending");
    expect(row(unarmed, "a").status).toBe("pending");
  });

  it("[C-10] a sweep-style run inserts the missing rows for an armed future event that was never enqueued (durable path)", async () => {
    registerPrepareStep("a", { fingerprint: () => "f", run: async () => ({ status: "done" }) });
    const id = seedArmed("2026-09-05"); // armed, NO enqueuePrepareSteps
    const out = await runPrepareSteps(db, { now: () => Date.parse("2026-09-02T18:00:00Z") });
    expect(out).toMatchObject({ ran: 1, done: 1 });
    expect(getPrepareStepRows(db, id).map((r) => [r.step, r.status])).toEqual([["a", "done"]]);
  });

  it("stableHash is deterministic and order-sensitive", () => {
    expect(stableHash([1, "a", null])).toBe(stableHash([1, "a", null]));
    expect(stableHash([1, "a"])).not.toBe(stableHash(["a", 1]));
    expect(stableHash([1])).toMatch(/^[0-9a-f]{64}$/);
  });
});
