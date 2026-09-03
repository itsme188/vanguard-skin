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
  ARMED_EVENTS_MAX_ENTRIES,
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
    });
    expect(await applyArmedEventsDelta(kv, { generation: 2, entries: [] })).toEqual({
      applied: false,
      generation: 2,
    });
    expect(await applyArmedEventsDelta(kv, { generation: 1, entries: [] })).toEqual({
      applied: false,
      generation: 2,
    });
    expect(
      await applyArmedEventsDelta(kv, {
        generation: 5,
        entries: [entry(77, "ACME", "2026-09-02")],
      }),
    ).toEqual({ applied: true, generation: 5 });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({
      generation: 5,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
    await expect(applyArmedEventsDelta(kv, { generation: "x" })).rejects.toThrow(/generation/);
    expect(await readArmedEventsDelta(kv)).toEqual({
      generation: 5,
      entries: [entry(77, "ACME", "2026-09-02")],
    });
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
