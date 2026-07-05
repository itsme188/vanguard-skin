/**
 * Coverage for the cross-process send-claim mutex (bug B3).
 *
 * The launchd shell's curl timeout + tsx fallback chain re-runs the earnings
 * email sweep while a first invocation is still mid-compose (Claude calls
 * run 60-180s each) — audit rows only land post-send, so an in-flight
 * candidate used to send twice. `earnings_emails`'s UNIQUE(event_id, phase)
 * doubles as a mutex: a claim row (`error='in_progress'`) is inserted BEFORE
 * composing, released on failure, and reaped after 30 min if stale.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  claimEarningsEmailSlot,
  releaseEarningsEmailClaim,
  reapStaleEarningsEmailClaims,
} from "@/lib/digest/send-earnings-email";

describe("earnings email claim slot", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const result = db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
         VALUES ('finnhub', 'earnings', '2026-07-05', 'AAPL earnings', 'AAPL', 'finnhub:AAPL:2026-07-05', '2026-06-29')`,
      )
      .run();
    eventId = result.lastInsertRowid as number;
  });

  it("first claim wins, concurrent second claim is refused", () => {
    const a = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(a).toEqual({ claimed: true, mode: "fresh" });
    const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(b.claimed).toBe(false);
    expect(b.reason).toBe("in_progress");
  });

  it("release deletes the claim so a retry can re-claim", () => {
    claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    releaseEarningsEmailClaim(db, eventId, "preview");
    const again = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(again.claimed).toBe(true);
  });

  it("stale in_progress claims (>30 min) can be taken over", () => {
    claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    db.prepare(
      `UPDATE earnings_emails SET sent_at = datetime('now', '-45 minutes')
        WHERE event_id = ? AND phase = 'preview'`,
    ).run(eventId);
    const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(b.claimed).toBe(true);
  });

  it("a completed row allows a manual re-fire (mode refire, no claim mutation)", () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'x@y.com', '# sent', NULL)`,
    ).run(eventId);
    const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(b).toEqual({ claimed: true, mode: "refire" });
  });

  it("reapStaleEarningsEmailClaims deletes only stale in_progress rows", () => {
    claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    db.prepare(
      `UPDATE earnings_emails SET sent_at = datetime('now', '-45 minutes')
        WHERE event_id = ?`,
    ).run(eventId);
    expect(reapStaleEarningsEmailClaims(db)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) c FROM earnings_emails").get(),
    ).toEqual({ c: 0 });
  });
});
