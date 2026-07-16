/**
 * EOD earnings-wrap send (#17 Task 2). Exercises the claim → staple →
 * single-email → per-event audit choreography of runWrapPass.
 * Spec: docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  composeEarningsEmail,
  type ComposeEarningsResult,
} from "@/lib/digest/send-earnings-email";
import { sendEmail } from "@/lib/email";
import {
  checkEarningsCloudMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";
import { runWrapPass } from "@/lib/earnings/wrap-send";

// composeEarningsEmail is the only send-earnings-email export we stub — the
// claim/release/renderHeadlineTable/EarningsEmailError exports stay REAL so the
// mutex + scoreboard behave exactly as in production (AI-mocking memory pattern).
vi.mock("@/lib/digest/send-earnings-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digest/send-earnings-email")>()),
  composeEarningsEmail: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: vi.fn().mockResolvedValue(null),
  setEarningsRunningMarker: vi.fn().mockResolvedValue(null),
  clearEarningsRunningMarker: vi.fn().mockResolvedValue(null),
  writeMacSentEarningsMarker: vi.fn().mockResolvedValue(null),
}));

const mockedCompose = vi.mocked(composeEarningsEmail);
const mockedSend = vi.mocked(sendEmail);
const mockedCloudMarker = vi.mocked(checkEarningsCloudMarker);
const mockedMacSent = vi.mocked(writeMacSentEarningsMarker);

const TODAY = "2026-07-16";
const RECIPIENT = "desk@example.com";
// All-ready AMC send: 14:00 ET on 7/16 (before the 20:00 AMC deadline).
const NOW_ALL_READY = new Date("2026-07-16T18:00:00Z");
// AMC deadline passed: 20:30 ET on 7/16.
const NOW_DEADLINE_PASSED = new Date("2026-07-17T00:30:00Z");
// Before the AMC deadline: 14:00 ET on 7/16.
const NOW_WAITING = new Date("2026-07-16T18:00:00Z");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  mockedCloudMarker.mockResolvedValue(null);
  // Default compose stub: distinct aiMarkdown per event so audit rows and the
  // stapled body can be asserted independently.
  mockedCompose.mockImplementation(
    async (_db, eventId): Promise<ComposeEarningsResult> => ({
      symbol: `E${eventId}`,
      title: `title-${eventId}`,
      markdown: `md-${eventId}`,
      aiMarkdown: `AI recap body for event ${eventId}`,
      html: `<p>${eventId}</p>`,
      promptHash: `hash${eventId}`,
    }),
  );
});

function seedHeld(symbol: string): number {
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
     VALUES (?, ?, 100, '2026-07-15', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

function seedEvent(opts: {
  symbol: string;
  releaseTime?: string | null;
  ready?: boolean;
  date?: string;
}): number {
  const ready = opts.ready ?? true;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol,
           consensus_estimate, actual_value, enriched_at, source_key, week_of, superseded)
         VALUES ('finnhub', 'earnings', ?, ?, ?, ?, 'EPS 0.90', ?, ?, ?, '2026-07-13', 0)`,
      )
      .run(
        opts.date ?? TODAY,
        opts.releaseTime === undefined ? "16:15" : opts.releaseTime,
        `${opts.symbol} earnings`,
        opts.symbol,
        ready ? "EPS 1.00" : null,
        ready ? "2026-07-16 18:20:00" : null,
        `finnhub:${opts.symbol}:${opts.date ?? TODAY}`,
      ).lastInsertRowid,
  );
}

/** Held + AMC + ready in one call; returns the calendar_events id. */
function seedReadyAmc(symbol: string): number {
  seedHeld(symbol);
  return seedEvent({ symbol, ready: true });
}

function auditRows(): { event_id: number; error: string | null; ai_output_md: string | null }[] {
  return db
    .prepare(`SELECT event_id, error, ai_output_md FROM earnings_emails ORDER BY event_id`)
    .all() as { event_id: number; error: string | null; ai_output_md: string | null }[];
}

