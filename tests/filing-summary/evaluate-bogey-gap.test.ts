/**
 * QA finding (2026-11-18): "Revenue of $X was above the $Y consensus, a gap of Z%"
 * came out "Periods differ". The gap is typed as growth(actual, consensus) — the
 * only operation that yields a percent difference — and growth demanded that the
 * old input end a year (or a quarter) before the new one. A pre-print figure for
 * this print's own quarter is the SAME period as the release's figure, so the gap
 * is a same-period computation, not a year-on-year one. A bogey for another
 * quarter must still say periods_differ. Synthetic figures only.
 */
import { describe, it, expect } from "vitest";
import type { PeriodSpec } from "@/lib/filing-summary/types";
import { bogey, bogeyFig, cite, claim, cmp, codes, computedFig, one, revenueQ3 } from "./evaluate-helpers";

const NEXT_QUARTER: PeriodSpec = {
  kind: "quarter", role: "outlook", endDate: null, fiscalYear: null, fiscalQuarter: null, anchor: "next_quarter", label: "next quarter outlook",
};

const gapClaim = (stated: string, value: number, bogeyPeriod?: PeriodSpec) =>
  one(
    claim(
      "Revenue of {f1} was above the {f2} consensus, a gap of {f3}.",
      [cite("q1", "Revenue | 64,601")],
      [
        revenueQ3(),
        bogeyFig("f2", "b1.revenue_consensus_usd", {
          valueText: "$60.00 billion", value: 60, scale: "billions", metric: "revenue consensus",
          ...(bogeyPeriod ? { period: bogeyPeriod } : {}),
        }),
        computedFig("f3", { valueText: stated, value, metric: "revenue versus consensus", operation: "growth", inputs: ["f1", "f2"] }),
      ],
      [cmp("f1", "f2", "above")],
    ),
    { bogeys: [bogey("b1.revenue_consensus_usd", 60e9, bogeyPeriod ? { period: bogeyPeriod } : {})] },
  );

describe("gap against a same-quarter bogey", () => {
  it("a gap to this print's quarter consensus is checked, not periods_differ", () => {
    const c = gapClaim("7.7%", 7.7); // 64,601 / 60,000 - 1 = 7.67%
    expect(codes(c)).not.toContain("periods_differ");
    expect(c.status).toBe("checked");
    const f3 = c.figureChecks.find((f) => f.figureId === "f3");
    expect(f3?.established).toBe(true);
    expect(f3?.foundValue).toBeCloseTo(7.668, 2);
  });

  it("the same gap stated wrongly is contradicted (the operands are established)", () => {
    const c = gapClaim("12%", 12);
    expect(c.status).toBe("contradicted");
    expect(codes(c)).toContain("computed_mismatch");
  });

  it("a gap to a bogey for ANOTHER quarter still says periods_differ", () => {
    const c = gapClaim("7.7%", 7.7, NEXT_QUARTER);
    expect(c.status).toBe("periods_differ");
    expect(codes(c)).toContain("periods_differ");
    expect(codes(c)).not.toContain("computed_mismatch");
  });
});
