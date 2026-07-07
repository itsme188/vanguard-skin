/**
 * Parity tests for workers/cron/src/plausibility.ts — a byte-for-byte hand
 * copy of lib/earnings/plausibility.ts below the header (Worker can't cross
 * the Next.js path-alias boundary).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isPlausibleEarnings } from "../src/plausibility";

describe("plausibility parity (Worker mirror of lib/earnings/plausibility.ts)", () => {
  it("is byte-identical to the Mac source below the header", () => {
    const mac = readFileSync(
      new URL("../../../lib/earnings/plausibility.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(new URL("../src/plausibility.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.slice(s.indexOf("/**\n * Reject a Finnhub-sourced"));
    expect(strip(wkr)).toBe(strip(mac));
  });

  // Behavior pins mirrored from tests/digest/read-throughs.test.ts.
  it("accepts in-line and genuine-beat prints", () => {
    expect(isPlausibleEarnings(null, null, null, null)).toBe(true);
    expect(isPlausibleEarnings(2.7, 2.62, 110_000_000_000, 109_900_000_000)).toBe(true);
    expect(isPlausibleEarnings(2.09, 2.68, 7_067_819_551, 7_874_790_000)).toBe(true); // PWR +28%
  });

  it("rejects ratio-implausible actuals", () => {
    expect(isPlausibleEarnings(2.7, 5.11, null, null)).toBe(false); // GOOGL bogus
    expect(isPlausibleEarnings(2.0, 0.5, null, null)).toBe(false);
    expect(isPlausibleEarnings(null, null, 100_000_000, 145_000_000)).toBe(false);
  });

  it("rejects EPS sign flips (B19 basis mismatch)", () => {
    expect(isPlausibleEarnings(-0.24, 0.23, null, null)).toBe(false); // U
    expect(isPlausibleEarnings(-0.23, 0.08, null, null)).toBe(false); // LAND
  });

  it("passes a genuine $0.00 actual (no ratio claim)", () => {
    expect(isPlausibleEarnings(1.5, 0, null, null)).toBe(true);
  });
});
