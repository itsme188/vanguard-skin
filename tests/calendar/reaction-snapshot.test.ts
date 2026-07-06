/**
 * Unit tests for lib/calendar/reaction-snapshot.ts
 *
 * Focus on the pure bar-matcher + DST-aware release_instant composer.
 * TWS fetch is exercised via a mocked IBApiNext shim.
 */

import { describe, it, expect } from "vitest";
import type { IBApiNext } from "@stoqey/ib";
import {
  findNearestBar,
  matchBarsToReaction,
  composeReleaseInstant,
  resolveSectorEtf,
  captureReactionFromTws,
  type TimedClose,
} from "@/lib/calendar/reaction-snapshot";

function hourOffsets(base: number, offsets: number[], step = 1): TimedClose[] {
  return offsets.map((o, i) => ({
    tMs: base + o * 60 * 1000,
    close: 100 + i * step,
  }));
}

describe("findNearestBar", () => {
  it("returns the bar with the smallest time diff", () => {
    const bars: TimedClose[] = [
      { tMs: 100, close: 1 },
      { tMs: 200, close: 2 },
      { tMs: 300, close: 3 },
    ];
    expect(findNearestBar(bars, 190)?.close).toBe(2);
    expect(findNearestBar(bars, 310)?.close).toBe(3);
  });

  it("returns null when the closest bar is outside the tolerance", () => {
    const bars: TimedClose[] = [{ tMs: 100, close: 1 }];
    expect(findNearestBar(bars, 100 + 60 * 60 * 1000, 10_000)).toBeNull();
  });

  it("returns null for an empty bar list", () => {
    expect(findNearestBar([], 100)).toBeNull();
  });
});

describe("matchBarsToReaction", () => {
  it("picks bars at T-5 and T+120 and computes percent delta", () => {
    const release = Date.UTC(2026, 3, 11, 12, 30, 0); // 2026-04-11T12:30:00Z
    const bars: TimedClose[] = [
      { tMs: release - 5 * 60 * 1000, close: 585.21 },    // T-5
      { tMs: release,                  close: 586.00 },   // T0 (ignored)
      { tMs: release + 120 * 60 * 1000, close: 582.84 },  // T+120
    ];
    const r = matchBarsToReaction(bars, release);
    expect(r?.t_pre).toBe(585.21);
    expect(r?.t_post).toBe(582.84);
    // (582.84 - 585.21) / 585.21 * 100 = -0.4049% → -0.40
    expect(r?.delta_pct).toBe(-0.40);
  });

  it("returns null when one endpoint is missing", () => {
    const release = Date.UTC(2026, 3, 11, 12, 30, 0);
    // No T+120 bar within tolerance
    const bars = [{ tMs: release - 5 * 60 * 1000, close: 585.21 }];
    expect(matchBarsToReaction(bars, release)).toBeNull();
  });

  it("returns null for zero pre-price", () => {
    const release = Date.UTC(2026, 3, 11, 12, 30, 0);
    const bars: TimedClose[] = [
      { tMs: release - 5 * 60 * 1000, close: 0 },
      { tMs: release + 120 * 60 * 1000, close: 100 },
    ];
    expect(matchBarsToReaction(bars, release)).toBeNull();
  });
});

describe("composeReleaseInstant", () => {
  it("treats 08:30 ET on a DST date as UTC-4 (EDT)", () => {
    const instant = composeReleaseInstant("2026-04-11", "08:30");
    // 08:30 EDT = 12:30 UTC
    expect(instant?.toISOString()).toBe("2026-04-11T12:30:00.000Z");
  });

  it("treats 08:30 ET on a winter date as UTC-5 (EST)", () => {
    const instant = composeReleaseInstant("2026-01-15", "08:30");
    // 08:30 EST = 13:30 UTC
    expect(instant?.toISOString()).toBe("2026-01-15T13:30:00.000Z");
  });

  it("returns null for bad formats", () => {
    expect(composeReleaseInstant("not-a-date", "08:30")).toBeNull();
    expect(composeReleaseInstant("2026-04-11", "BMO")).toBeNull();
  });
});

describe("resolveSectorEtf", () => {
  it("maps macro event_type via EVENT_SECTOR_MAP", () => {
    expect(resolveSectorEtf("cpi", null)).toBe("XLF");
    expect(resolveSectorEtf("housing", null)).toBe("XHB");
    expect(resolveSectorEtf("gdp", null)).toBeNull();
  });

  it("maps earnings via securities.sector", () => {
    expect(resolveSectorEtf("earnings", "Technology")).toBe("XLK");
    expect(resolveSectorEtf("earnings", "Financials")).toBe("XLF");
    expect(resolveSectorEtf("earnings", "Unknown Sector")).toBeNull();
  });

  it("returns null for earnings with no sector", () => {
    expect(resolveSectorEtf("earnings", null)).toBeNull();
  });

  it("resolves the canonical GICS 'Healthcare' label to XLV (vocabulary-drift fix)", () => {
    expect(resolveSectorEtf("earnings", "Healthcare")).toBe("XLV");
  });

  it("resolves legacy pre-normalizer labels via normalizeSector defense", () => {
    expect(resolveSectorEtf("earnings", "Health Care")).toBe("XLV");
    expect(resolveSectorEtf("earnings", "Financial")).toBe("XLF");
  });
});

