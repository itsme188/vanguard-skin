/**
 * Morning-debrief SEND (2026-08-02 plan, Task 3). Exercises the window/day
 * gate, wrap-style claim choreography (with the debrief's per-member-drop
 * instead of whole-batch-abort on conflict), compose → send, and per-member
 * audit rows of runMorningDebrief.
 *
 * Slice E (R-E9) added the last describe block: delivery now goes through
 * `deliverClaimedBatch`, and every assertion here about the debrief's
 * OBSERVABLE result — `{ sent, covered, skippedReason? }` — is unchanged on
 * purpose, because the sweep reads it and must not be able to tell.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findDebriefCandidates } from "@/lib/earnings/debrief";
import { runMorningDebrief } from "@/lib/earnings/debrief-send";

// findDebriefCandidates is stubbed so a single test can simulate the race a
// real deployment can hit: candidate selection ran before a concurrent
// process claimed one of the events. Every OTHER export of the module (and
// findDebriefCandidates's own default behavior) stays REAL — same pattern as
// wrap-send.test.ts stubbing only composeEarningsEmail off send-earnings-email.
vi.mock("@/lib/earnings/debrief", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/earnings/debrief")>();
  return { ...actual, findDebriefCandidates: vi.fn(actual.findDebriefCandidates) };
});
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
// Mac↔cloud KV marker dance (F2) — same stub shape wrap-send.test.ts uses.
// All helpers no-op in production when WORKER_MARKER_URL is unset; mocking
// keeps the tests off the network and lets them pin the calls.
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: vi.fn().mockResolvedValue(null),
  setEarningsRunningMarker: vi.fn().mockResolvedValue(null),
  clearEarningsRunningMarker: vi.fn().mockResolvedValue(null),
  writeMacSentEarningsMarker: vi.fn().mockResolvedValue(null),
  fetchCloudSentEarnings: vi.fn().mockResolvedValue([]),
  checkPrintPushMarker: vi.fn().mockResolvedValue(false),
  writePrintPushMarker: vi.fn().mockResolvedValue(null),
}));

const mockedFindCandidates = vi.mocked(findDebriefCandidates);

import { sendEmail, type SendEmailOptions } from "@/lib/email";
import {
  checkEarningsCloudMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";
const mockedSend = vi.mocked(sendEmail);
const mockedCloudMarker = vi.mocked(checkEarningsCloudMarker);
const mockedMacSent = vi.mocked(writeMacSentEarningsMarker);

const RECIPIENT = "desk@example.com";
// 2026-08-02T11:45:00Z = 07:45 ET (EDT, UTC-4) — the window's opening minute.
const NOW_IN_WINDOW = new Date("2026-08-02T11:45:00Z");
// 05:00 ET — well before the window opens.
const NOW_BEFORE_WINDOW = new Date("2026-08-02T09:00:00Z");
// 08:30 ET — after the window closes.
const NOW_AFTER_WINDOW = new Date("2026-08-02T12:30:00Z");
const TODAY = "2026-08-02";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — reset the marker stubs explicitly so
  // a per-test mockImplementation can't leak into the next test.
  mockedCloudMarker.mockReset();
  mockedCloudMarker.mockResolvedValue(null);
  mockedMacSent.mockReset();
  mockedMacSent.mockResolvedValue(null);
  // Slice E (R-E9): the debrief delivers through deliverClaimedBatch, which
  // READS the provider's answer (`info.response` lands in provider_response).
  // The module-level @/lib/email mock still intercepts, because the send
  // service resolves `seams.sendEmail ?? sendEmail` — but it now has to
  // resolve like the real mailer. Tests that need to steer the wire inject
  // `seams.sendEmail` instead.
  mockedSend.mockReset();
  mockedSend.mockResolvedValue({ messageId: "<debrief@example.com>", response: "250 OK" });
});

function seedHeld(symbol: string): void {
  const sec = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-08-01', ?)`,
  ).run(acct, sec, `t:${symbol}`);
}

let eventCounter = 0;
// enriched_at is stamped by default: TODAY-dated rows only become debrief
// candidates once their enrichment completed (F3 — an in-flight today print
// belongs to its richer individual recap).
function seedEvent(opts: { symbol: string; date?: string; releaseTime?: string | null }): number {
  eventCounter += 1;
  const date = opts.date ?? TODAY;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol,
           actual_value, source_key, week_of, superseded, enriched_at)
         VALUES ('finnhub', 'earnings', ?, ?, ?, ?, 'EPS 1.00 · Rev 500M', ?, '2026-07-27', 0, ?)`,
      )
      .run(
        date,
        opts.releaseTime === undefined ? null : opts.releaseTime,
        `${opts.symbol} earnings`,
        opts.symbol,
        `finnhub:${opts.symbol}:${date}:${eventCounter}`,
        `${date} 07:00:00`,
      ).lastInsertRowid,
  );
}

/** Held + ready candidate in one call; returns the calendar_events id. */
function seedCandidate(symbol: string): number {
  seedHeld(symbol);
  return seedEvent({ symbol });
}

