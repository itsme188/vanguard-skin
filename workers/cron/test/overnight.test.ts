/**
 * Worker overnight block — numbers-only mirror of lib/digest/overnight.ts
 * (spec: docs/superpowers/specs/2026-07-15-overnight-digest-block-design.md).
 * One Yahoo spark request for all four symbols; VK-Dawn commentary is
 * deliberately Mac-only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OVERNIGHT_INSTRUMENTS,
  fetchOvernightMovesWorker,
  renderOvernightLines,
  type OvernightMove,
} from "../src/overnight";

const TODAY = "2026-07-15";

/** Seconds-epoch for an ET-noon instant on the given date (DST-safe enough
 *  for July fixtures). */
function ts(date: string): number {
  return Math.floor(Date.parse(`${date}T12:00:00-04:00`) / 1000);
}

function sparkBody(
  entries: Record<string, { timestamp: number[]; close: Array<number | null> }>,
) {
  return {
    ok: true,
    json: async () => entries,
  } as Response;
}

describe("fetchOvernightMovesWorker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches all four symbols in ONE spark request and computes moves in order", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sparkBody({
        "^KS11": { timestamp: [ts("2026-07-14"), ts("2026-07-15")], close: [100, 100.8] },
        "BTC-USD": { timestamp: [ts("2026-07-14"), ts("2026-07-15")], close: [100000, 97900] },
        "^N225": { timestamp: [ts("2026-07-14"), ts("2026-07-15")], close: [40000, 40480] },
        "^HSI": { timestamp: [ts("2026-07-14"), ts("2026-07-15")], close: [20000, 19940] },
      }),
    );

    const moves = await fetchOvernightMovesWorker(TODAY);

    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    for (const inst of OVERNIGHT_INSTRUMENTS) {
      expect(url).toContain(encodeURIComponent(inst.symbol));
    }
    expect(moves.map((m) => m.label)).toEqual(["KOSPI", "Bitcoin", "Nikkei", "Hang Seng"]);
    expect((moves[0] as { pct: number }).pct).toBeCloseTo(0.8, 5);
    expect((moves[1] as { pct: number }).pct).toBeCloseTo(-2.1, 5);
  });

  it("pairs closes with their timestamps when nulls are interleaved", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sparkBody({
        "^KS11": {
          timestamp: [ts("2026-07-13"), ts("2026-07-14"), ts("2026-07-15")],
          close: [100, null, 102],
        },
      }),
    );

    const moves = await fetchOvernightMovesWorker(TODAY);

    // Valid pair is (07-13: 100) → (07-15: 102); latest is fresh.
    expect(moves).toEqual([{ label: "KOSPI", pct: expect.closeTo(2, 5) }]);
  });

  it("marks a market closed when its latest close is older than 3 calendar days", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sparkBody({
        "^N225": {
          timestamp: [ts("2026-07-10"), ts("2026-07-11")],
          close: [39900, 40000],
        },
      }),
    );

    const moves = await fetchOvernightMovesWorker(TODAY);
    expect(moves).toEqual([{ label: "Nikkei", closed: true }]);
  });

  it("drops symbols Yahoo omits or returns <2 closes for", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      sparkBody({
        "^KS11": { timestamp: [ts("2026-07-15")], close: [100] },
      }),
    );

    const moves = await fetchOvernightMovesWorker(TODAY);
    expect(moves).toEqual([]);
  });

  it("returns [] on a non-ok response and on a thrown fetch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    expect(await fetchOvernightMovesWorker(TODAY)).toEqual([]);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));
    expect(await fetchOvernightMovesWorker(TODAY)).toEqual([]);
  });
});

describe("renderOvernightLines", () => {
  it("matches the Mac renderer's numbers-only shape", () => {
    const moves: OvernightMove[] = [
      { label: "KOSPI", pct: 0.8 },
      { label: "Bitcoin", pct: -2.14 },
      { label: "Nikkei", closed: true },
      { label: "Hang Seng", pct: -0.3 },
    ];
    const block = renderOvernightLines(moves);
    expect(block).toContain("## Overnight");
    expect(block).toContain("KOSPI +0.8% · Bitcoin −2.1% · Nikkei closed · Hang Seng −0.3%");
  });

  it("returns null for no moves", () => {
    expect(renderOvernightLines([])).toBeNull();
  });
});
