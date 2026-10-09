/**
 * The "two hand-entered rows, one email" rule must see the WHOLE calendar.
 *
 * The Mac reads every live hand-entered earnings row
 * (lib/queries/manual-twin-email.ts::getEmailIgnoredManualTwins). The Worker
 * used to run the same rule over the snapshot's calendar window only
 * (yesterday to +7 days), so with two hand-entered rows nine days apart the
 * earlier row had left the window by the later date, the Worker saw no twin,
 * and with the Mac asleep it sent the preview and recap the Mac refuses.
 *
 * The snapshot now carries `manualEarningsRows` (every live hand-entered
 * earnings row, five columns) and both Worker selectors union it, by event
 * id, into the rule's input. The field is optional: a snapshot without it
 * behaves exactly as before.
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

import {
  runEarningsFallback,
  issuerSiblings,
  manualTwinRuleRows,
} from "../src/fallback-earnings";
import { emailIgnoredManualTwins } from "../src/manual-twin-email";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";

const SYMBOL = "ZZA";
const RELEASE_TIME = "16:00";
// Nine days apart: inside the rule's 14-day span, wider than the snapshot's
// calendar window on the later date.
const EARLIER = { id: 1, eventDate: "2026-06-02" };
const LATER = { id: 2, eventDate: "2026-06-11" };
/** 16:00 ET in June is 20:00 UTC; two hours before each release. */
const TWO_HOURS_BEFORE_EARLIER = "2026-06-02T18:00:00Z";
const TWO_HOURS_BEFORE_LATER = "2026-06-11T18:00:00Z";
const LATER_ENRICHED_AT = "2026-06-11 20:30:00";
const AFTER_LATER_ENRICHED = "2026-06-11T21:00:00Z";

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

function calendarRow(
  which: { id: number; eventDate: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: which.id,
    week_of: "2026-06-08",
    event_date: which.eventDate,
    event_type: "earnings",
    title: `${SYMBOL} earnings`,
    description: null,
    symbol: SYMBOL,
    event_time: "AMC",
    release_time: RELEASE_TIME,
    expected_impact: "high",
    source: "manual",
    source_key: `manual:${SYMBOL}:${which.eventDate}:earnings`,
    raw_json: {},
    superseded: 0,
    enriched_at: null,
    consensus_estimate: "EPS 1.00 · Rev 1B",
    consensus_value: null,
    actual_value: null,
    previous_value: null,
    reaction_snapshot: null,
    ...overrides,
  };
}

/** One row of the snapshot's `manualEarningsRows`, as the Mac writes it. */
function manualRow(which: { id: number; eventDate: string }, symbol = SYMBOL) {
  return {
    id: which.id,
    symbol,
    event_date: which.eventDate,
    source: "manual",
    event_type: "earnings",
  };
}

function snapshotOf(
  calendarEvents: Record<string, unknown>[],
  manualEarningsRows?: unknown,
): Snapshot {
  return {
    schemaVersion: 13,
    snapshotDate: LATER.eventDate,
    generatedAt: new Date().toISOString(),
    heldSymbols: [SYMBOL],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents,
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
    ...(manualEarningsRows === undefined ? {} : { manualEarningsRows }),
  } as unknown as Snapshot;
}

const sentIds = (result: Awaited<ReturnType<typeof runEarningsFallback>>) =>
  result.details.filter((d) => d.status === "sent").map((d) => d.eventId);
const touchedIds = (result: Awaited<ReturnType<typeof runEarningsFallback>>) =>
  result.details.map((d) => d.eventId);

const laterWithActual = () =>
  calendarRow(LATER, {
    enriched_at: LATER_ENRICHED_AT,
    actual_value: "EPS 1.00 · Rev 1000000000",
    consensus_value: "EPS 1.00 · Rev 1000000000",
  });

