/**
 * Worker↔Mac parity for the EOD earnings-wrap deadlines + slot classifier
 * (#17 final-review, T5 minor fix). `lib/earnings/wrap.ts` is the Mac
 * source; `workers/cron/src/fallback-earnings.ts` carries a hand-mirrored
 * copy (`SLOT_DEADLINES_ET` + `wrapSlotForCloud`) — same constraint as
 * every other Worker mirror (issuer-family, plausibility, editions,
 * presence-position): the Worker bundle can't cross the Next.js
 * path-alias boundary at RUNTIME, so the two implementations are separate
 * hand copies that can silently drift apart.
 *
 * Unlike the zero-import mirrors (plausibility.ts, issuer-family.ts),
 * lib/earnings/wrap.ts pulls in `@/lib/calendar/date-utils`,
 * `@/lib/queries/calendar`, `@/lib/queries/briefing-symbols`,
 * `@/lib/queries/earnings-settings`, and `@/lib/securities/issuer-family` —
 * all either zero-import themselves or `import type Database from
 * "better-sqlite3"` (type-only, erased at build), so importing the Mac
 * module directly is safe at TEST time. It just needs the same "@/*" alias
 * tsconfig.json defines for the Next.js app; vitest.config.ts adds that
 * alias scoped to this test run only — the Worker's own bundle never uses
 * "@/" imports, so production behavior is unaffected.
 *
 * Two things are pinned: the deadline constants (byte-identical objects),
 * and the slot classifier's behavior across a representative case matrix
 * (event_time marker variants including the Bank-of-Montreal ticker
 * collision, title-phrase detection, and release_time fallback) — both
 * sides must return the SAME slot for every case, not just look similar.
 */

import { describe, it, expect } from "vitest";
import { SLOT_DEADLINES_ET as MAC_SLOT_DEADLINES_ET, wrapSlotFor } from "../../../lib/earnings/wrap";
import {
  SLOT_DEADLINES_ET as CLOUD_SLOT_DEADLINES_ET,
  wrapSlotForCloud,
} from "../src/fallback-earnings";

describe("EOD wrap parity (Worker mirror of lib/earnings/wrap.ts)", () => {
  it("SLOT_DEADLINES_ET is identical on both sides", () => {
    expect(CLOUD_SLOT_DEADLINES_ET).toEqual(MAC_SLOT_DEADLINES_ET);
  });

  // Representative case matrix. Mirrors tests/earnings/wrap.test.ts's
  // wrapSlotFor pins plus the extra event_time marker variants (lowercase,
  // whitespace-padded, whitespace-only, empty) the final review asked to
  // check on both sides.
  const CASES: Array<{
    label: string;
    event_time: string | null;
    title: string | null;
    release_time: string | null;
    expected: "BMO" | "AMC" | null;
  }> = [
    {
      label: "event_time lowercase 'bmo'",
      event_time: "bmo",
      title: null,
      release_time: null,
      expected: "BMO",
    },
    {
      label: "event_time uppercase 'AMC'",
      event_time: "AMC",
      title: null,
      release_time: null,
      expected: "AMC",
    },
    {
      label: "event_time whitespace-padded '  AMC  ' trims to AMC",
      event_time: "  AMC  ",
      title: null,
      release_time: null,
      expected: "AMC",
    },
    {
      label: "event_time whitespace-padded '  bmo  ' trims to BMO",
      event_time: "  bmo  ",
      title: null,
      release_time: null,
      expected: "BMO",
    },
    {
      label: "event_time whitespace-only falls through (no title/release_time) — TBD",
      event_time: "   ",
      title: null,
      release_time: null,
      expected: null,
    },
    {
      label: "event_time empty string falls through to release_time",
      event_time: "",
      title: null,
      release_time: "16:15",
      expected: "AMC",
    },
    {
      label: "event_time null, title phrase 'After Market Close'",
      event_time: null,
      title: "X earnings (After Market Close)",
      release_time: null,
      expected: "AMC",
    },
    {
      label: "Bank-of-Montreal ticker collision — title phrase wins over bare 'BMO' substring",
      event_time: null,
      title: "BMO earnings (After Market Close)",
      release_time: null,
      expected: "AMC",
    },
    {
      label: "plain title (no phrase), release_time 08:00 falls back to BMO",
      event_time: null,
      title: "AAPL earnings",
      release_time: "08:00",
      expected: "BMO",
    },
    {
      label: "plain title (no phrase), release_time 16:15 falls back to AMC",
      event_time: null,
      title: "AAPL earnings",
      release_time: "16:15",
      expected: "AMC",
    },
    {
      label: "no event_time/title, release_time 08:00 -> BMO",
      event_time: null,
      title: null,
      release_time: "08:00",
      expected: "BMO",
    },
    {
      label: "no event_time/title, release_time 16:15 -> AMC",
      event_time: null,
      title: null,
      release_time: "16:15",
      expected: "AMC",
    },
    {
      label: "all null -> TBD, never clusters",
      event_time: null,
      title: null,
      release_time: null,
      expected: null,
    },
  ];

  it.each(CASES)("$label", ({ event_time, title, release_time, expected }) => {
    // Mac and Worker both use the "BMO" | "AMC" | null representation
    // directly — no normalization needed between the two return shapes.
    expect(wrapSlotFor({ event_time, title, release_time })).toBe(expected);
    expect(wrapSlotForCloud({ event_time, title, release_time })).toBe(expected);
  });
});
