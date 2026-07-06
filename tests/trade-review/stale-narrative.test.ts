import { describe, it, expect } from "vitest";
import {
  isNarrativeStale,
  OPTION_DOLLARS_REPAIRED_AT_UTC,
} from "@/lib/trade-review/stale-narrative";

// Context: commit 9003ec4 fixed computeTaxLots' missing option contract
// multiplier (option dollars were 100x understated) and the companion repair
// rewrote stored roundtrip/summary dollars for reviews 4/8/10/12 on
// 2026-07-04 — deliberately leaving review_markdown untouched. Any review
// generated BEFORE the repair whose trade set includes options therefore has
// a narrative quoting understated dollars next to corrected header metrics.

const OCC_OPTION = { symbol: "INTC  280121C00050000", securityType: null };
const TYPED_OPTION = { symbol: "RSP 260515C00189000", securityType: "Option" };
const STOCK = { symbol: "VTI", securityType: "ETF" };

describe("isNarrativeStale", () => {
  it("regenerated review (fresh generated_at) clears even with the same trades", () => {
    expect(isNarrativeStale("2026-07-06 17:20:00", [OCC_OPTION])).toBe(false);
  });

  it("flags a pre-repair review containing an OCC-symbol option trade", () => {
    expect(isNarrativeStale("2026-05-05 18:35:32", [STOCK, OCC_OPTION])).toBe(true);
  });

  it("flags via securityType even when the symbol is not OCC-parseable (case-insensitive)", () => {
    expect(
      isNarrativeStale("2026-04-07 17:12:17", [{ symbol: "QQQ put", securityType: "option" }])
    ).toBe(true);
  });

  it("does not flag a pre-repair stock/ETF-only review (nothing was understated)", () => {
    expect(isNarrativeStale("2026-05-05 18:35:32", [STOCK])).toBe(false);
  });

  it("does not flag reviews generated after the repair", () => {
    expect(isNarrativeStale("2026-07-06 12:00:00", [OCC_OPTION, TYPED_OPTION])).toBe(false);
    expect(isNarrativeStale(OPTION_DOLLARS_REPAIRED_AT_UTC, [OCC_OPTION])).toBe(false);
  });

  it("empty trade list never flags", () => {
    expect(isNarrativeStale("2026-05-05 18:35:32", [])).toBe(false);
  });
});
