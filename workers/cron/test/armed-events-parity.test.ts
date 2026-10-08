/**
 * Parity pin for the armed-events data-flow contract (live print v2 slice A,
 * global constraint: "the projection shape … changes on both sides in the same
 * task, with a parity test").
 *
 * Why this needs a test rather than the type system: `parseEntry` in
 * workers/cron/src/armed-events.ts drops unlisted keys BY DESIGN ([C-19]), so a
 * field added to the Mac's ArmedEventProjection would be silently discarded at
 * the Worker's door — the Mac suite green, the Worker suite green, and the new
 * field simply absent in the cloud.
 *
 * The Worker can't import the Mac module (it pulls better-sqlite3 and the "@/"
 * path alias, which don't exist inside the Worker's vitest project), so the Mac
 * key list is read out of the source text — the issuer-family-parity.test.ts
 * pattern. Everything else compares real exported constants and real parser
 * output, not regex-scraped literals.
 *
 * Three links, so a drift anywhere fails:
 *   Mac ARMED_EVENT_PROJECTION_KEYS
 *     == Worker ARMED_EVENT_ENTRY_KEYS      (the parser's allowlist)
 *     == Worker ArmedEventEntry interface   (the type consumers read)
 *     == parseEntry's actual output keys    (what really survives a POST)
 *
 * A fourth link closes the gap the first three leave: `parseEntry` is DRIVEN by
 * `ARMED_EVENT_ENTRY_FIELDS` (one rule per key) and walks
 * `ARMED_EVENT_ENTRY_KEYS`, and the round-trip fixture below is generated from
 * the same two constants. A key added to every declared list therefore either
 * has a rule (and round-trips) or fails here — it can no longer be listed and
 * silently left out of the parser body.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ARMED_EVENT_ENTRY_FIELDS,
  ARMED_EVENT_ENTRY_KEYS,
  ARMED_EVENTS_MAX_REMOVED_IDS,
  ARMED_EVENTS_MAX_SUPERSEDED_IDS,
  applyArmedEventsDelta,
  readArmedEventsDelta,
} from "../src/armed-events";
import type { ArmedEventEntry } from "../src/state";

/** Evaluate a `[...] as const` array literal out of TypeScript source. */
function extractKeyList(source: string, marker: RegExp, what: string): string[] {
  const match = source.match(marker);
  if (!match) throw new Error(`armed-events-parity: could not locate ${what}`);
  return new Function(`"use strict"; return (${match[1]});`)() as string[];
}

