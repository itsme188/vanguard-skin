/**
 * The sweep lists its candidates once and then sends them one at a time, each
 * send taking minutes. A candidate whose calendar entry is superseded AFTER
 * the list was built and BEFORE its turn must be refused by the send service,
 * booked as a skip (not a failure), and the loop must go on to the next one
 * (controller ruling 2026-10-07,
 * qa:earnings-email-viewer--second-recap-sent-on-superseded-twin-listed-as-valid-opposite-reaction).
 *
 * REAL sweep, REAL finder, REAL send service and composer. Stubbed: the mail
 * transport, the AI client, `fetch`, the Worker marker calls, Pushover, and
 * the sweep's unrelated end-of-tick passes (print-watch, worksheet printing,
 * transcripts, the outbox sender), none of which this test is about.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

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
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: async () => null,
  setEarningsRunningMarker: async () => null,
  clearEarningsRunningMarker: async () => null,
  writeMacSentEarningsMarker: async () => null,
  fetchCloudSentEarnings: async () => [],
  postMacRecentEarningsSweepMarker: async () => null,
}));
vi.mock("@/lib/alerts/notify-pushover", () => ({ sendPushover: async () => ({ sent: true }) }));
vi.mock("@/lib/transcripts/same-day", () => ({
  fetchSameDayTranscripts: async () => ({ attempted: 0, fetched: 0 }),
}));
vi.mock("@/lib/earnings/cloud-outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/cloud-outbox")>()),
  drainCloudOutbox: async () => ({ sent: 0, failed: 0, skipped: null }),
}));
vi.mock("@/lib/earnings/worksheet", () => ({ printArmedWorksheets: async () => ({ printed: 0 }) }));
vi.mock("@/lib/print-watch/watcher", () => ({ ensurePrintWatch: () => undefined }));

import { runEarningsEmailSweep } from "@/lib/calendar/email-sweep";

const RECIPIENT = "desk@example.com";
// Prints dated the day BEFORE the tick, so no same-day wrap suppression applies.
const DAY = "2026-06-09";
const ENRICHED_AT = "2026-06-10 21:30:00";
const NOW = new Date("2026-06-10T22:00:00Z");

let db: Database.Database;

beforeEach(() => {
  vi.stubEnv("WORKER_MARKER_URL", "");
  vi.stubEnv("CRON_SHARED_SECRET", "");
  vi.stubEnv("BRIEFING_EMAIL_TO", RECIPIENT);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network is off in this test");
    }),
  );
  sendEmail.mockReset();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  db.close();
});

function seedReportedHeld(symbol: string): number {
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
       VALUES ('finnhub', 'earnings', ?, 'AMC', '16:30', ?, ?, ?, '2026-06-08',
               'EPS 0.90 / Rev 90,000,000', 'EPS 1.00 / Rev 100,000,000', ?)`,
    )
    .run(DAY, `${symbol} earnings`, symbol, `finnhub:${symbol}:${DAY}:earnings`, ENRICHED_AT)
    .lastInsertRowid as number;
}

function emailRows() {
  return db
    .prepare(`SELECT event_id, phase, error FROM earnings_emails ORDER BY event_id`)
    .all() as Array<{ event_id: number; phase: string; error: string | null }>;
}

describe("runEarningsEmailSweep: a candidate superseded after the scan, before its turn", () => {
  it("is refused and booked as a skip, leaves no claim, and the next candidate is still sent", async () => {
    const a = seedReportedHeld("ZZA");
    const b = seedReportedHeld("ZZB");
    const c = seedReportedHeld("ZZC");

    // While the FIRST email is on the wire, another process supersedes ZZB's
    // entry. The sweep already holds ZZB in its list.
    sendEmail.mockImplementation(async (o: { messageId?: string }) => {
      if (sendEmail.mock.calls.length === 1) {
        db.prepare(`UPDATE calendar_events SET superseded = 1 WHERE id = ?`).run(b);
      }
      return { messageId: o.messageId ?? "<m@test>", response: "250 OK" };
    });

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.swept).toBe(3);
    expect(summary.results.map((r) => [r.eventId, r.ok, r.skipped ?? null])).toEqual([
      [a, true, null],
      [b, true, "entry-replaced"],
      [c, true, null],
    ]);
    expect(summary).toMatchObject({ sent: 2, skipped: 1, failed: 0 });
    expect(summary.results[1].message).toBe(
      "The calendar entry this recap was for has been replaced. Nothing was sent.",
    );
    expect(sendEmail).toHaveBeenCalledTimes(2);
    // No row at all for the refused candidate: no claim, no audit row.
    expect(emailRows()).toEqual([
      { event_id: a, phase: "recap", error: null },
      { event_id: c, phase: "recap", error: null },
    ]);
  });

  it("a candidate DELETED after the scan, before its turn, is booked as entry-not-found and the loop goes on", async () => {
    const a = seedReportedHeld("ZZA");
    const b = seedReportedHeld("ZZB");
    const c = seedReportedHeld("ZZC");
    sendEmail.mockImplementation(async (o: { messageId?: string }) => {
      if (sendEmail.mock.calls.length === 1) {
        db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(b);
      }
      return { messageId: o.messageId ?? "<m@test>", response: "250 OK" };
    });

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.results.map((r) => [r.eventId, r.ok, r.skipped ?? null])).toEqual([
      [a, true, null],
      [b, true, "entry-not-found"],
      [c, true, null],
    ]);
    expect(summary).toMatchObject({ sent: 2, skipped: 1, failed: 0 });
    expect(summary.results[1]).toMatchObject({
      status: 404,
      message: "The calendar entry this recap was for no longer exists. Nothing was sent.",
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(emailRows()).toEqual([
      { event_id: a, phase: "recap", error: null },
      { event_id: c, phase: "recap", error: null },
    ]);
  });

  it("does not come back on the next tick (no retry storm): the finder no longer lists it", async () => {
    const a = seedReportedHeld("ZZA");
    const b = seedReportedHeld("ZZB");
    sendEmail.mockImplementation(async (o: { messageId?: string }) => {
      db.prepare(`UPDATE calendar_events SET superseded = 1 WHERE id = ?`).run(b);
      return { messageId: o.messageId ?? "<m@test>", response: "250 OK" };
    });
    await runEarningsEmailSweep(db, { now: NOW });
    const second = await runEarningsEmailSweep(db, { now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(second.swept).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailRows()).toEqual([{ event_id: a, phase: "recap", error: null }]);
  });

  it("control: with nothing superseded, all three are sent", async () => {
    seedReportedHeld("ZZA");
    seedReportedHeld("ZZB");
    seedReportedHeld("ZZC");
    sendEmail.mockImplementation(async (o: { messageId?: string }) => ({
      messageId: o.messageId ?? "<m@test>",
      response: "250 OK",
    }));
    const summary = await runEarningsEmailSweep(db, { now: NOW });
    expect(summary).toMatchObject({ swept: 3, sent: 3, skipped: 0, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });
});
