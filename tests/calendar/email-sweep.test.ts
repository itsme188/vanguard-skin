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
  EarningsEmailError: class extends Error {
    status = 500;
  },
}));

const checkMarker = vi.fn(async (..._args: unknown[]) => null as { sentBy: string } | null);
const setRunning = vi.fn(async (..._args: unknown[]) => null);
const clearRunning = vi.fn(async (..._args: unknown[]) => null);
const writeSent = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: (...a: unknown[]) => checkMarker(...a),
  setEarningsRunningMarker: (...a: unknown[]) => setRunning(...a),
  clearEarningsRunningMarker: (...a: unknown[]) => clearRunning(...a),
  writeMacSentEarningsMarker: (...a: unknown[]) => writeSent(...a),
}));

const pushover = vi.fn(async (..._args: unknown[]) => ({ sent: true }));
vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendPushover: (...a: unknown[]) => pushover(...a),
}));

import { runEarningsEmailSweep, alertBlockedRecaps } from "@/lib/calendar/email-sweep";

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
