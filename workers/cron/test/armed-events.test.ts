/**
 * Armed-events resolver — the Worker's half of "armed as covered"
 * (live print v2 slice A §4.1 cloud, deviation D2).
 *
 * The Mac is the source of truth: it POSTs the full armed projection to
 * POST /internal/armed-events, which the Worker stores in KV under a
 * generation watermark. Every consumer then reads the EFFECTIVE calendar —
 * the R2 snapshot merged with any KV delta newer than the snapshot's own
 * `armedGeneration` — so an event armed after the 2am snapshot is still
 * covered in the cloud.
 */
import { describe, it, expect, vi } from "vitest";
import {
  effectiveCalendarEvents,
  applyArmedEventsDelta,
  readArmedEventsDelta,
  isCoveredInCloud,
  ArmedEventsValidationError,
  ARMED_EVENTS_MAX_ENTRIES,
  ARMED_EVENTS_MAX_REMOVED_IDS,
  ARMED_EVENTS_MAX_SUPERSEDED_IDS,
} from "../src/armed-events";
import type { Snapshot, ArmedEventEntry } from "../src/state";

const entry = (
  eventId: number,
  symbol: string,
  eventDate: string,
  extra: Partial<ArmedEventEntry> = {},
): ArmedEventEntry => ({
  eventId,
  symbol,
  eventDate,
  eventTime: "AMC",
  releaseTime: "16:15",
  sourceKey: `manual:${symbol}:${eventDate}:earnings`,
  source: "manual",
  consensusValue: null,
  expectedImpact: null,
  securityId: null,
  epsConsensusVendor: null,
  ...extra,
});

const snap = (over: Partial<Snapshot>): Snapshot =>
  ({
    schemaVersion: 11,
    snapshotDate: "2026-09-02",
    generatedAt: "",
    heldSymbols: ["HELDCO"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: 1,
        source: "finnhub",
        event_type: "earnings",
        event_date: "2026-09-03",
        event_time: "AMC",
        title: "HELDCO",
        description: null,
        security_id: null,
        symbol: "HELDCO",
        expected_impact: null,
        consensus_estimate: null,
        previous_value: null,
        raw_json: null,
      },
    ],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
    armedGeneration: 3,
    armedEvents: [],
    ...over,
  }) as unknown as Snapshot;

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      delete: vi.fn(),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
  };
}

