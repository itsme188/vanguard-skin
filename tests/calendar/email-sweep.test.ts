/**
 * Coverage for the shared earnings-email sweep (lib/calendar/email-sweep.ts).
 *
 * Bug B1: the production sweep (route + tsx fallback script) fired sends
 * with NO marker dance — that dance only existed in the per-event routes
 * (/api/cron/earnings-{preview,recap}) that nothing calls, so the Cloudflare
 * Worker fallback and the Mac double-sent every preview whenever the Mac
 * was awake. These tests pin the dance: cloud-marker pre-check, running
 * marker set/clear (including on failure), mac-sent marker on success, and
 * a local "sent-by-cloud" audit row when the cloud already delivered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const sendPreview = vi.fn(async (..._args: unknown[]) => ({ success: true }));
const sendRecap = vi.fn(async (..._args: unknown[]) => ({ success: true }));
const reapStaleClaims = vi.fn((..._args: unknown[]) => 0);
vi.mock("@/lib/digest/send-earnings-email", () => ({
  sendEarningsPreview: (...a: unknown[]) => sendPreview(...a),
  sendEarningsRecap: (...a: unknown[]) => sendRecap(...a),
  reapStaleEarningsEmailClaims: (...a: unknown[]) => reapStaleClaims(...a),
  // Mirrors the real EarningsEmailError shape (message, status, optional
  // benign-409 `code` discriminator) — Task 5 needs to construct real
  // instances from the test body, not just a bare status=500 stand-in.
  EarningsEmailError: class extends Error {
    status: number;
    code?: "claim_held" | "not_ready";
    constructor(message: string, status: number, code?: "claim_held" | "not_ready") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const checkMarker = vi.fn(async (..._args: unknown[]) => null as { sentBy: string } | null);
const setRunning = vi.fn(async (..._args: unknown[]) => null);
const clearRunning = vi.fn(async (..._args: unknown[]) => null);
const writeSent = vi.fn(async (..._args: unknown[]) => null);
const fetchCloudSent = vi.fn(
  async (..._args: unknown[]) =>
    [] as { phase: "preview" | "recap"; eventId: number; sentAt: string | null }[],
);
const postAliveMarker = vi.fn(async (..._args: unknown[]) => null);
const sendReporterRecap = vi.fn(async (..._args: unknown[]) => ({ subject: "s", targets: ["T"] }));
vi.mock("@/lib/earnings/reporter-recap", () => ({
  sendReporterRecapEmail: (...a: unknown[]) => sendReporterRecap(...a),
}));

vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: (...a: unknown[]) => checkMarker(...a),
  setEarningsRunningMarker: (...a: unknown[]) => setRunning(...a),
  clearEarningsRunningMarker: (...a: unknown[]) => clearRunning(...a),
  writeMacSentEarningsMarker: (...a: unknown[]) => writeSent(...a),
  fetchCloudSentEarnings: (...a: unknown[]) => fetchCloudSent(...a),
  postMacRecentEarningsSweepMarker: (...a: unknown[]) => postAliveMarker(...a),
}));

const pushover = vi.fn(async (..._args: unknown[]) => ({ sent: true }));
vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendPushover: (...a: unknown[]) => pushover(...a),
}));

// Task 4 (2026-08-02 morning-debrief plan): the sweep no longer runs the EOD
// wrap pass — it invokes the morning debrief pass instead (same "best-effort,
// never fails the sweep" try/catch shape the wrap pass used).
const runMorningDebrief = vi.fn(
  async (..._args: unknown[]) => ({ sent: false, covered: [] as string[] }),
);
vi.mock("@/lib/earnings/debrief-send", () => ({
  runMorningDebrief: (...a: unknown[]) => runMorningDebrief(...a),
}));

// Already-reported preview guard (2026-07-23, IMAX case): the sweep's guard
// calls probeFinnhubActualExists as its live layer. Default resolves false so
// every PRE-EXISTING preview test in this file (which never set an
// actual_value and doesn't know about this mock) keeps sending unaffected —
// only the new describe block below overrides it per-test.
// enrichment-runner.ts (transitively loaded via findEmailCandidates, and NOT
// itself mocked) also imports fetchActualForEvent from this same module —
// importOriginal spreads the real exports through so that import stays a
// real function, and only probeFinnhubActualExists is replaced.
const probeFinnhubActualExists = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@/lib/calendar/enrich-actuals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/enrich-actuals")>();
  return {
    ...actual,
    probeFinnhubActualExists: (...a: unknown[]) => probeFinnhubActualExists(...a),
  };
});

// #12 B1: the same-day transcript step is best-effort and unrelated to the
// marker-dance/wrap-suppression assertions this file pins — mock it out so
// fixtures here (which coincidentally satisfy fetchSameDayTranscripts' own
// held+actual+within-36h eligibility criteria) don't trigger a real
// fetchTranscript call (network I/O to EDGAR/Alpha Vantage/API Ninjas).
const fetchSameDayTranscripts = vi.fn(
  async (..._args: unknown[]) => ({ attempted: 0, fetched: 0 }),
);
vi.mock("@/lib/transcripts/same-day", () => ({
  fetchSameDayTranscripts: (...a: unknown[]) => fetchSameDayTranscripts(...a),
}));

// Task 5 (2026-08-05, sweep ordering): {printed: 0} matches the real
// no-armed-flags behavior every pre-existing fixture in this file produces
// (nothing here sets earnings_worksheet_flags.armed=1), so mocking this out
// doesn't change any other test's outcome — it only lets the new ordering
// test below observe invocationCallOrder against sendPreview.
const printArmed = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ printed: 0 })),
);
vi.mock("@/lib/earnings/worksheet", () => ({
  printArmedWorksheets: (...a: unknown[]) => printArmed(...a),
}));

import { runEarningsEmailSweep, alertBlockedRecaps } from "@/lib/calendar/email-sweep";
import { EarningsEmailError } from "@/lib/digest/send-earnings-email";
import { setMutedEarningsSymbols } from "@/lib/queries/earnings-settings";

// 2h before 16:30 ET release = 20:30 UTC. Same construction as
// tests/calendar/findEmailCandidates-skip.test.ts's AAPL preview case —
// squarely inside the [105min, 135min] preview window.
const NOW = new Date("2026-06-01T18:30:00Z");

function seedAccount(db: Database.Database, name: string): number {
  return (
    db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(name) as {
      id: number;
    }
  ).id;
}

function seedHeldPreviewCandidate(db: Database.Database, symbol: string): number {
  const accountId = seedAccount(db, `acct-${symbol}`);
  const securityId = (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
         VALUES (?, 'stock', 'equity', 1) RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
  // Held position so the symbol passes getSymbolStatus = 'held'.
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 100);

  const result = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, security_id, source_key, week_of
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?)`,
    )
    .run(
      "2026-06-01",
      "16:30",
      "16:30",
      `${symbol} earnings`,
      symbol,
      securityId,
      `finnhub:${symbol}:2026-06-01`,
      "2026-06-01",
    );
  return result.lastInsertRowid as number;
}

/**
 * Held AMC recap candidate: enrichment already landed (actual + enriched_at
 * inside the 4h recap window relative to NOW), no audit row yet, so
 * findEmailCandidates selects it as a recap candidate. event_time 'AMC'
 * classifies it via wrapSlotFor's marker branch (highest priority, so the
 * early release_time below doesn't affect slot classification). release_time
 * is deliberately set to a value ALREADY PAST relative to NOW (2026-06-01
 * 18:30 UTC) — a same-day 16:15 release_time would ALSO fall inside
 * findEmailCandidates' preview window ([105,135] min out), producing a
 * duplicate preview candidate for the same event and defeating the
 * recap-only suppression this fixture is meant to isolate.
 */