describe("runWrapPass", () => {
  it("1. cluster below threshold → no-op (no send, no audit rows)", async () => {
    seedReadyAmc("AAA");
    seedReadyAmc("BBB"); // only 2 members — below WRAP_THRESHOLD (3)

    const res = await runWrapPass(db, { now: NOW_ALL_READY, recipient: RECIPIENT });

    expect(res).toEqual({ wrapsSent: 0, wrapped: 0, stillWaiting: [] });
    expect(mockedSend).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("2. cluster ≥3 all ready → ONE email, per-event audit rows + mac-sent markers", async () => {
    const ids = ["AAA", "BBB", "CCC"].map(seedReadyAmc);

    const res = await runWrapPass(db, { now: NOW_ALL_READY, recipient: RECIPIENT });

    expect(res.wrapsSent).toBe(1);
    expect(res.wrapped).toBe(3);
    expect(res.stillWaiting).toEqual([]);

    // ONE stapled email.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const call = mockedSend.mock.calls[0][0];
    expect(call.subject).toBe(`\u{1F4CA} Earnings wrap — AMC ${TODAY} (3 names)`);
    expect(call.to).toBe(RECIPIENT);
    expect(call.fromLocalPart).toBe("earnings");
    for (const id of ids) {
      expect(call.html).toContain(`AI recap body for event ${id}`);
    }

    // One completed audit row per event + a mac-sent marker each.
    const rows = auditRows();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.error).toBeNull();
      expect(r.ai_output_md).toBe(`AI recap body for event ${r.event_id}`);
    }
    expect(mockedMacSent).toHaveBeenCalledTimes(3);
    for (const id of ids) {
      expect(mockedMacSent).toHaveBeenCalledWith("recap", id);
    }
  });

  it("3. deadline passed with a blocked member → sends ready ones + still-waiting line; blocked gets no audit row", async () => {
    const a = seedReadyAmc("AAA");
    const b = seedReadyAmc("BBB");
    seedHeld("ZZZ");
    const blocked = seedEvent({ symbol: "ZZZ", ready: false }); // no actual → not ready

    const res = await runWrapPass(db, { now: NOW_DEADLINE_PASSED, recipient: RECIPIENT });

    expect(res.wrapsSent).toBe(1);
    expect(res.wrapped).toBe(2);
    expect(res.stillWaiting).toEqual(["ZZZ"]);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const call = mockedSend.mock.calls[0][0];
    expect(call.subject).toBe(`\u{1F4CA} Earnings wrap — AMC ${TODAY} (2 names)`);
    expect(call.html).toContain("Still waiting on actuals: ZZZ");

    const rows = auditRows();
    expect(rows.map((r) => r.event_id).sort()).toEqual([a, b].sort());
    // Blocked member never touched.
    expect(rows.find((r) => r.event_id === blocked)).toBeUndefined();
  });

  it("4. deadline not passed and not all ready → no-op (waiting)", async () => {
    seedReadyAmc("AAA");
    seedReadyAmc("BBB");
    seedHeld("ZZZ");
    seedEvent({ symbol: "ZZZ", ready: false });

    const res = await runWrapPass(db, { now: NOW_WAITING, recipient: RECIPIENT });

    expect(res.wrapsSent).toBe(0);
    expect(res.wrapped).toBe(0);
    expect(res.stillWaiting).toEqual(["ZZZ"]);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("5. one compose failure → that name shows scoreboard + retry note, wrap still sends, its claim is released (no audit row)", async () => {
    const a = seedReadyAmc("AAA");
    const b = seedReadyAmc("BBB");
    const c = seedReadyAmc("CCC");
    const failId = b;
    mockedCompose.mockImplementation(async (_db, eventId): Promise<ComposeEarningsResult> => {
      if (eventId === failId) throw new Error("Claude timed out");
      return {
        symbol: `E${eventId}`,
        title: `title-${eventId}`,
        markdown: `md-${eventId}`,
        aiMarkdown: `AI recap body for event ${eventId}`,
        html: `<p>${eventId}</p>`,
        promptHash: `hash${eventId}`,
      };
    });

    const res = await runWrapPass(db, { now: NOW_ALL_READY, recipient: RECIPIENT });

    expect(res.wrapsSent).toBe(1);
    expect(res.wrapped).toBe(2); // only the 2 that composed
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const call = mockedSend.mock.calls[0][0];
    // All 3 names appear in the wrap (2 recaps + 1 compose-failed section).
    expect(call.subject).toBe(`\u{1F4CA} Earnings wrap — AMC ${TODAY} (3 names)`);
    expect(call.html).toContain("Compose failed");
    expect(call.html).toContain("BBB"); // scoreboard for the failed name is present

    // Only the 2 composed names get audit rows; the failed one's claim is released.
    const rows = auditRows();
    expect(rows.map((r) => r.event_id).sort()).toEqual([a, c].sort());
    expect(
      db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(failId),
    ).toBeUndefined();
    // mac-sent only for the two composed names.
    expect(mockedMacSent).toHaveBeenCalledTimes(2);
    expect(mockedMacSent).not.toHaveBeenCalledWith("recap", failId);
  });

  it("6. per-event cloud-sent marker present → that member is excluded from the staple", async () => {
    const a = seedReadyAmc("AAA");
    const b = seedReadyAmc("BBB");
    const c = seedReadyAmc("CCC");
    const cloud = seedReadyAmc("DDD");
    mockedCloudMarker.mockImplementation(async (_phase, eventId) =>
      eventId === cloud ? { sentBy: "cloud" } : null,
    );

    const res = await runWrapPass(db, { now: NOW_ALL_READY, recipient: RECIPIENT });

    expect(res.wrapsSent).toBe(1);
    expect(res.wrapped).toBe(3); // 4 expected − 1 cloud-sent
    const call = mockedSend.mock.calls[0][0];
    expect(call.subject).toBe(`\u{1F4CA} Earnings wrap — AMC ${TODAY} (3 names)`);

    const rows = auditRows();
    expect(rows.map((r) => r.event_id).sort()).toEqual([a, b, c].sort());
    expect(rows.find((r) => r.event_id === cloud)).toBeUndefined();
    expect(mockedMacSent).not.toHaveBeenCalledWith("recap", cloud);
  });

  it("7. claim conflict on a member → aborts this tick, releases the claims already taken, sends nothing", async () => {
    const a = seedReadyAmc("AAA");
    const b = seedReadyAmc("BBB");
    const z = seedReadyAmc("ZZZ"); // sorts last → wrap claims AAA, BBB, then conflicts on ZZZ
    // Pre-existing live (non-stale) claim held by another process on ZZZ.
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
       VALUES (?, 'recap', 'other@x.com', datetime('now'), 'in_progress', 'foreign-token')`,
    ).run(z);

    const res = await runWrapPass(db, { now: NOW_ALL_READY, recipient: RECIPIENT });

    expect(res.wrapsSent).toBe(0);
    expect(mockedSend).not.toHaveBeenCalled();
    // AAA + BBB claims released; only the foreign ZZZ claim remains.
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(z);
    expect(rows[0].error).toBe("in_progress");
    expect([a, b]).not.toContain(rows[0].event_id);
  });

  it("8. send failure after compose → releases all fresh claims, writes no audit rows, returns zeros (does not throw)", async () => {
    ["AAA", "BBB", "CCC"].forEach(seedReadyAmc);
    mockedSend.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await runWrapPass(db, { now: NOW_ALL_READY, recipient: RECIPIENT });

    expect(res).toEqual({ wrapsSent: 0, wrapped: 0, stillWaiting: [] });
    expect(auditRows()).toHaveLength(0); // every fresh claim released
    expect(mockedMacSent).not.toHaveBeenCalled();
  });

  it("throws a 400 EarningsEmailError when no recipient is configured", async () => {
    const prev = process.env.BRIEFING_EMAIL_TO;
    delete process.env.BRIEFING_EMAIL_TO;
    try {
      await expect(runWrapPass(db, { now: NOW_ALL_READY })).rejects.toMatchObject({
        name: "EarningsEmailError",
        status: 400,
      });
    } finally {
      if (prev !== undefined) process.env.BRIEFING_EMAIL_TO = prev;
    }
  });
});
