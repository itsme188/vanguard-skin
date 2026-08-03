/**
 * Read-through reporter recap (feedback #3) — candidacy, composer, send path.
 *
 * A pure read-through reporter (NOT held/watchlist) with FIRST ACTUALS
 * captured and ≥1 live pair gets a lean deterministic email — zero AI, fires
 * before enrichment completes. Spec:
 * docs/superpowers/specs/2026-08-03-reporter-recap-design.md
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => undefined) }));
import { sendEmail } from "@/lib/email";
const mockedSend = vi.mocked(sendEmail);

import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import {
  composeReporterRecap,
  reporterActualsUsable,
  getNextPrintForTarget,
  sendReporterRecapEmail,
} from "@/lib/earnings/reporter-recap";
import { EarningsEmailError } from "@/lib/digest/send-earnings-email";

let db: Database.Database;

function seedSecurity(symbol: string): number {
  return (
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier)
         VALUES (?, ?, 'stock', 'equity', 1) RETURNING id`,
      )
      .get(symbol, `${symbol} Corp`) as { id: number }
  ).id;
}

function seedHolding(symbol: string, quantity = 100): number {
  const accountId = (
    db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(`acct-${symbol}`) as {
      id: number;
    }
  ).id;
  const securityId = seedSecurity(symbol);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, quantity);
  return securityId;
}

function seedPair(reporter: string, target: string, hypothesis: string | null = "Same end market.") {
  db.prepare(
    `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
     VALUES (?, ?, 1.0, ?)`,
  ).run(reporter, target, hypothesis);
}

function seedReporterEvent(
  symbol: string,
  eventDate: string,
  opts: {
    actual?: string | null;
    consensus?: string | null;
    releaseTime?: string | null;
    reaction?: string | null;
  } = {},
): number {
  const r = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, week_of, consensus_estimate, actual_value, reaction_snapshot
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      eventDate,
      opts.releaseTime === undefined ? "07:30" : opts.releaseTime,
      opts.releaseTime === undefined ? "07:30" : opts.releaseTime,
      `${symbol} earnings`,
      symbol,
      `finnhub:${symbol}:${eventDate}`,
      eventDate,
      opts.consensus === undefined ? "EPS 0.55 · Rev 147,100,000" : opts.consensus,
      opts.actual === undefined ? "EPS 0.60 · Rev 149,300,000" : opts.actual,
      opts.reaction ?? null,
    );
  return r.lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  mockedSend.mockResolvedValue(undefined as never);
});

const NOW = new Date("2026-07-31T12:00:00Z"); // 08:00 ET on the PRLB print day

describe("findEmailCandidates — reporter recap road", () => {
  it("a pure reporter with actuals + a live pair is a reporterRecap candidate (no enrichment needed)", () => {
    seedHolding("XMTR"); // target held
    seedPair("PRLB", "XMTR");
    const eventId = seedReporterEvent("PRLB", "2026-07-31");

    const out = findEmailCandidates(db, { now: NOW });
    const cand = out.find((c) => c.eventId === eventId);
    expect(cand).toMatchObject({ phase: "recap", symbol: "PRLB", reporterRecap: true });
  });

  it("fires even when NO held/watchlist candidates exist at all (early-return regression guard)", () => {
    // The only holdings row is the target — no preview/recap candidates form.
    seedHolding("XMTR");
    seedPair("PRLB", "XMTR");
    const eventId = seedReporterEvent("PRLB", "2026-07-31");
    const out = findEmailCandidates(db, { now: NOW });
    expect(out.some((c) => c.eventId === eventId && c.reporterRecap)).toBe(true);
  });

  it("a reporter whose target is not held/watchlist is NOT a candidate (self-narrowing gate)", () => {
    seedPair("PRLB", "XMTR"); // XMTR never seeded as held
    seedReporterEvent("PRLB", "2026-07-31");
    expect(findEmailCandidates(db, { now: NOW })).toHaveLength(0);
  });

  it("a HELD reporter is never a reporterRecap candidate — even when its recap was already audited", () => {
    seedHolding("PRLB"); // reporter itself held
    seedHolding("XMTR");
    seedPair("PRLB", "XMTR");
    const eventId = seedReporterEvent("PRLB", "2026-07-31");
    // Audit the recap so the held symbol drops out of the normal recap road
    // entirely — the status map must STILL resolve it as covered.
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at)
       VALUES (?, 'recap', 'x@y.com', datetime('now'))`,
    ).run(eventId);
    expect(findEmailCandidates(db, { now: NOW }).some((c) => c.reporterRecap)).toBe(false);
  });

  it("audit row, skip row, mute, and stale dates each exclude the reporter", () => {
    seedHolding("XMTR");
    seedPair("PRLB", "XMTR");

    const audited = seedReporterEvent("PRLB", "2026-07-31");
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at)
       VALUES (?, 'recap', 'x@y.com', datetime('now'))`,
    ).run(audited);
    expect(findEmailCandidates(db, { now: NOW })).toHaveLength(0);
    db.prepare(`DELETE FROM earnings_emails`).run();

    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`,
    ).run(audited);
    expect(findEmailCandidates(db, { now: NOW })).toHaveLength(0);
    db.prepare(`DELETE FROM earnings_email_skips`).run();

    // Comma-separated storage (see lib/queries/earnings-settings.ts), not JSON.
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('earnings_emails_muted_symbols', 'PRLB')`,
    ).run();
    expect(findEmailCandidates(db, { now: NOW })).toHaveLength(0);
    db.prepare(`DELETE FROM settings WHERE key = 'earnings_emails_muted_symbols'`).run();

    // Stale: 3 days before `now` — outside [yesterday, today].
    db.prepare(`UPDATE calendar_events SET event_date = '2026-07-28', source_key = 'finnhub:PRLB:2026-07-28' WHERE id = ?`).run(audited);
    expect(findEmailCandidates(db, { now: NOW })).toHaveLength(0);
  });

  it("a reporter event with NO actuals yet is not a candidate", () => {
    seedHolding("XMTR");
    seedPair("PRLB", "XMTR");
    seedReporterEvent("PRLB", "2026-07-31", { actual: null });
    expect(findEmailCandidates(db, { now: NOW })).toHaveLength(0);
  });
});

describe("reporterActualsUsable", () => {
  it("true for a plausible print, false for missing/implausible actuals", () => {
    const base = { consensus_estimate: "EPS 0.55 · Rev 147,100,000", consensus_value: null };
    expect(
      reporterActualsUsable({ ...base, actual_value: "EPS 0.60 · Rev 149,300,000" }),
    ).toBe(true);
    expect(reporterActualsUsable({ ...base, actual_value: null })).toBe(false);
    // 4× consensus EPS → implausible per isPlausibleEarnings.
    expect(reporterActualsUsable({ ...base, actual_value: "EPS 2.20 · Rev 149,300,000" })).toBe(false);
  });
});

describe("composeReporterRecap", () => {
  const EVENT = {
    symbol: "PRLB",
    event_date: "2026-07-31",
    release_time: "07:30",
    consensus_estimate: "EPS 0.55 · Rev 147,100,000",
    consensus_value: null,
    actual_value: "EPS 0.60 · Rev 149,300,000",
    reaction_snapshot: null,
  };
  const PAIR = {
    target: "XMTR",
    targetStatus: "held",
    hypothesis: "Both make on-demand parts; margins move on the same cycle.",
    nextPrint: { date: "2026-08-04", slot: "BMO" as const },
    positionLines: ["long XMTR (ibkr)"],
  };

  it("renders scoreboard + pending-reaction ETA + hypothesis verbatim + next print + presence", () => {
    const { subject, markdown } = composeReporterRecap(EVENT, [PAIR]);
    expect(subject).toBe("📡 PRLB printed — read-through to XMTR");
    expect(markdown).toContain("| **EPS**"); // deterministic scoreboard
    expect(markdown).toContain("Reaction snapshot pending (~9:30 AM ET)");
    expect(markdown).toContain("> Both make on-demand parts; margins move on the same cycle.");
    expect(markdown).toContain("## Read-through: XMTR (held) — reports Tue, Aug 4 (BMO); this print lands first");
    expect(markdown).toContain("Positions: long XMTR (ibkr)");
    expect(markdown).toContain("no AI interpretation");
  });

  it("omits the pending line when the reaction is captured, and the ETA when release_time is null", () => {
    const withReaction = composeReporterRecap(
      { ...EVENT, reaction_snapshot: JSON.stringify({ symbol: { delta_pct: -1.8 } }) },
      [PAIR],
    );
    expect(withReaction.markdown).not.toContain("Reaction snapshot pending");

    const noRelease = composeReporterRecap({ ...EVENT, release_time: null }, [PAIR]);
    expect(noRelease.markdown).toContain("Reaction snapshot pending —");
    expect(noRelease.markdown).not.toContain("(~");
  });

  it("multiple pairs each get a section; subject joins targets", () => {
    const second = { ...PAIR, target: "FTHM", targetStatus: "watchlist", nextPrint: null, positionLines: [] };
    const { subject, markdown } = composeReporterRecap(EVENT, [PAIR, second]);
    expect(subject).toBe("📡 PRLB printed — read-through to XMTR · FTHM");
    expect(markdown).toContain("## Read-through: FTHM (watchlist)");
    expect(markdown).not.toContain("FTHM (watchlist) — reports");
  });
});

describe("getNextPrintForTarget", () => {
  it("returns the family's next scheduled print, skipping superseded rows", () => {
    seedReporterEvent("XMTR", "2026-08-04", { actual: null, releaseTime: "08:00" });
    db.prepare(`UPDATE calendar_events SET event_time = 'BMO' WHERE symbol = 'XMTR'`).run();
    expect(getNextPrintForTarget(db, "XMTR", "2026-07-31")).toEqual({
      date: "2026-08-04",
      slot: "BMO",
    });
    expect(getNextPrintForTarget(db, "XMTR", "2026-08-05")).toBeNull();
  });
});

describe("sendReporterRecapEmail", () => {
  function seedFullScenario(): number {
    seedHolding("XMTR");
    seedPair("PRLB", "XMTR");
    return seedReporterEvent("PRLB", "2026-07-31");
  }

  it("sends, completes the audit row with the markdown, and reports targets", async () => {
    const eventId = seedFullScenario();
    const res = await sendReporterRecapEmail(db, eventId, { recipient: "me@example.com" });
    expect(res.targets).toEqual(["XMTR"]);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const call = mockedSend.mock.calls[0][0];
    expect(call.subject).toContain("PRLB printed");
    expect(call.fromLocalPart).toBe("earnings");

    const audit = db
      .prepare(`SELECT error, ai_output_md FROM earnings_emails WHERE event_id = ? AND phase = 'recap'`)
      .get(eventId) as { error: string | null; ai_output_md: string | null };
    expect(audit.error).toBeNull();
    expect(audit.ai_output_md).toContain("Read-through: XMTR");
  });

  it("withholds on implausible actuals — 409 not_ready, no audit row", async () => {
    seedHolding("XMTR");
    seedPair("PRLB", "XMTR");
    const eventId = seedReporterEvent("PRLB", "2026-07-31", { actual: "EPS 2.20 · Rev 149,300,000" });
    await expect(
      sendReporterRecapEmail(db, eventId, { recipient: "me@example.com" }),
    ).rejects.toMatchObject({ status: 409, code: "not_ready" });
    expect(mockedSend).not.toHaveBeenCalled();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ?`).get(eventId),
    ).toEqual({ n: 0 });
  });

  it("respects a live claim (409 claim_held)", async () => {
    const eventId = seedFullScenario();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
       VALUES (?, 'recap', 'other@x.com', datetime('now'), 'in_progress', 'tok-1')`,
    ).run(eventId);
    await expect(
      sendReporterRecapEmail(db, eventId, { recipient: "me@example.com" }),
    ).rejects.toMatchObject({ status: 409, code: "claim_held" });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("releases its claim when the send throws (no lingering in_progress row)", async () => {
    const eventId = seedFullScenario();
    mockedSend.mockRejectedValueOnce(new Error("smtp down"));
    await expect(
      sendReporterRecapEmail(db, eventId, { recipient: "me@example.com" }),
    ).rejects.toThrow("smtp down");
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ?`).get(eventId),
    ).toEqual({ n: 0 });
  });

  it("EarningsEmailError types are preserved for the sweep's benign-409 accounting", async () => {
    const eventId = seedFullScenario();
    db.prepare(`UPDATE calendar_events SET actual_value = NULL WHERE id = ?`).run(eventId);
    try {
      await sendReporterRecapEmail(db, eventId, { recipient: "me@example.com" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EarningsEmailError);
    }
  });
});