function seedHeldRecapCandidate(
  db: Database.Database,
  symbol: string,
  slot: "AMC" | "BMO" = "AMC",
): number {
  const accountId = seedAccount(db, `acct-${symbol}`);
  const securityId = (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
         VALUES (?, 'stock', 'equity', 1) RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 100);

  const result = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, security_id, actual_value, enriched_at, source_key, week_of
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "2026-06-01",
      slot,
      "08:00", // already past NOW (18:30 UTC) — keeps this out of the preview window
      `${symbol} earnings`,
      symbol,
      securityId,
      "EPS 1.00",
      "2026-06-01 18:00:00", // inside [NOW-4h, NOW] = [14:30, 18:30]
      `finnhub:${symbol}:2026-06-01`,
      "2026-06-01",
    );
  return result.lastInsertRowid as number;
}

/**
 * Held AMC recap candidate whose `event_date` is a caller-chosen day, NOT
 * necessarily "today" relative to the `now` the test injects — models a
 * same-day Finnhub outage where the user backfills actuals the next
 * morning: `enriched_at` (which gates recap-candidate selection) lands
 * recently, but `event_date` (the calendar day label) lags behind. Unlike
 * `seedHeldRecapCandidate`, `event_date`/`week_of`/`enriched_at` are all
 * explicit params so a test can put `event_date` in the SAME ISO week as
 * `week_of` (required for `getExpectedRecapCluster`'s `week_of`-keyed
 * lookup to find the row at all) while still differing from `now`'s ET day.
 */
function seedRecapCandidateForDate(
  db: Database.Database,
  symbol: string,
  eventDate: string,
  weekOf: string,
  enrichedAt: string,
): number {
  const accountId = seedAccount(db, `acct-${symbol}`);
  const securityId = (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
         VALUES (?, 'stock', 'equity', 1) RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 100);

  const result = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, security_id, actual_value, enriched_at, source_key, week_of
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      eventDate,
      "AMC",
      "08:00",
      `${symbol} earnings`,
      symbol,
      securityId,
      "EPS 1.00",
      enrichedAt,
      `finnhub:${symbol}:${eventDate}`,
      weekOf,
    );
  return result.lastInsertRowid as number;
}

