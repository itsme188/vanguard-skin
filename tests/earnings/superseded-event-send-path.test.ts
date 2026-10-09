/**
 * Does the send path refuse an earnings row that is not the print's email row?
 * (owner ruling 2026-10-06, verification half,
 * qa:earnings-email-viewer--second-recap-sent-on-superseded-twin-listed-as-valid-opposite-reaction).
 *
 * Three reasons a row is not the email row, each checked against every email
 * kind (preview, recap, read-through reporter recap, morning debrief, and the
 * recap cluster that decides wrap suppression):
 *   1. the row is superseded;
 *   2. it is the LATER of two live hand-entered rows (email follows the
 *      earlier, lib/earnings/manual-twin-email.ts);
 *   3. it is a vendor twin hidden behind a hand-entered row (the real
 *      reconciler supersedes it).
 *
 * Every case runs the REAL finders, and the sends run the REAL
 * `sendEarningsCandidate` with the REAL composer. Only the outside world is
 * stubbed: the mail transport (the `sendEmail` seam), the AI client, the
 * options/history refresh (broker network) and `fetch`. Each "is refused" case
 * has a control beside it proving the same row DOES send while it is live, so
 * a refusal is the rule under test and not a broken fixture.
 *
 * History: this file first FOUND that only the finders refused such a row and
 * the send service sent for any event id it was handed. The seven cases that
 * recorded that are the "handed a superseded row directly" block below; they
 * failed until the claim itself started re-reading the calendar row.
 *
 * Synthetic book: ZZ* tickers, round numbers, a frozen clock per case.
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
// Broker/vendor network: the preview composer refreshes option pricing.
vi.mock("@/lib/earnings/intel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/intel")>()),
  ensureIntelForEvents: vi.fn(async () => undefined),
}));

import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { findDebriefCandidates } from "@/lib/earnings/debrief";
import { runMorningDebrief } from "@/lib/earnings/debrief-send";
import { getExpectedRecapCluster } from "@/lib/earnings/wrap";
import {
  sendEarningsCandidate,
  sendEarningsRecap,
  type SendMode,
} from "@/lib/earnings/send-service";
import { claimEarningsEmailSlot, EarningsEmailError } from "@/lib/digest/send-earnings-email";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { getEmailIgnoredManualTwins } from "@/lib/queries/manual-twin-email";

const RECIPIENT = "desk@example.com";
const DAY = "2026-06-10"; // a Wednesday; US Eastern is UTC-4
const WEEK = "2026-06-08";
const RELEASE = "16:30"; // ET = 20:30Z
const PREVIEW_NOW = new Date("2026-06-10T18:30:00Z"); // two hours before the release
const ENRICHED_AT = "2026-06-10 21:30:00";
const RECAP_NOW = new Date("2026-06-10T22:00:00Z");
const DEBRIEF_NOW = new Date("2026-06-11T11:50:00Z"); // 07:50 ET the next morning
const ACTUAL = "EPS 1.00 / Rev 100,000,000";
const CONSENSUS = "EPS 0.90 / Rev 90,000,000";

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

function seedHeld(symbol: string): void {
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
}

function seedEvent(o: {
  source: string;
  symbol: string;
  eventDate?: string;
  reported?: boolean;
  superseded?: number;
}): number {
  const date = o.eventDate ?? DAY;
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          source_key, week_of, consensus_estimate, actual_value, enriched_at, superseded)
       VALUES (?, 'earnings', ?, 'AMC', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.source,
      date,
      RELEASE,
      `${o.symbol} earnings`,
      o.symbol,
      `${o.source}:${o.symbol}:${date}:earnings`,
      WEEK,
      CONSENSUS,
      o.reported ? ACTUAL : null,
      o.reported ? ENRICHED_AT : null,
      o.superseded ?? 0,
    ).lastInsertRowid as number;
}

function setSuperseded(eventId: number, value: 0 | 1): void {
  db.prepare(`UPDATE calendar_events SET superseded = ? WHERE id = ?`).run(value, eventId);
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

/** Finder -> real send service, exactly as the sweep loop hands candidates over. */
async function sweepOnce(now: Date, sendEmail: ReturnType<typeof transport>) {
  const candidates = findEmailCandidates(db, { now });
  const outcomes = [];
  for (const c of candidates) {
    outcomes.push(
      await sendEarningsCandidate(
        db,
        { eventId: c.eventId, symbol: c.symbol, phase: c.phase, reporterRecap: c.reporterRecap },
        { mode: "sweep", recipient: RECIPIENT, seams: { sendEmail } },
      ),
    );
  }
  return { candidates, outcomes };
}

