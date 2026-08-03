/**
 * Parity + behavior pins for workers/cron/src/expected-move.ts — byte-parity
 * hand-copy of lib/earnings/expected-move.ts (sheet > straddle > iv_approx).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveExpectedMove } from "../src/expected-move";

describe("resolveExpectedMove (Worker copy)", () => {
  it("sheet outranks straddle and carries its label", () => {
    expect(
      resolveExpectedMove({
        bogeys: [{ expectedMovePct: 6, sourceLabel: "TMT sheet", uploadedAt: "2026-07-28" }],
        impliedMovePct: 5.2,
        impliedMethod: "straddle",
      }),
    ).toEqual({ pct: 6, method: "sheet", sourceLabel: "TMT sheet" });
  });

  it("falls through to iv_approx when no sheet value exists", () => {
    expect(
      resolveExpectedMove({ bogeys: [], impliedMovePct: 1.5, impliedMethod: "iv_approx" }),
    ).toEqual({ pct: 1.5, method: "iv_approx", sourceLabel: null });
  });

  it("returns null when nothing resolves", () => {
    expect(
      resolveExpectedMove({ bogeys: [], impliedMovePct: null, impliedMethod: null }),
    ).toBeNull();
  });
});

describe("expected-move parity (Worker mirror of lib/earnings/expected-move.ts)", () => {
  it("is byte-identical to the Mac original below each file's own header comment", () => {
    const mac = readFileSync(
      new URL("../../../lib/earnings/expected-move.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(new URL("../src/expected-move.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.slice(s.indexOf("export interface ExpectedMoveBogey {"));
    expect(strip(wkr)).toBe(strip(mac));
  });
});
