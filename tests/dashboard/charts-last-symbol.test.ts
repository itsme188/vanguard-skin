/**
 * app/dashboard/charts/last-symbol.ts — pure localStorage helpers for the
 * charts-landing "last-viewed symbol" default (ruling step 2). No jsdom/RTL
 * in this repo, so this exercises the accessors directly against a fake
 * Storage object, same shape as tests/dashboard/hub-live-expansion.test.ts'
 * manual-toggle coverage.
 */
import { describe, it, expect } from "vitest";
import {
  readLastChartSymbolId,
  writeLastChartSymbolId,
  LAST_CHART_SYMBOL_KEY,
} from "@/app/dashboard/charts/last-symbol";

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

describe("readLastChartSymbolId / writeLastChartSymbolId", () => {
  it("round-trips a symbol id under vgs:charts:lastSymbolId", () => {
    const s = fakeStorage();
    expect(readLastChartSymbolId(s)).toBeNull();
    writeLastChartSymbolId(42, s);
    expect(s.map.get(LAST_CHART_SYMBOL_KEY)).toBe("42");
    expect(readLastChartSymbolId(s)).toBe(42);
  });

  it("overwrites a previously stored id on re-write", () => {
    const s = fakeStorage();
    writeLastChartSymbolId(1, s);
    writeLastChartSymbolId(2, s);
    expect(readLastChartSymbolId(s)).toBe(2);
  });

  it("missing key reads as null", () => {
    expect(readLastChartSymbolId(fakeStorage())).toBeNull();
  });

  it("garbage stored values read as null (never NaN, never 0, never negative)", () => {
    expect(
      readLastChartSymbolId(fakeStorage({ [LAST_CHART_SYMBOL_KEY]: "not-a-number" })),
    ).toBeNull();
    expect(
      readLastChartSymbolId(fakeStorage({ [LAST_CHART_SYMBOL_KEY]: "" })),
    ).toBeNull();
    expect(
      readLastChartSymbolId(fakeStorage({ [LAST_CHART_SYMBOL_KEY]: "0" })),
    ).toBeNull();
    expect(
      readLastChartSymbolId(fakeStorage({ [LAST_CHART_SYMBOL_KEY]: "-5" })),
    ).toBeNull();
    expect(
      readLastChartSymbolId(fakeStorage({ [LAST_CHART_SYMBOL_KEY]: "3.5" })),
    ).toBeNull();
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
    expect(readLastChartSymbolId(throwing)).toBeNull();
    expect(() => writeLastChartSymbolId(7, throwing)).not.toThrow();
  });
});
