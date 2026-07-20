/**
 * fetchYahooRolling24hPct — rolling 24h percent change from hourly bars,
 * for 24/7 assets (BTC-USD) in the digest's Overnight block. The daily-close
 * pair measured only the partial UTC day at digest time (7/20: chip said
 * −0.1% while VK's overnight note said −0.75%).
 */

import { describe, it, expect } from "vitest";
import { fetchYahooRolling24hPct } from "@/lib/quotes/yahoo-daily";

const HOUR = 3600;
const T0 = 1_800_000_000; // arbitrary epoch anchor

function chartResponse(points: { t: number; c: number | null }[]) {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: points.map((p) => p.t),
            indicators: { quote: [{ close: points.map((p) => p.c) }] },
          },
        ],
      },
    }),
  } as Response;
}

function stubFetch(points: { t: number; c: number | null }[]): typeof fetch {
  return (async () => chartResponse(points)) as unknown as typeof fetch;
}

describe("fetchYahooRolling24hPct", () => {
  it("returns latest price vs the bar closest to 24h earlier", async () => {
    // 49 hourly bars: 100 at t-48h rising 0.5/hour → last = 124, 24h back = 112.
    const points = Array.from({ length: 49 }, (_, i) => ({
      t: T0 + i * HOUR,
      c: 100 + i * 0.5,
    }));
    const pct = await fetchYahooRolling24hPct("BTC-USD", stubFetch(points));

    expect(pct).toBeCloseTo((124 / 112 - 1) * 100, 6);
  });

  it("skips null closes when picking the latest and prior bars", async () => {
    const points = Array.from({ length: 49 }, (_, i) => ({
      t: T0 + i * HOUR,
      c: (i === 48 || i === 24 ? null : 100 + i) as number | null,
    }));
    // Latest valid bar = i=47 (147); 24h before that = i=23 (123).
    const pct = await fetchYahooRolling24hPct("BTC-USD", stubFetch(points));

    expect(pct).toBeCloseTo((147 / 123 - 1) * 100, 6);
  });

  it("returns null when the series has no bar near the 24h-back target", async () => {
    // Only two bars an hour apart — nothing anywhere near 24h back.
    const pct = await fetchYahooRolling24hPct(
      "BTC-USD",
      stubFetch([
        { t: T0, c: 100 },
        { t: T0 + HOUR, c: 101 },
      ]),
    );

    expect(pct).toBeNull();
  });

  it("returns null on fetch failure", async () => {
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;

    expect(await fetchYahooRolling24hPct("BTC-USD", failing)).toBeNull();
  });
});
