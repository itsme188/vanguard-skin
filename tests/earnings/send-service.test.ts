/**
 * Spec §8, E line: "one claim owner across sweep, nudge, manual route; `sending`
 * before the provider call; `delivery_unknown` on a simulated crash; nudge
 * non-refiring; awaited markers; concurrent sweep and nudge send once."
 *
 * Every provider call goes through an injected seam — no socket is ever opened,
 * and nothing in this file can reach nodemailer or the AI SDK. The KV marker
 * env is stubbed empty in beforeEach so even the DEFAULT marker helpers (used
 * by the tests that inject no `markers` seam) short-circuit before `fetch`.
 * The concurrency cases use a FILE-backed database with two connections and an
 * explicit promise barrier, never a sleep.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import {
  deliverClaimedBatch,
  isAmbiguousSendFailure,
  SEND_TIMEOUT_MS,
  sendEarningsCandidate,
  type SendMode,
} from "@/lib/earnings/send-service";
import {
  claimEarningsEmailSlot,
  reapStaleEarningsEmailClaims,
  SENDING_STALE_MINUTES,
} from "@/lib/digest/send-earnings-email";
import type { ComposeEarningsResult } from "@/lib/digest/send-earnings-email";

let db: Database.Database;
let eventId: number;
const RECIPIENT = "desk@example.com";

const composed: ComposeEarningsResult = {
  symbol: "XMPL",
  title: "XMPL Earnings Recap — September 10, 2026",
  markdown: "# XMPL\n\nbody",
  aiMarkdown: "body",
  html: "<p>body</p>",
  promptHash: "hash1",
};

function markerSpies() {
  const order: string[] = [];
  return {
    order,
    markers: {
      setRunning: vi.fn(async () => {
        order.push("setRunning");
      }),
      clearRunning: vi.fn(async () => {
        order.push("clearRunning");
      }),
      writeMacSent: vi.fn(async () => {
        order.push("writeMacSent");
      }),
    },
  };
}

function seedEvent(conn: Database.Database, sourceKey = "k1"): number {
  return Number(
    conn
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, actual_value)
         VALUES ('manual','earnings','2026-09-10','XMPL earnings','XMPL',?,'EPS 1.00 / Rev 100,000,000')`,
      )
      .run(sourceKey).lastInsertRowid,
  );
}

beforeEach(() => {
  // Hermetic KV: the default marker helpers return null without a fetch when
  // either env var is missing, so a developer with a real WORKER_MARKER_URL
  // exported in their shell can never make this file talk to the Worker.
  vi.stubEnv("WORKER_MARKER_URL", "");
  vi.stubEnv("CRON_SHARED_SECRET", "");
  vi.stubEnv("BRIEFING_EMAIL_TO", "");
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = seedEvent(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

const CAND = () => ({ eventId, symbol: "XMPL", phase: "recap" as const });

describe("the happy path", () => {
  it("writes 'sending' with the message id BEFORE the provider call, then commits 'sent'", async () => {
    let seenAtCallTime: { error: string | null; provider_message_id: string | null } | undefined;
    const sendEmail = vi.fn(async (o: { messageId?: string }) => {
      seenAtCallTime = db
        .prepare(`SELECT error, provider_message_id FROM earnings_emails WHERE event_id = ?`)
        .get(eventId) as { error: string | null; provider_message_id: string | null };
      return { messageId: o.messageId!, response: "250 OK" };
    });
    const { markers } = markerSpies();
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: { sendEmail, compose: async () => composed, markers },
    });
    expect(res).toMatchObject({
      outcome: "sent",
      sentTo: RECIPIENT,
      symbol: "XMPL",
      title: composed.title,
      modelOutputChars: composed.markdown.length,
    });
    expect(seenAtCallTime!.error).toBe("sending");
    expect(seenAtCallTime!.provider_message_id).toBe(
      (res as { providerMessageId: string }).providerMessageId,
    );
    const row = db
      .prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`)
      .get(eventId) as Record<string, unknown>;
    expect(row).toMatchObject({
      error: null,
      ai_output_md: "body",
      ai_input_hash: "hash1",
      recipient: RECIPIENT,
      provider_message_id: (res as { providerMessageId: string }).providerMessageId,
    });
  });

  it("awaits every marker, in order: setRunning … markSent → writeMacSent → clearRunning, before it resolves", async () => {
    const { markers, order } = markerSpies();
    await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        compose: async () => composed,
        markers,
      },
    });
    expect(order).toEqual(["setRunning", "writeMacSent", "clearRunning"]);
    for (const m of Object.values(markers)) expect(m).toHaveBeenCalledTimes(1);
  });

  it("clears the running marker exactly once even when the provider throws", async () => {
    const { markers, order } = markerSpies();
    await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        sendEmail: async () => {
          throw new Error("smtp down");
        },
        compose: async () => composed,
        markers,
      },
    });
    expect(order).toEqual(["setRunning", "clearRunning"]);
    expect(markers.clearRunning).toHaveBeenCalledTimes(1);
    expect(markers.writeMacSent).not.toHaveBeenCalled();
  });

  it("keeps the 'Send failed: ' prefix a missing-key throw is reported under", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async () => {
          throw new Error("Missing RESEND_API_KEY or RESEND_FROM_DOMAIN env vars.");
        },
      },
    });
    expect(res).toMatchObject({
      outcome: "failed",
      reason: "Send failed: Missing RESEND_API_KEY or RESEND_FROM_DOMAIN env vars.",
      status: 500,
    });
  });

  it("the deadline is the one declared next to the reaper's threshold", () => {
    expect(SEND_TIMEOUT_MS).toBe(90_000);
    expect(SENDING_STALE_MINUTES * 60_000).toBeGreaterThan(SEND_TIMEOUT_MS);
  });
});

describe("coordination outcomes", () => {
  it("returns in_progress for a live claim and never composes", async () => {
    claimEarningsEmailSlot(db, eventId, "recap", "someone@else.com");
    const compose = vi.fn();
    const sendEmail = vi.fn();
    expect(
      await sendEarningsCandidate(db, CAND(), {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: { compose, sendEmail },
      }),
    ).toEqual({ outcome: "in_progress" });
    expect(compose).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("nudge mode never refires: a sent row returns already_sent with no compose and no provider call", async () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', '# prior', NULL)`,
    ).run(eventId);
    const compose = vi.fn();
    const sendEmail = vi.fn();
    expect(
      await sendEarningsCandidate(db, CAND(), {
        mode: "nudge",
        recipient: RECIPIENT,
        seams: { compose, sendEmail },
      }),
    ).toEqual({ outcome: "already_sent", sentAt: "2026-09-10 20:30:00", sentBy: "local" });
    expect(compose).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("nudge mode reports a delivery_unknown row as such, with the stored message id", async () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, provider_message_id)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', 'delivery_unknown', '<m7@d>')`,
    ).run(eventId);
    const { markers } = markerSpies();
    expect(
      await sendEarningsCandidate(db, CAND(), {
        mode: "nudge",
        recipient: RECIPIENT,
        seams: { sendEmail: vi.fn(), markers },
      }),
    ).toMatchObject({
      outcome: "delivery_unknown",
      providerMessageId: "<m7@d>",
      since: "2026-09-10 20:30:00",
    });
    // R-E4: the phase is claimed in KV so the Worker fallback cannot resend it.
    expect(markers.writeMacSent).toHaveBeenCalledWith("recap", eventId);
  });

  it("a cloud-delivered row reports already_sent / cloud", async () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
       VALUES (?, 'recap', 'cloud-fallback', '2026-09-10 20:30:00', 'sent-by-cloud')`,
    ).run(eventId);
    expect(
      await sendEarningsCandidate(db, CAND(), {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: { sendEmail: vi.fn() },
      }),
    ).toEqual({ outcome: "already_sent", sentAt: "2026-09-10 20:30:00", sentBy: "cloud" });
  });

  it("refuses with a domain reason and no claim residue when there is no recipient", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      seams: { sendEmail: vi.fn() },
    });
    expect(res).toMatchObject({ outcome: "refused", status: 400 });
    expect(db.prepare(`SELECT 1 FROM earnings_emails`).get()).toBeUndefined();
  });

  it("a not_ready compose releases the fresh claim and refuses", async () => {
    const { EarningsEmailError } = await import("@/lib/digest/send-earnings-email");
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => {
          throw new EarningsEmailError("no actual_value yet", 409, "not_ready");
        },
        sendEmail: vi.fn(),
      },
    });
    expect(res).toMatchObject({ outcome: "refused", reason: "no actual_value yet", status: 409 });
    expect(db.prepare(`SELECT 1 FROM earnings_emails`).get()).toBeUndefined();
  });

  it("any other compose failure releases the claim and fails (retryable next tick)", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => {
          throw new Error("model exploded");
        },
        sendEmail: vi.fn(),
      },
    });
    expect(res).toMatchObject({ outcome: "failed", status: 500 });
    expect(db.prepare(`SELECT 1 FROM earnings_emails`).get()).toBeUndefined();
  });

  it("a compose failure on a manual REFIRE restores the delivered row untouched", async () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', 'old', '# OLD', NULL)`,
    ).run(eventId);
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "manual",
      recipient: RECIPIENT,
      seams: {
        compose: async () => {
          throw new Error("model exploded");
        },
        sendEmail: vi.fn(),
      },
    });
    expect(res).toMatchObject({ outcome: "failed", status: 500 });
    expect(
      db
        .prepare(`SELECT error, sent_at, ai_output_md, recipient FROM earnings_emails WHERE event_id = ?`)
        .get(eventId),
    ).toEqual({
      error: null,
      sent_at: "2026-09-10 20:30:00",
      ai_output_md: "# OLD",
      recipient: "me@example.com",
    });
  });
});

describe("delivery_unknown", () => {
  it("(a) a provider call that never answers times out and books delivery_unknown — the row is NOT deleted", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: () => new Promise(() => {}), // never settles
        timeoutMs: 20,
      },
    });
    expect(res).toMatchObject({ outcome: "delivery_unknown" });
    const row = db
      .prepare(`SELECT error, provider_message_id FROM earnings_emails WHERE event_id = ?`)
      .get(eventId) as { error: string; provider_message_id: string };
    expect(row.error).toBe("delivery_unknown");
    expect(row.provider_message_id).toBe((res as { providerMessageId: string }).providerMessageId);
  });

  it("(b) a process that dies mid-send leaves a 'sending' row the reaper flips, notifying once", async () => {
    // Simulate the crash: drive the row to 'sending' and abandon it.
    const claim = claimEarningsEmailSlot(db, eventId, "recap", RECIPIENT);
    const { markEmailSending } = await import("@/lib/digest/send-earnings-email");
    markEmailSending(db, eventId, "recap", claim.token!, {
      mode: "fresh",
      recipient: RECIPIENT,
      aiInputHash: "h",
      aiOutputMd: "body",
      providerMessageId: "<crash@d>",
    });
    db.prepare(`UPDATE earnings_emails SET sent_at = datetime('now', '-6 minutes') WHERE event_id = ?`).run(
      eventId,
    );
    const notify = vi.fn(async () => ({ sent: true }));
    expect(await reapStaleEarningsEmailClaims(db, { notify })).toEqual({
      reaped: 0,
      flippedUnknown: 1,
      flipped: [{ eventId, phase: "recap" }],
    });
    expect(notify).toHaveBeenCalledTimes(1);
    // And the next automatic attempt refuses rather than resending.
    expect(
      await sendEarningsCandidate(db, CAND(), {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: { sendEmail: vi.fn() },
      }),
    ).toMatchObject({ outcome: "delivery_unknown", providerMessageId: "<crash@d>" });
  });

  it("(c) the provider accepted but the reaper already flipped the row: delivery_unknown, never a resend", async () => {
    const sendEmail = vi.fn(async (o: { messageId?: string }) => {
      db.prepare(`UPDATE earnings_emails SET error = 'delivery_unknown' WHERE event_id = ?`).run(eventId);
      return { messageId: o.messageId!, response: "250 OK" };
    });
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: { compose: async () => composed, sendEmail },
    });
    expect(res).toMatchObject({ outcome: "delivery_unknown" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("classifies provider failures: only a possible transmission is ambiguous", () => {
    expect(isAmbiguousSendFailure(new Error("anything"), true)).toBe(true); // our own deadline
    expect(isAmbiguousSendFailure({ code: "ESOCKET", command: "DATA" }, false)).toBe(true);
    expect(isAmbiguousSendFailure({ code: "ECONNECTION", command: "CONN" }, false)).toBe(false);
    expect(isAmbiguousSendFailure({ code: "EENVELOPE", command: "RCPT TO" }, false)).toBe(false);
    expect(isAmbiguousSendFailure({ code: "EMESSAGE", command: "DATA" }, false)).toBe(false);
    expect(isAmbiguousSendFailure({ code: "EAUTH", command: "AUTH LOGIN" }, false)).toBe(false);
    expect(isAmbiguousSendFailure(new Error("Missing RESEND_API_KEY"), false)).toBe(false);
  });

  it("a definitive rejection releases a FRESH claim so the next tick retries", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async () => {
          throw Object.assign(new Error("Invalid recipient"), {
            code: "EENVELOPE",
            command: "RCPT TO",
          });
        },
      },
    });
    expect(res).toMatchObject({ outcome: "failed" });
    expect(db.prepare(`SELECT 1 FROM earnings_emails`).get()).toBeUndefined();
  });

  it("a definitive rejection of a manual REFIRE restores the delivered row untouched", async () => {
    // "Untouched" includes the PROVIDER EVIDENCE (whole-branch review I1): the
    // original send's Message-ID and the relay's own reply line are the desk's
    // only handle for reconciling that send by hand (R-E10), and the refire
    // overwrites both before the wire. Seed them, and pin them byte for byte.
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error,
                                    provider_message_id, provider_response)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', 'old', '# OLD', NULL,
               '<orig@example.invalid>', '250 2.0.0 OK orig')`,
    ).run(eventId);
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "manual",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async () => {
          throw Object.assign(new Error("nope"), { code: "EMESSAGE", command: "DATA" });
        },
      },
    });
    expect(res).toMatchObject({ outcome: "failed" });
    expect(
      db
        .prepare(
          `SELECT error, sent_at, ai_output_md, recipient, provider_message_id, provider_response
             FROM earnings_emails WHERE event_id = ?`,
        )
        .get(eventId),
    ).toEqual({
      error: null,
      sent_at: "2026-09-10 20:30:00",
      ai_output_md: "# OLD",
      recipient: "me@example.com",
      provider_message_id: "<orig@example.invalid>",
      provider_response: "250 2.0.0 OK orig",
    });
  });
});

describe("the crash boundaries (Codex round 1)", () => {
  it("E-S4: a provider promise that resolves AFTER the deadline changes nothing", async () => {
    let settle!: (v: { messageId: string; response: string }) => void;
    const parked = new Promise<{ messageId: string; response: string }>((r) => {
      settle = r;
    });
    const { markers, order } = markerSpies();
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: { compose: async () => composed, sendEmail: () => parked, timeoutMs: 20, markers },
    });
    expect(res).toMatchObject({ outcome: "delivery_unknown" });
    // R-E4: the phase is CLAIMED before the running marker is released.
    expect(order).toEqual(["setRunning", "writeMacSent", "clearRunning"]);
    const before = db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(eventId);
    // The late success lands now. Nothing may move: markEmailSent's CAS is on
    // error = 'sending', which no longer holds.
    settle({ messageId: "<late@d>", response: "250 OK" });
    await Promise.resolve();
    expect(db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(eventId)).toEqual(before);
  });

  it("a post-accept failure whose RECOVERY READ also throws still ends delivery_unknown, never a 500 (R-E-C10)", async () => {
    // The realistic trigger for the post-accept catch is a SQLite fault, and a
    // database in that state can just as easily fail the SELECT the recovery
    // path makes to report `since`. That read sits INSIDE the catch, so an
    // unguarded throw escapes the handler entirely, propagates through the
    // `finally`, and the sweep's backstop books ok:false / status 500 — the
    // one outcome R-E5 forbids once the provider has said yes.
    //
    // LOAD-BEARING: drop the try/catch in `safeSentAt` and this test throws
    // "database is locked" out of sendEarningsCandidate instead of returning.
    const claims = await import("@/lib/digest/send-earnings-email");
    const boom = () =>
      Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    let postAccept = false;
    const sentSpy = vi.spyOn(claims, "markEmailSent").mockImplementation(() => {
      postAccept = true; // the provider has already accepted by this point
      throw boom();
    });
    // Only the RECOVERY read fails — the claim path's reads still work, so the
    // send reaches the post-accept window exactly as it does in production.
    const realGetSendRow = claims.getSendRow;
    const rowSpy = vi.spyOn(claims, "getSendRow").mockImplementation((...args) => {
      if (postAccept) throw boom();
      return realGetSendRow(...args);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { markers, order } = markerSpies();

    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        markers,
      },
    });

    // No exception, and the outcome shape is unchanged — `since` simply falls
    // back to "" exactly as it already does for a row that cannot be found.
    expect(res).toMatchObject({ outcome: "delivery_unknown", since: "" });
    expect((res as { note?: string }).note).toContain("post-accept persistence failed");
    // The row was still flipped terminal and the phase still claimed in KV, so
    // neither the next tick nor the Worker fallback can resend it.
    expect(
      (db.prepare(`SELECT error FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
        error: string;
      }).error,
    ).toBe("delivery_unknown");
    expect(order).toEqual(["setRunning", "writeMacSent", "clearRunning"]);

    rowSpy.mockRestore();
    sentSpy.mockRestore();
    warn.mockRestore();
  });

  it("a post-accept SQLite error ends delivery_unknown with a note — never a 500", async () => {
    const claims = await import("@/lib/digest/send-earnings-email");
    const spy = vi.spyOn(claims, "markEmailSent").mockImplementation(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { markers, order } = markerSpies();
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        markers,
      },
    });
    expect(res).toMatchObject({ outcome: "delivery_unknown" });
    expect((res as { note?: string }).note).toContain("post-accept persistence failed");
    expect(
      (db.prepare(`SELECT error FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
        error: string;
      }).error,
    ).toBe("delivery_unknown");
    expect(order).toEqual(["setRunning", "writeMacSent", "clearRunning"]);
    expect(markers.clearRunning).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    warn.mockRestore();
  });

  it("a rejected marker promise never changes the outcome (fail-open, R-E6)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        markers: {
          setRunning: async () => {
            throw new Error("KV down");
          },
          clearRunning: async () => {
            throw new Error("KV down");
          },
          writeMacSent: async () => {
            throw new Error("KV down");
          },
        },
      },
    });
    expect(res).toMatchObject({ outcome: "sent" });
    expect(db.prepare(`SELECT error FROM earnings_emails WHERE event_id = ?`).get(eventId)).toEqual({
      error: null,
    });
    warn.mockRestore();
  });

  it("stores the provider's own reply line beside the id we minted (R-E10)", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 2.0.0 Ok: queued as ABC123" }),
      },
    });
    expect(
      db
        .prepare(`SELECT provider_message_id, provider_response FROM earnings_emails WHERE event_id = ?`)
        .get(eventId),
    ).toEqual({
      provider_message_id: (res as { providerMessageId: string }).providerMessageId,
      provider_response: "250 2.0.0 Ok: queued as ABC123",
    });
  });
});

describe("the cloud pre-check lives in the service (R-E6)", () => {
  it.each(["sweep", "nudge"] as const)("%s: a cloud marker short-circuits before any compose", async (mode) => {
    const compose = vi.fn();
    const sendEmail = vi.fn();
    const checkCloudMarker = vi.fn(async () => ({ sentBy: "cloud" as const }));
    const res = await sendEarningsCandidate(db, CAND(), {
      mode,
      recipient: RECIPIENT,
      seams: { compose, sendEmail, checkCloudMarker },
    });
    expect(res).toMatchObject({ outcome: "already_sent", sentBy: "cloud" });
    expect(compose).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    // A sent-by-cloud audit row now exists, so the next tick stops selecting it.
    expect(
      (db.prepare(`SELECT error FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
        error: string;
      }).error,
    ).toBe("sent-by-cloud");
  });

  it("a mac marker with NO local row answers already_sent and WARNS that the row was lost", async () => {
    // The old sweep acted only on sentBy === "cloud"; this arm short-circuits on
    // ANY sentBy, so a "mac" marker with no local audit row now answers
    // already_sent too (review M1). Reachable only after the row was LOST — a
    // database restore inside the marker's 30-hour TTL — because the Mac writes
    // row and marker together. Keep the behaviour (the Mac did handle the
    // phase; a second copy is worse) but make the reason visible: already_sent
    // carries no `note`, so the log is the only place it can be said.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const compose = vi.fn();
    const sendEmail = vi.fn();
    const recordCloudSent = vi.fn();
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose,
        sendEmail,
        recordCloudSent,
        checkCloudMarker: async () => ({ sentBy: "mac" as const }),
      },
    });
    expect(res).toMatchObject({ outcome: "already_sent", sentAt: "", sentBy: "local" });
    expect(compose).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    // A mac marker is NOT a cloud send — no sent-by-cloud row is invented.
    expect(recordCloudSent).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT 1 FROM earnings_emails WHERE event_id = ?`).get(eventId)).toBeUndefined();
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("mac-sent KV marker");
    expect(warned).toContain("NO local");
    expect(warned).toMatch(/lost/i);
    warn.mockRestore();
  });

  it("a mac marker WITH a local row is silent — nothing was lost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', '# OLD', NULL)`,
    ).run(eventId);
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: vi.fn(),
        sendEmail: vi.fn(),
        checkCloudMarker: async () => ({ sentBy: "mac" as const }),
      },
    });
    expect(res).toMatchObject({
      outcome: "already_sent",
      sentAt: "2026-09-10 20:30:00",
      sentBy: "local",
    });
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("mac-sent KV marker");
    warn.mockRestore();
  });

  it("manual mode never consults the cloud marker — a refire is an explicit second copy", async () => {
    const checkCloudMarker = vi.fn(async () => ({ sentBy: "cloud" as const }));
    await sendEarningsCandidate(db, CAND(), {
      mode: "manual",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        checkCloudMarker,
      },
    });
    expect(checkCloudMarker).not.toHaveBeenCalled();
  });

  it("a marker check that rejects does not block the send (fail-open)", async () => {
    const res = await sendEarningsCandidate(db, CAND(), {
      mode: "sweep",
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        checkCloudMarker: async () => {
          throw new Error("KV down");
        },
      },
    });
    expect(res).toMatchObject({ outcome: "sent" });
  });
});

describe("the reporter-recap candidate uses the deterministic composer", () => {
  it("composes through composeReporter, not the AI composer, and stores its markdown", async () => {
    const compose = vi.fn();
    const composeReporter = vi.fn(async () => ({
      symbol: "XMPL",
      title: "XMPL printed — read-through to TGT",
      subject: "📡 XMPL printed — read-through to TGT",
      html: "<p>rt</p>",
      markdown: "# rt",
      aiMarkdown: "# rt",
      promptHash: null,
      targets: ["TGT"],
    }));
    const res = await sendEarningsCandidate(
      db,
      { ...CAND(), reporterRecap: true },
      {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: {
          compose,
          composeReporter,
          sendEmail: async (o) => ({ messageId: o.messageId!, response: "250 OK" }),
        },
      },
    );
    expect(res).toMatchObject({ outcome: "sent" });
    expect(compose).not.toHaveBeenCalled();
    expect(composeReporter).toHaveBeenCalledWith(db, eventId);
    const row = db
      .prepare(`SELECT ai_output_md, ai_input_hash FROM earnings_emails WHERE event_id = ?`)
      .get(eventId);
    expect(row).toEqual({ ai_output_md: "# rt", ai_input_hash: null });
  });

  it("keeps the reporter composer's own subject (it already carries its glyph)", async () => {
    const sendEmail = vi.fn(async (o: { messageId?: string; subject: string }) => ({
      messageId: o.messageId!,
      response: "250",
    }));
    await sendEarningsCandidate(
      db,
      { ...CAND(), reporterRecap: true },
      {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: {
          composeReporter: async () => ({
            symbol: "XMPL",
            title: "T",
            subject: "📡 XMPL printed",
            html: "<p>x</p>",
            markdown: "m",
            aiMarkdown: "m",
            promptHash: null,
            targets: ["TGT"],
          }),
          sendEmail,
        },
      },
    );
    expect(sendEmail.mock.calls[0][0].subject).toBe("📡 XMPL printed");
  });
});

describe("the manual entry points POST /api/earnings/email calls", () => {
  // These two wrappers MOVED here from lib/digest/send-earnings-email.ts
  // (M-E19). They go through the real composer + mailer seams via a namespace
  // spy rather than the injected seams, because that is exactly the path the
  // route takes — no seam is threaded through it.
  async function stubComposerAndMailer() {
    const claims = await import("@/lib/digest/send-earnings-email");
    const mail = await import("@/lib/email");
    const compose = vi.spyOn(claims, "composeEarningsEmail").mockResolvedValue(composed);
    const send = vi
      .spyOn(mail, "sendEmail")
      .mockImplementation(async (o) => ({ messageId: o.messageId ?? "<x@d>", response: "250 OK" }));
    return { compose, send, restore: () => { compose.mockRestore(); send.mockRestore(); } };
  }

  it("REFIRE a delivered row: the manual road still sends a second copy on purpose", async () => {
    // Wave W2 left the route on the new `automatic` default, which refuses a
    // completed row — a manual refire 409'd. `manual` mode is what closes that.
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', 'old', '# OLD', NULL)`,
    ).run(eventId);
    const { send, restore } = await stubComposerAndMailer();
    const { sendEarningsRecap } = await import("@/lib/earnings/send-service");

    const res = await sendEarningsRecap(db, eventId, { recipient: RECIPIENT });

    expect(res).toMatchObject({
      success: true,
      eventId,
      symbol: "XMPL",
      phase: "recap",
      sentTo: RECIPIENT,
      title: composed.title,
      modelOutputChars: composed.markdown.length,
    });
    expect(send).toHaveBeenCalledTimes(1);
    // The row is the NEW send, in place, with the refire's own message id.
    const row = db
      .prepare(
        `SELECT error, recipient, ai_output_md, ai_input_hash, provider_message_id, provider_response
           FROM earnings_emails WHERE event_id = ?`,
      )
      .get(eventId) as Record<string, unknown>;
    expect(row).toMatchObject({
      error: null,
      recipient: RECIPIENT,
      ai_output_md: "body",
      ai_input_hash: "hash1",
      provider_response: "250 OK",
    });
    expect(row.provider_message_id).toEqual(expect.stringContaining("@"));
    expect(db.prepare(`SELECT COUNT(*) c FROM earnings_emails`).get()).toEqual({ c: 1 });
    restore();
  });

  it("preview and recap each go out under their own phase", async () => {
    const { send, restore } = await stubComposerAndMailer();
    const { sendEarningsPreview } = await import("@/lib/earnings/send-service");
    const res = await sendEarningsPreview(db, eventId, { recipient: RECIPIENT });
    expect(res.phase).toBe("preview");
    expect(send.mock.calls[0][0].subject).toContain(composed.title);
    expect(
      db.prepare(`SELECT phase FROM earnings_emails WHERE event_id = ?`).get(eventId),
    ).toEqual({ phase: "preview" });
    restore();
  });

  it("a live claim is still the 409 claim_held the route surfaces", async () => {
    claimEarningsEmailSlot(db, eventId, "recap", "other@example.com");
    const { sendEarningsRecap } = await import("@/lib/earnings/send-service");
    await expect(sendEarningsRecap(db, eventId, { recipient: RECIPIENT })).rejects.toMatchObject({
      status: 409,
      code: "claim_held",
    });
  });

  it("an unknown event is a 404 and claims nothing", async () => {
    const { sendEarningsRecap } = await import("@/lib/earnings/send-service");
    await expect(sendEarningsRecap(db, 999_999, { recipient: RECIPIENT })).rejects.toMatchObject({
      status: 404,
    });
    expect(db.prepare(`SELECT 1 FROM earnings_emails`).get()).toBeUndefined();
  });

  it("a delivery-unknown row is reported, not silently resent", async () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, provider_message_id)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', 'delivery_unknown', '<m7@d>')`,
    ).run(eventId);
    const { send, restore } = await stubComposerAndMailer();
    const { sendEarningsRecap } = await import("@/lib/earnings/send-service");
    // A human refire is explicit, so it DOES go out — the manual road never
    // consults the marker and never refuses a terminal row.
    const res = await sendEarningsRecap(db, eventId, { recipient: RECIPIENT });
    expect(res.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    restore();
  });
});

describe("deliverClaimedBatch (R-E9)", () => {
  function claimAll(ids: number[]) {
    return ids.map((id) => {
      const c = claimEarningsEmailSlot(db, id, "recap", RECIPIENT);
      return { eventId: id, phase: "recap" as const, token: c.token!, mode: "fresh" as const };
    });
  }

  it("N members share ONE message id and ONE provider call, and all land sent", async () => {
    const ids = [eventId, seedEvent(db, "k2"), seedEvent(db, "k3")];
    const members = claimAll(ids);
    const sendEmail = vi.fn(async (o: { messageId?: string }) => ({
      messageId: o.messageId!,
      response: "250 OK",
    }));
    const { markers } = markerSpies();
    const res = await deliverClaimedBatch(
      db,
      {
        members,
        recipient: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        aiInputHash: null,
        aiOutputMd: "# debrief",
      },
      { sendEmail, markers },
    );
    expect(res.outcome).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const rows = db
      .prepare(`SELECT error, provider_message_id, ai_output_md FROM earnings_emails ORDER BY id`)
      .all();
    expect(rows).toHaveLength(3);
    for (const r of rows as Array<{
      error: string | null;
      provider_message_id: string;
      ai_output_md: string;
    }>) {
      expect(r).toMatchObject({ error: null, ai_output_md: "# debrief" });
      expect(r.provider_message_id).toBe((res as { providerMessageId: string }).providerMessageId);
    }
    expect(markers.writeMacSent).toHaveBeenCalledTimes(3);
  });

  it("a timeout leaves all N delivery_unknown with a mac-sent marker each", async () => {
    const ids = [eventId, seedEvent(db, "k2"), seedEvent(db, "k3")];
    const members = claimAll(ids);
    const { markers } = markerSpies();
    const res = await deliverClaimedBatch(
      db,
      {
        members,
        recipient: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        aiInputHash: null,
        aiOutputMd: "# d",
      },
      { sendEmail: () => new Promise(() => {}), timeoutMs: 20, markers },
    );
    expect(res.outcome).toBe("delivery_unknown");
    expect(db.prepare(`SELECT COUNT(*) c FROM earnings_emails WHERE error = 'delivery_unknown'`).get()).toEqual({
      c: 3,
    });
    expect(markers.writeMacSent).toHaveBeenCalledTimes(3);
  });

  it("a definitive rejection releases every fresh member — no residue at all", async () => {
    const ids = [eventId, seedEvent(db, "k2")];
    const members = claimAll(ids);
    const { markers } = markerSpies();
    const res = await deliverClaimedBatch(
      db,
      {
        members,
        recipient: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        aiInputHash: null,
        aiOutputMd: "# d",
      },
      {
        sendEmail: async () => {
          throw Object.assign(new Error("Invalid recipient"), {
            code: "EENVELOPE",
            command: "RCPT TO",
          });
        },
        markers,
      },
    );
    expect(res).toMatchObject({ outcome: "failed" });
    expect(db.prepare(`SELECT COUNT(*) c FROM earnings_emails`).get()).toEqual({ c: 0 });
    expect(markers.writeMacSent).not.toHaveBeenCalled();
  });

  it("a definitive rejection RESTORES a refire member (all four columns) while releasing a fresh one", async () => {
    // undoMember's two arms in one batch: the fresh member's row is DELETED (that
    // send never happened), the refire member's DELIVERED row is put back —
    // error, sent_at and BOTH provider columns (review I1).
    const fresh = seedEvent(db, "k2");
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error,
                                    provider_message_id, provider_response)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:30:00', 'old', '# OLD', NULL,
               '<orig@example.invalid>', '250 2.0.0 OK orig')`,
    ).run(eventId);
    const refire = claimEarningsEmailSlot(db, eventId, "recap", RECIPIENT, { mode: "manual" });
    expect(refire.mode).toBe("refire");
    const freshClaim = claimEarningsEmailSlot(db, fresh, "recap", RECIPIENT);
    const { markers } = markerSpies();
    const res = await deliverClaimedBatch(
      db,
      {
        members: [
          {
            eventId,
            phase: "recap",
            token: refire.token!,
            mode: "refire",
            priorError: refire.priorError,
            priorSentAt: refire.priorSentAt,
            priorProviderMessageId: refire.priorProviderMessageId,
            priorProviderResponse: refire.priorProviderResponse,
          },
          { eventId: fresh, phase: "recap", token: freshClaim.token!, mode: "fresh" },
        ],
        recipient: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        aiInputHash: "new",
        aiOutputMd: "# NEW",
      },
      {
        sendEmail: async () => {
          throw Object.assign(new Error("Invalid recipient"), {
            code: "EENVELOPE",
            command: "RCPT TO",
          });
        },
        markers,
      },
    );
    expect(res).toMatchObject({ outcome: "failed" });
    expect(markers.writeMacSent).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT 1 FROM earnings_emails WHERE event_id = ?`).get(fresh)).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT error, sent_at, ai_output_md, recipient, claim_token,
                  provider_message_id, provider_response
             FROM earnings_emails WHERE event_id = ?`,
        )
        .get(eventId),
    ).toEqual({
      error: null,
      sent_at: "2026-09-10 20:30:00",
      ai_output_md: "# OLD",
      recipient: "me@example.com",
      claim_token: null,
      provider_message_id: "<orig@example.invalid>",
      provider_response: "250 2.0.0 OK orig",
    });
  });

  it("a member whose row moved is dropped, not fatal; zero survivors refuses before the wire", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = seedEvent(db, "k2");
    const good = claimEarningsEmailSlot(db, eventId, "recap", RECIPIENT);
    const stale = claimEarningsEmailSlot(db, other, "recap", RECIPIENT);
    db.prepare(`UPDATE earnings_emails SET claim_token = 'someone-else' WHERE event_id = ?`).run(other);
    const sendEmail = vi.fn(async (o: { messageId?: string }) => ({
      messageId: o.messageId!,
      response: "250 OK",
    }));
    const res = await deliverClaimedBatch(
      db,
      {
        members: [
          { eventId, phase: "recap", token: good.token!, mode: "fresh" },
          { eventId: other, phase: "recap", token: stale.token!, mode: "fresh" },
        ],
        recipient: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        aiInputHash: null,
        aiOutputMd: "# d",
      },
      { sendEmail },
    );
    expect(res.outcome).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(
      (db.prepare(`SELECT error FROM earnings_emails WHERE event_id = ?`).get(other) as {
        error: string;
      }).error,
    ).toBe("in_progress"); // still the other process's, untouched

    // Zero survivors: every member's row has moved, so nothing goes on the wire.
    db.prepare(`UPDATE earnings_emails SET claim_token = 'gone' WHERE event_id = ?`).run(eventId);
    const none = await deliverClaimedBatch(
      db,
      {
        members: [{ eventId, phase: "recap", token: good.token!, mode: "fresh" }],
        recipient: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        aiInputHash: null,
        aiOutputMd: "# d",
      },
      { sendEmail },
    );
    expect(none).toMatchObject({ outcome: "failed", status: 409, providerMessageId: null });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("two Mac callers racing send exactly once", () => {
  // TWO CONNECTIONS TO ONE FILE, IN ONE PROCESS. That is representative: SQLite
  // serialises on the same file lock whether the writers are threads, processes
  // or launchd invocations, and it is the lock — not the process boundary —
  // that the UNIQUE(event_id, phase) claim relies on. (Same reasoning as the
  // slice D precedent.) Barriers, never sleeps.
  let dir: string;
  let file: string;
  let a: Database.Database;
  let b: Database.Database;
  let id: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-service-race-"));
    file = path.join(dir, "race.db");
    a = new Database(file);
    a.pragma("journal_mode = WAL");
    a.pragma("foreign_keys = ON");
    runMigrations(a);
    id = seedEvent(a);
    b = new Database(file);
    b.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["sweep", "nudge"],
    ["nudge", "manual"],
    ["manual", "sweep"],
  ] as Array<[SendMode, SendMode]>)(
    "first=%s, second=%s → one provider call",
    async (firstMode, secondMode) => {
      let providerCalls = 0;
      let releaseProvider!: () => void;
      const providerEntered = new Promise<void>((resolve) => {
        // The first send parks here until the second attempt has run to completion.
        releaseProvider = resolve;
      });
      let firstEntered!: () => void;
      const firstHasEntered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });

      const cand = { eventId: id, symbol: "XMPL", phase: "recap" as const };
      const first = sendEarningsCandidate(a, cand, {
        mode: firstMode,
        recipient: RECIPIENT,
        seams: {
          compose: async () => composed,
          sendEmail: async (o) => {
            providerCalls += 1;
            firstEntered();
            await providerEntered;
            return { messageId: o.messageId!, response: "250 OK" };
          },
        },
      });

      await firstHasEntered; // barrier: the row is now 'sending'
      const second = await sendEarningsCandidate(b, cand, {
        mode: secondMode,
        recipient: RECIPIENT,
        seams: {
          compose: async () => composed,
          sendEmail: async () => {
            providerCalls += 1;
            return { messageId: "x", response: "" };
          },
        },
      });
      // The loser's outcome is in_progress for every pair: a live 'sending' row
      // is never taken over, in AUTOMATIC or MANUAL mode (M-E4).
      expect(second).toEqual({ outcome: "in_progress" });

      releaseProvider();
      expect(await first).toMatchObject({ outcome: "sent" });
      expect(providerCalls).toBe(1);
      expect(a.prepare(`SELECT COUNT(*) c FROM earnings_emails`).get()).toEqual({ c: 1 });
    },
  );
});