describe("effectiveCalendarEvents (spec §4.1 cloud)", () => {
  it("an armed-only event added after the snapshot reaches the effective collection and is covered", () => {
    const s = snap({});
    const eff = effectiveCalendarEvents(s, {
      generation: 4,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
    expect(eff.source).toBe("snapshot+delta");
    // Snapshot rows keep their own order; delta-only additions append after.
    expect(eff.events.map((e) => e.id)).toEqual([1, 77]);
    expect(eff.armedEventIds).toEqual(new Set([77]));
    expect(isCoveredInCloud(s, eff, { id: 77, symbol: "ACME" })).toBe(true);
    expect(isCoveredInCloud(s, eff, { id: 1, symbol: "HELDCO" })).toBe(true); // held, unchanged
  });

  it("a tombstone removes a delta-only event and un-arms a snapshot event", () => {
    const s = snap({ armedEvents: [entry(1, "HELDCO", "2026-09-03")] });
    const eff = effectiveCalendarEvents(s, {
      generation: 4,
      entries: [
        entry(77, "ACME", "2026-09-02", { removed: true }),
        entry(1, "HELDCO", "2026-09-03", { removed: true }),
      ],
    });
    expect(eff.events.map((e) => e.id)).toEqual([1]);
    expect(eff.armedEventIds).toEqual(new Set());
    expect(isCoveredInCloud(s, eff, { id: 1, symbol: "HELDCO" })).toBe(true); // still held
  });

  it("a delta tombstone drops an event the delta itself added earlier in the same list", () => {
    const s = snap({});
    const eff = effectiveCalendarEvents(s, {
      generation: 4,
      entries: [entry(77, "ACME", "2026-09-02"), entry(77, "ACME", "2026-09-02", { removed: true })],
    });
    expect(eff.events.map((e) => e.id)).toEqual([1]);
    expect(eff.armedEventIds).toEqual(new Set());
  });

  it("a tombstone carried INSIDE the snapshot payload never counts as armed", () => {
    // buildArmedEventsEntries ships live rows AND tombstones (D7 retention),
    // so the snapshot's armedEvents array can hold `removed: true` entries.
    const s = snap({
      armedEvents: [
        entry(5, "BETA", "2026-09-03"),
        entry(78, "GONE", "2026-09-02", { removed: true, removedAt: "2026-09-02T20:00:00.000Z" }),
      ],
    });
    const eff = effectiveCalendarEvents(s, null);
    expect(eff.source).toBe("snapshot");
    expect(eff.armedEventIds).toEqual(new Set([5]));
    expect(eff.events.map((e) => e.id)).toEqual([1, 5]);
  });

  it("a stale delta (generation <= snapshot.armedGeneration) is ignored; the snapshot's own armedEvents still count", () => {
    const s = snap({ armedEvents: [entry(5, "BETA", "2026-09-03")] });
    const eff = effectiveCalendarEvents(s, {
      generation: 3,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
    expect(eff.source).toBe("snapshot");
    expect(eff.events.map((e) => e.id)).toEqual([1, 5]);
    expect(eff.armedEventIds).toEqual(new Set([5]));
  });

  it("a v10 snapshot ignores the delta and degrades to held+watchlist", () => {
    const s = snap({
      schemaVersion: 10,
      armedGeneration: undefined,
      armedEvents: undefined,
    } as Partial<Snapshot>);
    const eff = effectiveCalendarEvents(s, {
      generation: 9,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
    expect(eff.source).toBe("degraded-v10");
    expect(eff.events.map((e) => e.id)).toEqual([1]);
    expect(eff.armedEventIds).toEqual(new Set());
    expect(isCoveredInCloud(s, eff, { id: 77, symbol: "ACME" })).toBe(false);
  });

  it("with no delta at all, a v11 snapshot returns its calendar rows in snapshot order", () => {
    const s = snap({
      calendarEvents: [
        { id: 9, event_type: "earnings", event_date: "2026-09-05", symbol: "ZED" },
        { id: 2, event_type: "earnings", event_date: "2026-09-03", symbol: "HELDCO" },
      ] as unknown as Snapshot["calendarEvents"],
    });
    const eff = effectiveCalendarEvents(s, null);
    expect(eff.source).toBe("snapshot");
    expect(eff.events.map((e) => e.id)).toEqual([9, 2]); // untouched, not re-sorted
  });

  it("a replaced projection wins over the snapshot row of the same id", () => {
    const s = snap({});
    const eff = effectiveCalendarEvents(s, {
      generation: 4,
      entries: [entry(1, "HELDCO", "2026-09-04", { releaseTime: "07:00", eventTime: "BMO" })],
    });
    expect(eff.events.find((e) => e.id === 1)).toMatchObject({
      event_date: "2026-09-04",
      event_time: "BMO",
      release_time: "07:00",
    });
    // ...and keeps its snapshot slot rather than moving to the appended tail.
    expect(eff.events.map((e) => e.id)).toEqual([1]);
  });

  it("a live armed event that never ages out of the Mac payload still reaches the collection", () => {
    // The projection has NO date filter (plan): the Worker must not assume the
    // delta is small or recent — the consumers apply their own date windows.
    const s = snap({});
    const eff = effectiveCalendarEvents(s, {
      generation: 4,
      entries: [entry(77, "ACME", "2020-01-15"), entry(78, "BETA", "2031-12-31")],
    });
    expect(eff.events.map((e) => e.id)).toEqual([1, 77, 78]);
    expect(eff.armedEventIds).toEqual(new Set([77, 78]));
  });
});

describe("applyArmedEventsDelta (KV read-compare-write)", () => {
  it("applies a higher generation, refuses a lower or equal one, rejects a malformed body", async () => {
    const { kv, store } = makeKv();
    expect(await applyArmedEventsDelta(kv, { generation: 2, entries: [] })).toEqual({
      applied: true,
      generation: 2,
      accepted: { supersededEventIds: 0, removedEventIds: 0 },
    });
    expect(await applyArmedEventsDelta(kv, { generation: 2, entries: [] })).toEqual({
      applied: false,
      generation: 2,
      accepted: { supersededEventIds: 0, removedEventIds: 0 },
    });
    expect(await applyArmedEventsDelta(kv, { generation: 1, entries: [] })).toEqual({
      applied: false,
      generation: 2,
      accepted: { supersededEventIds: 0, removedEventIds: 0 },
    });
    expect(
      await applyArmedEventsDelta(kv, {
        generation: 5,
        entries: [entry(77, "ACME", "2026-09-02")],
      }),
    ).toEqual({ applied: true, generation: 5, accepted: { supersededEventIds: 0, removedEventIds: 0 } });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({
      generation: 5,
      entries: [entry(77, "ACME", "2026-09-02")],
      supersededEventIds: [],
      removedEventIds: [],
    });
    await expect(applyArmedEventsDelta(kv, { generation: "x" })).rejects.toThrow(/generation/);
    expect(await readArmedEventsDelta(kv)).toEqual({
      generation: 5,
      entries: [entry(77, "ACME", "2026-09-02")],
      supersededEventIds: [],
      removedEventIds: [],
    });
  });

  it("strictly parses superseded ids, dedupes ascending, and accepts old two-key payloads", async () => {
    const { kv, store } = makeKv();
    await applyArmedEventsDelta(kv, {
      generation: 1,
      entries: [],
      supersededEventIds: [9, 2, 9],
    });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({
      generation: 1,
      entries: [],
      supersededEventIds: [2, 9],
      removedEventIds: [],
    });

    store.set("armed-events", JSON.stringify({ generation: 2, entries: [] }));
    expect(await readArmedEventsDelta(kv)).toEqual({
      generation: 2,
      entries: [],
      supersededEventIds: [],
      removedEventIds: [],
    });

    await expect(
      applyArmedEventsDelta(kv, { generation: 3, entries: [], supersededEventIds: "2" }),
    ).rejects.toThrow(/supersededEventIds/);
    await expect(
      applyArmedEventsDelta(kv, { generation: 3, entries: [], supersededEventIds: [0] }),
    ).rejects.toThrow(/positive integers/);
    await expect(
      applyArmedEventsDelta(kv, {
        generation: 3,
        entries: [],
        supersededEventIds: Array.from({ length: ARMED_EVENTS_MAX_SUPERSEDED_IDS + 1 }, (_, i) => i + 1),
      }),
    ).rejects.toThrow(/too many superseded ids/);
  });

  it("[M2] strictly parses removed ids and applies them like superseded ids", async () => {
    const { kv, store } = makeKv();
    await applyArmedEventsDelta(kv, {
      generation: 1,
      entries: [],
      removedEventIds: [
        { id: 9, eventDate: "2026-09-03", removedAt: "2026-09-02T20:00:00.000Z" },
        { id: 2, eventDate: "2026-09-02", removedAt: "2026-09-02T20:00:00.000Z" },
        { id: 9, eventDate: "2026-09-03", removedAt: "2026-09-02T20:00:00.000Z" },
      ],
    });
    expect(JSON.parse(store.get("armed-events")!).removedEventIds).toEqual([
      { id: 2, eventDate: "2026-09-02", removedAt: "2026-09-02T20:00:00.000Z" },
      { id: 9, eventDate: "2026-09-03", removedAt: "2026-09-02T20:00:00.000Z" },
    ]);

    await expect(
      applyArmedEventsDelta(kv, { generation: 2, entries: [], removedEventIds: "2" }),
    ).rejects.toThrow(/removedEventIds/);
    await expect(
      applyArmedEventsDelta(kv, { generation: 2, entries: [], removedEventIds: [{ id: 0, eventDate: "2026-09-02", removedAt: "x" }] }),
    ).rejects.toThrow(/positive integer ids/);
    await expect(
      applyArmedEventsDelta(kv, {
        generation: 2,
        entries: [],
        removedEventIds: Array.from({ length: ARMED_EVENTS_MAX_REMOVED_IDS + 1 }, (_, i) => ({
          id: i + 1,
          eventDate: "2026-09-02",
          removedAt: "2026-09-02T20:00:00.000Z",
        })),
      }),
    ).rejects.toThrow(/too many removed ids/);
  });

  // The handler answers 400 for this class only (the Mac then gives up on that
  // generation), so every rejection of the BODY must carry the tag and a
  // message a person can read — never a raw TypeError.
  it("a null list item is a clean, tagged validation error on all three lists", async () => {
    const { kv, store } = makeKv();
    const cases: Array<[unknown, RegExp]> = [
      [{ generation: 1, entries: [null] }, /every entry must be an object/],
      [{ generation: 1, entries: ["x"] }, /every entry must be an object/],
      [{ generation: 1, entries: [], supersededEventIds: [null] }, /positive integers/],
      [{ generation: 1, entries: [], removedEventIds: [null] }, /removedEventIds entries must be objects/],
      [{ generation: 1, entries: [], removedEventIds: [7] }, /removedEventIds entries must be objects/],
      [null, /integer generation/],
    ];
    for (const [body, message] of cases) {
      const err = await applyArmedEventsDelta(kv, body).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArmedEventsValidationError);
      expect((err as Error).message).toMatch(message);
    }
    expect(store.size).toBe(0);
  });

  it("a removed id needs a YYYY-MM-DD eventDate and a removedAt that parses as a date", async () => {
    const { kv, store } = makeKv();
    const good = { id: 5, eventDate: "2026-09-02", removedAt: "2026-09-02T20:00:00.000Z" };
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, eventDate: "2026-9-2" }, /eventDate must be YYYY-MM-DD/],
      [{ ...good, eventDate: "2026-09-02T00:00:00Z" }, /eventDate must be YYYY-MM-DD/],
      [{ ...good, eventDate: "next week" }, /eventDate must be YYYY-MM-DD/],
      [{ ...good, removedAt: "yesterday-ish" }, /removedAt must be a date-time/],
      [{ ...good, removedAt: "" }, /removedAt must be a date-time/],
    ];
    for (const [item, message] of bad) {
      const err = await applyArmedEventsDelta(kv, {
        generation: 1,
        entries: [],
        removedEventIds: [good, item],
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArmedEventsValidationError);
      expect((err as Error).message).toMatch(message);
    }
    expect(store.size).toBe(0); // the whole POST is rejected, nothing half-applied
    expect(
      await applyArmedEventsDelta(kv, { generation: 1, entries: [], removedEventIds: [good] }),
    ).toEqual({
      applied: true,
      generation: 1,
      accepted: { supersededEventIds: 0, removedEventIds: 1 },
    });
  });

  it("a KV failure is NOT a validation error (the handler must answer 503, not 400)", async () => {
    const kv = {
      get: vi.fn(async () => {
        throw new Error("KV GET failed: 500");
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const err = await applyArmedEventsDelta(kv, { generation: 1, entries: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ArmedEventsValidationError);
  });

  it("[C-19] drops unknown keys, preserves removed/removedAt, and rejects a bad shape", async () => {
    const { kv, store } = makeKv();
    await applyArmedEventsDelta(kv, {
      generation: 1,
      entries: [
        { ...entry(77, "acme", "2026-09-02"), notes: "user prose", documentText: "secret" },
        entry(78, "BETA", "2026-09-03", { removed: true, removedAt: "2026-09-03T01:02:03.000Z" }),
      ],
    });
    const stored = JSON.parse(store.get("armed-events")!) as { entries: ArmedEventEntry[] };
    expect(Object.keys(stored.entries[0]).sort()).toEqual(
      [
        "consensusValue",
        "epsConsensusVendor",
        "eventDate",
        "eventId",
        "eventTime",
        "expectedImpact",
        "releaseTime",
        "securityId",
        "source",
        "sourceKey",
        "symbol",
      ].sort(),
    );
    expect(stored.entries[0].symbol).toBe("ACME"); // normalised
    expect(stored.entries[1]).toMatchObject({
      removed: true,
      removedAt: "2026-09-03T01:02:03.000Z",
    });
  });

  it("rejects an oversized entry list and an entry missing a required field", async () => {
    const { kv } = makeKv();
    const many = Array.from({ length: ARMED_EVENTS_MAX_ENTRIES + 1 }, (_, i) =>
      entry(i + 1, "ACME", "2026-09-02"),
    );
    await expect(applyArmedEventsDelta(kv, { generation: 1, entries: many })).rejects.toThrow(
      /too many entries/,
    );
    const { sourceKey: _dropped, ...noSourceKey } = entry(77, "ACME", "2026-09-02");
    void _dropped;
    await expect(
      applyArmedEventsDelta(kv, { generation: 1, entries: [noSourceKey] }),
    ).rejects.toThrow(/sourceKey/);
  });

  it("readArmedEventsDelta returns null for missing or corrupt KV values", async () => {
    const { kv, store } = makeKv();
    expect(await readArmedEventsDelta(kv)).toBeNull();
    store.set("armed-events", "{not json");
    expect(await readArmedEventsDelta(kv)).toBeNull();
    store.set("armed-events", JSON.stringify({ generation: "x", entries: [] }));
    expect(await readArmedEventsDelta(kv)).toBeNull();
  });
});

/**
 * Fix round 1, item 1: the projection may only overwrite the fields it OWNS.
 *
 * `consensus_estimate` (Finnhub sync-time) and `consensus_value`
 * (enrichment-time) are different columns with different lifecycles. Spreading
 * a synthesized row over a real snapshot row blanked `consensus_estimate`,
 * which kills effectiveConsensusRaw's last fallback in fallback-earnings, empties
 * the `cons` column in todays-reporters, and hands a null consensus to
 * calendar-enrich's actual-fetch context. A synthesized `title` could also lose
 * slot inference for a "(Before Market Open)" event with no release_time.
 */
describe("projection merge — snapshot-only fields survive", () => {
  const richSnapshot = (over: Partial<Snapshot> = {}) =>
    snap({
      calendarEvents: [
        {
          id: 1,
          source: "finnhub",
          event_type: "earnings",
          event_date: "2026-09-03",
          event_time: null,
          title: "HELDCO earnings (Before Market Open)",
          description: "vendor blurb",
          security_id: 42,
          symbol: "HELDCO",
          expected_impact: "high",
          consensus_estimate: "EPS 9.99 · Rev 1,000,000",
          consensus_value: null,
          previous_value: "EPS 8.00",
          raw_json: '{"v":1}',
          enriched_at: "2026-09-03 21:00:00",
          actual_value: "EPS 10.10",
          reaction_snapshot: '{"pct":2.1}',
          release_time: null,
          superseded: 0,
        },
      ] as unknown as Snapshot["calendarEvents"],
      ...over,
    });

  it("a delta entry over an existing snapshot row updates only owned fields", () => {
    const eff = effectiveCalendarEvents(richSnapshot(), {
      generation: 4,
      entries: [
        entry(1, "HELDCO", "2026-09-05", {
          releaseTime: "07:00",
          eventTime: "BMO",
          consensusValue: "EPS 10.00",
        }),
      ],
    });
    const row = eff.events.find((e) => e.id === 1)!;
    // Owned by the projection — updated.
    expect(row).toMatchObject({
      event_date: "2026-09-05",
      event_time: "BMO",
      release_time: "07:00",
      consensus_value: "EPS 10.00",
      source_key: "manual:HELDCO:2026-09-05:earnings",
      source: "manual",
    });
    // Snapshot-only — untouched.
    expect(row.consensus_estimate).toBe("EPS 9.99 · Rev 1,000,000");
    expect(row.title).toBe("HELDCO earnings (Before Market Open)");
    expect(row.description).toBe("vendor blurb");
    expect(row.previous_value).toBe("EPS 8.00");
    expect(row.raw_json).toBe('{"v":1}');
    expect(row.enriched_at).toBe("2026-09-03 21:00:00");
    expect(row.actual_value).toBe("EPS 10.10");
    expect(row.reaction_snapshot).toBe('{"pct":2.1}');
  });

  it("the snapshot's own armedEvents path merges identically to the delta path", () => {
    const viaSnapshot = effectiveCalendarEvents(
      richSnapshot({
        armedEvents: [
          entry(1, "HELDCO", "2026-09-05", { releaseTime: "07:00", eventTime: "BMO" }),
        ],
      }),
      null,
    );
    const viaDelta = effectiveCalendarEvents(richSnapshot(), {
      generation: 4,
      entries: [entry(1, "HELDCO", "2026-09-05", { releaseTime: "07:00", eventTime: "BMO" })],
    });
    expect(viaSnapshot.events.find((e) => e.id === 1)).toEqual(
      viaDelta.events.find((e) => e.id === 1),
    );
    expect(viaSnapshot.armedEventIds).toEqual(viaDelta.armedEventIds);
  });

  it("with NO snapshot row the synthesized row still carries a usable consensus + slot", () => {
    const eff = effectiveCalendarEvents(snap({}), {
      generation: 4,
      entries: [
        entry(77, "ACME", "2026-09-02", {
          eventTime: "BMO",
          releaseTime: "07:00",
          consensusValue: "EPS 1.20",
        }),
      ],
    });
    const row = eff.events.find((e) => e.id === 77)!;
    expect(row).toMatchObject({
      id: 77,
      event_type: "earnings",
      symbol: "ACME",
      event_date: "2026-09-02",
      event_time: "BMO",
      release_time: "07:00",
      title: "ACME earnings",
      // Delta-only rows have no other source of consensus, so the projection's
      // value fills BOTH columns — this is the one place synthesis is right.
      consensus_estimate: "EPS 1.20",
      consensus_value: "EPS 1.20",
      superseded: 0,
    });
  });

  it("a superseded snapshot row stays superseded when armed", () => {
    const eff = effectiveCalendarEvents(
      richSnapshot({
        calendarEvents: [
          { id: 1, event_type: "earnings", event_date: "2026-09-03", symbol: "HELDCO", superseded: 1 },
        ] as unknown as Snapshot["calendarEvents"],
      }),
      { generation: 4, entries: [entry(1, "HELDCO", "2026-09-03")] },
    );
    expect(eff.events.find((e) => e.id === 1)!.superseded).toBe(1);
  });

  it("a newer delta marks existing rows superseded one-way and removes them from armed ids", () => {
    const eff = effectiveCalendarEvents(
      richSnapshot({
        armedEvents: [entry(1, "HELDCO", "2026-09-03")],
      }),
      {
        generation: 4,
        entries: [entry(2, "MISS", "2026-09-03")],
        supersededEventIds: [1, 999],
      },
    );
    expect(eff.events.find((e) => e.id === 1)!.superseded).toBe(1);
    expect(eff.events.some((e) => e.id === 999)).toBe(false);
    expect(eff.armedEventIds.has(1)).toBe(false);
    expect(eff.armedEventIds.has(2)).toBe(true);
  });

  it("[M2] a newer delta marks removed ids superseded one-way and removes them from armed ids", () => {
    const eff = effectiveCalendarEvents(
      richSnapshot({
        armedEvents: [entry(1, "HELDCO", "2026-09-03")],
      }),
      {
        generation: 4,
        entries: [],
        removedEventIds: [
          { id: 1, eventDate: "2026-09-03", removedAt: "2026-09-02T20:00:00.000Z" },
          { id: 999, eventDate: "2026-09-03", removedAt: "2026-09-02T20:00:00.000Z" },
        ],
      },
    );
    expect(eff.events.find((e) => e.id === 1)!.superseded).toBe(1);
    expect(eff.events.some((e) => e.id === 999)).toBe(false);
    expect(eff.armedEventIds.has(1)).toBe(false);
  });

  it("ignores superseded ids from stale deltas and degraded snapshots", () => {
    const newerSnapshot = effectiveCalendarEvents(richSnapshot(), {
      generation: 3,
      entries: [],
      supersededEventIds: [1],
    });
    expect(newerSnapshot.events.find((e) => e.id === 1)!.superseded).toBe(0);

    const degraded = effectiveCalendarEvents(
      richSnapshot({ schemaVersion: 10, armedGeneration: undefined } as Partial<Snapshot>),
      { generation: 9, entries: [], supersededEventIds: [1] },
    );
    expect(degraded.events.find((e) => e.id === 1)!.superseded).toBe(0);
  });
});

// FIX-W2 (R1): the reply states what the Worker actually holds, so the Mac can
// tell a Worker that stored its replaced/removed id lists from an old build
// that accepted the POST and dropped them.
describe("applyArmedEventsDelta acknowledges the id lists it stored", () => {
  const removed = (id: number) => ({
    id,
    eventDate: "2026-09-03",
    removedAt: "2026-09-02T20:00:00.000Z",
  });

  it("an applied generation reports the counts it persisted (after its own dedupe)", async () => {
    const { kv } = makeKv();
    expect(
      await applyArmedEventsDelta(kv, {
        generation: 1,
        entries: [],
        supersededEventIds: [9, 2, 9],
        removedEventIds: [removed(4)],
      }),
    ).toEqual({
      applied: true,
      generation: 1,
      accepted: { supersededEventIds: 2, removedEventIds: 1 },
    });
  });

  it("a replayed generation reports the counts of the record that stands, not of the body", async () => {
    const { kv } = makeKv();
    await applyArmedEventsDelta(kv, { generation: 5, entries: [], supersededEventIds: [1, 2, 3] });
    expect(
      await applyArmedEventsDelta(kv, { generation: 4, entries: [], removedEventIds: [removed(4)] }),
    ).toEqual({
      applied: false,
      generation: 5,
      accepted: { supersededEventIds: 3, removedEventIds: 0 },
    });
  });

  it("a record an OLD build stored without the id lists is completed by the same generation with IDENTICAL entries", async () => {
    const { kv, store } = makeKv();
    const heldEntries = [entry(77, "ACME", "2026-09-02"), entry(78, "ZZZ", "2026-09-03")];
    // What the pre-id-list Worker wrote: two keys only.
    store.set("armed-events", JSON.stringify({ generation: 7, entries: heldEntries }));
    expect(
      await applyArmedEventsDelta(kv, {
        generation: 7,
        // Same entries; key order differs, which is the one thing ignored.
        entries: heldEntries.map((e) => Object.fromEntries(Object.entries(e).reverse())),
        supersededEventIds: [3],
        removedEventIds: [removed(4)],
      }),
    ).toEqual({
      applied: true,
      generation: 7,
      accepted: { supersededEventIds: 1, removedEventIds: 1 },
    });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({
      generation: 7,
      entries: heldEntries,
      supersededEventIds: [3],
      removedEventIds: [removed(4)],
    });
    // Once complete it is an ordinary held generation again: equal is refused.
    const completed = store.get("armed-events");
    expect(
      await applyArmedEventsDelta(kv, {
        generation: 7,
        entries: heldEntries,
        supersededEventIds: [8, 9],
      }),
    ).toEqual({
      applied: false,
      generation: 7,
      accepted: { supersededEventIds: 1, removedEventIds: 1 },
    });
    expect(store.get("armed-events")).toBe(completed);
  });

  it("a same-generation body with DIFFERENT entries never changes the held record (restored database)", async () => {
    const heldEntries = [entry(77, "ACME", "2026-09-02"), entry(78, "ZZZ", "2026-09-03")];
    const different: Array<[string, unknown[]]> = [
      ["other event", [entry(99, "OTHER", "2026-09-02"), heldEntries[1]]],
      ["one field differs", [heldEntries[0], entry(78, "ZZZ", "2026-09-03", { releaseTime: "07:00" })]],
      ["null vs value", [heldEntries[0], entry(78, "ZZZ", "2026-09-03", { securityId: 5 })]],
      ["reordered", [heldEntries[1], heldEntries[0]]],
      ["one fewer", [heldEntries[0]]],
      ["one more", [...heldEntries, entry(79, "AAA", "2026-09-04")]],
      ["none", []],
      [
        "tombstoned",
        [heldEntries[0], entry(78, "ZZZ", "2026-09-03", { removed: true, removedAt: "2026-09-02T20:00:00.000Z" })],
      ],
    ];
    for (const [label, entries] of different) {
      const { kv, store } = makeKv();
      const legacy = JSON.stringify({ generation: 7, entries: heldEntries });
      store.set("armed-events", legacy);
      expect(
        await applyArmedEventsDelta(kv, {
          generation: 7,
          entries,
          supersededEventIds: [3],
          removedEventIds: [removed(4)],
        }),
        label,
      ).toEqual({
        applied: false,
        generation: 7,
        accepted: { supersededEventIds: 0, removedEventIds: 0 },
      });
      expect(store.get("armed-events"), label).toBe(legacy);
    }
  });

  it("a record that already has EITHER list key is never completed, identical entries or not", async () => {
    const heldEntries = [entry(77, "ACME", "2026-09-02")];
    for (const lists of [
      { supersededEventIds: [] },
      { removedEventIds: [] },
      { supersededEventIds: [], removedEventIds: [] },
    ]) {
      const { kv, store } = makeKv();
      const before = JSON.stringify({ generation: 7, entries: heldEntries, ...lists });
      store.set("armed-events", before);
      expect(
        await applyArmedEventsDelta(kv, {
          generation: 7,
          entries: heldEntries,
          supersededEventIds: [3],
          removedEventIds: [removed(4)],
        }),
      ).toEqual({
        applied: false,
        generation: 7,
        accepted: { supersededEventIds: 0, removedEventIds: 0 },
      });
      expect(store.get("armed-events")).toBe(before);
    }
  });

  it("a HIGHER generation still replaces an old-build record, entries and all", async () => {
    const { kv, store } = makeKv();
    store.set(
      "armed-events",
      JSON.stringify({ generation: 7, entries: [entry(77, "ACME", "2026-09-02")] }),
    );
    expect(
      await applyArmedEventsDelta(kv, {
        generation: 8,
        entries: [entry(99, "OTHER", "2026-09-02")],
        supersededEventIds: [3],
      }),
    ).toEqual({
      applied: true,
      generation: 8,
      accepted: { supersededEventIds: 1, removedEventIds: 0 },
    });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({
      generation: 8,
      entries: [entry(99, "OTHER", "2026-09-02")],
      supersededEventIds: [3],
      removedEventIds: [],
    });
  });

  it("the old-build completion never applies to a LOWER generation, or to a body with no ids", async () => {
    const { kv, store } = makeKv();
    const legacy = JSON.stringify({ generation: 7, entries: [] });
    store.set("armed-events", legacy);
    expect(
      await applyArmedEventsDelta(kv, { generation: 6, entries: [], supersededEventIds: [3] }),
    ).toEqual({
      applied: false,
      generation: 7,
      accepted: { supersededEventIds: 0, removedEventIds: 0 },
    });
    expect(await applyArmedEventsDelta(kv, { generation: 7, entries: [] })).toEqual({
      applied: false,
      generation: 7,
      accepted: { supersededEventIds: 0, removedEventIds: 0 },
    });
    expect(store.get("armed-events")).toBe(legacy);
  });
});

// FIX-W2 (R2): the vendor sync deletes and re-creates an unenriched earnings
// row, so a re-listed print has a NEW id while the 2am snapshot still holds the
// OLD one. Once the new row is armed the delta must not add a second live row
// for the same print.
describe("a re-listed print: one (source_key, event_date) is live at most once", () => {
  const KEY = "finnhub:HELDCO:2026-09-03";
  const row = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    source: "finnhub",
    source_key: KEY,
    event_type: "earnings",
    event_date: "2026-09-03",
    event_time: "AMC",
    title: "HELDCO earnings",
    description: null,
    security_id: null,
    symbol: "HELDCO",
    expected_impact: null,
    consensus_estimate: null,
    previous_value: null,
    raw_json: null,
    superseded: 0,
    ...over,
  });
  const relisted = (events: unknown[], over: Partial<Snapshot> = {}) =>
    snap({ calendarEvents: events as unknown as Snapshot["calendarEvents"], ...over });
  const armedNew = (over: Partial<ArmedEventEntry> = {}) =>
    entry(20, "HELDCO", "2026-09-03", { sourceKey: KEY, source: "finnhub", ...over });
  const supersededOf = (eff: ReturnType<typeof effectiveCalendarEvents>, id: number) =>
    eff.events.find((e) => e.id === id)!.superseded;

  it("the snapshot's old row is marked superseded; the delta's row stays live and armed", () => {
    const eff = effectiveCalendarEvents(relisted([row(10)]), { generation: 4, entries: [armedNew()] });
    expect(eff.events.map((e) => e.id)).toEqual([10, 20]);
    expect(supersededOf(eff, 10)).toBe(1);
    expect(supersededOf(eff, 20)).toBe(0);
    expect(eff.armedEventIds.has(20)).toBe(true);
    expect(eff.armedEventIds.has(10)).toBe(false);
  });

  it("an old row the snapshot itself had armed loses its armed mark with it", () => {
    const eff = effectiveCalendarEvents(
      relisted([row(10)], { armedEvents: [entry(10, "HELDCO", "2026-09-03", { sourceKey: KEY })] }),
      { generation: 4, entries: [armedNew()] },
    );
    expect(supersededOf(eff, 10)).toBe(1);
    expect([...eff.armedEventIds]).toEqual([20]);
  });

  it("CONTROL: a different date, or a different source_key, leaves both rows live", () => {
    const otherDate = effectiveCalendarEvents(relisted([row(10, { event_date: "2026-09-04" })]), {
      generation: 4,
      entries: [armedNew()],
    });
    expect(supersededOf(otherDate, 10)).toBe(0);
    expect(supersededOf(otherDate, 20)).toBe(0);

    const otherKey = effectiveCalendarEvents(
      relisted([row(10, { source_key: "nasdaq:HELDCO:2026-09-03" })]),
      { generation: 4, entries: [armedNew()] },
    );
    expect(supersededOf(otherKey, 10)).toBe(0);
    expect(supersededOf(otherKey, 20)).toBe(0);
  });

  it("the same symbol alone is never enough, and an empty or missing source_key never matches", () => {
    for (const blank of [null, "", undefined]) {
      const eff = effectiveCalendarEvents(relisted([row(10, { source_key: blank })]), {
        generation: 4,
        entries: [armedNew({ sourceKey: "" })],
      });
      expect(supersededOf(eff, 10)).toBe(0);
      expect(supersededOf(eff, 20)).toBe(0);
    }
  });

  it("an unarmed re-listing (no delta entry for the new row) leaves the old row live", () => {
    const eff = effectiveCalendarEvents(relisted([row(10)]), {
      generation: 4,
      entries: [entry(77, "ACME", "2026-09-03")],
    });
    expect(supersededOf(eff, 10)).toBe(0);
    expect(eff.events.some((e) => e.id === 20)).toBe(false);
  });

  it("a tombstoned new row supersedes nothing", () => {
    const eff = effectiveCalendarEvents(relisted([row(10)]), {
      generation: 4,
      entries: [armedNew({ removed: true, removedAt: "2026-09-02T20:00:00.000Z" })],
    });
    expect(supersededOf(eff, 10)).toBe(0);
    expect(eff.events.some((e) => e.id === 20)).toBe(false);
  });

  it("a new row the delta itself lists as replaced supersedes nothing (never silence both)", () => {
    const eff = effectiveCalendarEvents(relisted([row(10)]), {
      generation: 4,
      entries: [armedNew()],
      supersededEventIds: [20],
    });
    expect(supersededOf(eff, 10)).toBe(0);
    expect(supersededOf(eff, 20)).toBe(1);
  });

  it("two rows that are BOTH live delta entries are left alone", () => {
    const eff = effectiveCalendarEvents(relisted([row(10)]), {
      generation: 4,
      entries: [entry(10, "HELDCO", "2026-09-03", { sourceKey: KEY, source: "finnhub" }), armedNew()],
    });
    expect(supersededOf(eff, 10)).toBe(0);
    expect(supersededOf(eff, 20)).toBe(0);
  });

  it("the older-generation and degraded paths are unchanged", () => {
    const stale = effectiveCalendarEvents(relisted([row(10)]), { generation: 3, entries: [armedNew()] });
    expect(stale.source).toBe("snapshot");
    expect(supersededOf(stale, 10)).toBe(0);
    expect(stale.events.some((e) => e.id === 20)).toBe(false);

    const degraded = effectiveCalendarEvents(
      relisted([row(10)], { schemaVersion: 10, armedGeneration: undefined } as Partial<Snapshot>),
      { generation: 9, entries: [armedNew()] },
    );
    expect(degraded.source).toBe("degraded-v10");
    expect(supersededOf(degraded, 10)).toBe(0);
  });

  it("a snapshot's own armed list never triggers it — only a newer delta does", () => {
    const eff = effectiveCalendarEvents(relisted([row(10)], { armedEvents: [armedNew()] }), null);
    expect(supersededOf(eff, 10)).toBe(0);
    expect(supersededOf(eff, 20)).toBe(0);
  });
});
