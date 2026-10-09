/**
 * An earnings email is asked for a calendar entry that does not exist (it was
 * never there, or it was deleted between the candidate scan and the send).
 *
 * Before this file's fix the slot claim tried to insert an audit row for the
 * missing entry and SQLite answered with a raw foreign-key error, which
 * travelled up through the send service as an uncaught exception. And a
 * member deleted WHILE the morning debrief was being composed was not noticed
 * at all: the stapled email went out still narrating it.
 *
 * Now the one reader of "may this calendar row be emailed" (`emailRowRefusal`)
 * answers `event_not_found`, and every caller treats it like the other two
 * calendar-row refusals: nothing is sent, nothing is written, and the desk
 * gets a plain sentence.
 *
 * REAL claim, REAL send service, REAL debrief. Stubbed: the mail transport,
 * the AI client, the option/history refresh and `fetch`. Synthetic ZZ*
 * tickers and round figures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/provider", () => ({
  getRawAnthropicClient: () => ({
    messages: {
      create: async () => ({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "## Read\n\nSynthetic body." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  }),
}));
vi.mock("@/lib/ai/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/models")>()),
  resolveFeatureModel: () => ({ provider: "anthropic", modelId: "test-model" }),
}));
vi.mock("@/lib/earnings/intel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/intel")>()),
  ensureIntelForEvents: vi.fn(async () => undefined),
}));

import { runMorningDebrief } from "@/lib/earnings/debrief-send";
import { sendEarningsCandidate, type SendMode } from "@/lib/earnings/send-service";
import {
  claimEarningsEmailSlot,
  emailRowRefusal,
  isEmailRowRefusal,
} from "@/lib/digest/send-earnings-email";

const RECIPIENT = "desk@example.com";
const DAY = "2026-06-10";
const WEEK = "2026-06-08";
const ENRICHED_AT = "2026-06-10 21:30:00";
const MISSING_ID = 987654;

let db: Database.Database;

beforeEach(() => {
  vi.stubEnv("WORKER_MARKER_URL", "");
  vi.stubEnv("CRON_SHARED_SECRET", "");
  vi.stubEnv("BRIEFING_EMAIL_TO", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network is off in this test");
    }),
  );
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  db.close();
});

function seedHeldReported(symbol: string): number {
  const accountId = (
    db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(`acct-${symbol}`) as {
      id: number;
    }
  ).id;
  const securityId = (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
         VALUES (?, 'stock', 'equity', 1) RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, '2026-06-01')",
  ).run(accountId, securityId);
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          source_key, week_of, consensus_estimate, actual_value, enriched_at)
       VALUES ('finnhub', 'earnings', ?, 'AMC', '16:30', ?, ?, ?, ?,
               'EPS 0.90 / Rev 90,000,000', 'EPS 1.00 / Rev 100,000,000', ?)`,
    )
    .run(DAY, `${symbol} earnings`, symbol, `finnhub:${symbol}:${DAY}:earnings`, WEEK, ENRICHED_AT)
    .lastInsertRowid as number;
}

function deleteEvent(id: number): void {
  db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
}

function emailRows(): Array<{ event_id: number; phase: string; error: string | null }> {
  return db
    .prepare(`SELECT event_id, phase, error FROM earnings_emails ORDER BY id`)
    .all() as Array<{ event_id: number; phase: string; error: string | null }>;
}

function transport() {
  return vi.fn(async (o: { messageId?: string }) => ({
    messageId: o.messageId ?? "<m@test>",
    response: "250 OK",
  }));
}

describe("the one reader: a calendar entry that does not exist", () => {
  it("answers event_not_found, whichever way the manual-twin switch is set", () => {
    expect(emailRowRefusal(db, MISSING_ID, { refuseIgnoredManualTwin: true })).toBe("event_not_found");
    expect(emailRowRefusal(db, MISSING_ID, { refuseIgnoredManualTwin: false })).toBe("event_not_found");
  });

  it("control: a live entry is not refused", () => {
    const id = seedHeldReported("ZZA");
    expect(emailRowRefusal(db, id, { refuseIgnoredManualTwin: true })).toBeNull();
  });

  it("the guard recognises all three calendar-row refusals and nothing else", () => {
    expect(isEmailRowRefusal("event_not_found")).toBe(true);
    expect(isEmailRowRefusal("superseded_event")).toBe(true);
    expect(isEmailRowRefusal("ignored_manual_twin")).toBe(true);
    expect(isEmailRowRefusal("already_sent")).toBe(false);
    expect(isEmailRowRefusal(undefined)).toBe(false);
  });
});

describe("the slot claim, for a calendar entry that does not exist", () => {
  it("refuses in plain terms instead of raising a foreign-key error, and writes nothing", () => {
    expect(claimEarningsEmailSlot(db, MISSING_ID, "recap", RECIPIENT)).toEqual({
      claimed: false,
      mode: "fresh",
      reason: "event_not_found",
    });
    expect(claimEarningsEmailSlot(db, MISSING_ID, "preview", RECIPIENT, { mode: "manual" })).toEqual({
      claimed: false,
      mode: "fresh",
      reason: "event_not_found",
    });
    expect(emailRows()).toEqual([]);
  });

  it("control: the same call on a live entry claims the slot", () => {
    const id = seedHeldReported("ZZA");
    expect(claimEarningsEmailSlot(db, id, "recap", RECIPIENT)).toMatchObject({ claimed: true });
    expect(emailRows()).toEqual([{ event_id: id, phase: "recap", error: "in_progress" }]);
  });
});

describe("sendEarningsCandidate, handed a calendar entry that does not exist", () => {
  const modes: SendMode[] = ["sweep", "nudge", "manual"];
  for (const mode of modes) {
    for (const phase of ["preview", "recap"] as const) {
      it(`${phase}, mode ${mode}: refused with a plain sentence, nothing sent, nothing written`, async () => {
        const sendEmail = transport();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const res = await sendEarningsCandidate(
          db,
          { eventId: MISSING_ID, symbol: "ZZA", phase },
          { mode, recipient: RECIPIENT, seams: { sendEmail } },
        );
        warn.mockRestore();
        expect(res).toEqual({
          outcome: "refused",
          code: "event_not_found",
          status: 404,
          reason: `The calendar entry this ${phase} was for no longer exists. Nothing was sent.`,
        });
        expect(sendEmail).not.toHaveBeenCalled();
        expect(emailRows()).toEqual([]);
      });
    }
  }

  it("deleted WHILE the email is being composed: refused before the wire, no row left behind", async () => {
    const id = seedHeldReported("ZZA");
    const sendEmail = transport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let claimedDuringCompose: unknown;
    const res = await sendEarningsCandidate(
      db,
      { eventId: id, symbol: "ZZA", phase: "recap" },
      {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: {
          sendEmail,
          compose: async () => {
            claimedDuringCompose = emailRows();
            deleteEvent(id);
            return {
              symbol: "ZZA",
              title: "ZZA Earnings Recap",
              markdown: "# ZZA",
              aiMarkdown: "body",
              html: "<p>body</p>",
              promptHash: "h",
            };
          },
        },
      },
    );
    warn.mockRestore();
    expect(claimedDuringCompose).toEqual([{ event_id: id, phase: "recap", error: "in_progress" }]);
    expect(res).toMatchObject({ outcome: "refused", code: "event_not_found", status: 404 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);
  });

  it("control: the same entry, still there, is sent", async () => {
    const id = seedHeldReported("ZZA");
    const sendEmail = transport();
    const res = await sendEarningsCandidate(
      db,
      { eventId: id, symbol: "ZZA", phase: "recap" },
      { mode: "sweep", recipient: RECIPIENT, seams: { sendEmail } },
    );
    expect(res.outcome).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailRows()).toEqual([{ event_id: id, phase: "recap", error: null }]);
  });
});

describe("runMorningDebrief: a member deleted while the debrief is being composed", () => {
  const TICK_1 = new Date("2026-06-11T11:50:00Z"); // 07:50 ET
  const TICK_2 = new Date("2026-06-11T12:05:00Z"); // 08:05 ET, same window

  it("sends nothing (the draft narrates an entry that is gone); the next run sends for the member that is left", async () => {
    const a = seedHeldReported("ZZA");
    const b = seedHeldReported("ZZB");
    const sendEmail = transport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await runMorningDebrief(db, {
      now: TICK_1,
      recipient: RECIPIENT,
      generate: async () => {
        deleteEvent(b);
        return "## What changed overnight\n\n- synthetic";
      },
      seams: { sendEmail },
    });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(first).toEqual({ sent: false, covered: [], skippedReason: "member-replaced" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);
    expect(lines).toEqual([
      `[debrief] nothing sent: ZZB (event ${b}) was replaced on or removed from the calendar while the debrief was being composed; released 2 claim(s), the next run rebuilds the batch`,
    ]);

    const second = await runMorningDebrief(db, {
      now: TICK_2,
      recipient: RECIPIENT,
      generate: async () => "## What changed overnight\n\n- synthetic",
      seams: { sendEmail },
    });
    expect(second).toMatchObject({ sent: true, covered: ["ZZA"] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailRows()).toEqual([{ event_id: a, phase: "recap", error: null }]);
  });
});