describe("runEarningsEmailSweep marker dance", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    sendPreview.mockClear();
    sendRecap.mockClear();
    reapStaleClaims.mockClear();
    checkMarker.mockClear();
    setRunning.mockClear();
    clearRunning.mockClear();
    writeSent.mockClear();
    fetchCloudSent.mockClear();
    fetchCloudSent.mockResolvedValue([]);
    printArmed.mockClear();
    runMorningDebrief.mockClear();
    runMorningDebrief.mockResolvedValue({ sent: false, covered: [] });
    sendReporterRecap.mockClear();
    fetchSameDayTranscripts.mockClear();
    fetchSameDayTranscripts.mockResolvedValue({ attempted: 0, fetched: 0 });
  });

  // ── Cloud-sent audit reconcile (2026-07-15) ─────────────────────────────
  //
  // Worker preview/recap sends write only cloud-sent-earnings-{phase}-{id}
  // KV markers. Pre-fix, the ONLY path that turned a marker into a local
  // earnings_emails row was the per-candidate check above — which requires
  // the event to still be inside findEmailCandidates' windows. A preview
  // cloud-sent while the Mac slept vanished from the audit trail once the
  // window closed (observed 7/14): no EarningsHub chip, no viewer entry, and
  // the audit lost the send when the KV TTL expired.

  it("backfills a sent-by-cloud audit row for a cloud send whose window has closed", async () => {
    // Event released YESTERDAY — outside the preview window, so
    // findEmailCandidates will not select it.
    const eventId = seedHeldPreviewCandidate(db, "JPM");
    db.prepare("UPDATE calendar_events SET event_date = '2026-05-31' WHERE id = ?").run(eventId);

    fetchCloudSent.mockResolvedValue([
      { phase: "preview", eventId, sentAt: "2026-05-31T10:00:12.000Z" },
    ]);

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.cloudReconciled).toBe(1);
    expect(sendPreview).not.toHaveBeenCalled();

    const audit = db
      .prepare(
        "SELECT recipient, sent_at, ai_output_md, error FROM earnings_emails WHERE event_id = ? AND phase = 'preview'",
      )
      .get(eventId) as
      | { recipient: string; sent_at: string; ai_output_md: string | null; error: string }
      | undefined;
    expect(audit?.error).toBe("sent-by-cloud");
    expect(audit?.recipient).toBe("cloud-fallback");
    expect(audit?.ai_output_md).toBeNull();
    // The marker's real send time, not "now" — stored in SQLite's space-
    // separated datetime format like every other sent_at.
    expect(audit?.sent_at).toBe("2026-05-31 10:00:12");
  });

  it("reconcile is idempotent — the same marker on the next tick adds nothing", async () => {
    const eventId = seedHeldPreviewCandidate(db, "GS");
    db.prepare("UPDATE calendar_events SET event_date = '2026-05-31' WHERE id = ?").run(eventId);
    fetchCloudSent.mockResolvedValue([
      { phase: "preview", eventId, sentAt: "2026-05-31T10:00:12.000Z" },
    ]);

    await runEarningsEmailSweep(db, { now: NOW });
    const second = await runEarningsEmailSweep(db, { now: NOW });

    expect(second.cloudReconciled).toBe(0);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ?")
      .get(eventId) as { n: number };
    expect(count.n).toBe(1);
  });

  it("never overwrites an existing Mac audit row for the same (event, phase)", async () => {
    const eventId = seedHeldPreviewCandidate(db, "BAC");
    db.prepare("UPDATE calendar_events SET event_date = '2026-05-31' WHERE id = ?").run(eventId);
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'user@example.com', '# Mac-composed preview', NULL)`,
    ).run(eventId);

    fetchCloudSent.mockResolvedValue([
      { phase: "preview", eventId, sentAt: "2026-05-31T10:00:12.000Z" },
    ]);

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.cloudReconciled).toBe(0);
    const audit = db
      .prepare("SELECT recipient, error FROM earnings_emails WHERE event_id = ?")
      .get(eventId) as { recipient: string; error: string | null };
    expect(audit.recipient).toBe("user@example.com");
    expect(audit.error).toBeNull();
  });

  it("skips markers for events that no longer exist without failing the sweep", async () => {
    const eventId = seedHeldPreviewCandidate(db, "WFC");
    db.prepare("UPDATE calendar_events SET event_date = '2026-05-31' WHERE id = ?").run(eventId);

    fetchCloudSent.mockResolvedValue([
      { phase: "recap", eventId: 999999, sentAt: "2026-05-31T14:00:00.000Z" }, // deleted event
      { phase: "preview", eventId, sentAt: "2026-05-31T10:00:12.000Z" },
    ]);

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    // The orphan marker is skipped; the real one still reconciles.
    expect(summary.cloudReconciled).toBe(1);
    const audit = db
      .prepare("SELECT error FROM earnings_emails WHERE event_id = ?")
      .get(eventId) as { error: string } | undefined;
    expect(audit?.error).toBe("sent-by-cloud");
  });

  it("checks cloud marker, sets running, sends, writes mac-sent, clears running, in order", async () => {
    seedHeldPreviewCandidate(db, "AAPL");

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.sent).toBe(1);
    // Default path pin (Task 9 reviewer follow-up): a fresh preview send with
    // no pre-existing earnings_emails row can't also be a "blocked recap"
    // candidate, so the alert pass must report zero.
    expect(summary.recapAlerts).toBe(0);
    expect(checkMarker).toHaveBeenCalledWith("preview", expect.any(Number));
    expect(setRunning).toHaveBeenCalled();
    expect(sendPreview).toHaveBeenCalledTimes(1);
    expect(writeSent).toHaveBeenCalled();
    expect(clearRunning).toHaveBeenCalled();

    // Marker call-order pin (Task 7 reviewer follow-up): checkMarker must
    // resolve before the running marker is set, which must precede the
    // actual send, which must precede the mac-sent write, which must
    // precede clearing the running marker.
    const checkOrder = checkMarker.mock.invocationCallOrder[0];
    const setRunningOrder = setRunning.mock.invocationCallOrder[0];
    const sendOrder = sendPreview.mock.invocationCallOrder[0];
    const writeSentOrder = writeSent.mock.invocationCallOrder[0];
    const clearRunningOrder = clearRunning.mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(setRunningOrder);
    expect(setRunningOrder).toBeLessThan(sendOrder);
    expect(sendOrder).toBeLessThan(writeSentOrder);
    expect(writeSentOrder).toBeLessThan(clearRunningOrder);
  });

  // Task 5 (2026-08-05, rich-preview-print plan): the worksheet auto-print
  // pass moved from BEFORE the candidate loop to AFTER it, because the rich
  // sheet is composed from the LOCAL preview email's stored prose — a tick
  // that sends a preview must also be the tick that prints it, or the
  // worksheet waits a full 15-min cycle for no reason.
  it("runs the worksheet auto-print pass AFTER the send loop so the tick that sends a preview can print it", async () => {
    seedHeldPreviewCandidate(db, "AAPL");

    await runEarningsEmailSweep(db, { now: NOW });

    expect(sendPreview).toHaveBeenCalled();
    expect(printArmed).toHaveBeenCalledTimes(1);
    // vitest global invocation ordering: send must precede print.
    expect(printArmed.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendPreview.mock.invocationCallOrder[0],
    );
  });

  it("skips the send when the cloud already delivered, and records a local audit row", async () => {
    seedHeldPreviewCandidate(db, "MSFT");
    checkMarker.mockResolvedValueOnce({ sentBy: "cloud" });

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.skipped).toBe(1);
    expect(sendPreview).not.toHaveBeenCalled();

    const audit = db
      .prepare("SELECT error FROM earnings_emails WHERE phase = 'preview'")
      .get() as { error: string } | undefined;
    expect(audit?.error).toBe("sent-by-cloud");
  });

  it("clears the running marker even when the send throws", async () => {
    seedHeldPreviewCandidate(db, "GOOG");
    sendPreview.mockRejectedValueOnce(new Error("boom"));

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.failed).toBe(1);
    expect(clearRunning).toHaveBeenCalled();
  });

  // Task 5: sendEarningsEmail throws EarningsEmailError(msg, 409, "claim_held")
  // when another process already holds the (event_id, phase) claim slot —
  // a benign cross-process coordination outcome, not a failure. Pre-fix this
  // landed in `failed`, making season launchd logs read as broken every time
  // two processes raced a send.
  //
  // Note on fixture shape: the brief's suggested arrangement (pre-insert an
  // `earnings_emails` row with error='in_progress' before the sweep runs)
  // isn't reachable here — findEmailCandidates LEFT JOINs earnings_emails on
  // (event_id, phase) and excludes any row that already has an audit row,
  // so the candidate would never be selected in the first place and
  // sendPreview would never be invoked. Since this file mocks
  // sendEarningsPreview/sendEarningsRecap wholesale (the real claim-check
  // logic never runs here), the equivalent — and the pattern this file
  // already uses for the "clears the running marker" throw test above — is
  // to have the mock reject with a real EarningsEmailError(status=409,
  // code="claim_held") for an otherwise-eligible candidate.
  it("counts a cross-process 409 claim refusal as skipped, not failed", async () => {
    const eventId = seedHeldPreviewCandidate(db, "NFLX");
    sendPreview.mockRejectedValueOnce(
      new EarningsEmailError(
        `Event ${eventId} preview is already being sent by another process — skipping duplicate.`,
        409,
        "claim_held",
      ),
    );

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
    const r = summary.results.find((x) => x.eventId === eventId)!;
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe("claim-held");
    expect(r.status).toBe(409);
  });
});

/**
 * Wrap-mode suppression (#17 Task 3): a (date, slot) cluster whose expected-
 * unsent recap count reaches WRAP_THRESHOLD should NOT have its members sent
 * as individual recaps by the candidate loop — the wrap pass (Task 2) staples
 * them into one email instead. The suppression gate MUST use the SAME raw
 * getExpectedRecapCluster(...).length >= WRAP_THRESHOLD determination that
 * runWrapPass uses internally (Task 2 reviewer's coordination rule) — never a
 * post-exclusion count, or individuals get suppressed while the wrap sends
 * nothing.
 */
describe("wrap-mode suppression (#17 T3)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    sendPreview.mockClear();
    sendRecap.mockClear();
    reapStaleClaims.mockClear();
    checkMarker.mockClear();
    setRunning.mockClear();
    clearRunning.mockClear();
    writeSent.mockClear();
    fetchCloudSent.mockClear();
    fetchCloudSent.mockResolvedValue([]);
    printArmed.mockClear();
    runMorningDebrief.mockClear();
    runMorningDebrief.mockResolvedValue({ sent: false, covered: [] });
    sendReporterRecap.mockClear();
    fetchSameDayTranscripts.mockClear();
    fetchSameDayTranscripts.mockResolvedValue({ attempted: 0, fetched: 0 });
  });

  it("suppresses all three ready AMC recap candidates when the cluster reaches WRAP_THRESHOLD, and still runs the morning debrief pass once", async () => {
    const ids = [
      seedHeldRecapCandidate(db, "AAA"),
      seedHeldRecapCandidate(db, "BBB"),
      seedHeldRecapCandidate(db, "CCC"),
    ];

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    for (const id of ids) {
      const r = summary.results.find((x) => x.eventId === id)!;
      expect(r.ok).toBe(true);
      expect(r.skipped).toBe("wrap-pending");
    }
    expect(sendRecap).not.toHaveBeenCalled();
    // The wrap-pending suppression math itself is unchanged (Task 4 scope
    // guard) — only the pass that runs AFTER the candidate loop changed from
    // runWrapPass to runMorningDebrief.
    expect(runMorningDebrief).toHaveBeenCalledTimes(1);
    expect(runMorningDebrief).toHaveBeenCalledWith(db, { now: NOW });
  });

  it("a read-through reporter recap is EXEMPT from wrap suppression and dispatches its own sender (feedback #3)", async () => {
    // Three held AMC recaps → wrap mode for the (date, AMC) slot…
    const heldIds = [
      seedHeldRecapCandidate(db, "AAA"),
      seedHeldRecapCandidate(db, "BBB"),
      seedHeldRecapCandidate(db, "CCC"),
    ];
    // …plus a pure read-through reporter in the SAME slot with first actuals
    // (no enriched_at — the ASAP road) whose target is held.
    const targetAcct = seedAccount(db, "acct-TGT");
    const targetSec = (
      db
        .prepare(
          `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
           VALUES ('TGT', 'stock', 'equity', 1) RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
       VALUES (?, ?, 100, date('now'))`,
    ).run(targetAcct, targetSec);
    db.prepare(
      `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
       VALUES ('RPT', 'TGT', 1.0, 'same cycle')`,
    ).run();
    const reporterId = (
      db
        .prepare(
          `INSERT INTO calendar_events (
             source, event_type, event_date, event_time, release_time, title,
             symbol, actual_value, source_key, week_of
           ) VALUES ('finnhub','earnings','2026-06-01','AMC','08:00','RPT earnings','RPT','EPS 1.10','finnhub:RPT:2026-06-01','2026-06-01')`,
        )
        .run() as { lastInsertRowid: number | bigint }
    ).lastInsertRowid as number;

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    // Held cluster suppressed as wrap-pending; the reporter recap SENDS.
    for (const id of heldIds) {
      expect(summary.results.find((x) => x.eventId === id)!.skipped).toBe("wrap-pending");
    }
    const rpt = summary.results.find((x) => x.eventId === reporterId)!;
    expect(rpt.ok).toBe(true);
    expect(rpt.skipped).toBeUndefined();
    expect(sendReporterRecap).toHaveBeenCalledTimes(1);
    expect(sendReporterRecap).toHaveBeenCalledWith(db, reporterId);
    expect(sendRecap).not.toHaveBeenCalled(); // held ones stayed suppressed
    // Marker dance ran for the reporter send.
    expect(writeSent).toHaveBeenCalledWith("recap", reporterId);
  });

  /**
   * BMO exemption (2026-08-04 decision): wrap suppression defers a cluster's
   * recaps to the NEXT-MORNING 07:45 debrief — a rationale built for AMC
   * prints (evening recaps land when the user is done for the day). For BMO
   * prints the individual recap window IS the same morning, so suppression
   * buys nothing and costs a full day (the 8/04 DOCN/XMTR/WIX cluster had
   * to be recapped manually). Only AMC clusters suppress.
   */
  it("a BMO cluster at WRAP_THRESHOLD is EXEMPT from wrap suppression — individual same-morning recaps fire (2026-08-04 decision)", async () => {
    const ids = [
      seedHeldRecapCandidate(db, "AAA", "BMO"),
      seedHeldRecapCandidate(db, "BBB", "BMO"),
      seedHeldRecapCandidate(db, "CCC", "BMO"),
    ];

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    for (const id of ids) {
      const r = summary.results.find((x) => x.eventId === id)!;
      expect(r.ok).toBe(true);
      expect(r.skipped).toBeUndefined();
    }
    expect(sendRecap).toHaveBeenCalledTimes(3);
    expect(summary.results.some((r) => r.skipped === "wrap-pending")).toBe(false);
  });

  it("does not suppress recap candidates when the cluster is below WRAP_THRESHOLD — individual sends happen", async () => {
    const ids = [seedHeldRecapCandidate(db, "DDD"), seedHeldRecapCandidate(db, "EEE")];

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    for (const id of ids) {
      const r = summary.results.find((x) => x.eventId === id)!;
      expect(r.skipped).toBeUndefined();
    }
    expect(sendRecap).toHaveBeenCalledTimes(2);
    expect(summary.results.some((r) => r.skipped === "wrap-pending")).toBe(false);
  });

  it("never suppresses preview candidates, even when three would otherwise cluster", async () => {
    const ids = [
      seedHeldPreviewCandidate(db, "FFF"),
      seedHeldPreviewCandidate(db, "GGG"),
      seedHeldPreviewCandidate(db, "HHH"),
    ];

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    for (const id of ids) {
      const r = summary.results.find((x) => x.eventId === id)!;
      expect(r.skipped).toBeUndefined();
      expect(r.ok).toBe(true);
    }
    expect(sendPreview).toHaveBeenCalledTimes(3);
  });

  /**
   * #17 final-review fix: the suppression branch used to compute the wrap
   * cluster on `eventRow.event_date` (whatever date the row happened to
   * carry) while `runWrapPass` only ever evaluates TODAY's (date, slot)
   * clusters (`date = todayET(now)` in wrap-send.ts). A recap candidate
   * whose `event_date` is NOT today — e.g. a same-day Finnhub outage where
   * the user backfills actuals the next morning, reopening recap
   * candidates dated yesterday via a fresh `enriched_at` — would get
   * suppressed with `wrap-pending` every tick while no wrap pass could
   * ever match its (yesterday, slot) cluster. At `enriched_at`+4h the
   * candidates fall out of `findEmailCandidates`' window entirely: the
   * recaps vanish with no email ever sent. The fix gates the suppression
   * branch on `eventRow.event_date === todayET(opts.now)`; a non-today
   * cluster must fall through to individual sends instead.
   *
   * `event_date` and `week_of` are deliberately the SAME day here (Monday
   * 2026-06-01) so `getExpectedRecapCluster`'s `week_of`-keyed lookup WOULD
   * find and cluster these three rows if the (pre-fix) code path reached
   * it — proving this is a genuine red case, not a week_of-mismatch false
   * negative. `now` is the next day (Tuesday 2026-06-02) so
   * `todayET(now) !== event_date`.
   */
  it("does not suppress a recap cluster dated YESTERDAY even at WRAP_THRESHOLD — falls through to individual sends, wrap pass still runs (#17 final-review fix)", async () => {
    const NOW_NEXT_DAY = new Date("2026-06-02T17:00:00Z"); // ~13:00 ET Tuesday
    const yesterday = "2026-06-01"; // Monday — todayET(NOW_NEXT_DAY) is Tuesday
    const weekOf = "2026-06-01"; // mondayOf('2026-06-01') === '2026-06-01'
    const recentEnrichedAt = "2026-06-02 16:00:00"; // 1h before NOW_NEXT_DAY — inside the 4h recap window

    const ids = [
      seedRecapCandidateForDate(db, "III", yesterday, weekOf, recentEnrichedAt),
      seedRecapCandidateForDate(db, "JJJ", yesterday, weekOf, recentEnrichedAt),
      seedRecapCandidateForDate(db, "KKK", yesterday, weekOf, recentEnrichedAt),
    ];

    const summary = await runEarningsEmailSweep(db, { now: NOW_NEXT_DAY });

    for (const id of ids) {
      const r = summary.results.find((x) => x.eventId === id)!;
      expect(r.ok).toBe(true);
      expect(r.skipped).toBeUndefined();
    }
    expect(sendRecap).toHaveBeenCalledTimes(3);
    expect(summary.results.some((r) => r.skipped === "wrap-pending")).toBe(false);
    // The morning debrief pass still runs every tick (its own window/day gate
    // decides whether it actually sends) — the sweep invokes it unconditionally.
    expect(runMorningDebrief).toHaveBeenCalledTimes(1);
    expect(runMorningDebrief).toHaveBeenCalledWith(db, { now: NOW_NEXT_DAY });
  });
});

/**
 * Morning debrief pass wiring (2026-08-02 plan, Task 4): the sweep retired
 * its EOD wrap-send call in favor of the 7:45 ET morning debrief
 * (lib/earnings/debrief-send.ts::runMorningDebrief). The pass runs
 * unconditionally BEFORE the candidate loop (its own window/once-per-day gate
 * decides whether it actually composes+sends) and must never fail the sweep.
 */
describe("morning debrief pass (Task 4)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    sendPreview.mockClear();
    sendRecap.mockClear();
    reapStaleClaims.mockClear();
    checkMarker.mockClear();
    setRunning.mockClear();
    clearRunning.mockClear();
    writeSent.mockClear();
    fetchCloudSent.mockClear();
    fetchCloudSent.mockResolvedValue([]);
    printArmed.mockClear();
    runMorningDebrief.mockClear();
    runMorningDebrief.mockResolvedValue({ sent: false, covered: [] });
    sendReporterRecap.mockClear();
    fetchSameDayTranscripts.mockClear();
    fetchSameDayTranscripts.mockResolvedValue({ attempted: 0, fetched: 0 });
  });

  it("invokes runMorningDebrief once per sweep and reports its result under summary.debrief", async () => {
    runMorningDebrief.mockResolvedValueOnce({ sent: true, covered: ["AAA", "BBB"] });

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(runMorningDebrief).toHaveBeenCalledTimes(1);
    expect(runMorningDebrief).toHaveBeenCalledWith(db, { now: NOW });
    expect(summary.debrief).toEqual({ sent: true, covered: ["AAA", "BBB"] });
  });

  /**
   * F1b (durability): the debrief pass must run BEFORE the per-candidate send
   * loop. Individual sends are 60–180s Claude calls each, so a sweep that
   * starts at 08:10 with three candidates would push the debrief past its
   * 08:20 window close and lose the morning. The pass self-gates, so on 90+
   * ticks a day this reordering costs one cheap settings read.
   */
  it("runs the debrief pass BEFORE the per-candidate send loop (long sends must not push it past its 08:20 window)", async () => {
    seedHeldPreviewCandidate(db, "AAPL");

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.sent).toBe(1);
    expect(runMorningDebrief).toHaveBeenCalledTimes(1);
    expect(runMorningDebrief.mock.invocationCallOrder[0]).toBeLessThan(
      sendPreview.mock.invocationCallOrder[0],
    );
  });

  it("summary.debrief is null and the sweep still completes when the debrief pass throws", async () => {
    runMorningDebrief.mockRejectedValueOnce(new Error("AI Gateway timeout"));

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(summary.debrief).toBeNull();
    // The sweep's other responsibilities (candidate processing, blocked-recap
    // alerts, transcript orchestration) still complete normally.
    expect(summary.swept).toBe(0);
    expect(summary.results).toEqual([]);
  });
});

/**
 * Already-reported preview guard (2026-07-23, IMAX case): IMAX was tagged
 * AMC 16:15 by both calendar sources but reported pre-market — the preview
 * fired at 14:07 ET, hours after the real print, because the preview window
 * is measured only against the RECORDED release instant. Two layers: the
 * row's own actual_value (cheap), then a live Finnhub probe. On detection,
 * a permanent per-event preview skip is recorded (recap is untouched — the
 * IMAX recap still went out at 16:43) and the guard is best-effort (an
 * error falls through to the normal send).
 */
describe("already-reported preview guard (IMAX 7/23 case)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    sendPreview.mockClear();
    sendRecap.mockClear();
    reapStaleClaims.mockClear();
    checkMarker.mockClear();
    setRunning.mockClear();
    clearRunning.mockClear();
    writeSent.mockClear();
    fetchCloudSent.mockClear();
    fetchCloudSent.mockResolvedValue([]);
    printArmed.mockClear();
    runMorningDebrief.mockClear();
    runMorningDebrief.mockResolvedValue({ sent: false, covered: [] });
    sendReporterRecap.mockClear();
    fetchSameDayTranscripts.mockClear();
    fetchSameDayTranscripts.mockResolvedValue({ attempted: 0, fetched: 0 });
    probeFinnhubActualExists.mockClear();
    probeFinnhubActualExists.mockResolvedValue(false);
  });

  it("skips the preview when the event row already has an actual_value", async () => {
    const eventId = seedHeldPreviewCandidate(db, "IMAX");
    db.prepare(`UPDATE calendar_events SET actual_value = 'EPS 0.43 · Rev 102,840,000' WHERE id = ?`).run(
      eventId,
    );

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(sendPreview).not.toHaveBeenCalled();
    const r = summary.results.find((x) => x.eventId === eventId)!;
    expect(r.skipped).toBe("already-reported");
    expect(r.ok).toBe(true);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);

    // Permanent skip row recorded so the candidate never re-enters.
    const skip = db
      .prepare(`SELECT 1 FROM earnings_email_skips WHERE event_id = ? AND phase = 'preview'`)
      .get(eventId);
    expect(skip).toBeTruthy();

    // Actual_value present → cheap-layer catch, no live probe needed.
    expect(probeFinnhubActualExists).not.toHaveBeenCalled();

    // KV marker claimed too: the Worker's preview fallback can't see
    // earnings_email_skips, so without this marker its later
    // [105,120]-window tick would still ship the wrong-slot preview.
    expect(writeSent).toHaveBeenCalledWith("preview", eventId);
  });

  it("skips when the live Finnhub probe says the print is out", async () => {
    const eventId = seedHeldPreviewCandidate(db, "IMAX");
    probeFinnhubActualExists.mockResolvedValueOnce(true);

    const summary = await runEarningsEmailSweep(db, { now: NOW });

    expect(sendPreview).not.toHaveBeenCalled();
    expect(summary.results.find((x) => x.eventId === eventId)!.skipped).toBe("already-reported");
  });

  it("sends normally when neither layer detects a print", async () => {
    seedHeldPreviewCandidate(db, "IMAX");
    probeFinnhubActualExists.mockResolvedValueOnce(false);

    await runEarningsEmailSweep(db, { now: NOW });

    expect(sendPreview).toHaveBeenCalledTimes(1);
  });

  it("a probe failure never blocks the send (guard is best-effort)", async () => {
    seedHeldPreviewCandidate(db, "IMAX");
    probeFinnhubActualExists.mockRejectedValueOnce(new Error("network"));

    await runEarningsEmailSweep(db, { now: NOW });

    expect(sendPreview).toHaveBeenCalledTimes(1);
  });

  it("recap candidates are never probed", async () => {
    seedHeldRecapCandidate(db, "IMAX");

    await runEarningsEmailSweep(db, { now: NOW });

    expect(probeFinnhubActualExists).not.toHaveBeenCalled();
    expect(sendRecap).toHaveBeenCalledTimes(1);
  });
});

/**
 * alertBlockedRecaps (Task 9): last season 10 previewed names never got a
 * recap because Finnhub actuals never arrived — silently. This gate fires
 * ONE Pushover push per event once a previewed print has sat 2-18h
 * post-release with no actual, deep-linking to Today so the user can enter
 * actuals manually via BogeysEditModal.
 *
 * The implementation's SQL pre-filter (`ce.event_date >= date('now', '-2
 * days')`) uses SQLite's own real wall-clock `now()`, NOT the injected
 * `opts.now` — so fixtures here are built from the REAL current instant
 * (captured once at module load) rather than a frozen historical date like
 * the marker-dance tests above use. This keeps the SQL pre-filter and the
 * JS age-window check aligned regardless of what day the suite actually
 * runs, and mirrors composeReleaseInstant round-tripping used by
 * tests/calendar/enrichment-runner.test.ts for DST-proof window fixtures.
 */
describe("alertBlockedRecaps", () => {
  let db: Database.Database;

  // Real current instant, captured once so every fixture + the injected
  // `now` in each test share one consistent reference point.
  const REAL_NOW = new Date();

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    pushover.mockClear();
  });

  /**
   * Convert a UTC instant into its ET wall-clock date/time parts, for
   * constructing event_date/release_time fixtures. Same helper as
   * tests/calendar/enrichment-runner.test.ts's etDateTimeParts — using Intl
   * (rather than hand-rolled DST math) means these fixtures don't need to
   * know whether a given date falls in EDT or EST.
   */
  function etDateTimeParts(d: Date): { date: string; time: string } {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    let hour = get("hour");
    if (hour === "24") hour = "00"; // Intl quirk: midnight can format as "24"
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${hour}:${get("minute")}`,
    };
  }

  /** Insert a bare earnings calendar_events row whose release was `hoursAgo`
   * hours before REAL_NOW. No security_id / holdings needed — alertBlockedRecaps
   * doesn't filter on held/watchlist status. */
  function insertReleasedEvent(symbol: string, hoursAgo: number): number {
    const releaseInstant = new Date(REAL_NOW.getTime() - hoursAgo * 60 * 60 * 1000);
    const { date, time } = etDateTimeParts(releaseInstant);
    const result = db
      .prepare(
        `INSERT INTO calendar_events (
           source, event_type, event_date, event_time, release_time, title,
           symbol, source_key, week_of
         ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?)`,
      )
      .run(
        date,
        time,
        time,
        `${symbol} earnings`,
        symbol,
        `finnhub:${symbol}:${date}`,
        date,
      );
    return result.lastInsertRowid as number;
  }

  function insertSentPreview(eventId: number): void {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'test@example.com', 'preview body', NULL)`,
    ).run(eventId);
  }

  /** Preview audit row recorded via the cloud-fallback path (Task 3 pattern:
   * ai_output_md NULL, error='sent-by-cloud'). The alertBlockedRecaps JOIN
   * only excludes error='in_progress' — a cloud-sent preview still counts as
   * "previewed" for blocked-recap purposes. */
  function insertCloudSentPreview(eventId: number): void {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'cloud-fallback', NULL, 'sent-by-cloud')`,
    ).run(eventId);
  }

  function insertRecapAudit(eventId: number): void {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'recap', 'test@example.com', 'recap body', NULL)`,
    ).run(eventId);
  }

  function insertRecapSkip(eventId: number): void {
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`,
    ).run(eventId);
  }

  it("pushes once for a previewed event >2h post-release with no actual, then never again", async () => {
    const eventId = insertReleasedEvent("ZETA", 3);
    insertSentPreview(eventId);

    const n1 = await alertBlockedRecaps(db, { now: REAL_NOW });
    expect(n1).toBe(1);
    expect(pushover).toHaveBeenCalledTimes(1);

    const n2 = await alertBlockedRecaps(db, { now: REAL_NOW });
    expect(n2).toBe(0); // actual_missing_alerted_at dedup
    expect(pushover).toHaveBeenCalledTimes(1); // no second push
  });

  it("does not alert when the actual landed", async () => {
    const eventId = insertReleasedEvent("ZETA", 3);
    insertSentPreview(eventId);
    db.prepare(`UPDATE calendar_events SET actual_value = ? WHERE id = ?`).run(
      "EPS 1.23 · Rev 400M",
      eventId,
    );

    expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(0);
    expect(pushover).not.toHaveBeenCalled();
  });

  it("does not alert without a sent preview", async () => {
    insertReleasedEvent("ZETA", 3); // no earnings_emails preview row

    expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(0);
    expect(pushover).not.toHaveBeenCalled();
  });

  it("does not alert before 2h or after 18h post-release", async () => {
    const early = insertReleasedEvent("EARLY", 1); // 1h ago — under the floor
    insertSentPreview(early);
    const late = insertReleasedEvent("LATEE", 20); // 20h ago — past the ceiling
    insertSentPreview(late);

    expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(0);
    expect(pushover).not.toHaveBeenCalled();
  });

  it("stamps actual_missing_alerted_at on the eligible row and leaves a non-eligible row null", async () => {
    const eligible = insertReleasedEvent("ZETA", 3);
    insertSentPreview(eligible);
    // Non-eligible sibling: no preview ever sent, so alertBlockedRecaps
    // should skip it entirely and never touch its stamp column.
    const nonEligible = insertReleasedEvent("NOPE", 3);

    const n = await alertBlockedRecaps(db, { now: REAL_NOW });
    expect(n).toBe(1);

    const eligibleRow = db
      .prepare(`SELECT actual_missing_alerted_at FROM calendar_events WHERE id = ?`)
      .get(eligible) as { actual_missing_alerted_at: string | null };
    expect(eligibleRow.actual_missing_alerted_at).not.toBeNull();

    const nonEligibleRow = db
      .prepare(`SELECT actual_missing_alerted_at FROM calendar_events WHERE id = ?`)
      .get(nonEligible) as { actual_missing_alerted_at: string | null };
    expect(nonEligibleRow.actual_missing_alerted_at).toBeNull();
  });

  describe("push payload", () => {
    const ORIGINAL_LINK_BASE = process.env.PUSHOVER_LINK_BASE;

    afterEach(() => {
      if (ORIGINAL_LINK_BASE === undefined) {
        delete process.env.PUSHOVER_LINK_BASE;
      } else {
        process.env.PUSHOVER_LINK_BASE = ORIGINAL_LINK_BASE;
      }
    });

    it("builds title/url/urlTitle with the localhost fallback when PUSHOVER_LINK_BASE is unset", async () => {
      delete process.env.PUSHOVER_LINK_BASE;
      const eventId = insertReleasedEvent("ZETA", 3);
      insertSentPreview(eventId);

      await alertBlockedRecaps(db, { now: REAL_NOW });

      expect(pushover).toHaveBeenCalledTimes(1);
      const payload = pushover.mock.calls[0][0] as {
        title: string;
        url: string;
        urlTitle: string;
      };
      expect(payload.title).toContain("ZETA");
      expect(payload.title).toContain("recap blocked");
      expect(payload.url).toBe("http://localhost:3099/dashboard/today");
      expect(payload.urlTitle).toBe("Open Earnings Hub");
    });

    it("uses PUSHOVER_LINK_BASE for the deep link when set", async () => {
      process.env.PUSHOVER_LINK_BASE = "https://100.96.0.1:3099";
      const eventId = insertReleasedEvent("ZETA", 3);
      insertSentPreview(eventId);

      await alertBlockedRecaps(db, { now: REAL_NOW });

      const payload = pushover.mock.calls[0][0] as { url: string };
      expect(payload.url).toBe("https://100.96.0.1:3099/dashboard/today");
    });
  });

  describe("eligibility branches", () => {
    it("alerts on a preview sent via the cloud-fallback path ('sent-by-cloud')", async () => {
      const eventId = insertReleasedEvent("ZETA", 3);
      insertCloudSentPreview(eventId);

      expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(1);
      expect(pushover).toHaveBeenCalledTimes(1);
    });

    it("does not alert when a recap audit row already exists", async () => {
      const eventId = insertReleasedEvent("ZETA", 3);
      insertSentPreview(eventId);
      insertRecapAudit(eventId);

      expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(0);
      expect(pushover).not.toHaveBeenCalled();
    });

    it("does not alert when a recap skip row already exists", async () => {
      const eventId = insertReleasedEvent("ZETA", 3);
      insertSentPreview(eventId);
      insertRecapSkip(eventId);

      expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(0);
      expect(pushover).not.toHaveBeenCalled();
    });
  });

  describe("respects the muted-symbols setting (Task 8)", () => {
    it("does not push a blocked-recap alert for a muted symbol, and does not stamp it", async () => {
      const eventId = insertReleasedEvent("TER", 3);
      insertSentPreview(eventId);
      // getMutedEarningsSymbols reads a comma-separated string, NOT a JSON
      // array — go through the real setter so the fixture matches the
      // actual settings shape rather than guessing at it.
      setMutedEarningsSymbols(db, ["TER"]);

      const alerted = await alertBlockedRecaps(db, { now: REAL_NOW });
      expect(alerted).toBe(0);
      expect(pushover).not.toHaveBeenCalled();

      const row = db
        .prepare(`SELECT actual_missing_alerted_at FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_missing_alerted_at: string | null };
      // Unmuting inside the age window should re-enable the alert on the
      // next tick — deliberately no stamp for muted rows.
      expect(row.actual_missing_alerted_at).toBeNull();
    });

    it("still alerts for a non-muted symbol when other symbols are muted", async () => {
      const eventId = insertReleasedEvent("ZETA", 3);
      insertSentPreview(eventId);
      setMutedEarningsSymbols(db, ["TER", "AAPL"]);

      expect(await alertBlockedRecaps(db, { now: REAL_NOW })).toBe(1);
      expect(pushover).toHaveBeenCalledTimes(1);
    });
  });

  describe("wired through runEarningsEmailSweep", () => {
    it("surfaces recapAlerts=1 and fires Pushover for an eligible blocked-recap fixture", async () => {
      const eventId = insertReleasedEvent("ZETA", 3);
      insertSentPreview(eventId);

      const summary = await runEarningsEmailSweep(db, { now: REAL_NOW });

      expect(summary.recapAlerts).toBe(1);
      expect(pushover).toHaveBeenCalledTimes(1);
    });
  });
});

// ── Mac-aliveness marker (2026-08-05, the APP/MELI preview race) ─────────────
// Every completed sweep tick posts `mac-recent-earnings-sweep` so the Worker's
// preview fallback knows the Mac is alive — QUIET ticks included (most ticks
// have no candidates; aliveness is about the sweep running, not sending).

describe("runEarningsEmailSweep mac-aliveness marker", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.clearAllMocks();
  });
  afterEach(() => db.close());

  it("posts the marker after a quiet tick (zero candidates)", async () => {
    const summary = await runEarningsEmailSweep(db, { now: NOW });
    expect(summary.swept).toBe(0);
    expect(postAliveMarker).toHaveBeenCalledTimes(1);
  });

  it("posts the marker after a sending tick too", async () => {
    seedHeldPreviewCandidate(db, "AAPL");
    await runEarningsEmailSweep(db, { now: NOW });
    expect(postAliveMarker).toHaveBeenCalledTimes(1);
  });
});
