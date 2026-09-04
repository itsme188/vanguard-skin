/**
 * The expansion state machine (slice F, Task 6; spec §4.6, M-F6).
 *
 * `deriveExpansion` answers "did something just happen that should open this
 * row?"; `nextOpenState` answers "so is it open?". Both are pure, which is what
 * makes the date-correction case testable at all — this repo has no jsdom and
 * no React Testing Library, and none may be added, so these reducers ARE the
 * proof for wiring that has no mounted test.
 */
import { describe, it, expect } from "vitest";
import {
  deriveExpansion,
  nextOpenState,
  snapshotOf,
  readManual,
  writeManual,
  EXPANDED_KEY_PREFIX,
  type ExpansionSnapshot,
} from "@/app/dashboard/today/hub-live/expansion";
import type { PrintWatchState } from "@/lib/print-watch/types";
import type { PrintWatchStateWire } from "@/app/dashboard/today/hub-live/types";

const snap = (o: Partial<ExpansionSnapshot> = {}): ExpansionSnapshot => ({
  printId: 1,
  state: "scheduled",
  forcedOpenAt: null,
  goRequestId: null,
  ...o,
});

describe("deriveExpansion — the transition matrix (spec §4.6 'Auto-expansion is transition-based')", () => {
  const STATES = ["scheduled", "window_open", "acquired", "parsed", "expired", "disarmed"] as const;

  it("opens on ENTERING window_open or acquired, from any other state", () => {
    for (const from of STATES) {
      for (const to of ["window_open", "acquired"] as const) {
        const expected = from !== to; // entering, not sitting in
        expect(deriveExpansion(snap({ state: from }), snap({ state: to }), null)).toBe(expected);
      }
    }
  });

  it("never opens on entering parsed, expired, disarmed or scheduled", () => {
    for (const from of STATES) {
      for (const to of ["parsed", "expired", "disarmed", "scheduled"] as const) {
        expect(deriveExpansion(snap({ state: from }), snap({ state: to }), null)).toBe(false);
      }
    }
  });

  it("does NOT auto-open on FIRST load, whatever the state — including parsed", () => {
    for (const to of STATES) {
      expect(deriveExpansion(null, snap({ state: to }), null)).toBe(false);
    }
  });

  it("opens when forcedOpenAt is newly set (the go press), and not when it merely persists", () => {
    expect(deriveExpansion(snap(), snap({ forcedOpenAt: "2026-09-10T20:05:00.000Z" }), null)).toBe(true);
    expect(
      deriveExpansion(
        snap({ forcedOpenAt: "2026-09-10T20:05:00.000Z" }),
        snap({ forcedOpenAt: "2026-09-10T20:05:00.000Z" }),
        null,
      ),
    ).toBe(false);
  });

  it("opens when a NEW go request id appears, and not when the same one is still running", () => {
    expect(deriveExpansion(snap(), snap({ goRequestId: 7 }), null)).toBe(true);
    expect(deriveExpansion(snap({ goRequestId: 7 }), snap({ goRequestId: 7 }), null)).toBe(false);
    expect(deriveExpansion(snap({ goRequestId: 7 }), snap({ goRequestId: 8 }), null)).toBe(true);
  });

  it("a manual toggle for THIS print overrides every transition, in both directions", () => {
    const opening = { prev: snap(), next: snap({ state: "window_open" }) };
    expect(deriveExpansion(opening.prev, opening.next, { printId: 1, open: false })).toBe(false);
    expect(
      deriveExpansion(snap({ state: "parsed" }), snap({ state: "parsed" }), { printId: 1, open: true }),
    ).toBe(true);
  });

  it("a manual toggle for a DIFFERENT print is ignored (the correction case)", () => {
    expect(deriveExpansion(snap(), snap({ state: "acquired" }), { printId: 99, open: false })).toBe(true);
  });

  it("a print id CHANGE (a date correction re-homed the print) is treated as a first load, not a transition", () => {
    // The old print's snapshot must never decide the new print's expansion.
    expect(
      deriveExpansion(snap({ printId: 1, state: "scheduled" }), snap({ printId: 2, state: "window_open" }), null),
    ).toBe(false);
    // ...and a manual override keyed to the OLD print does not follow it.
    expect(
      deriveExpansion(snap({ printId: 1 }), snap({ printId: 2, state: "acquired" }), { printId: 1, open: true }),
    ).toBe(false);
  });
});