/** Field names declared by a TS interface, in declaration order. */
function extractInterfaceFields(source: string, name: string): string[] {
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!match) throw new Error(`armed-events-parity: could not locate interface ${name}`);
  return [...match[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

const macSource = readFileSync(
  new URL("../../../lib/earnings/armed-events-projection.ts", import.meta.url),
  "utf8",
);
const workerStateSource = readFileSync(new URL("../src/state.ts", import.meta.url), "utf8");

const macKeys = extractKeyList(
  macSource,
  /export const ARMED_EVENT_PROJECTION_KEYS = (\[[\s\S]*?\n\]) as const;/,
  "the Mac's ARMED_EVENT_PROJECTION_KEYS",
);
const macLookback = Number(
  /export const LIVE_LOOKBACK_DAYS = (\d+);/.exec(macSource)?.[1] ?? Number.NaN,
);
const macIdListCap = Number(
  /export const ARMED_EVENTS_MAX_ID_LIST = (\d+);/.exec(macSource)?.[1] ?? Number.NaN,
);

/**
 * One value per allowlisted key that its parse rule keeps VERBATIM, so a
 * round-trip can be asserted with `toEqual`. Derived from the constants — there
 * is deliberately no hand-written field list here to forget a key in.
 */
function sampleValue(key: string, index: number): unknown {
  const rule = (ARMED_EVENT_ENTRY_FIELDS as Record<string, { kind: string; max?: number; upper?: boolean }>)[
    key
  ];
  if (!rule) throw new Error(`armed-events-parity: no parse rule for key "${key}"`);
  switch (rule.kind) {
    case "required-int":
      return 70 + index;
    case "nullable-number":
      return index + 0.25;
    case "tombstone-flag":
      return true;
    case "required-string":
    case "nullable-string":
    case "tombstone-string": {
      const text = `${key}-${index}`.slice(0, rule.max ?? 200);
      return rule.upper ? text.toUpperCase() : text;
    }
    default:
      throw new Error(`armed-events-parity: unknown rule kind "${rule.kind}" for "${key}"`);
  }
}

function maximalEntry(): ArmedEventEntry {
  return Object.fromEntries(
    ARMED_EVENT_ENTRY_KEYS.map((key, i) => [key, sampleValue(key, i)]),
  ) as unknown as ArmedEventEntry;
}

describe("armed-events projection parity (Mac ↔ Worker)", () => {
  it("every allowlisted key has exactly one parse rule, and no rule is unlisted", () => {
    expect(Object.keys(ARMED_EVENT_ENTRY_FIELDS).sort()).toEqual([...ARMED_EVENT_ENTRY_KEYS].sort());
  });

  it("the parser reads its field list from the constant, not a hand-written body", () => {
    // Source pin: the body must walk the pinned key list. A hand-listed
    // `eventTime: str("eventTime")` literal is the regression this catches.
    const src = readFileSync(new URL("../src/armed-events.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function parseEntry("));
    const parser = body.slice(0, body.indexOf("\n}\n"));
    expect(parser).toMatch(/for \(const key of ARMED_EVENT_ENTRY_KEYS\)/);
    for (const key of ARMED_EVENT_ENTRY_KEYS) {
      expect(parser, `parseEntry hand-lists "${key}"`).not.toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it("the Mac key list is non-trivial and includes the tombstone fields", () => {
    // Guards the extraction itself: a regex that silently matched an empty
    // array would make every assertion below vacuously true.
    expect(macKeys.length).toBeGreaterThanOrEqual(13);
    expect(macKeys).toContain("removed");
    expect(macKeys).toContain("removedAt");
    expect(macKeys).toContain("epsConsensusVendor");
  });

  it("the Worker parser's allowlist equals the Mac's projection key set", () => {
    expect([...ARMED_EVENT_ENTRY_KEYS].sort()).toEqual([...macKeys].sort());
  });

  it("pins the top-level removed/superseded id fields, shared cap, and 14-day lookback", async () => {
    expect(macSource).toContain("supersededEventIds");
    expect(macSource).toContain("removedEventIds");
    expect(macLookback).toBe(14);
    expect(macIdListCap).toBe(2000);
    expect(ARMED_EVENTS_MAX_SUPERSEDED_IDS).toBe(2000);
    expect(ARMED_EVENTS_MAX_REMOVED_IDS).toBe(macIdListCap);

    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      delete: vi.fn(),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace;

    const macPayloadFixture = {
      generation: 1,
      entries: [],
      supersededEventIds: [42, 7, 42],
      removedEventIds: [
        { id: 9, eventDate: "2026-09-02", removedAt: "2026-09-02T20:00:00.000Z" },
        { id: 9, eventDate: "2026-09-02", removedAt: "2026-09-02T20:00:00.000Z" },
      ],
    };
    await applyArmedEventsDelta(kv, macPayloadFixture);
    expect((await readArmedEventsDelta(kv))!.supersededEventIds).toEqual([7, 42]);
    expect((await readArmedEventsDelta(kv))!.removedEventIds).toEqual([
      { id: 9, eventDate: "2026-09-02", removedAt: "2026-09-02T20:00:00.000Z" },
    ]);
  });

  it("the Worker's ArmedEventEntry interface declares exactly those fields", () => {
    expect(extractInterfaceFields(workerStateSource, "ArmedEventEntry").sort()).toEqual(
      [...macKeys].sort(),
    );
  });

  it("parseEntry actually preserves every allowlisted field end to end", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      delete: vi.fn(),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace;

    // A maximal entry GENERATED from the pinned key list: every allowlisted
    // field populated (tombstone pair included) with a value its rule keeps.
    const maximal = maximalEntry();
    expect(Object.keys(maximal).sort()).toEqual([...ARMED_EVENT_ENTRY_KEYS].sort());

    await applyArmedEventsDelta(kv, { generation: 1, entries: [maximal] });
    const stored = await readArmedEventsDelta(kv);

    // Round-trips whole — no allowlisted field is lost at the Worker's door.
    expect(stored!.entries[0]).toEqual(maximal);
    expect(Object.keys(stored!.entries[0]).sort()).toEqual([...macKeys].sort());
  });
});
