/**
 * Worker-side tests for the earnings prior-close reaction anchor
 * (2026-08-04, XMTR incident):
 *
 * 1. The mirrored matchBarsToReaction accepts a preAnchorClose and computes
 *    the delta against it (semantic parity with lib/calendar/reaction-snapshot).
 * 2. captureReactionFromYahoo anchors BMO earnings to each symbol's
 *    chartPreviousClose from the Yahoo meta and flags pre_anchor.
 * 3. Macro captures (no earningsCloseMs) keep the release-window semantics.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  matchBarsToReaction,
  lastBarAtOrBefore,
  type TimedClose,
} from "../src/reaction-matcher";
import { captureReactionFromYahoo } from "../src/yahoo";

const RELEASE = new Date("2026-08-04T12:00:00Z"); // BMO 08:00 EDT
const CLOSE_MS = Date.UTC(2026, 7, 4, 20, 0, 0); // 16:00 EDT

describe("matchBarsToReaction — anchored (Worker mirror)", () => {
  const releaseMs = RELEASE.getTime();

  it("uses the anchor as t_pre and computes delta vs the anchor", () => {
    const bars: TimedClose[] = [
      { tMs: releaseMs - 5 * 60 * 1000, close: 94.04 },
      { tMs: releaseMs + 120 * 60 * 1000, close: 89.52 },
    ];
    const r = matchBarsToReaction(bars, releaseMs, 87.01);
    expect(r?.t_pre).toBe(87.01);
    expect(r?.delta_pct).toBe(2.88);
  });

  it("does not require a pre bar when anchored", () => {
    const bars: TimedClose[] = [
      { tMs: releaseMs + 120 * 60 * 1000, close: 89.52 },
    ];
    expect(matchBarsToReaction(bars, releaseMs, 87.01)?.delta_pct).toBe(2.88);
  });

  it("null/zero anchor falls back to legacy nearest-bar matching", () => {
    const bars: TimedClose[] = [
      { tMs: releaseMs - 5 * 60 * 1000, close: 100 },
      { tMs: releaseMs + 120 * 60 * 1000, close: 101 },
    ];
    expect(matchBarsToReaction(bars, releaseMs, null)?.t_pre).toBe(100);
    expect(matchBarsToReaction(bars, releaseMs, 0)?.t_pre).toBe(100);
  });
});

describe("lastBarAtOrBefore (Worker mirror)", () => {
  it("picks the latest bar at or before the target, null when none", () => {
    const bars: TimedClose[] = [
      { tMs: 100, close: 1 },
      { tMs: 300, close: 3 },
    ];
    expect(lastBarAtOrBefore(bars, 200)?.close).toBe(1);
    expect(lastBarAtOrBefore(bars, 50)).toBeNull();
  });
});

describe("captureReactionFromYahoo — earnings prior-close anchor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function yahooResponse(prevClose: number, preBar: number, postBar: number) {
    const releaseSec = Math.floor(RELEASE.getTime() / 1000);
    return {
      chart: {
        result: [
          {
            meta: { chartPreviousClose: prevClose },
            timestamp: [releaseSec - 300, releaseSec + 7200],
            indicators: { quote: [{ close: [preBar, postBar] }] },
          },
        ],
      },
    };
  }

  function stubFetch(bySymbol: Record<string, ReturnType<typeof yahooResponse>>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const sym = /\/chart\/([^?]+)\?/.exec(String(url))?.[1] ?? "";
        const body = bySymbol[sym] ?? yahooResponse(100, 100, 101);
        return { ok: true, json: async () => body } as Response;
      }),
    );
  }

  it("BMO: anchors each symbol to its own chartPreviousClose and flags pre_anchor", async () => {
    stubFetch({
      SPY: yahooResponse(757.67, 760.3, 763.45),
      QQQ: yahooResponse(700.07, 707.91, 713.55),
      TLT: yahooResponse(82.3, 82.45, 82.6),
      XMTR: yahooResponse(87.01, 94.04, 89.52),
    });

    const snap = await captureReactionFromYahoo(RELEASE, null, {
      pacingMs: 0,
      eventSymbol: "XMTR",
      earningsCloseMs: CLOSE_MS,
    });
    expect(snap).not.toBeNull();
    expect(snap!.pre_anchor).toBe("prior_close");
    expect(snap!.spy.t_pre).toBe(757.67);
    expect(snap!.spy.delta_pct).toBe(0.76); // day move, not the 8:00→10:00 window
    expect(snap!.symbol?.t_pre).toBe(87.01);
    expect(snap!.symbol?.delta_pct).toBe(2.88);
  });

  it("macro (no earningsCloseMs): keeps release-window semantics, no flag", async () => {
    stubFetch({
      SPY: yahooResponse(757.67, 760.3, 763.45),
      QQQ: yahooResponse(700.07, 707.91, 713.55),
      TLT: yahooResponse(82.3, 82.45, 82.6),
    });

    const snap = await captureReactionFromYahoo(RELEASE, null, { pacingMs: 0 });
    expect(snap).not.toBeNull();
    expect(snap!.pre_anchor).toBeUndefined();
    expect(snap!.spy.t_pre).toBe(760.3);
    expect(snap!.spy.delta_pct).toBe(0.41);
  });
});
