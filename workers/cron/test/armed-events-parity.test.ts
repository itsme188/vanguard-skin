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
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ARMED_EVENT_ENTRY_KEYS,
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

describe("armed-events projection parity (Mac ↔ Worker)", () => {
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

    // A maximal entry: every field populated, including the tombstone pair.
    const maximal: ArmedEventEntry = {
      eventId: 77,
      symbol: "ACME",
      eventDate: "2026-09-02",
      eventTime: "AMC",
      releaseTime: "16:15",
      sourceKey: "manual:ACME:2026-09-02:earnings",
      source: "manual",
      consensusValue: "EPS 1.20",
      expectedImpact: "high",
      securityId: 42,
      epsConsensusVendor: 1.18,
      removed: true,
      removedAt: "2026-09-02T20:00:00.000Z",
    };

    await applyArmedEventsDelta(kv, { generation: 1, entries: [maximal] });
    const stored = await readArmedEventsDelta(kv);

    // Round-trips whole — no allowlisted field is lost at the Worker's door.
    expect(stored!.entries[0]).toEqual(maximal);
    expect(Object.keys(stored!.entries[0]).sort()).toEqual([...macKeys].sort());
  });
});
