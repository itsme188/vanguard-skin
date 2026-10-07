/**
 * finalizeReadFailed — the "attempt cap reached" prefix (slice D minor (d)).
 *
 * The prefix was written only for a RETRYABLE failure that landed at the cap.
 * A non-retryable failure landing on the same attempt got no prefix, so the
 * panel's label showed the cause with no "gave up" tail and `capped` read
 * false on a run that had in fact used every attempt. Scheduling was never
 * affected (the cap is judged from the attempt count) and still is not.
 * Every identifier is synthetic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint } from "@/lib/print-watch/store";
import {
  claimRead,
  finalizeReadFailed,
  getLastFailedAttempt,
  canScheduleRead,
  cappedAttempt,
  READ_MAX_ATTEMPTS,
  READ_RETRY_BACKOFF_MS,
} from "@/lib/print-watch/read-store";

let db: Database.Database;
let printId: number;
const T0 = Date.parse("2026-09-10T20:05:00Z");
const STEP = READ_RETRY_BACKOFF_MS + 1;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','AAA','k','AAA')`,
      )
      .run().lastInsertRowid,
  );
  printId = upsertPrint(db, eventId, "AAA", "2026-09-10", "16:05");
});

/** Fail attempt number `n` (1-based) of fingerprint "fp". */
function failAttempt(n: number, retryable: boolean, error = "cause text") {
  const nowMs = T0 + (n - 1) * STEP;
  const c = claimRead(db, printId, { fingerprint: "fp", recompute: () => "fp", nowMs, modelId: "m" });
  if (c.kind !== "claimed") throw new Error(`attempt ${n}: ${c.kind}`);
  expect(finalizeReadFailed(db, { readId: c.row.id, token: c.token, error, errorCode: retryable ? "model_error" : "model_drift", nowMs, retryable })).toBe(true);
}

describe("finalizeReadFailed — attempt cap prefix", () => {
  it("a NON-retryable failure landing at the cap carries the prefix and reads as capped", () => {
    for (let n = 1; n < READ_MAX_ATTEMPTS; n++) failAttempt(n, true);
    failAttempt(READ_MAX_ATTEMPTS, false, "model drifted");
    const last = getLastFailedAttempt(db, printId)!;
    expect(last.row.error).toBe(`attempt cap reached (${READ_MAX_ATTEMPTS}/${READ_MAX_ATTEMPTS}): model drifted`);
    expect(last.row.error_code).toBe("model_drift"); // the cause is still the code
    expect(last.row.next_retry_at).toBeNull();
    expect(last.capped).toBe(true);
    expect(cappedAttempt(last.row)).toBe(true);
    expect(last.totalAttempts).toBe(READ_MAX_ATTEMPTS);
    expect(canScheduleRead(db, printId, "fp", T0 + 100 * STEP)).toBe(false);
  });

  it("a non-retryable failure UNDER the cap keeps its bare cause and is not capped", () => {
    failAttempt(1, true);
    failAttempt(2, false, "model drifted");
    const last = getLastFailedAttempt(db, printId)!;
    expect(last.row.error).toBe("model drifted");
    expect(last.row.next_retry_at).toBeNull();
    expect(last.capped).toBe(false);
    expect(canScheduleRead(db, printId, "fp", T0 + 100 * STEP)).toBe(false); // terminal by its code, as before
  });

  it("a retryable failure at the cap is unchanged", () => {
    for (let n = 1; n <= READ_MAX_ATTEMPTS; n++) failAttempt(n, true);
    const last = getLastFailedAttempt(db, printId)!;
    expect(last.row.error).toBe(`attempt cap reached (${READ_MAX_ATTEMPTS}/${READ_MAX_ATTEMPTS}): cause text`);
    expect(last.capped).toBe(true);
  });
});