function auditRows(): { event_id: number; error: string | null; ai_output_md: string | null }[] {
  return db
    .prepare(`SELECT event_id, error, ai_output_md FROM earnings_emails ORDER BY event_id`)
    .all() as { event_id: number; error: string | null; ai_output_md: string | null }[];
}

function settingsValue(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

const stubGenerate = (text = "# What changed overnight\n- bullet one") =>
  vi.fn().mockResolvedValue(text);

describe("runMorningDebrief", () => {
  it("outside 07:45–08:20 ET → skippedReason outside-window (no writes)", async () => {
    seedCandidate("AAA");

    const res = await runMorningDebrief(db, {
      now: NOW_BEFORE_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res).toEqual({ sent: false, covered: [], skippedReason: "outside-window" });
    expect(settingsValue("last_debrief_date")).toBeNull();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);

    // Also after the window closes.
    const res2 = await runMorningDebrief(db, {
      now: NOW_AFTER_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res2.skippedReason).toBe("outside-window");
  });

  it("force:true bypasses the window but not the once-per-day key", async () => {
    seedCandidate("AAA");

    const res1 = await runMorningDebrief(db, {
      now: NOW_BEFORE_WINDOW,
      force: true,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res1.skippedReason).not.toBe("outside-window");
    expect(res1.sent).toBe(true);
    expect(settingsValue("last_debrief_date")).toBe(TODAY);

    // Same ET day, still forced — the day key (not the window) now blocks it.
    const res2 = await runMorningDebrief(db, {
      now: NOW_BEFORE_WINDOW,
      force: true,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res2.skippedReason).toBe("already-ran-today");
  });

  it("second run same ET day → already-ran-today (day key stamped on the first SENDING run, before compose)", async () => {
    seedCandidate("AAA");

    const res1 = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res1.sent).toBe(true);
    expect(settingsValue("last_debrief_date")).toBe(TODAY);

    const res2 = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res2).toEqual({ sent: false, covered: [], skippedReason: "already-ran-today" });
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  /**
   * F4: a candidate-less tick must NOT burn the day key. The sweep runs every
   * 15 min, so the window holds two or three ticks — actuals that land at
   * 07:52 (10 minutes after an empty 07:45 tick) must still get a debrief
   * that same morning rather than waiting a full day.
   */
  it("no unsent candidates → does NOT stamp the day key; a later same-day tick can still send", async () => {
    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res).toEqual({ sent: false, covered: [], skippedReason: "no-candidates" });
    expect(settingsValue("last_debrief_date")).toBeNull();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);

    // Actuals land between ticks; the next tick inside the window sends.
    seedCandidate("AAA");
    const res2 = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res2.sent).toBe(true);
    expect(res2.covered).toEqual(["AAA"]);
    expect(settingsValue("last_debrief_date")).toBe(TODAY);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it("happy path: claims every member, sends ONE email titled 'Earnings Debrief — {date}', writes a completed recap audit row per member, covered lists symbols", async () => {
    const aaa = seedCandidate("AAA");
    const bbb = seedCandidate("BBB");

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate("# What changed overnight\n- AAA guided up\n- BBB steady"),
    });

    expect(res.sent).toBe(true);
    expect(res.covered.sort()).toEqual(["AAA", "BBB"]);
    expect(res.skippedReason).toBeUndefined();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const call = mockedSend.mock.calls[0][0];
    expect(call.subject).toBe("☕ Earnings Debrief — Aug 2");
    expect(call.to).toBe(RECIPIENT);
    expect(call.fromLocalPart).toBe("earnings");
    expect(call.html).toContain("Earnings Debrief — Aug 2");
    expect(call.html).toContain("AAA guided up");
    expect(call.html).toContain("AAA");
    expect(call.html).toContain("BBB");

    const rows = auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.event_id).sort()).toEqual([aaa, bbb].sort());
    for (const r of rows) {
      expect(r.error).toBeNull();
      expect(r.ai_output_md).toContain("What changed overnight");
      // All members share the ONE debrief email's markdown.
      expect(r.ai_output_md).toBe(rows[0].ai_output_md);
    }
  });

  /**
   * F2 (marker dance): the debrief writes per-member recap audit rows, so it
   * owns the same Mac↔cloud coordination the retired wrap did — write
   * mac-sent per covered member after the send, and read the cloud marker
   * before composing so a recap the Worker already delivered (audit row not
   * yet reconciled) is never re-sent.
   */
  it("writes a mac-sent recap marker per covered member after a successful send", async () => {
    const aaa = seedCandidate("AAA");
    const bbb = seedCandidate("BBB");

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res.sent).toBe(true);
    expect(mockedMacSent).toHaveBeenCalledTimes(2);
    expect(mockedMacSent).toHaveBeenCalledWith("recap", aaa);
    expect(mockedMacSent).toHaveBeenCalledWith("recap", bbb);
    // Marker write follows the send, never precedes it.
    expect(mockedSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMacSent.mock.invocationCallOrder[0],
    );
  });

  it("no mac-sent markers are written when the send fails", async () => {
    seedCandidate("AAA");
    mockedSend.mockRejectedValueOnce(new Error("SMTP down"));

    await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(mockedMacSent).not.toHaveBeenCalled();
  });

  it("a member the cloud already recapped is dropped before compose: its fresh claim is released, a sent-by-cloud audit row is recorded, and it never reaches the email", async () => {
    const aaa = seedCandidate("AAA");
    const bbb = seedCandidate("BBB");

    mockedCloudMarker.mockImplementation(async (_phase, eventId) =>
      eventId === bbb ? { sentBy: "cloud" } : null,
    );

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(mockedCloudMarker).toHaveBeenCalledWith("recap", aaa);
    expect(mockedCloudMarker).toHaveBeenCalledWith("recap", bbb);

    expect(res.sent).toBe(true);
    expect(res.covered).toEqual(["AAA"]);
    // The cloud-delivered name is not narrated in the email.
    expect(mockedSend.mock.calls[0][0].html).not.toContain("BBB");
    // ...and gets no mac-sent marker (the cloud owns that key).
    expect(mockedMacSent).toHaveBeenCalledTimes(1);
    expect(mockedMacSent).toHaveBeenCalledWith("recap", aaa);

    const rows = auditRows();
    expect(rows).toHaveLength(2);
    const bbbRow = rows.find((r) => r.event_id === bbb)!;
    // Claim released, then the sent-by-cloud row recorded in its place —
    // never a lingering 'in_progress' claim, never a local ai_output_md.
    expect(bbbRow.error).toBe("sent-by-cloud");
    expect(bbbRow.ai_output_md).toBeNull();
    const aaaRow = rows.find((r) => r.event_id === aaa)!;
    expect(aaaRow.error).toBeNull();
  });

  it("a member already claimed by another process is dropped from this debrief (not aborted) and NOT audited", async () => {
    const a = seedCandidate("AAA");
    const b = seedCandidate("BBB");

    // Simulate the race: findDebriefCandidates already returned both as
    // eligible, but between that call and the claim step a concurrent
    // process took a live (non-stale) claim on BBB.
    mockedFindCandidates.mockReturnValueOnce({
      unsent: [
        { eventId: a, symbol: "AAA", event_date: TODAY, event_time: null, release_time: null },
        { eventId: b, symbol: "BBB", event_date: TODAY, event_time: null, release_time: null },
      ],
      alreadyRecapped: [],
    });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
       VALUES (?, 'recap', 'other@x.com', datetime('now'), 'in_progress', 'foreign-token')`,
    ).run(b);

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res.sent).toBe(true);
    expect(res.covered).toEqual(["AAA"]); // BBB dropped, not aborted
    expect(mockedSend).toHaveBeenCalledTimes(1);

    const rows = auditRows();
    // AAA's completed row + BBB's untouched foreign in_progress claim.
    expect(rows).toHaveLength(2);
    const aaaRow = rows.find((r) => r.event_id === a)!;
    expect(aaaRow.error).toBeNull();
    const bbbRow = rows.find((r) => r.event_id === b)!;
    expect(bbbRow.error).toBe("in_progress"); // never touched, never audited
  });

  it("compose/send failure releases the fresh claims (members return to candidacy) and the day key stays stamped", async () => {
    const a = seedCandidate("AAA");
    const b = seedCandidate("BBB");

    const failingGenerate = vi.fn().mockRejectedValue(new Error("AI Gateway timeout"));
    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: failingGenerate,
    });

    expect(res).toEqual({ sent: false, covered: [] });
    expect(mockedSend).not.toHaveBeenCalled();
    // Every fresh claim released — no lingering rows at all.
    expect(auditRows()).toHaveLength(0);
    // The day key is still stamped: no retry today even though nothing sent.
    expect(settingsValue("last_debrief_date")).toBe(TODAY);

    // The events are eligible again (as if for tomorrow's run) since no
    // earnings_emails row survives.
    const { unsent } = findDebriefCandidates(db, { now: NOW_IN_WINDOW });
    expect(unsent.map((c) => c.eventId).sort()).toEqual([a, b].sort());
  });

  it("send failure (after successful compose) also releases fresh claims and does not throw", async () => {
    seedCandidate("AAA");
    mockedSend.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res).toEqual({ sent: false, covered: [] });
    expect(auditRows()).toHaveLength(0);
  });

  it("AI output goes through stripModelPreamble", async () => {
    seedCandidate("AAA");

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(
        "Sure, here is the debrief you asked for:\n\n# What changed overnight\n- AAA beat estimates",
      ),
    });

    expect(res.sent).toBe(true);
    const call = mockedSend.mock.calls[0][0];
    expect(call.html).not.toContain("Sure, here is the debrief");
    expect(call.html).toContain("What changed overnight");

    const rows = auditRows();
    expect(rows[0].ai_output_md).not.toContain("Sure, here is the debrief");
    expect(rows[0].ai_output_md).toContain("AAA beat estimates");
  });

  it("missing recipient (no opts.recipient, no BRIEFING_EMAIL_TO) → no-recipient skip, day key NOT stamped, later tick still sends", async () => {
    const prev = process.env.BRIEFING_EMAIL_TO;
    delete process.env.BRIEFING_EMAIL_TO;
    try {
      const a = seedCandidate("AAA");

      const res = await runMorningDebrief(db, { now: NOW_IN_WINDOW, generate: stubGenerate() });

      expect(res).toEqual({ sent: false, covered: [], skippedReason: "no-recipient" });
      // 2026-08-02 parity fix: recipient resolution moved ABOVE the day-key
      // stamp — a misconfigured env must not burn the morning's debrief.
      expect(settingsValue("last_debrief_date")).toBeNull();
      expect(mockedSend).not.toHaveBeenCalled();
      expect(auditRows()).toHaveLength(0);
      // No claim was ever taken for AAA.
      expect(
        db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(a),
      ).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.BRIEFING_EMAIL_TO = prev;
    }

    // Env fixed (explicit recipient) → the same morning still sends.
    const res2 = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res2.sent).toBe(true);
    expect(settingsValue("last_debrief_date")).toBe(TODAY);
  });

  it("uses process.env.BRIEFING_EMAIL_TO when opts.recipient is omitted", async () => {
    const prev = process.env.BRIEFING_EMAIL_TO;
    process.env.BRIEFING_EMAIL_TO = "env-recipient@example.com";
    try {
      seedCandidate("AAA");
      const res = await runMorningDebrief(db, { now: NOW_IN_WINDOW, generate: stubGenerate() });
      expect(res.sent).toBe(true);
      expect(mockedSend.mock.calls[0][0].to).toBe("env-recipient@example.com");
    } finally {
      if (prev !== undefined) process.env.BRIEFING_EMAIL_TO = prev;
      else delete process.env.BRIEFING_EMAIL_TO;
    }
  });
});

/**
 * Slice E, R-E9. The morning debrief no longer owns a provider call: its N
 * claimed members are delivered by `deliverClaimedBatch`, the one lifecycle
 * primitive, so a stapled debrief gets the same in-flight state, the same
 * shared Message-ID, the same timeout classification and the same terminal
 * delivery-unknown ending as every other earnings email.
 *
 * The observable contract (`{ sent, covered, skippedReason? }`) is UNCHANGED on
 * purpose — the sweep reads it and must not be able to tell.
 */
describe("the debrief goes out through the one lifecycle primitive (slice E, R-E9)", () => {
  /** Three held, ready, TODAY-dated names — one stapled email covering N members. */
  function seedThreeDebriefCandidates(): number[] {
    return ["AAA", "BBB", "CCC"].map((s) => seedCandidate(s));
  }

  it("moves every member to 'sending' with ONE shared message id BEFORE the provider call", async () => {
    const ids = seedThreeDebriefCandidates();
    let seenAtCallTime: { error: string | null; provider_message_id: string | null }[] = [];
    const seamSend = vi.fn(async (o: SendEmailOptions) => {
      seenAtCallTime = db
        .prepare(`SELECT error, provider_message_id FROM earnings_emails ORDER BY event_id`)
        .all() as typeof seenAtCallTime;
      return { messageId: o.messageId!, response: "250 OK" };
    });

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate("## Debrief\n\nbody"),
      seams: { sendEmail: seamSend },
    });

    expect(res.sent).toBe(true);
    expect(res.covered.slice().sort()).toEqual(["AAA", "BBB", "CCC"]);
    expect(seamSend).toHaveBeenCalledTimes(1);
    // The module never reaches @/lib/email itself any more.
    expect(mockedSend).not.toHaveBeenCalled();

    // Every member is in flight, carrying the id we are about to put on the
    // wire, BEFORE the provider is called.
    expect(seenAtCallTime).toHaveLength(3);
    expect(new Set(seenAtCallTime.map((r) => r.error))).toEqual(new Set(["sending"]));
    expect(new Set(seenAtCallTime.map((r) => r.provider_message_id)).size).toBe(1);
    expect(seenAtCallTime[0].provider_message_id).toBe(seamSend.mock.calls[0][0].messageId);

    const after = db
      .prepare(
        `SELECT event_id, error, ai_output_md, provider_response
           FROM earnings_emails ORDER BY event_id`,
      )
      .all() as {
      event_id: number;
      error: string | null;
      ai_output_md: string;
      provider_response: string;
    }[];
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.event_id)).toEqual([...ids].sort((a, b) => a - b));
    for (const r of after) {
      expect(r.error).toBeNull();
      expect(r.ai_output_md).toContain("body"); // every member shares the stapled email
      expect(r.provider_response).toBe("250 OK");
    }
  });

  it("a timeout leaves all three delivery_unknown, reports sent, and never deletes a row", async () => {
    seedThreeDebriefCandidates();

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate("## Debrief\n\nbody"),
      // Never answers: the deadline decides. 20 ms keeps the test instant; the
      // production deadline is SEND_TIMEOUT_MS.
      seams: { sendEmail: () => new Promise<never>(() => {}), timeoutMs: 20 },
    });

    // The email may well have gone out — the safe reading, and the reason the
    // day key was stamped before compose.
    expect(res.sent).toBe(true);
    expect(res.covered).toHaveLength(3);
    expect(
      db.prepare(`SELECT COUNT(*) c FROM earnings_emails WHERE error = 'delivery_unknown'`).get(),
    ).toEqual({ c: 3 });
    // Terminal-unknown claims the phase for each member so the Worker fallback
    // never sends a second copy of a recap that did arrive.
    expect(mockedMacSent).toHaveBeenCalledTimes(3);
  });

  it("a definitive rejection releases every claim and reports not-sent", async () => {
    seedThreeDebriefCandidates();

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate("## Debrief\n\nbody"),
      seams: {
        sendEmail: async () => {
          throw Object.assign(new Error("Invalid recipient"), {
            code: "EENVELOPE",
            command: "RCPT TO",
          });
        },
      },
    });

    expect(res).toEqual({ sent: false, covered: [] });
    expect(db.prepare(`SELECT COUNT(*) c FROM earnings_emails`).get()).toEqual({ c: 0 });
    expect(mockedMacSent).not.toHaveBeenCalled();
  });

  it("a compose failure still releases the claims itself (the primitive was never reached)", async () => {
    seedThreeDebriefCandidates();
    const seamSend = vi.fn();

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: vi.fn().mockRejectedValue(new Error("model exploded")),
      seams: { sendEmail: seamSend },
    });

    expect(res).toEqual({ sent: false, covered: [] });
    expect(seamSend).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) c FROM earnings_emails`).get()).toEqual({ c: 0 });
    // The day key stays stamped: one debrief ATTEMPT per ET day.
    expect(settingsValue("last_debrief_date")).toBe(TODAY);
  });

  it("the per-member cloud-marker drop still happens BEFORE the batch", async () => {
    // R-E6 moved the SINGLE-candidate cloud pre-check into the send service.
    // The debrief's own PER-MEMBER pre-check is a different thing — pre-flight
    // over a batch, before one email is composed for the survivors — and stays
    // here.
    const ids = seedThreeDebriefCandidates();
    const cloudOwned = ids[1]; // BBB
    mockedCloudMarker.mockImplementation(async (_phase, eventId) =>
      eventId === cloudOwned ? { sentBy: "cloud" } : null,
    );
    const seamSend = vi.fn(async (o: SendEmailOptions) => ({
      messageId: o.messageId!,
      response: "250 OK",
    }));

    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate("## Debrief\n\nbody"),
      seams: { sendEmail: seamSend },
    });

    expect(res.sent).toBe(true);
    expect(res.covered).toEqual(["AAA", "CCC"]);
    expect(seamSend).toHaveBeenCalledTimes(1);
    expect(seamSend.mock.calls[0][0].html).not.toContain("BBB");
    expect(
      db.prepare(`SELECT COUNT(*) c FROM earnings_emails WHERE error = 'sent-by-cloud'`).get(),
    ).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) c FROM earnings_emails WHERE error IS NULL`).get()).toEqual({
      c: 2,
    });
  });
});
