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

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const sendPreview = vi.fn(async () => ({ success: true }));
const sendRecap = vi.fn(async () => ({ success: true }));
const reapStaleClaims = vi.fn(() => 0);
vi.mock("@/lib/digest/send-earnings-email", () => ({
  sendEarningsPreview: (...a: unknown[]) => sendPreview(...a),
  sendEarningsRecap: (...a: unknown[]) => sendRecap(...a),
  reapStaleEarningsEmailClaims: (...a: unknown[]) => reapStaleClaims(...a),
  EarningsEmailError: class extends Error {
    status = 500;
  },
}));

const checkMarker = vi.fn(async () => null as { sentBy: string } | null);
const setRunning = vi.fn(async () => null);
const clearRunning = vi.fn(async () => null);
const writeSent = vi.fn(async () => null);
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: (...a: unknown[]) => checkMarker(...a),
  setEarningsRunningMarker: (...a: unknown[]) => setRunning(...a),
  clearEarningsRunningMarker: (...a: unknown[]) => clearRunning(...a),
  writeMacSentEarningsMarker: (...a: unknown[]) => writeSent(...a),
}));

import { runEarningsEmailSweep } from "@/lib/calendar/email-sweep";

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
