/**
 * Late-arm preview (owner ruling 2026-10-28, option A): a print armed after
 * its regular 105-135 minute preview window closed still gets its preview,
 * while the print is at least 15 minutes away. "The print" is the EARLIER of
 * the recorded release instant and the BMO/AMC slot floor, because an AMC
 * release_time is often the call time. Unarmed rows keep the regular window.
 *
 * The kick (runLateArmPreviewKick) runs the sweep's own per-candidate path,
 * so the already-reported guard and the send service apply unchanged.
 * Synthetic tickers only; 2026-06-01 is a Monday in EDT (UTC-4).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const sendCandidate = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({
    outcome: "sent" as const,
    sentTo: "desk@example.com",
    providerMessageId: "<m@d>",
    title: "T",
    modelOutputChars: 10,
    symbol: "XMPL",
  })),
);
vi.mock("@/lib/earnings/send-service", () => ({
  sendEarningsCandidate: (...a: unknown[]) => sendCandidate(...a),
}));

const probeFinnhubActualExists = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => false));
vi.mock("@/lib/calendar/enrich-actuals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/enrich-actuals")>();
  return { ...actual, probeFinnhubActualExists: (...a: unknown[]) => probeFinnhubActualExists(...a) };
});

const writeSent = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null));
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: async () => null,
  setEarningsRunningMarker: async () => null,
  clearEarningsRunningMarker: async () => null,
  writeMacSentEarningsMarker: (...a: unknown[]) => writeSent(...a),
  fetchCloudSentEarnings: async () => [],
  postMacRecentEarningsSweepMarker: async () => null,
}));

vi.mock("@/lib/alerts/notify-pushover", () => ({ sendPushover: async () => ({ sent: true }) }));

const printArmed = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ printed: 0 })));
vi.mock("@/lib/earnings/worksheet", () => ({
  printArmedWorksheets: (...a: unknown[]) => printArmed(...a),
}));

import {
  findEmailCandidates,
  isLateArmPreviewInWindow,
  LATE_ARM_PREVIEW_CUTOFF_MS,
} from "@/lib/calendar/enrichment-runner";
import { processSweepCandidate, runLateArmPreviewKick } from "@/lib/calendar/email-sweep";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { recordEarningsEmailSkip } from "@/lib/mutations/earnings-skips";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sendCandidate.mockClear();
  probeFinnhubActualExists.mockReset();
  probeFinnhubActualExists.mockResolvedValue(false);
  printArmed.mockClear();
});

const DATE = "2026-06-01";

function seedEvent(
  symbol: string,
  opts: { eventTime?: string | null; releaseTime?: string; armed?: boolean } = {},
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, symbol, source_key)
         VALUES ('manual','earnings',?,?,?,?,?,?)`,
      )
      .run(
        DATE,
        opts.eventTime === undefined ? "AMC" : opts.eventTime,
        opts.releaseTime ?? "16:00",
        `${symbol} earnings`,
        symbol,
        `manual:${symbol}:${DATE}`,
      ).lastInsertRowid,
  );
  if (opts.armed !== false) armWorksheet(db, id);
  return id;
}

const at = (utc: string) => new Date(`${DATE}T${utc}Z`);
const previewIds = (now: Date) =>
  findEmailCandidates(db, { now })
    .filter((c) => c.phase === "preview")
    .map((c) => c.eventId);

describe("findEmailCandidates — late-arm preview window", () => {
  it("an armed print 60 minutes out (past the regular window) is a preview candidate", () => {
    const id = seedEvent("LATEA");
    expect(previewIds(at("19:00:00"))).toEqual([id]); // 15:00 ET, print 16:00 ET
  });

  it("an UNARMED print at the same distance is not (the regular window is unchanged)", () => {
    const id = seedEvent("UNARM", { armed: false });
    // Coverage would come from holdings for an unarmed name; give it a
    // watchlist entry so only the window decides.
    const sec = Number(
      db
        .prepare(`INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES (?, 'stock', 'equity', 1)`)
        .run("UNARM").lastInsertRowid,
    );
    db.prepare(`INSERT INTO watchlist (security_id) VALUES (?)`).run(sec);
    expect(previewIds(at("19:00:00"))).not.toContain(id);
    // ...and it is a candidate inside its regular window (2 hours out).
    expect(previewIds(at("18:00:00"))).toContain(id);
  });

  it("stops 15 minutes before the print", () => {
    const id = seedEvent("LATEB");
    expect(previewIds(at("19:45:00"))).toEqual([id]); // exactly 15 minutes out
    expect(previewIds(at("19:45:01"))).toEqual([]);
    expect(previewIds(at("20:30:00"))).toEqual([]); // after the print
  });

  it("measures against the slot floor when the stored time is the CALL time", () => {
    // AMC row whose release_time 17:00 is the call; the print floor is 16:00.
    const id = seedEvent("CALLT", { releaseTime: "17:00" });
    expect(previewIds(at("19:30:00"))).toEqual([id]); // floor 30 min out
    // 70 minutes before the stored time but 10 before the floor: too late.
    expect(previewIds(at("19:50:00"))).toEqual([]);
  });

  it("never earlier than the regular window: a release time after the slot floor keeps its slot", () => {
    // BMO row stored 08:30 ET: regular window 06:15-06:45 ET. The floor
    // (07:00) must not pull the preview to 05:15.
    const bmo = seedEvent("BMOLT", { eventTime: "BMO", releaseTime: "08:30" });
    expect(previewIds(at("09:20:00"))).not.toContain(bmo); // 05:20 ET
    expect(previewIds(at("10:30:00"))).toContain(bmo); // 06:30 ET, the regular window
    // Once that window closes (06:45) the 07:00 floor is already inside the
    // 15-minute cutoff, so there is no late window for this row.
    expect(previewIds(at("10:46:00"))).not.toContain(bmo); // 06:46 ET
    expect(previewIds(at("10:50:00"))).not.toContain(bmo); // 06:50 ET
  });

  it("an armed BMO row stored at its 07:00 floor gets a late window to 06:45 ET", () => {
    const id = seedEvent("BMOFL", { eventTime: "BMO", releaseTime: "07:00" });
    expect(previewIds(at("09:30:00"))).toContain(id); // 05:30 ET, past the 04:45-05:15 window
    expect(previewIds(at("10:45:00"))).toContain(id); // 06:45 ET, exactly 15 minutes out
    expect(previewIds(at("10:46:00"))).not.toContain(id);
  });

  it("an AMC row stored at the 17:00 call time is not pulled earlier than 15:15 ET", () => {
    const id = seedEvent("AMCLT", { releaseTime: "17:00" });
    expect(previewIds(at("18:20:00"))).not.toContain(id); // 14:20 ET
    expect(previewIds(at("19:00:00"))).toContain(id); // 15:00 ET, regular window
  });

  it("marks late-arm candidates, and only those", () => {
    const late = seedEvent("MARKA");
    expect(findEmailCandidates(db, { now: at("19:00:00") }).find((c) => c.eventId === late)).toMatchObject({
      lateArm: true,
    });
    const regular = seedEvent("MARKB", { releaseTime: "17:00" });
    const cand = findEmailCandidates(db, { now: at("19:00:00") }).find((c) => c.eventId === regular);
    expect(cand).toBeDefined();
    expect(cand?.lateArm).toBeUndefined();
  });

  it("a slot-less row is measured against its stored release time alone", () => {
    const id = seedEvent("NOSLT", { eventTime: null, releaseTime: "16:30" });
    expect(previewIds(at("19:30:00"))).toEqual([id]); // 60 minutes before 16:30 ET
  });

  it("a recorded preview skip still removes it", () => {
    const id = seedEvent("SKIPD");
    recordEarningsEmailSkip(db, id, "preview");
    expect(previewIds(at("19:00:00"))).toEqual([]);
  });

  it("a sent preview still removes it", () => {
    const id = seedEvent("SENTP");
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md)
       VALUES (?, 'preview', 'desk@example.com', datetime('now'), 'x')`,
    ).run(id);
    expect(previewIds(at("19:00:00"))).toEqual([]);
  });

  it("isLateArmPreviewInWindow: no composable instant is never a candidate", () => {
    expect(
      isLateArmPreviewInWindow(
        { event_date: "not-a-date", release_time: "16:00", event_time: "AMC", raw_json: null },
        at("19:00:00"),
      ),
    ).toBe(false);
    expect(LATE_ARM_PREVIEW_CUTOFF_MS).toBe(15 * 60 * 1000);
  });
});

describe("runLateArmPreviewKick", () => {
  it("sends the late-arm preview through the send service, then runs the auto-print pass", async () => {
    const id = seedEvent("KICKA");
    const now = at("19:00:00");
    const r = await runLateArmPreviewKick(db, id, { now });

    expect(r).toMatchObject({ eventId: id, phase: "preview", ok: true });
    expect(sendCandidate).toHaveBeenCalledTimes(1);
    expect(sendCandidate.mock.calls[0][1]).toMatchObject({ eventId: id, phase: "preview" });
    expect(sendCandidate.mock.calls[0][2]).toEqual({ mode: "sweep" });
    expect(printArmed).toHaveBeenCalledWith(db, { now });
    expect(sendCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      printArmed.mock.invocationCallOrder[0],
    );
  });

  it("does nothing when the event is not a preview candidate now", async () => {
    const id = seedEvent("KICKB");
    expect(await runLateArmPreviewKick(db, id, { now: at("19:50:00") })).toBeNull();
    expect(sendCandidate).not.toHaveBeenCalled();
    expect(printArmed).not.toHaveBeenCalled();
  });

  it("only sends the event it was asked about", async () => {
    seedEvent("OTHER");
    const id = seedEvent("KICKC");
    await runLateArmPreviewKick(db, id, { now: at("19:00:00") });
    expect(sendCandidate).toHaveBeenCalledTimes(1);
    expect(sendCandidate.mock.calls[0][1]).toMatchObject({ eventId: id });
  });

  it("keeps the sweep's already-reported guard: a print already out records a skip, no send", async () => {
    const id = seedEvent("KICKD");
    probeFinnhubActualExists.mockResolvedValue(true);
    const r = await runLateArmPreviewKick(db, id, { now: at("19:00:00") });

    expect(r).toMatchObject({ eventId: id, skipped: "already-reported" });
    expect(sendCandidate).not.toHaveBeenCalled();
    const skip = db
      .prepare(`SELECT 1 FROM earnings_email_skips WHERE event_id = ? AND phase = 'preview'`)
      .get(id);
    expect(skip).toBeDefined();
  });

  it("re-checks a late-arm window just before the send: a window that closed sends nothing", async () => {
    // Chosen at 15:00 ET; by the time its turn comes it is 15:50 ET.
    const id = seedEvent("RECHK");
    const r = await processSweepCandidate(
      db,
      { eventId: id, symbol: "RECHK", phase: "preview", lateArm: true },
      { now: at("19:50:00") },
    );
    expect(r).toMatchObject({ eventId: id, ok: true, skipped: "late-arm-window-closed" });
    expect(sendCandidate).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT 1 FROM earnings_email_skips WHERE event_id = ?`).get(id)).toBeUndefined();
  });

  it("the re-check lets a still-open late-arm window send", async () => {
    const id = seedEvent("RECHO");
    const r = await processSweepCandidate(
      db,
      { eventId: id, symbol: "RECHO", phase: "preview", lateArm: true },
      { now: at("19:30:00") },
    );
    expect(r).toMatchObject({ eventId: id, ok: true });
    expect(sendCandidate).toHaveBeenCalledTimes(1);
  });

  it("never throws: a throwing send service is booked as a failed result", async () => {
    const id = seedEvent("KICKE");
    sendCandidate.mockRejectedValueOnce(new Error("boom"));
    const r = await runLateArmPreviewKick(db, id, { now: at("19:00:00") });
    expect(r).toMatchObject({ eventId: id, ok: false });
  });
});
