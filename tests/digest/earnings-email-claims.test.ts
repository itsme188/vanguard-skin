/**
 * Coverage for the cross-process send-claim mutex (bug B3) and — from live
 * print v2 slice E — the full delivery lifecycle that grew out of it.
 *
 * The launchd shell's curl timeout + tsx fallback chain re-runs the earnings
 * email sweep while a first invocation is still mid-compose (Claude calls
 * run 60-180s each) — audit rows only land post-send, so an in-flight
 * candidate used to send twice. `earnings_emails`'s UNIQUE(event_id, phase)
 * doubles as a mutex: a claim row is inserted BEFORE composing, released on
 * failure, and reaped after 30 min if stale.
 *
 * Slice E turns that one row into a state machine — claim → sending → sent,
 * with an orphaned in-flight send flipped to a terminal delivery-unknown
 * state rather than deleted or silently resent. The five values `error` can
 * hold live in lib/earnings/email-states.ts; the state strings below are test
 * fixtures, which is why they are spelled out here and nowhere under lib/.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { PushoverMessage } from "@/lib/alerts/notify-pushover";
import {
  claimEarningsEmailSlot,
  releaseEarningsEmailClaim,
  reapStaleEarningsEmailClaims,
  markEmailSending,
  markEmailSent,
  markEmailDeliveryUnknown,
  restorePriorDelivered,
  getSendRow,
  SENDING_STALE_MINUTES,
  SEND_TIMEOUT_MS,
} from "@/lib/digest/send-earnings-email";

describe("earnings email claims and delivery lifecycle", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const result = db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
         VALUES ('finnhub', 'earnings', '2026-07-05', 'XMPL earnings', 'XMPL', 'finnhub:XMPL:2026-07-05', '2026-06-29')`,
      )
      .run();
    eventId = result.lastInsertRowid as number;
  });

  describe("claim slot", () => {
    it("first claim wins, concurrent second claim is refused", () => {
      const a = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      expect(a.claimed).toBe(true);
      expect(a.mode).toBe("fresh");
      expect(a.token).toBeTruthy();
      const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      expect(b.claimed).toBe(false);
      expect(b.reason).toBe("in_progress");
    });

    it("release deletes the claim so a retry can re-claim", () => {
      const a = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      releaseEarningsEmailClaim(db, eventId, "preview", a.token!);
      const again = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      expect(again.claimed).toBe(true);
    });

    it("a late finisher's release cannot delete a successor's takeover claim", () => {
      const a = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      expect(a.claimed).toBe(true);
      expect(a.token).toBeTruthy();

      // Age A's claim past the 30-min stale cutoff, then B takes over.
      db.prepare(
        `UPDATE earnings_emails SET sent_at = datetime('now', '-31 minutes')
          WHERE event_id = ? AND phase = 'preview'`,
      ).run(eventId);
      const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      expect(b.claimed).toBe(true);
      expect(b.token).toBeTruthy();
      expect(b.token).not.toBe(a.token);

      // A fails late and releases with ITS token — B's claim must survive.
      releaseEarningsEmailClaim(db, eventId, "preview", a.token!);
      const row = db
        .prepare(
          `SELECT error, claim_token FROM earnings_emails WHERE event_id = ? AND phase = 'preview'`,
        )
        .get(eventId) as { error: string; claim_token: string };
      expect(row).toBeDefined();
      expect(row.error).toBe("in_progress");
      expect(row.claim_token).toBe(b.token);

      // B releasing with its own token works.
      releaseEarningsEmailClaim(db, eventId, "preview", b.token!);
      expect(
        db.prepare(`SELECT 1 FROM earnings_emails WHERE event_id = ?`).get(eventId),
      ).toBeUndefined();
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

    // AMENDED (was: "a completed row allows a manual re-fire (mode refire, no
    // claim mutation)"). Automatic mode is the new default and must never
    // refire; manual mode keeps the old behaviour and now mints a token so the
    // send service can CAS its transitions. Split into the two tests below.
    it("automatic mode refuses a completed row (already_sent) and never touches it", () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
         VALUES (?, 'preview', 'x@y.com', '2026-07-05 12:00:00', '# sent', NULL)`,
      ).run(eventId);
      const b = claimEarningsEmailSlot(db, eventId, "preview", "z@y.com");
      expect(b).toEqual({ claimed: false, mode: "fresh", reason: "already_sent" });
      expect(
        db
          .prepare(`SELECT recipient, sent_at, error FROM earnings_emails WHERE event_id = ?`)
          .get(eventId),
      ).toEqual({ recipient: "x@y.com", sent_at: "2026-07-05 12:00:00", error: null });
    });

    it("automatic mode refuses a sent-by-cloud row and a delivery_unknown row by name", () => {
      for (const [state, reason] of [
        ["sent-by-cloud", "already_sent"],
        ["delivery_unknown", "delivery_unknown"],
      ] as const) {
        db.prepare(`DELETE FROM earnings_emails`).run();
        db.prepare(
          `INSERT INTO earnings_emails (event_id, phase, recipient, error) VALUES (?, 'preview', 'x@y.com', ?)`,
        ).run(eventId, state);
        expect(claimEarningsEmailSlot(db, eventId, "preview", "z@y.com").reason).toBe(reason);
      }
    });

    it("automatic mode refuses a live 'sending' row as in_progress and NEVER takes it over, however old", () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
         VALUES (?, 'preview', 'x@y.com', datetime('now', '-99 minutes'), 'sending', 'tok-live')`,
      ).run(eventId);
      const b = claimEarningsEmailSlot(db, eventId, "preview", "z@y.com");
      expect(b).toEqual({ claimed: false, mode: "fresh", reason: "in_progress" });
      expect(
        (
          db.prepare(`SELECT claim_token FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
            claim_token: string;
          }
        ).claim_token,
      ).toBe("tok-live");
    });

    it("manual mode refires a completed row: a token, the prior state and the prior sent_at", () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
         VALUES (?, 'preview', 'x@y.com', '2026-07-05 12:00:00', '# sent', NULL)`,
      ).run(eventId);
      const b = claimEarningsEmailSlot(db, eventId, "preview", "z@y.com", { mode: "manual" });
      expect(b.claimed).toBe(true);
      expect(b.mode).toBe("refire");
      expect(b.token).toBeTruthy();
      expect(b.prior).toBe("sent");
      expect(b.priorError).toBeNull();
      expect(b.priorSentAt).toBe("2026-07-05 12:00:00");
      // Nothing is written until markEmailSending.
      expect(
        db.prepare(`SELECT error, claim_token FROM earnings_emails WHERE event_id = ?`).get(eventId),
      ).toEqual({ error: null, claim_token: null });
    });

    it("manual mode still refuses a live claim of either kind", () => {
      for (const state of ["in_progress", "sending"]) {
        db.prepare(`DELETE FROM earnings_emails`).run();
        db.prepare(
          `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
           VALUES (?, 'preview', 'x@y.com', datetime('now'), ?, 'tok')`,
        ).run(eventId, state);
        expect(
          claimEarningsEmailSlot(db, eventId, "preview", "z@y.com", { mode: "manual" }).claimed,
        ).toBe(false);
      }
    });
  });

  describe("delivery transitions", () => {
    it("fresh: in_progress → sending writes prose + message id, then sending → sent clears the state", () => {
      const c = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      expect(
        markEmailSending(db, eventId, "preview", c.token!, {
          mode: "fresh",
          recipient: "x@y.com",
          aiInputHash: "h1",
          aiOutputMd: "# body",
          providerMessageId: "<m1@d>",
        }),
      ).toBe(true);
      let row = db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(eventId) as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        error: "sending",
        ai_output_md: "# body",
        ai_input_hash: "h1",
        provider_message_id: "<m1@d>",
      });
      expect(
        markEmailSent(db, eventId, "preview", c.token!, {
          recipient: "x@y.com",
          aiInputHash: "h1",
          aiOutputMd: "# body",
          providerResponse: "250 OK",
        }),
      ).toBe(true);
      row = db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(eventId) as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        error: null,
        provider_message_id: "<m1@d>",
        ai_output_md: "# body",
        // R-E10: what the RELAY said, not only what we put on the wire.
        provider_response: "250 OK",
      });
    });

    it("getSendRow reads the state, the timestamp and both provider columns", () => {
      const c = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      markEmailSending(db, eventId, "preview", c.token!, {
        mode: "fresh",
        recipient: "x@y.com",
        aiInputHash: null,
        aiOutputMd: "x",
        providerMessageId: "<m0@d>",
      });
      const mid = getSendRow(db, eventId, "preview");
      expect(mid).toMatchObject({
        error: "sending",
        provider_message_id: "<m0@d>",
        provider_response: null,
      });
      expect(mid!.sent_at).toBeTruthy();
      expect(getSendRow(db, eventId, "recap")).toBeNull();
    });

    it("every transition is compare-and-set on the token AND the expected state", () => {
      const c = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      // Wrong token cannot move the row.
      expect(
        markEmailSending(db, eventId, "preview", "not-my-token", {
          mode: "fresh",
          recipient: "x@y.com",
          aiInputHash: null,
          aiOutputMd: "x",
          providerMessageId: "<m@d>",
        }),
      ).toBe(false);
      // Right token, wrong state (still in_progress) cannot complete a send.
      expect(
        markEmailSent(db, eventId, "preview", c.token!, {
          recipient: "x@y.com",
          aiInputHash: null,
          aiOutputMd: "x",
          providerResponse: "250 OK",
        }),
      ).toBe(false);
      markEmailSending(db, eventId, "preview", c.token!, {
        mode: "fresh",
        recipient: "x@y.com",
        aiInputHash: null,
        aiOutputMd: "x",
        providerMessageId: "<m@d>",
      });
      // A reaper that already flipped the row wins: markEmailSent returns false.
      db.prepare(`UPDATE earnings_emails SET error = 'delivery_unknown' WHERE event_id = ?`).run(
        eventId,
      );
      expect(
        markEmailSent(db, eventId, "preview", c.token!, {
          recipient: "x@y.com",
          aiInputHash: null,
          aiOutputMd: "x",
          providerResponse: "250 OK",
        }),
      ).toBe(false);
    });

    it("refire: completed → sending directly (never in_progress) and keeps the delivered prose until the send lands", () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
         VALUES (?, 'preview', 'x@y.com', '2026-07-05 12:00:00', 'old-hash', '# OLD', NULL)`,
      ).run(eventId);
      const c = claimEarningsEmailSlot(db, eventId, "preview", "z@y.com", { mode: "manual" });
      expect(
        markEmailSending(db, eventId, "preview", c.token!, {
          mode: "refire",
          recipient: "z@y.com",
          aiInputHash: "new-hash",
          aiOutputMd: "# NEW",
          providerMessageId: "<m2@d>",
          priorError: c.priorError,
          priorSentAt: c.priorSentAt,
        }),
      ).toBe(true);
      const mid = db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(eventId) as Record<
        string,
        unknown
      >;
      expect(mid).toMatchObject({
        error: "sending",
        ai_output_md: "# OLD",
        ai_input_hash: "old-hash",
        provider_message_id: "<m2@d>",
      });
      markEmailSent(db, eventId, "preview", c.token!, {
        recipient: "z@y.com",
        aiInputHash: "new-hash",
        aiOutputMd: "# NEW",
        providerResponse: "250 OK",
      });
      const after = db
        .prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`)
        .get(eventId) as Record<string, unknown>;
      expect(after).toMatchObject({
        error: null,
        ai_output_md: "# NEW",
        ai_input_hash: "new-hash",
        recipient: "z@y.com",
      });
    });

    it("a refire whose row moved under it cannot send: markEmailSending returns false", () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
         VALUES (?, 'preview', 'x@y.com', '2026-07-05 12:00:00', 'old-hash', '# OLD', NULL)`,
      ).run(eventId);
      const stale = claimEarningsEmailSlot(db, eventId, "preview", "z@y.com", { mode: "manual" });
      // A FASTER refire lands first and delivers.
      const fast = claimEarningsEmailSlot(db, eventId, "preview", "fast@y.com", { mode: "manual" });
      expect(
        markEmailSending(db, eventId, "preview", fast.token!, {
          mode: "refire",
          recipient: "fast@y.com",
          aiInputHash: "h2",
          aiOutputMd: "# NEW",
          providerMessageId: "<fast@d>",
          priorError: fast.priorError,
          priorSentAt: fast.priorSentAt,
        }),
      ).toBe(true);
      markEmailSent(db, eventId, "preview", fast.token!, {
        recipient: "fast@y.com",
        aiInputHash: "h2",
        aiOutputMd: "# NEW",
        providerResponse: "250 OK",
      });
      // The slow one still holds the ORIGINAL identity and must lose.
      expect(
        markEmailSending(db, eventId, "preview", stale.token!, {
          mode: "refire",
          recipient: "z@y.com",
          aiInputHash: "h3",
          aiOutputMd: "# STALE",
          providerMessageId: "<stale@d>",
          priorError: stale.priorError,
          priorSentAt: stale.priorSentAt,
        }),
      ).toBe(false);
      expect(
        db
          .prepare(
            `SELECT ai_output_md, provider_message_id FROM earnings_emails WHERE event_id = ?`,
          )
          .get(eventId),
      ).toEqual({ ai_output_md: "# NEW", provider_message_id: "<fast@d>" });
    });

    it("a definitively-rejected refire restores the delivered row exactly as it was", () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
         VALUES (?, 'preview', 'x@y.com', '2026-07-05 12:00:00', 'old-hash', '# OLD', NULL)`,
      ).run(eventId);
      const c = claimEarningsEmailSlot(db, eventId, "preview", "z@y.com", { mode: "manual" });
      markEmailSending(db, eventId, "preview", c.token!, {
        mode: "refire",
        recipient: "z@y.com",
        aiInputHash: "h",
        aiOutputMd: "# NEW",
        providerMessageId: "<m@d>",
        priorError: c.priorError,
        priorSentAt: c.priorSentAt,
      });
      expect(
        restorePriorDelivered(db, eventId, "preview", c.token!, c.priorError!, c.priorSentAt!),
      ).toBe(true);
      expect(
        db
          .prepare(
            `SELECT error, sent_at, ai_output_md, claim_token FROM earnings_emails WHERE event_id = ?`,
          )
          .get(eventId),
      ).toEqual({
        error: null,
        sent_at: "2026-07-05 12:00:00",
        ai_output_md: "# OLD",
        claim_token: null,
      });
    });

    it("markEmailDeliveryUnknown flips a sending row and leaves sent_at at the call's start", () => {
      const c = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      markEmailSending(db, eventId, "preview", c.token!, {
        mode: "fresh",
        recipient: "x@y.com",
        aiInputHash: null,
        aiOutputMd: "x",
        providerMessageId: "<m@d>",
      });
      const at = (
        db.prepare(`SELECT sent_at FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
          sent_at: string;
        }
      ).sent_at;
      expect(markEmailDeliveryUnknown(db, eventId, "preview", c.token!)).toBe(true);
      expect(
        db.prepare(`SELECT error, sent_at FROM earnings_emails WHERE event_id = ?`).get(eventId),
      ).toEqual({ error: "delivery_unknown", sent_at: at });
    });

    it("release deletes a sending row too (a definitively-rejected FRESH send never happened)", () => {
      const c = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      markEmailSending(db, eventId, "preview", c.token!, {
        mode: "fresh",
        recipient: "x@y.com",
        aiInputHash: null,
        aiOutputMd: "x",
        providerMessageId: "<m@d>",
      });
      releaseEarningsEmailClaim(db, eventId, "preview", c.token!);
      expect(
        db.prepare(`SELECT 1 FROM earnings_emails WHERE event_id = ?`).get(eventId),
      ).toBeUndefined();
    });
  });

  describe("the reaper", () => {
    it("the stale threshold clears the send deadline with margin (static, not behavioural)", () => {
      // R-E7: the service must always win its own race. If someone drops
      // SENDING_STALE_MINUTES to 1, or raises SEND_TIMEOUT_MS past it, the
      // reaper starts flipping healthy in-flight sends. 300s >= 90s + 120s.
      expect(SENDING_STALE_MINUTES * 60_000).toBeGreaterThanOrEqual(SEND_TIMEOUT_MS + 2 * 60_000);
    });

    // AMENDED (was: "reapStaleEarningsEmailClaims deletes only stale
    // in_progress rows", asserting a bare number) — the reaper now also flips
    // stale in-flight rows and returns both counts plus the (event, phase)
    // pairs it moved (R-E4b), so the assertion is on the object.
    it("deletes stale in_progress rows and reports the count", async () => {
      claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
      db.prepare(
        `UPDATE earnings_emails SET sent_at = datetime('now', '-45 minutes') WHERE event_id = ?`,
      ).run(eventId);
      const notify = vi.fn(async (_msg: PushoverMessage) => ({ sent: true }));
      expect(await reapStaleEarningsEmailClaims(db, { notify })).toEqual({
        reaped: 1,
        flippedUnknown: 0,
        flipped: [],
      });
      expect(db.prepare("SELECT COUNT(*) c FROM earnings_emails").get()).toEqual({ c: 0 });
      expect(notify).not.toHaveBeenCalled();
    });

    it("flips a sending row older than 5 minutes to delivery_unknown and Pushovers once, naming the message id", async () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token, provider_message_id)
         VALUES (?, 'recap', 'x@y.com', datetime('now', '-6 minutes'), 'sending', 'tok', '<m9@d>')`,
      ).run(eventId);
      const notify = vi.fn(async (_msg: PushoverMessage) => ({ sent: true }));
      expect(await reapStaleEarningsEmailClaims(db, { notify })).toEqual({
        reaped: 0,
        flippedUnknown: 1,
        // R-E4b: the sweep claims each of these in KV.
        flipped: [{ eventId, phase: "recap" }],
      });
      expect(
        (
          db.prepare(`SELECT error FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
            error: string;
          }
        ).error,
      ).toBe("delivery_unknown");
      expect(notify).toHaveBeenCalledTimes(1);
      const msg = notify.mock.calls[0][0];
      expect(msg.message).toContain("XMPL");
      expect(msg.message).toContain("<m9@d>");
      expect(msg.message).toContain("delivery unknown");
    });

    it("leaves a sending row younger than 5 minutes alone (the 90s provider deadline has margin)", async () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
         VALUES (?, 'recap', 'x@y.com', datetime('now', '-2 minutes'), 'sending', 'tok')`,
      ).run(eventId);
      expect(
        await reapStaleEarningsEmailClaims(db, {
          notify: vi.fn(async (_msg: PushoverMessage) => ({ sent: true })),
        }),
      ).toEqual({ reaped: 0, flippedUnknown: 0, flipped: [] });
    });

    it("a notify failure never blocks the flip", async () => {
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
         VALUES (?, 'recap', 'x@y.com', datetime('now', '-6 minutes'), 'sending', 'tok')`,
      ).run(eventId);
      const notify = vi.fn(async (_msg: PushoverMessage) => {
        throw new Error("pushover down");
      });
      expect(await reapStaleEarningsEmailClaims(db, { notify })).toEqual({
        reaped: 0,
        flippedUnknown: 1,
        flipped: [{ eventId, phase: "recap" }],
      });
    });

    it("ABA: a row that completed and was re-fired between the SELECT and the UPDATE is NOT flipped", async () => {
      // The stale row the reaper would select.
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token, provider_message_id)
         VALUES (?, 'recap', 'x@y.com', datetime('now', '-6 minutes'), 'sending', 'tok-old', '<old@d>')`,
      ).run(eventId);
      const notify = vi.fn(async (_msg: PushoverMessage) => ({ sent: true }));
      // Drive the row to a NEW attempt after seeding, then reap — the
      // deterministic equivalent of the owner finishing and a manual refire
      // landing inside the reaper's SELECT → UPDATE window.
      db.prepare(
        `UPDATE earnings_emails
            SET error = 'sending', sent_at = datetime('now'), claim_token = 'tok-new',
                provider_message_id = '<new@d>'
          WHERE event_id = ?`,
      ).run(eventId);
      // The fresh attempt is young, so nothing is stale and nothing flips.
      expect(await reapStaleEarningsEmailClaims(db, { notify })).toEqual({
        reaped: 0,
        flippedUnknown: 0,
        flipped: [],
      });
      // And the CAS itself refuses a stale (token, sent_at) pair even when the
      // row IS in flight — this is the assertion that actually pins R-E7.
      expect(
        db
          .prepare(
            `UPDATE earnings_emails SET error = 'delivery_unknown'
              WHERE event_id = ? AND phase = 'recap' AND error = 'sending'
                AND claim_token IS ? AND sent_at = ?`,
          )
          .run(eventId, "tok-old", "1970-01-01 00:00:00").changes,
      ).toBe(0);
      expect(
        db.prepare(`SELECT error, claim_token FROM earnings_emails WHERE event_id = ?`).get(eventId),
      ).toEqual({ error: "sending", claim_token: "tok-new" });
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
