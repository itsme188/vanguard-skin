/**
 * Morning-debrief SEND (2026-08-02 plan, Task 3). Exercises the window/day
 * gate, wrap-style claim choreography (with the debrief's per-member-drop
 * instead of whole-batch-abort on conflict), compose → send, and per-member
 * audit rows of runMorningDebrief.
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

const mockedFindCandidates = vi.mocked(findDebriefCandidates);

import { sendEmail } from "@/lib/email";
const mockedSend = vi.mocked(sendEmail);

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
    // No candidates seeded — isolates the gate behavior from send behavior.
    const res1 = await runMorningDebrief(db, {
      now: NOW_BEFORE_WINDOW,
      force: true,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res1.skippedReason).not.toBe("outside-window");
    expect(res1.skippedReason).toBe("no-candidates");
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

  it("second run same ET day → already-ran-today (day key stamped on first run, before compose)", async () => {
    const res1 = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res1.skippedReason).toBe("no-candidates");
    expect(settingsValue("last_debrief_date")).toBe(TODAY);

    const res2 = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });
    expect(res2).toEqual({ sent: false, covered: [], skippedReason: "already-ran-today" });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("no unsent candidates → stamps the day key, sends nothing, sent:false no-candidates", async () => {
    const res = await runMorningDebrief(db, {
      now: NOW_IN_WINDOW,
      recipient: RECIPIENT,
      generate: stubGenerate(),
    });

    expect(res).toEqual({ sent: false, covered: [], skippedReason: "no-candidates" });
    expect(settingsValue("last_debrief_date")).toBe(TODAY);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
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

  it("missing recipient (no opts.recipient, no BRIEFING_EMAIL_TO) → sent:false, never throws, no claims taken", async () => {
    const prev = process.env.BRIEFING_EMAIL_TO;
    delete process.env.BRIEFING_EMAIL_TO;
    try {
      const a = seedCandidate("AAA");

      const res = await runMorningDebrief(db, { now: NOW_IN_WINDOW, generate: stubGenerate() });

      expect(res).toEqual({ sent: false, covered: [] });
      expect(mockedSend).not.toHaveBeenCalled();
      expect(auditRows()).toHaveLength(0);
      // No claim was ever taken for AAA.
      expect(
        db.prepare(`SELECT * FROM earnings_emails WHERE event_id = ?`).get(a),
      ).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.BRIEFING_EMAIL_TO = prev;
    }
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
