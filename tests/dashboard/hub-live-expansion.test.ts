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
import fs from "node:fs";
import type { PrintWatchState } from "@/lib/print-watch/types";
import type {
  CockpitIntelWire,
  CockpitPayloadWire,
  CockpitRowWire,
  PrintWatchStateWire,
} from "@/app/dashboard/today/hub-live/types";
// Type-only, so it is erased before vitest ever loads a module: no db, no
// server stack. The client-boundary guard scans app/dashboard/today/**, not
// tests/**, and a test is not bundled for the browser either way.
import type {
  CockpitIntel,
  CockpitPayload,
  CockpitRow,
} from "@/lib/queries/earnings-cockpit";

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

/** Top-level field names of `export interface <name>` in a TS source file.
 *  Brace-depth aware, so `lanes: { bmo: … }` contributes `lanes` and nothing
 *  else, and comment lines contribute nothing. */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found — the mirror has nothing to pin against`);
  const lines = source.slice(start).split("\n");
  const fields: string[] = [];
  let depth = 0;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const isComment = line.startsWith("*") || line.startsWith("/*") || line.startsWith("//");
    if (i > 0 && depth === 1 && !isComment) {
      const m = line.match(/^([A-Za-z_$][\w$]*)\??\s*:/);
      if (m) fields.push(m[1]);
    }
    if (!isComment) depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
    if (i > 0 && depth === 0) break;
  }
  return fields.sort();
}

describe("the wire mirrors track the server shapes", () => {
  it("the state union is assignable both ways", () => {
    // NOTE: the `expect` below is a tautology. The real assertion is the two
    // casts, and ONLY `tsc --noEmit` / `next build` evaluates them — vitest
    // strips types with esbuild and never typechecks. A green vitest run is
    // therefore NOT evidence that the unions are in step; the wave's tsc gate
    // is. The key-set test underneath is the half that has teeth here.
    const toWire: PrintWatchStateWire = "window_open" as PrintWatchState;
    const toServer: PrintWatchState = "window_open" as PrintWatchStateWire;
    expect([toWire, toServer]).toEqual(["window_open", "window_open"]);
  });

  it("the three cockpit mirrors are assignable both ways (tsc-only, like the union above)", () => {
    const rowOut: CockpitRowWire = null as unknown as CockpitRow;
    const rowIn: CockpitRow = null as unknown as CockpitRowWire;
    const payOut: CockpitPayloadWire = null as unknown as CockpitPayload;
    const payIn: CockpitPayload = null as unknown as CockpitPayloadWire;
    const intelOut: CockpitIntelWire = null as unknown as CockpitIntel;
    const intelIn: CockpitIntel = null as unknown as CockpitIntelWire;
    expect([rowOut, rowIn, payOut, payIn, intelOut, intelIn]).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  it("carries the SAME field set as the server types — a widening there fails HERE, under vitest", () => {
    // Drift in these three is silent at runtime: a hand copy that is missing a
    // field still typechecks in every consumer that does not read the field,
    // and the desk sees `undefined` at 16:05. `rowsByEvent` (M-F5) is exactly
    // how that happens — it was added to CockpitPayload this same wave.
    const server = fs.readFileSync("lib/queries/earnings-cockpit.ts", "utf8");
    const wire = fs.readFileSync("app/dashboard/today/hub-live/types.ts", "utf8");
    for (const [serverName, wireName] of [
      ["CockpitIntel", "CockpitIntelWire"],
      ["CockpitRow", "CockpitRowWire"],
      ["CockpitPayload", "CockpitPayloadWire"],
    ] as const) {
      expect(interfaceFields(wire, wireName), `${wireName} has drifted from ${serverName}`).toEqual(
        interfaceFields(server, serverName),
      );
    }
  });

  it("the field reader is brace-depth aware, so a nested object type is ONE field", () => {
    const src = [
      "export interface X {",
      "  /** doc: not a field */",
      "  a: string;",
      "  lanes: { bmo: number[]; amc: number[] };",
      "  nested: {",
      "    inner: string;",
      "  };",
      "  b?: number | null;",
      "}",
      "export interface Y { z: string }",
    ].join("\n");
    expect(interfaceFields(src, "X")).toEqual(["a", "b", "lanes", "nested"]);
    expect(() => interfaceFields(src, "Nope")).toThrow(/not found/);
  });
});