describe("captureReactionFromTws", () => {
  const release = new Date("2026-04-11T12:30:00Z"); // 08:30 EDT CPI

  function makeBars(base: number, preClose: number, postClose: number) {
    return [
      // Buffer bars on either side
      { time: formatTwsTime(base - 10 * 60 * 1000), close: preClose - 0.1 },
      { time: formatTwsTime(base - 5 * 60 * 1000),  close: preClose },
      { time: formatTwsTime(base),                   close: preClose + 0.2 },
      { time: formatTwsTime(base + 60 * 60 * 1000),  close: (preClose + postClose) / 2 },
      { time: formatTwsTime(base + 120 * 60 * 1000), close: postClose },
      { time: formatTwsTime(base + 125 * 60 * 1000), close: postClose + 0.05 },
    ];
  }

  function formatTwsTime(ms: number): string {
    // "YYYYMMDD  HH:MM:SS" in ET. For a release at 12:30 UTC (EDT=-4),
    // the ET wall clock is 08:30. For an offset-minutes bar at +120min,
    // ET wall clock is 10:30.
    const etMs = ms - 4 * 60 * 60 * 1000; // EDT offset for test case
    const d = new Date(etMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}  ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    );
  }

  it("produces a snapshot with SPY/QQQ/TLT deltas and fixed source=tws", async () => {
    const mockApi = {
      getHistoricalData: async (
        contract: { symbol: string },
      ) => {
        const base = release.getTime();
        if (contract.symbol === "SPY") return makeBars(base, 585.21, 582.84);
        if (contract.symbol === "QQQ") return makeBars(base, 495.10, 492.30);
        if (contract.symbol === "TLT") return makeBars(base, 92.30, 91.80);
        return [];
      },
    } as unknown as IBApiNext;

    const snap = await captureReactionFromTws(mockApi, release, null, { pacingMs: 0 });
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe("tws");
    expect(snap!.window_min).toBe(120);
    expect(snap!.t0_utc).toBe("2026-04-11T12:30:00.000Z");
    expect(snap!.spy.delta_pct).toBe(-0.40);
    expect(snap!.qqq.delta_pct).toBeLessThan(0);
    expect(snap!.tlt.delta_pct).toBeLessThan(0);
    expect(snap!.sector).toBeUndefined();
  });

  it("includes the event symbol's own bars when eventSymbol is passed", async () => {
    const mockApi = {
      getHistoricalData: async (
        contract: { symbol: string },
      ) => {
        const base = release.getTime();
        if (contract.symbol === "SPY") return makeBars(base, 585.21, 582.84);
        if (contract.symbol === "QQQ") return makeBars(base, 495.10, 492.30);
        if (contract.symbol === "TLT") return makeBars(base, 92.30, 91.80);
        if (contract.symbol === "GLW") return makeBars(base, 50.10, 52.20); // +4.19%
        return [];
      },
    } as unknown as IBApiNext;

    const snap = await captureReactionFromTws(mockApi, release, null, {
      pacingMs: 0,
      eventSymbol: "GLW",
    });
    expect(snap?.symbol?.symbol).toBe("GLW");
    expect(snap?.symbol?.delta_pct).toBeGreaterThan(4); // GLW outperformed SPY by ~4.6 pts
    expect(snap?.spy.delta_pct).toBeLessThan(0);
  });

  it("omits the symbol field when eventSymbol bars are unavailable", async () => {
    const mockApi = {
      getHistoricalData: async (
        contract: { symbol: string },
      ) => {
        const base = release.getTime();
        if (contract.symbol === "SPY") return makeBars(base, 585.21, 582.84);
        if (contract.symbol === "QQQ") return makeBars(base, 495.10, 492.30);
        if (contract.symbol === "TLT") return makeBars(base, 92.30, 91.80);
        // ZZZZ returns empty — captures core benchmarks only.
        return [];
      },
    } as unknown as IBApiNext;

    const snap = await captureReactionFromTws(mockApi, release, null, {
      pacingMs: 0,
      eventSymbol: "ZZZZ",
    });
    expect(snap).not.toBeNull();
    expect(snap!.symbol).toBeUndefined();
    expect(snap!.spy.delta_pct).toBeLessThan(0);
  });

  it("includes sector ETF when mapped", async () => {
    const mockApi = {
      getHistoricalData: async (
        contract: { symbol: string },
      ) => {
        const base = release.getTime();
        if (contract.symbol === "SPY") return makeBars(base, 585.21, 582.84);
        if (contract.symbol === "QQQ") return makeBars(base, 495.10, 492.30);
        if (contract.symbol === "TLT") return makeBars(base, 92.30, 91.80);
        if (contract.symbol === "XLF") return makeBars(base, 51.20, 50.85);
        return [];
      },
    } as unknown as IBApiNext;

    const snap = await captureReactionFromTws(mockApi, release, "XLF", { pacingMs: 0 });
    expect(snap?.sector?.symbol).toBe("XLF");
    expect(snap?.sector?.delta_pct).toBeLessThan(0);
  });

  it("returns null when all three core benchmarks are missing", async () => {
    const mockApi = {
      getHistoricalData: async () => [],
    } as unknown as IBApiNext;

    const snap = await captureReactionFromTws(mockApi, release, null, { pacingMs: 0 });
    expect(snap).toBeNull();
  });

  it("tolerates a single benchmark failure and continues with the others", async () => {
    const mockApi = {
      getHistoricalData: async (
        contract: { symbol: string },
      ) => {
        const base = release.getTime();
        if (contract.symbol === "TLT") {
          throw new Error("simulated TWS timeout");
        }
        return makeBars(base, 100, 101);
      },
    } as unknown as IBApiNext;

    const snap = await captureReactionFromTws(mockApi, release, null, { pacingMs: 0 });
    expect(snap).not.toBeNull();
    expect(snap!.spy.delta_pct).toBeGreaterThan(0);
    // TLT fell back to the zero-filled sentinel
    expect(snap!.tlt.t_pre).toBe(0);
  });
});