describe("nextOpenState — the correction case the effect used to get wrong (Codex 8 / F-S1)", () => {
  it("closes an open row when the print id changes, even into an opening state", () => {
    const next = snap({ printId: 2, state: "window_open" });
    const decided = deriveExpansion(snap({ printId: 1, state: "scheduled" }), next, null);
    expect(decided).toBe(false); // different subject
    expect(nextOpenState({ was: true, decided, prevPrintId: 1, next, manual: null })).toBe(false);
  });
  it("then opens the NEW print on its own next transition", () => {
    const next = snap({ printId: 2, state: "acquired" });
    const decided = deriveExpansion(snap({ printId: 2, state: "window_open" }), next, null);
    expect(decided).toBe(true);
    expect(nextOpenState({ was: false, decided, prevPrintId: 2, next, manual: null })).toBe(true);
  });
  it("keeps an open row open across an uneventful poll of the SAME print", () => {
    const next = snap({ printId: 1, state: "acquired" });
    expect(nextOpenState({ was: true, decided: false, prevPrintId: 1, next, manual: null })).toBe(true);
  });
  it("lets a manual choice for THIS print win in both directions, and ignores one for another print", () => {
    const next = snap({ printId: 2, state: "acquired" });
    expect(
      nextOpenState({ was: true, decided: true, prevPrintId: 2, next, manual: { printId: 2, open: false } }),
    ).toBe(false);
    expect(
      nextOpenState({ was: false, decided: false, prevPrintId: 2, next, manual: { printId: 2, open: true } }),
    ).toBe(true);
    expect(
      nextOpenState({ was: true, decided: false, prevPrintId: 1, next, manual: { printId: 1, open: true } }),
    ).toBe(false);
  });
  it("a first sight (prevPrintId null) opens only on a fresh decision, which a first load never is", () => {
    const next = snap({ printId: 5, state: "window_open" });
    expect(deriveExpansion(null, next, null)).toBe(false);
    expect(nextOpenState({ was: false, decided: false, prevPrintId: null, next, manual: null })).toBe(false);
  });
});

describe("snapshotOf", () => {
  it("normalises the optional wire fields to null", () => {
    expect(snapshotOf({ printId: 3, state: "parsed" })).toEqual({
      printId: 3,
      state: "parsed",
      forcedOpenAt: null,
      goRequestId: null,
    });
    expect(snapshotOf({ printId: 3, state: "parsed", forcedOpenAt: "t", goRequest: { id: 9 } })).toEqual({
      printId: 3,
      state: "parsed",
      forcedOpenAt: "t",
      goRequestId: 9,
    });
  });
});

describe("manual toggle persistence", () => {
  function fakeStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      map,
    };
  }
  it("round-trips per print under vgs:print-expanded:<printId>", () => {
    const s = fakeStorage();
    expect(readManual(4, s)).toBeNull();
    writeManual(4, true, s);
    expect(s.map.get(`${EXPANDED_KEY_PREFIX}4`)).toBe("1");
    expect(readManual(4, s)).toBe(true);
    writeManual(4, false, s);
    expect(readManual(4, s)).toBe(false);
    expect(readManual(5, s)).toBeNull();
  });
  it("survives a storage that throws (private window, blocked site data)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readManual(4, throwing)).toBeNull();
    expect(() => writeManual(4, true, throwing)).not.toThrow();
  });
  it("treats an unrecognised stored value as no preference", () => {
    expect(readManual(4, fakeStorage({ [`${EXPANDED_KEY_PREFIX}4`]: "yes" }))).toBeNull();
  });
});

describe("the wire state union tracks the server union", () => {
  it("is assignable both ways (a server-side addition fails to compile here)", () => {
    const toWire: PrintWatchStateWire = "window_open" as PrintWatchState;
    const toServer: PrintWatchState = "window_open" as PrintWatchStateWire;
    expect([toWire, toServer]).toEqual(["window_open", "window_open"]);
  });
});
