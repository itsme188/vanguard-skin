/**
 * resolveExpectedMove — sheet > straddle > iv_approx precedence (feedback #5).
 * Pure + zero-import; byte-parity Worker mirror pinned in
 * workers/cron/test/expected-move-parity.test.ts.
 */

import { describe, it, expect } from "vitest";
import { resolveExpectedMove } from "@/lib/earnings/expected-move";

const noBogeys: Array<{
  expectedMovePct: number | null;
  sourceLabel: string | null;
  uploadedAt: string | null;
}> = [];

describe("resolveExpectedMove", () => {
  it("returns null when neither a sheet value nor an intel value exists", () => {
    expect(
      resolveExpectedMove({ bogeys: noBogeys, impliedMovePct: null, impliedMethod: null }),
    ).toBeNull();
  });

  it("passes through the intel value when no bogey carries an expected move", () => {
    const out = resolveExpectedMove({
      bogeys: [{ expectedMovePct: null, sourceLabel: "TMT sheet", uploadedAt: "2026-08-01" }],
      impliedMovePct: 5.2,
      impliedMethod: "straddle",
    });
    expect(out).toEqual({ pct: 5.2, method: "straddle", sourceLabel: null });
  });

  it("iv_approx passes through too", () => {
    const out = resolveExpectedMove({
      bogeys: noBogeys,
      impliedMovePct: 1.5,
      impliedMethod: "iv_approx",
    });
    expect(out).toEqual({ pct: 1.5, method: "iv_approx", sourceLabel: null });
  });

  it("a sheet expected move outranks a straddle", () => {
    const out = resolveExpectedMove({
      bogeys: [
        { expectedMovePct: 6, sourceLabel: "TMT Breakout 7/28 weekly", uploadedAt: "2026-07-28" },
      ],
      impliedMovePct: 5.2,
      impliedMethod: "straddle",
    });
    expect(out).toEqual({
      pct: 6,
      method: "sheet",
      sourceLabel: "TMT Breakout 7/28 weekly",
    });
  });

  it("the NEWEST sheet value wins when several bogeys carry one", () => {
    const out = resolveExpectedMove({
      bogeys: [
        { expectedMovePct: 4, sourceLabel: "old sheet", uploadedAt: "2026-07-20" },
        { expectedMovePct: 7, sourceLabel: "fresh sheet", uploadedAt: "2026-07-28" },
        { expectedMovePct: null, sourceLabel: "no-move source", uploadedAt: "2026-07-30" },
      ],
      impliedMovePct: null,
      impliedMethod: null,
    });
    expect(out).toEqual({ pct: 7, method: "sheet", sourceLabel: "fresh sheet" });
  });

  it("a null uploadedAt sorts last (dated sheets beat undated ones)", () => {
    const out = resolveExpectedMove({
      bogeys: [
        { expectedMovePct: 3, sourceLabel: "undated", uploadedAt: null },
        { expectedMovePct: 8, sourceLabel: "dated", uploadedAt: "2026-07-28" },
      ],
      impliedMovePct: null,
      impliedMethod: null,
    });
    expect(out).toEqual({ pct: 8, method: "sheet", sourceLabel: "dated" });
  });

  it("guards non-finite / zero / negative sheet values (falls through to intel)", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = resolveExpectedMove({
        bogeys: [{ expectedMovePct: bad, sourceLabel: "junk", uploadedAt: "2026-07-28" }],
        impliedMovePct: 5.2,
        impliedMethod: "straddle",
      });
      expect(out).toEqual({ pct: 5.2, method: "straddle", sourceLabel: null });
    }
  });

  it("intel pct without a method is treated as absent (never an unlabeled number)", () => {
    expect(
      resolveExpectedMove({ bogeys: noBogeys, impliedMovePct: 5.2, impliedMethod: null }),
    ).toBeNull();
  });
});
