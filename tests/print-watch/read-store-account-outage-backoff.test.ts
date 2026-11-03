/**
 * finalizeReadFailed — an account-outage failure (refunded attempt) waits 15
 * minutes, not 60 seconds. The refund means the attempt cap never stops the
 * loop, so the long backoff is what bounds it. Every identifier is synthetic.
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
  READ_RETRY_BACKOFF_MS,
  READ_ACCOUNT_OUTAGE_BACKOFF_MS,
} from "@/lib/print-watch/read-store";

let db: Database.Database;
let printId: number;
const T0 = Date.parse("2026-09-10T20:05:00Z");

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

function fail(refundAttempt: boolean) {
  const c = claimRead(db, printId, { fingerprint: "fp", recompute: () => "fp", nowMs: T0, modelId: "m" });
  if (c.kind !== "claimed") throw new Error(c.kind);
  expect(
    finalizeReadFailed(db, {
      readId: c.row.id,
      token: c.token,
      error: "cause",
      errorCode: "model_error",
      nowMs: T0,
      retryable: true,
      refundAttempt,
    }),
  ).toBe(true);
}

describe("finalizeReadFailed — account outage backoff", () => {
  it("a refunded retryable failure books a 15-minute backoff and refunds the attempt", () => {
    fail(true);
    const last = getLastFailedAttempt(db, printId)!;
    expect(READ_ACCOUNT_OUTAGE_BACKOFF_MS).toBe(15 * 60_000);
    expect(last.row.next_retry_at).toBe(new Date(T0 + 15 * 60_000).toISOString());
    expect(last.totalAttempts).toBe(0);
  });

  it("a non-refunded retryable failure still books the 60-second backoff", () => {
    fail(false);
    const last = getLastFailedAttempt(db, printId)!;
    expect(last.row.next_retry_at).toBe(new Date(T0 + READ_RETRY_BACKOFF_MS).toISOString());
  });

  it("canScheduleRead waits for the 15-minute mark after a refunded failure", () => {
    fail(true);
    expect(canScheduleRead(db, printId, "fp", T0 + 2 * 60_000)).toBe(false);
    expect(canScheduleRead(db, printId, "fp", T0 + 14 * 60_000)).toBe(false);
    expect(canScheduleRead(db, printId, "fp", T0 + 15 * 60_000 + 1)).toBe(true);
  });
});
