/**
 * Worker <-> Mac parity for the "two hand-entered rows, one email" rule
 * (owner ruling 2026-10-07): when one company has two live hand-entered
 * earnings rows, the EARLIER date counts for email and the later row is
 * ignored by every email finder.
 *
 * Three pins:
 *  1. workers/cron/src/manual-twin-email.ts is byte-identical to
 *     lib/earnings/manual-twin-email.ts below the header (the Worker cannot
 *     cross the Next.js path-alias boundary, so it carries a hand copy);
 *  2. both copies return the same answer on a case matrix;
 *  3. the Worker's scan, run on the SAME fixture the Mac finder test uses
 *     (tests/fixtures/manual-twin-email-fixture.ts, asserted Mac-side in
 *     tests/earnings/manual-twin-email.test.ts), sends for the earlier row
 *     only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
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

import { runEarningsFallback, issuerSiblings } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import {
  emailIgnoredManualTwins as workerRule,
  MANUAL_TWIN_EMAIL_WINDOW_DAYS as WORKER_WINDOW,
} from "../src/manual-twin-email";
import {
  emailIgnoredManualTwins as macRule,
  MANUAL_TWIN_EMAIL_WINDOW_DAYS as MAC_WINDOW,
} from "../../../lib/earnings/manual-twin-email";
import { MANUAL_TWIN_FIXTURE as FX } from "../../../tests/fixtures/manual-twin-email-fixture";

describe("manual-twin email rule parity (Worker mirror of lib/earnings/manual-twin-email.ts)", () => {
  it("is byte-identical to the Mac source below the header", () => {
    const mac = readFileSync(
      new URL("../../../lib/earnings/manual-twin-email.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(new URL("../src/manual-twin-email.ts", import.meta.url), "utf8");
    const marker = "/**\n * With two hand-entered earnings rows";
    expect(mac.indexOf(marker)).toBeGreaterThan(-1);
    expect(wkr.indexOf(marker)).toBeGreaterThan(-1);
    expect(wkr.slice(wkr.indexOf(marker))).toBe(mac.slice(mac.indexOf(marker)));
  });

  it("both Worker email selectors (the scan and the wrap cluster) apply the rule", () => {
    const src = readFileSync(new URL("../src/fallback-earnings.ts", import.meta.url), "utf8");
    const slice = (from: string, to: string) => {
      const start = src.indexOf(from);
      const end = src.indexOf(to, start + from.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return src.slice(start, end);
    };
    for (const body of [
      slice("function buildWrapCluster(", "function prioritizeCandidates("),
      slice("async function findCandidatesFromSnapshot(", "async function composeAndSend("),
    ]) {
      // The rule's input is the calendar rows plus the snapshot's
      // `manualEarningsRows` (v13): the Mac reads every live hand-entered
      // row, not a date window. The armed-events delta is passed too, so a
      // row deleted or replaced since the snapshot is dropped from the
      // field's rows. See manual-twin-out-of-window.test.ts.
      expect(body).toMatch(
        /emailIgnoredManualTwins\(\s*manualTwinRuleRows\(snapshot, eff\.events, delta\),\s*issuerSiblings,?\s*\)/,
      );
      expect(body).toContain("if (ignoredManualTwins.has(e.id)) continue;");
    }
  });

  it("names the same window on both sides", () => {
    expect(WORKER_WINDOW).toBe(MAC_WINDOW);
  });

  const row = (id: number, symbol: string, event_date: string, source = "manual", superseded = 0) => ({
    id,
    symbol,
    event_date,
    source,
    event_type: "earnings",
    superseded,
  });
  const CASES = [
    { label: "two rows a day apart", rows: [row(1, "ZZA", "2026-06-10"), row(2, "ZZA", "2026-06-11")] },
    { label: "same date, lower id wins", rows: [row(7, "ZZA", "2026-06-10"), row(3, "ZZA", "2026-06-10")] },
    { label: "15 days apart", rows: [row(1, "ZZA", "2026-06-01"), row(2, "ZZA", "2026-06-16")] },
    { label: "manual beside vendor", rows: [row(1, "ZZA", "2026-06-10"), row(2, "ZZA", "2026-06-11", "finnhub")] },
    { label: "later twin hidden", rows: [row(1, "ZZA", "2026-06-10"), row(2, "ZZA", "2026-06-11", "manual", 1)] },
    { label: "share classes of one issuer", rows: [row(1, "GOOG", "2026-06-10"), row(2, "GOOGL", "2026-06-11")] },
  ];
  for (const c of CASES) {
    it(`both sides agree: ${c.label}`, () => {
      const wkr = [...workerRule(c.rows, issuerSiblings).entries()];
      const mac = [...macRule(c.rows, issuerSiblings).entries()];
      expect(wkr).toEqual(mac);
    });
  }
});

// ── The scan, on the fixture the Mac finder test runs ───────────────────────

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
    RESEND_FROM_DOMAIN: "myportfoliodesk.com",
  };
}

function fixtureEvent(
  which: { id: number; eventDate: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: which.id,
    week_of: "2026-06-08",
    event_date: which.eventDate,
    event_type: "earnings",
    title: `${FX.symbol} earnings`,
    description: null,
    symbol: FX.symbol,
    event_time: "AMC",
    release_time: FX.releaseTime,
    expected_impact: "high",
    source: "manual",
    source_key: `manual:${FX.symbol}:${which.eventDate}:earnings`,
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

function fixtureSnapshot(events: Record<string, unknown>[]): Snapshot {
  return {
    schemaVersion: 2,
    snapshotDate: FX.earlier.eventDate,
    generatedAt: new Date().toISOString(),
    heldSymbols: [FX.symbol],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: events,
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

describe("Worker scan on the shared two-hand-entered-rows fixture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  const sentIds = (result: Awaited<ReturnType<typeof runEarningsFallback>>) =>
    result.details.filter((d) => d.status === "sent").map((d) => d.eventId);
  const touchedIds = (result: Awaited<ReturnType<typeof runEarningsFallback>>) =>
    result.details.map((d) => d.eventId);

  it("previews the earlier row on its day", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixtureSnapshot([fixtureEvent(FX.earlier), fixtureEvent(FX.later)]),
    );
    const result = await runEarningsFallback(makeEnv(), {
      now: new Date(FX.twoHoursBeforeEarlierRelease),
    });
    expect(sentIds(result)).toEqual([FX.earlier.id]);
  });

  it("sends no preview for the later row on its day", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixtureSnapshot([fixtureEvent(FX.earlier), fixtureEvent(FX.later)]),
    );
    const result = await runEarningsFallback(makeEnv(), {
      now: new Date(FX.twoHoursBeforeLaterRelease),
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(touchedIds(result)).not.toContain(FX.later.id);
  });

  it("sends no recap for the later row, even when it carries an actual", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixtureSnapshot([
        fixtureEvent(FX.earlier),
        fixtureEvent(FX.later, {
          enriched_at: FX.laterRowEnrichedAt,
          actual_value: FX.laterRowActual,
          consensus_value: "EPS 1.00 · Rev 1000000000",
        }),
      ]),
    );
    const result = await runEarningsFallback(makeEnv(), {
      now: new Date(FX.afterLaterRowEnriched),
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(touchedIds(result)).not.toContain(FX.later.id);
  });

  it("a hand-entered row beside a vendor row is unaffected — the vendor row still previews", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixtureSnapshot([
        fixtureEvent(FX.earlier),
        fixtureEvent(FX.later, { source: "finnhub", source_key: "finnhub:ZZA:2026-06-11" }),
      ]),
    );
    const result = await runEarningsFallback(makeEnv(), {
      now: new Date(FX.twoHoursBeforeLaterRelease),
    });
    expect(sentIds(result)).toEqual([FX.later.id]);
  });
});