describe("hand-entered rows nine days apart: the earlier row has left the snapshot window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  it("sends no preview for the later row", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([calendarRow(LATER)], [manualRow(EARLIER), manualRow(LATER)]),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(touchedIds(result)).not.toContain(LATER.id);
  });

  it("sends no recap for the later row, even when it carries an actual", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([laterWithActual()], [manualRow(EARLIER), manualRow(LATER)]),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(AFTER_LATER_ENRICHED) });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(touchedIds(result)).not.toContain(LATER.id);
  });

  it("the earlier row is unaffected: it previews on its own day while the later row is beyond the window", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([calendarRow(EARLIER)], [manualRow(EARLIER), manualRow(LATER)]),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_EARLIER) });
    expect(sentIds(result)).toEqual([EARLIER.id]);
  });

  it("field absent (an older snapshot): exactly the old behaviour, the later row previews", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotOf([calendarRow(LATER)]));
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });

  it("field absent: the later row's recap still sends", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotOf([laterWithActual()]));
    const result = await runEarningsFallback(makeEnv(), { now: new Date(AFTER_LATER_ENRICHED) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });

  it("a field that is not a list is read as absent", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([calendarRow(LATER)], { rows: "not a list" }),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });

  it("a superseded hand-entered row does not count as the earlier twin", async () => {
    // The Mac never ships a superseded row in the field; a row that says so
    // anyway is still not a twin.
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([calendarRow(LATER)], [{ ...manualRow(EARLIER), superseded: 1 }, manualRow(LATER)]),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });

  it("an earlier row the calendar window shows as superseded stays superseded, whatever the field says", async () => {
    // Same event id in both places: the calendar row (which carries the
    // superseded flag) wins over the field's five-column copy.
    const EARLIER_IN_WINDOW = { id: 1, eventDate: "2026-06-10" };
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf(
        [calendarRow(EARLIER_IN_WINDOW, { superseded: 1 }), calendarRow(LATER)],
        [manualRow(EARLIER_IN_WINDOW), manualRow(LATER)],
      ),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });

  it("rows fifteen days apart are different quarters: the later row still previews", async () => {
    const FAR = { id: 1, eventDate: "2026-05-27" };
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([calendarRow(LATER)], [manualRow(FAR), manualRow(LATER)]),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });

  it("another company's hand-entered row never makes this one ignored", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotOf([calendarRow(LATER)], [manualRow(EARLIER, "ZZB"), manualRow(LATER)]),
    );
    const result = await runEarningsFallback(makeEnv(), { now: new Date(TWO_HOURS_BEFORE_LATER) });
    expect(sentIds(result)).toEqual([LATER.id]);
  });
});

describe("manualTwinRuleRows (the rule's input at both Worker call sites)", () => {
  const events = [calendarRow(LATER)] as unknown as Parameters<typeof manualTwinRuleRows>[1];

  it("returns the calendar rows themselves when the field is absent", () => {
    expect(manualTwinRuleRows(snapshotOf([]), events)).toBe(events);
  });

  it("adds the field's rows the calendar window lacks, and no second copy of one it has", () => {
    const rows = manualTwinRuleRows(snapshotOf([], [manualRow(EARLIER), manualRow(LATER)]), events);
    expect(rows.map((r) => r.id)).toEqual([LATER.id, EARLIER.id]);
    // The calendar's own row object is the one kept for a shared id.
    expect(rows[0]).toBe(events[0]);
    expect([...emailIgnoredManualTwins(rows, issuerSiblings).keys()]).toEqual([LATER.id]);
  });

  it("drops a malformed row instead of throwing", () => {
    const rows = manualTwinRuleRows(
      snapshotOf([], [null, 7, { id: "1", event_date: EARLIER.eventDate }, { id: 3 }, manualRow(EARLIER)]),
      events,
    );
    expect(rows.map((r) => r.id)).toEqual([LATER.id, EARLIER.id]);
  });

  it("adding rows can only ignore more: nothing the window-only rule ignored is un-ignored", () => {
    // Window shows two rows a day apart (the later ignored). Extra rows from
    // the field, before, between and after, never free the ignored row.
    const A = { id: 10, eventDate: "2026-06-10" };
    const B = { id: 11, eventDate: "2026-06-11" };
    const windowRows = [calendarRow(A), calendarRow(B)] as unknown as Parameters<typeof manualTwinRuleRows>[1];
    const before = new Set(emailIgnoredManualTwins(windowRows, issuerSiblings).keys());
    expect([...before]).toEqual([B.id]);
    for (const extraDate of ["2026-05-01", "2026-06-01", "2026-06-10", "2026-06-25", "2026-08-01"]) {
      const rows = manualTwinRuleRows(
        snapshotOf([], [manualRow({ id: 99, eventDate: extraDate })]),
        windowRows,
      );
      const after = new Set(emailIgnoredManualTwins(rows, issuerSiblings).keys());
      for (const id of before) expect(after.has(id)).toBe(true);
    }
  });
});
