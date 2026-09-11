/**
 * Worker↔Mac parity for the reaction-leg usability predicate.
 *
 * `workers/cron/src/reaction-leg.ts::isUsableReactionLeg` is a hand-copied
 * twin of `lib/calendar/reaction-snapshot-core.ts::isUsableReactionLeg` —
 * the Worker bundle can't cross the Next.js path-alias boundary at RUNTIME,
 * the same constraint every other Worker mirror lives under
 * (plausibility, issuer-family, editions, presence-position, wrap).
 * It shipped WITHOUT a parity pin.
 *
 * What a drift here would do: the predicate is the only thing standing
 * between a stored `{t_pre: 0, t_post: 0, delta_pct: 0}` sentinel and a
 * sent email that says "QQQ @ T+2h | +0.00%" as if the market had been flat
 * (the real 2026-09 incident). The Mac and the Worker each send earnings
 * recaps — the Worker on the fallback road, when the Mac is unreachable —
 * so a one-sided revert means the SAME snapshot renders honestly on one
 * road and fabricates a flat move on the other, with no local test failing.
 *
 * A byte-strip comparison (the plausibility.ts pattern) does not apply: the
 * two implementations differ in their parameter types on purpose (the Mac
 * narrows a `BenchmarkReaction`, the Worker takes an all-optional shape
 * because its callers hold looser JSON), so the pin is a BEHAVIOR TABLE run
 * against both. Importing the Mac module directly is safe at test time: it
 * is a documented zero-runtime-import leaf, and vitest.config.ts maps "@/"
 * for exactly this (see wrap-parity.test.ts's note).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isUsableReactionLeg as macIsUsableReactionLeg } from "@/lib/calendar/reaction-snapshot-core";
import { isUsableReactionLeg as workerIsUsableReactionLeg } from "../src/reaction-leg";

/** One row per input shape, with the answer BOTH sides must give. */
const CASES: Array<{
  name: string;
  leg: { t_pre?: number; t_post?: number; delta_pct?: number } | null | undefined;
  usable: boolean;
}> = [
  // The sentinel class this predicate exists to reject.
  { name: "0/0 dead quote (the 2026-09 incident)", leg: { t_pre: 0, t_post: 0, delta_pct: 0 }, usable: false },
  { name: "zero t_pre only", leg: { t_pre: 0, t_post: 100, delta_pct: 0 }, usable: false },
  { name: "zero t_post only", leg: { t_pre: 100, t_post: 0, delta_pct: -100 }, usable: false },

  // Negative prices are never real.
  { name: "negative t_pre", leg: { t_pre: -1, t_post: 100, delta_pct: 1 }, usable: false },
  { name: "negative t_post", leg: { t_pre: 100, t_post: -1, delta_pct: 1 }, usable: false },
  { name: "both negative", leg: { t_pre: -100, t_post: -101, delta_pct: 1 }, usable: false },

  // Non-finite on any leg.
  { name: "NaN t_pre", leg: { t_pre: NaN, t_post: 100, delta_pct: 1 }, usable: false },
  { name: "NaN t_post", leg: { t_pre: 100, t_post: NaN, delta_pct: 1 }, usable: false },
  { name: "NaN delta_pct", leg: { t_pre: 100, t_post: 101, delta_pct: NaN }, usable: false },
  { name: "Infinity t_post", leg: { t_pre: 100, t_post: Infinity, delta_pct: 1 }, usable: false },
  { name: "-Infinity t_pre", leg: { t_pre: -Infinity, t_post: 100, delta_pct: 1 }, usable: false },
  { name: "Infinity delta_pct (divide by a zero t_pre)", leg: { t_pre: 100, t_post: 101, delta_pct: Infinity }, usable: false },

  // Absent legs.
  { name: "null", leg: null, usable: false },
  { name: "undefined", leg: undefined, usable: false },
  { name: "empty object (every field missing)", leg: {}, usable: false },
  { name: "delta_pct missing", leg: { t_pre: 100, t_post: 101 }, usable: false },

  // Real legs.
  { name: "a real up move", leg: { t_pre: 500, t_post: 512.5, delta_pct: 2.5 }, usable: true },
  { name: "a real down move", leg: { t_pre: 500, t_post: 499.9, delta_pct: -0.02 }, usable: true },
  {
    name: "a genuinely flat move (real prices, delta 0) — deliberately NOT rejected",
    leg: { t_pre: 100, t_post: 100, delta_pct: 0 },
    usable: true,
  },
  { name: "a sub-dollar price", leg: { t_pre: 0.42, t_post: 0.5, delta_pct: 19.05 }, usable: true },
];

describe("reaction-leg parity (Worker mirror of lib/calendar/reaction-snapshot-core.ts)", () => {
  it.each(CASES)("both sides agree on $name", ({ leg, usable }) => {
    expect(macIsUsableReactionLeg(leg as never)).toBe(usable);
    expect(workerIsUsableReactionLeg(leg)).toBe(usable);
  });

  it("agrees across the whole table with no per-case exception", () => {
    for (const { name, leg } of CASES) {
      expect(
        [name, workerIsUsableReactionLeg(leg)],
        `divergence on: ${name}`,
      ).toEqual([name, macIsUsableReactionLeg(leg as never)]);
    }
  });

  it("the Worker file still points at the Mac source it mirrors", () => {
    // Cheap drift alarm: if the header stops naming the Mac module, the next
    // reader has no way to know a twin exists.
    const wkr = readFileSync(new URL("../src/reaction-leg.ts", import.meta.url), "utf8");
    expect(wkr).toContain("lib/calendar/reaction-snapshot-core.ts::isUsableReactionLeg");
  });

  it("the Mac source names every hand copy, including this one's module", () => {
    const mac = readFileSync(
      new URL("../../../lib/calendar/reaction-snapshot-core.ts", import.meta.url),
      "utf8",
    );
    for (const copy of [
      "workers/cron/src/reaction-leg.ts",
      "lib/alerts/print-push-message.ts",
      "workers/cron/src/print-push-message.ts",
    ]) {
      expect(mac).toContain(copy);
    }
  });
});
