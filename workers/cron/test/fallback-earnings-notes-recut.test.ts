/**
 * The 90-day notes window is re-cut at SEND time.
 *
 * The snapshot ships security-linked notes from the 90 days before the day it
 * was written. A snapshot a day or more old therefore still carried a note
 * that is now older than 90 days. The Worker cuts again with its own Eastern
 * today, by the Mac's rule (lib/queries/notes.ts::getNotesForFamily):
 * `date(event_date) > today - 90 days`. Prompt context only: this can remove
 * a note from the email, never add one, and decides no send.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-earnings";
import type { Snapshot } from "../src/state";

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));
vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositionsCached: vi.fn(async () => []) };
});

import { runEarningsFallback, resolveNotesForFamily } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";

const EVENT_DATE = "2026-06-11";
/** 16:00 ET release; 18:00 UTC is two hours before it (the preview window). */
const SEND_AT = "2026-06-11T18:00:00Z";

function makeEnv(): FallbackEnv {
  const store = new Map<string, string>();
  return {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    BRIEFING_EMAIL_TO: "user@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  };
}

const note = (id: number, event_date: string, content: string, symbol = "ZZA") => ({
  id,
  note_type: "trade_thesis",
  content,
  event_date,
  sentiment: null,
  tags: null,
  symbol,
  underlying_symbol: null,
});

function snapshotWith(notes: unknown[]): Snapshot {
  return {
    schemaVersion: 5,
    // Written two days before the send: its own 90-day cut is two days stale.
    snapshotDate: "2026-06-09",
    generatedAt: "2026-06-09T06:00:00.000Z",
    heldSymbols: ["ZZA"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: 1,
        week_of: "2026-06-08",
        event_date: EVENT_DATE,
        event_type: "earnings",
        title: "ZZA earnings",
        description: null,
        symbol: "ZZA",
        event_time: "AMC",
        release_time: "16:00",
        expected_impact: "high",
        source: "finnhub",
        source_key: `finnhub:ZZA:${EVENT_DATE}`,
        raw_json: {},
        superseded: 0,
        enriched_at: null,
        consensus_estimate: "EPS 1.00 · Rev 1B",
        consensus_value: null,
        actual_value: null,
        previous_value: null,
        reaction_snapshot: null,
      },
    ],
    notes,
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

async function previewHtml(notes: unknown[], now = SEND_AT): Promise<string> {
  (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWith(notes));
  const result = await runEarningsFallback(makeEnv(), { now: new Date(now) });
  expect(result.details.filter((d) => d.status === "sent")).toHaveLength(1);
  const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][1].html as string;
}

describe("earnings fallback: notes older than 90 days at send time are left out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  // 2026-06-11 minus 90 days is 2026-03-13. The rule is strictly after it.
  it("keeps a note 89 days old and drops notes 90 and 91 days old", async () => {
    const html = await previewHtml([
      note(1, "2026-03-14", "NOTEKEPT eighty-nine days"),
      note(2, "2026-03-13", "NOTEDROPPED ninety days"),
      note(3, "2026-03-12", "NOTEDROPPED ninety-one days"),
      note(4, "2026-06-10", "NOTEKEPT yesterday"),
    ]);
    expect(html).toContain("NOTEKEPT eighty-nine days");
    expect(html).toContain("NOTEKEPT yesterday");
    expect(html).not.toContain("NOTEDROPPED");
  });

  it("a stored timestamp form of the day is cut by its date", async () => {
    const html = await previewHtml([
      note(1, "2026-03-14 09:30:00", "NOTEKEPT with a time"),
      note(2, "2026-03-13T23:59:00", "NOTEDROPPED with a time"),
    ]);
    expect(html).toContain("NOTEKEPT with a time");
    expect(html).not.toContain("NOTEDROPPED");
  });

  it("uses the Eastern day: at 23:30 Eastern the UTC date is already tomorrow", () => {
    // 03:30 UTC on 12 June is 23:30 Eastern on 11 June. Counted from the
    // Eastern day the cut is 13 March and the 14 March note stays; counted
    // from the UTC date it would be 14 March and the note would be dropped.
    const snap = snapshotWith([
      note(1, "2026-03-14", "eighty-nine days on the Eastern day"),
      note(2, "2026-03-13", "ninety days"),
    ]);
    const ids = (now: string) =>
      resolveNotesForFamily(snap, ["ZZA"], new Date(now)).map((n) => n.id);
    expect(ids("2026-06-12T03:30:00Z")).toEqual([1]);
    // Half an hour later it is 12 June in New York too: the note ages out.
    expect(ids("2026-06-12T04:30:00Z")).toEqual([]);
  });

  it("a note with an unreadable date is left out", async () => {
    const html = await previewHtml([
      note(1, "soon", "NOTEDROPPED unreadable"),
      note(2, "2026-06-01", "NOTEKEPT readable"),
    ]);
    expect(html).toContain("NOTEKEPT readable");
    expect(html).not.toContain("NOTEDROPPED");
  });

  it("another company's note is still not shown", async () => {
    const html = await previewHtml([
      note(1, "2026-06-01", "NOTEDROPPED other company", "ZZB"),
      note(2, "2026-06-01", "NOTEKEPT this company"),
    ]);
    expect(html).toContain("NOTEKEPT this company");
    expect(html).not.toContain("NOTEDROPPED");
  });
});