// ── Reason 1: the row is superseded ──────────────────────────────────────

describe("a superseded row: the preview", () => {
  it("control: the same row, live, is found and really sent", async () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA" });
    const sendEmail = transport();
    const { candidates, outcomes } = await sweepOnce(PREVIEW_NOW, sendEmail);
    expect(candidates).toEqual([{ eventId: id, symbol: "ZZA", phase: "preview" }]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["sent"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("superseded: no finder offers it and nothing is sent", async () => {
    seedHeld("ZZA");
    seedEvent({ source: "finnhub", symbol: "ZZA", superseded: 1 });
    const sendEmail = transport();
    const { candidates } = await sweepOnce(PREVIEW_NOW, sendEmail);
    expect(candidates).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);
  });
});

describe("a superseded row: the recap", () => {
  it("control: the same row, live, is found and really sent", async () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    const sendEmail = transport();
    const { candidates, outcomes } = await sweepOnce(RECAP_NOW, sendEmail);
    expect(candidates).toEqual([{ eventId: id, symbol: "ZZA", phase: "recap" }]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["sent"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("superseded: no finder offers it and nothing is sent", async () => {
    seedHeld("ZZA");
    seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    const sendEmail = transport();
    const { candidates } = await sweepOnce(RECAP_NOW, sendEmail);
    expect(candidates).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);
  });

  it("superseded beside its live twin that already has a recap: still nothing (the residue case)", async () => {
    seedHeld("ZZA");
    const live = seedEvent({ source: "manual", symbol: "ZZA", reported: true });
    seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, 'recap', ?, '2026-06-10 21:40:00', '# prose', NULL)`,
    ).run(live, RECIPIENT);
    const sendEmail = transport();
    const { candidates } = await sweepOnce(RECAP_NOW, sendEmail);
    expect(candidates).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toHaveLength(1);
  });
});

describe("a superseded row: the read-through reporter recap", () => {
  function seedReporter(superseded: 0 | 1): number {
    // ZZT is held; ZZR is not, and reports with a read-through onto ZZT.
    seedHeld("ZZT");
    db.prepare(
      `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
       VALUES ('ZZR', 'ZZT', 1, 'Same end market.')`,
    ).run();
    return seedEvent({ source: "finnhub", symbol: "ZZR", reported: true, superseded });
  }

  it("control: the same row, live, is offered as a reporter recap", () => {
    const id = seedReporter(0);
    expect(findEmailCandidates(db, { now: RECAP_NOW })).toEqual([
      { eventId: id, symbol: "ZZR", phase: "recap", reporterRecap: true },
    ]);
  });

  it("superseded: not offered", () => {
    seedReporter(1);
    expect(findEmailCandidates(db, { now: RECAP_NOW })).toEqual([]);
  });
});

describe("a superseded row: the morning debrief", () => {
  it("control: the same row, live, is found and the debrief really goes out", async () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    expect(findDebriefCandidates(db, { now: DEBRIEF_NOW }).unsent.map((c) => c.eventId)).toEqual([id]);
    const sendEmail = transport();
    const res = await runMorningDebrief(db, {
      now: DEBRIEF_NOW,
      recipient: RECIPIENT,
      generate: async () => "## What changed overnight\n\n- synthetic",
      seams: { sendEmail },
    });
    expect(res).toMatchObject({ sent: true, covered: ["ZZA"] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("superseded: not a candidate, and the debrief sends nothing", async () => {
    seedHeld("ZZA");
    seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    expect(findDebriefCandidates(db, { now: DEBRIEF_NOW }).unsent).toEqual([]);
    const sendEmail = transport();
    const res = await runMorningDebrief(db, {
      now: DEBRIEF_NOW,
      recipient: RECIPIENT,
      generate: async () => "## What changed overnight\n\n- synthetic",
      seams: { sendEmail },
    });
    expect(res).toMatchObject({ sent: false, skippedReason: "no-candidates" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);
  });
});

describe("a superseded row: the recap cluster that decides wrap suppression", () => {
  it("control then superseded: the row counts only while it is live", () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    expect(getExpectedRecapCluster(db, DAY, "AMC").map((m) => m.eventId)).toEqual([id]);
    setSuperseded(id, 1);
    expect(getExpectedRecapCluster(db, DAY, "AMC")).toEqual([]);
  });
});

// ── Reason 2: the later of two live hand-entered rows ────────────────────

describe("the later of two live hand-entered rows", () => {
  const LATER_DAY = "2026-06-12";
  function seedTwins(): { earlier: number; later: number } {
    seedHeld("ZZA");
    const earlier = seedEvent({ source: "manual", symbol: "ZZA" });
    const later = seedEvent({ source: "manual", symbol: "ZZA", eventDate: LATER_DAY, reported: true });
    return { earlier, later };
  }

  it("is the row the shared rule ignores", () => {
    const { earlier, later } = seedTwins();
    expect([...getEmailIgnoredManualTwins(db).keys()]).toEqual([later]);
    expect(getEmailIgnoredManualTwins(db).get(later)?.emailRowId).toBe(earlier);
  });

  it("gets no preview on its own day", async () => {
    const { later } = seedTwins();
    db.prepare(`UPDATE calendar_events SET actual_value = NULL, enriched_at = NULL WHERE id = ?`).run(later);
    const sendEmail = transport();
    const { candidates } = await sweepOnce(new Date("2026-06-12T18:30:00Z"), sendEmail);
    expect(candidates).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("gets no recap, even carrying an actual inside the recap window", async () => {
    seedTwins();
    const sendEmail = transport();
    const { candidates } = await sweepOnce(RECAP_NOW, sendEmail);
    expect(candidates).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is not a debrief candidate and not in the recap cluster", () => {
    seedTwins();
    expect(findDebriefCandidates(db, { now: new Date("2026-06-13T11:50:00Z") }).unsent).toEqual([]);
    expect(getExpectedRecapCluster(db, LATER_DAY, "AMC")).toEqual([]);
  });

  it("control: alone (no earlier twin) the same row IS a recap candidate", () => {
    seedHeld("ZZA");
    const only = seedEvent({ source: "manual", symbol: "ZZA", eventDate: LATER_DAY, reported: true });
    expect(findEmailCandidates(db, { now: RECAP_NOW }).map((c) => c.eventId)).toEqual([only]);
  });
});

// ── Reason 3: a vendor twin hidden behind a hand-entered row ─────────────

describe("a vendor twin hidden behind a hand-entered row", () => {
  it("after the real reconciler runs, the vendor twin gets no preview, recap or debrief", async () => {
    seedHeld("ZZA");
    const manual = seedEvent({ source: "manual", symbol: "ZZA" });
    const vendor = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-11" });
    reconcileEarningsDates(db, { today: DAY });
    expect(
      db.prepare(`SELECT id, superseded FROM calendar_events ORDER BY id`).all(),
    ).toEqual([
      { id: manual, superseded: 0 },
      { id: vendor, superseded: 1 },
    ]);

    // Preview window of the vendor twin's own (wrong) day.
    const sendEmail = transport();
    expect((await sweepOnce(new Date("2026-06-11T18:30:00Z"), sendEmail)).candidates).toEqual([]);

    // The vendor twin later picks up an actual of its own.
    db.prepare(`UPDATE calendar_events SET actual_value = ?, enriched_at = ? WHERE id = ?`).run(
      ACTUAL,
      "2026-06-11 21:30:00",
      vendor,
    );
    const recapNow = new Date("2026-06-11T22:00:00Z");
    expect(findEmailCandidates(db, { now: recapNow }).filter((c) => c.eventId === vendor)).toEqual([]);
    expect(
      findDebriefCandidates(db, { now: new Date("2026-06-12T11:50:00Z") }).unsent.filter(
        (c) => c.eventId === vendor,
      ),
    ).toEqual([]);
    expect(getExpectedRecapCluster(db, "2026-06-11", "AMC")).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the print still gets exactly one preview and one recap, on the hand-entered row", async () => {
    seedHeld("ZZA");
    const manual = seedEvent({ source: "manual", symbol: "ZZA" });
    seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-11" });
    reconcileEarningsDates(db, { today: DAY });

    const sendEmail = transport();
    const preview = await sweepOnce(PREVIEW_NOW, sendEmail);
    expect(preview.candidates.map((c) => [c.eventId, c.phase])).toEqual([[manual, "preview"]]);

    db.prepare(`UPDATE calendar_events SET actual_value = ?, enriched_at = ? WHERE id = ?`).run(
      ACTUAL,
      ENRICHED_AT,
      manual,
    );
    const recap = await sweepOnce(RECAP_NOW, sendEmail);
    expect(recap.candidates.map((c) => [c.eventId, c.phase])).toEqual([[manual, "recap"]]);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(emailRows().map((r) => [r.event_id, r.phase, r.error])).toEqual([
      [manual, "preview", null],
      [manual, "recap", null],
    ]);
  });
});

// ── The send service itself, handed a row that is not the email row ──────
//
// The finders are not the only way in: the sweep's list can be minutes old by
// the time a candidate's turn comes, and "send recap now" and the manual
// route never go through a finder. So the claim re-reads the calendar row in
// its own transaction, and the service asks once more after composing.

describe("sendEarningsCandidate, handed a superseded row directly", () => {
  const modes: SendMode[] = ["sweep", "nudge", "manual"];

  for (const mode of modes) {
    it(`recap, mode ${mode}: refuses, sends nothing, writes no audit row`, async () => {
      seedHeld("ZZA");
      const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: id, symbol: "ZZA", phase: "recap" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res.outcome).toBe("refused");
      expect(sendEmail).not.toHaveBeenCalled();
      expect(emailRows()).toEqual([]);
    });

    it(`preview, mode ${mode}: refuses, sends nothing, writes no audit row`, async () => {
      seedHeld("ZZA");
      const id = seedEvent({ source: "finnhub", symbol: "ZZA", superseded: 1 });
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: id, symbol: "ZZA", phase: "preview" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res.outcome).toBe("refused");
      expect(sendEmail).not.toHaveBeenCalled();
      expect(emailRows()).toEqual([]);
    });

    it(`control, mode ${mode}: the same row, live, is sent`, async () => {
      seedHeld("ZZA");
      const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: id, symbol: "ZZA", phase: "recap" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res.outcome).toBe("sent");
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(emailRows()).toEqual([{ event_id: id, phase: "recap", error: null }]);
    });
  }

  it("the sweep's own order: found while live, superseded before its turn, refused with no slot left claimed", async () => {
    seedHeld("ZZA");
    const manual = seedEvent({ source: "manual", symbol: "ZZA", reported: true });
    const vendor = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-11", reported: true });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, 'recap', ?, '2026-06-10 21:40:00', '# prose', NULL)`,
    ).run(manual, RECIPIENT);

    // 1. The sweep builds its list: the vendor twin is live and has no recap.
    const candidates = findEmailCandidates(db, { now: RECAP_NOW });
    expect(candidates.map((c) => [c.eventId, c.phase])).toEqual([[vendor, "recap"]]);

    // 2. A calendar sync in another process reconciles before the send.
    reconcileEarningsDates(db, { today: "2026-06-11" });
    expect(db.prepare(`SELECT superseded FROM calendar_events WHERE id = ?`).get(vendor)).toEqual({
      superseded: 1,
    });

    // 3. The sweep reaches the candidate it already holds.
    const sendEmail = transport();
    const res = await sendEarningsCandidate(
      db,
      { eventId: vendor, symbol: "ZZA", phase: "recap" },
      { mode: "sweep", recipient: RECIPIENT, seams: { sendEmail } },
    );
    expect(res).toMatchObject({ outcome: "refused", code: "superseded_event", status: 409 });
    expect(sendEmail).not.toHaveBeenCalled();
    // Only the live entry's own delivered recap exists: no claim, no audit row.
    expect(emailRows()).toEqual([{ event_id: manual, phase: "recap", error: null }]);
  });

  it("says so in plain words and names the date the print now sits on", async () => {
    seedHeld("ZZA");
    seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-09" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    const res = await sendEarningsCandidate(
      db,
      { eventId: old, symbol: "ZZA", phase: "recap" },
      { mode: "nudge", recipient: RECIPIENT, seams: { sendEmail: transport() } },
    );
    expect(res).toMatchObject({
      outcome: "refused",
      code: "superseded_event",
      reason:
        "The calendar entry this recap was for has been replaced; the current entry for ZZA reports 2026-06-09. Nothing was sent.",
    });
  });

  it("with no live entry to name, the sentence still stands on its own", async () => {
    seedHeld("ZZA");
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    const res = await sendEarningsCandidate(
      db,
      { eventId: old, symbol: "ZZA", phase: "preview" },
      { mode: "sweep", recipient: RECIPIENT, seams: { sendEmail: transport() } },
    );
    expect(res).toMatchObject({
      outcome: "refused",
      reason: "The calendar entry this preview was for has been replaced. Nothing was sent.",
    });
  });

  it("logs one line for a refusal", async () => {
    seedHeld("ZZA");
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sendEarningsCandidate(
      db,
      { eventId: old, symbol: "ZZA", phase: "recap" },
      { mode: "sweep", recipient: RECIPIENT, seams: { sendEmail: transport() } },
    );
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(lines).toEqual([
      `[send-service] recap ${old} (ZZA, sweep): refused at the claim, superseded_event`,
    ]);
  });

  it("superseded WHILE the email is being composed: refused before the wire, the claim is released", async () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    const sendEmail = transport();
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
            setSuperseded(id, 1);
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
    expect(claimedDuringCompose).toEqual([{ event_id: id, phase: "recap", error: "in_progress" }]);
    expect(res).toMatchObject({ outcome: "refused", code: "superseded_event" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);
  });

  it("a manual resend of a delivered email on a now-superseded entry is refused and the delivered row is untouched", async () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    db.prepare(
      `INSERT INTO earnings_emails
         (event_id, phase, recipient, sent_at, ai_output_md, error, provider_message_id, provider_response)
       VALUES (?, 'recap', ?, '2026-06-10 21:40:00', '# first', NULL, '<first@test>', '250 OK')`,
    ).run(id, RECIPIENT);
    setSuperseded(id, 1);
    const before = db.prepare(`SELECT * FROM earnings_emails`).all();

    const sendEmail = transport();
    const res = await sendEarningsCandidate(
      db,
      { eventId: id, symbol: "ZZA", phase: "recap" },
      { mode: "manual", recipient: RECIPIENT, seams: { sendEmail } },
    );
    expect(res).toMatchObject({ outcome: "refused", code: "superseded_event" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT * FROM earnings_emails`).all()).toEqual(before);
  });

  it("the manual route's entry point raises the same sentence as a 409, without the retry code", async () => {
    seedHeld("ZZA");
    seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-09" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    const err = await sendEarningsRecap(db, old, { recipient: RECIPIENT }).catch((e) => e);
    expect(err).toBeInstanceOf(EarningsEmailError);
    expect(err).toMatchObject({
      status: 409,
      message:
        "The calendar entry this recap was for has been replaced; the current entry for ZZA reports 2026-06-09. Nothing was sent.",
    });
    expect((err as EarningsEmailError).code).toBeUndefined();
    expect(emailRows()).toEqual([]);
  });
});

describe("the slot claim itself (what the morning debrief and the retired wrap call)", () => {
  it("refuses a superseded row and writes nothing", () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true, superseded: 1 });
    expect(claimEarningsEmailSlot(db, id, "recap", RECIPIENT)).toEqual({
      claimed: false,
      mode: "fresh",
      reason: "superseded_event",
    });
    expect(claimEarningsEmailSlot(db, id, "recap", RECIPIENT, { mode: "manual" })).toMatchObject({
      claimed: false,
      reason: "superseded_event",
    });
    expect(emailRows()).toEqual([]);
  });

  it("control: claims the same row while it is live", () => {
    seedHeld("ZZA");
    const id = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    expect(claimEarningsEmailSlot(db, id, "recap", RECIPIENT)).toMatchObject({
      claimed: true,
      mode: "fresh",
    });
    expect(emailRows()).toEqual([{ event_id: id, phase: "recap", error: "in_progress" }]);
  });

  it("works inside a caller's open transaction", () => {
    seedHeld("ZZA");
    const live = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    const old = seedEvent({ source: "nasdaq", symbol: "ZZA", reported: true, superseded: 1 });
    const out = db.transaction(() => [
      claimEarningsEmailSlot(db, live, "recap", RECIPIENT).claimed,
      claimEarningsEmailSlot(db, old, "recap", RECIPIENT).reason,
    ])();
    expect(out).toEqual([true, "superseded_event"]);
  });

  it("by default also refuses the later of two live hand-entered rows", () => {
    seedHeld("ZZA");
    const earlier = seedEvent({ source: "manual", symbol: "ZZA" });
    const later = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-12", reported: true });
    expect(claimEarningsEmailSlot(db, later, "recap", RECIPIENT).reason).toBe("ignored_manual_twin");
    expect(claimEarningsEmailSlot(db, earlier, "preview", RECIPIENT).claimed).toBe(true);
    expect(emailRows().map((r) => r.event_id)).toEqual([earlier]);
  });
});

// Ruling 2026-10-08 (orchestrator, after a second opinion; the owner can
// reverse it): a person pressing send on the later twin is refused too. Before
// this, `manual` and `nudge` sent an email for a row every other path ignores.
describe("sendEarningsCandidate, handed the later of two live hand-entered rows", () => {
  const LATER_TWIN_REASON =
    "This is the later of two hand-entered earnings entries for ZZA. Emails follow the earlier one (2026-06-10). " +
    "To email this entry, remove or re-date the earlier one. Nothing was sent.";

  function seedTwins(): { earlier: number; later: number } {
    seedHeld("ZZA");
    const earlier = seedEvent({ source: "manual", symbol: "ZZA" });
    const later = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-12", reported: true });
    return { earlier, later };
  }

  function calendarRows(): unknown[] {
    return db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all();
  }

  for (const mode of ["sweep", "nudge", "manual"] as const) {
    it(`mode ${mode}: refused with a 409, the earlier date and what to do; nothing claimed, sent or changed`, async () => {
      const { later } = seedTwins();
      const calendarBefore = calendarRows();
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: later, symbol: "ZZA", phase: "recap" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res).toEqual({
        outcome: "refused",
        code: "ignored_manual_twin",
        status: 409,
        reason: LATER_TWIN_REASON,
      });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(emailRows()).toEqual([]);
      expect(calendarRows()).toEqual(calendarBefore);
    });

    it(`mode ${mode}: the EARLIER twin still sends`, async () => {
      const { earlier } = seedTwins();
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: earlier, symbol: "ZZA", phase: "preview" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res.outcome).toBe("sent");
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(emailRows()).toEqual([{ event_id: earlier, phase: "preview", error: null }]);
    });
  }

  for (const mode of ["nudge", "manual"] as const) {
    it(`mode ${mode}: a single hand-entered row is unaffected`, async () => {
      seedHeld("ZZA");
      const only = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-12", reported: true });
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: only, symbol: "ZZA", phase: "recap" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res.outcome).toBe("sent");
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    // A feed twin is a different rule (the reconciler hides the FEED row behind
    // the hand-entered one). The later hand-entered row beside an earlier,
    // still-live feed row is not an "ignored twin" and must keep sending.
    it(`mode ${mode}: a hand-entered row with an earlier FEED twin is unaffected`, async () => {
      seedHeld("ZZA");
      seedEvent({ source: "finnhub", symbol: "ZZA" });
      const manual = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-12", reported: true });
      expect(getEmailIgnoredManualTwins(db).size).toBe(0);
      const sendEmail = transport();
      const res = await sendEarningsCandidate(
        db,
        { eventId: manual, symbol: "ZZA", phase: "recap" },
        { mode, recipient: RECIPIENT, seams: { sendEmail } },
      );
      expect(res.outcome).toBe("sent");
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });
  }

  it("a manual resend of an email already delivered on the later twin is refused and the delivered row is untouched", async () => {
    const { later } = seedTwins();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, 'recap', ?, '2026-06-12 21:40:00', '# prose', NULL)`,
    ).run(later, RECIPIENT);
    const before = db.prepare(`SELECT * FROM earnings_emails`).all();
    const sendEmail = transport();
    const res = await sendEarningsCandidate(
      db,
      { eventId: later, symbol: "ZZA", phase: "recap" },
      { mode: "manual", recipient: RECIPIENT, seams: { sendEmail } },
    );
    expect(res).toMatchObject({ outcome: "refused", code: "ignored_manual_twin", status: 409 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT * FROM earnings_emails`).all()).toEqual(before);
  });

  it("the manual route's entry point raises the same words as a 409, without the retry code", async () => {
    const { later } = seedTwins();
    const err = await sendEarningsRecap(db, later, { recipient: RECIPIENT }).catch((e) => e);
    expect(err).toBeInstanceOf(EarningsEmailError);
    expect(err).toMatchObject({ status: 409, message: LATER_TWIN_REASON });
    expect((err as EarningsEmailError).code).toBeUndefined();
    expect(emailRows()).toEqual([]);
  });

  it("removing the earlier entry is the way out: the same press then sends", async () => {
    // The test deletes the row as the user would through the calendar; the
    // send path itself never edits or deletes a calendar row.
    const { earlier, later } = seedTwins();
    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(earlier);
    const sendEmail = transport();
    const res = await sendEarningsCandidate(
      db,
      { eventId: later, symbol: "ZZA", phase: "recap" },
      { mode: "manual", recipient: RECIPIENT, seams: { sendEmail } },
    );
    expect(res.outcome).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ── The morning debrief: one stapled email for several names ─────────────

describe("runMorningDebrief: a member replaced while the debrief is being composed", () => {
  const TICK_1 = new Date("2026-06-11T11:50:00Z"); // 07:50 ET
  const TICK_2 = new Date("2026-06-11T12:05:00Z"); // 08:05 ET, same window

  it("sends nothing, leaves no row, and the next run sends for the live members and the replacing entry", async () => {
    seedHeld("ZZA");
    seedHeld("ZZB");
    const a = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    const b = seedEvent({ source: "finnhub", symbol: "ZZB", reported: true });
    // The entry that will replace ZZB's: already on the calendar, superseded for now.
    const bLive = seedEvent({ source: "nasdaq", symbol: "ZZB", reported: true, superseded: 1 });

    const sendEmail = transport();
    let rowsDuringCompose: unknown;
    const first = await runMorningDebrief(db, {
      now: TICK_1,
      recipient: RECIPIENT,
      generate: async () => {
        rowsDuringCompose = emailRows();
        // Another process reconciles: ZZB's entry is replaced by its twin.
        setSuperseded(b, 1);
        setSuperseded(bLive, 0);
        return "## What changed overnight\n\n- synthetic";
      },
      seams: { sendEmail },
    });

    expect(rowsDuringCompose).toEqual([
      { event_id: a, phase: "recap", error: "in_progress" },
      { event_id: b, phase: "recap", error: "in_progress" },
    ]);
    expect(first).toEqual({ sent: false, covered: [], skippedReason: "member-replaced" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);

    const second = await runMorningDebrief(db, {
      now: TICK_2,
      recipient: RECIPIENT,
      generate: async () => "## What changed overnight\n\n- synthetic",
      seams: { sendEmail },
    });
    expect(second).toMatchObject({ sent: true, covered: ["ZZA", "ZZB"] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // Delivered rows sit on the live entries only; nothing on the replaced one.
    expect(emailRows()).toEqual([
      { event_id: a, phase: "recap", error: null },
      { event_id: bLive, phase: "recap", error: null },
    ]);
  });

  it("with no replacing entry, the next run sends for the remaining live member only", async () => {
    seedHeld("ZZA");
    seedHeld("ZZB");
    const a = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    const b = seedEvent({ source: "finnhub", symbol: "ZZB", reported: true });
    const sendEmail = transport();
    const first = await runMorningDebrief(db, {
      now: TICK_1,
      recipient: RECIPIENT,
      generate: async () => {
        setSuperseded(b, 1);
        return "## What changed overnight\n\n- synthetic";
      },
      seams: { sendEmail },
    });
    expect(first.skippedReason).toBe("member-replaced");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailRows()).toEqual([]);

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

  it("logs one line naming the replaced member", async () => {
    seedHeld("ZZA");
    const a = seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runMorningDebrief(db, {
      now: TICK_1,
      recipient: RECIPIENT,
      generate: async () => {
        setSuperseded(a, 1);
        return "## x";
      },
      seams: { sendEmail: transport() },
    });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(lines).toEqual([
      `[debrief] nothing sent: ZZA (event ${a}) was replaced on the calendar while the debrief was being composed; released 1 claim(s), the next run rebuilds the batch`,
    ]);
  });

  it("control: nothing replaced, the same two-member debrief is sent once and stamps the day", async () => {
    seedHeld("ZZA");
    seedHeld("ZZB");
    seedEvent({ source: "finnhub", symbol: "ZZA", reported: true });
    seedEvent({ source: "finnhub", symbol: "ZZB", reported: true });
    const sendEmail = transport();
    const opts = {
      recipient: RECIPIENT,
      generate: async () => "## What changed overnight\n\n- synthetic",
      seams: { sendEmail },
    };
    expect(await runMorningDebrief(db, { now: TICK_1, ...opts })).toMatchObject({
      sent: true,
      covered: ["ZZA", "ZZB"],
    });
    expect(await runMorningDebrief(db, { now: TICK_2, ...opts })).toMatchObject({
      sent: false,
      skippedReason: "already-ran-today",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
