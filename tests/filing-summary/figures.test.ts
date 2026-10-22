import { describe, it, expect } from "vitest";
import {
  FIGURE_REASON_CODES,
  IN_LINE_BAND,
  checkRelation,
  computeOp,
  matchesWithRounding,
  parseNumberToken,
  parsePeriodHeader,
  parsePeriodPhrase,
  samePeriod,
  scaleFromNote,
  toUnits,
  type Operand,
} from "@/lib/filing-summary/figures";

const usd = (units: number): Operand => ({ units, unit: "usd" });
const pct = (units: number): Operand => ({ units, unit: "percent" });
const range = (low: number, high: number, unit: Operand["unit"] = "usd"): Operand => ({
  units: (low + high) / 2,
  unit,
  low,
  high,
});

describe("parseNumberToken (R4)", () => {
  it("reads commas, currency, parentheses and signs", () => {
    expect(parseNumberToken("(5,313)")).toEqual({ value: -5313, decimals: 0 });
    expect(parseNumberToken("$12.99")).toEqual({ value: 12.99, decimals: 2 });
    expect(parseNumberToken("$ (1.23)")).toEqual({ value: -1.23, decimals: 2 });
    expect(parseNumberToken("−3.2")).toEqual({ value: -3.2, decimals: 1 });
    expect(parseNumberToken("-3.2")).toEqual({ value: -3.2, decimals: 1 });
    expect(parseNumberToken("-$1.20")).toEqual({ value: -1.2, decimals: 2 });
    expect(parseNumberToken("12.5%")).toEqual({ value: 12.5, decimals: 1 });
    expect(parseNumberToken("+3.1%")).toEqual({ value: 3.1, decimals: 1 });
    expect(parseNumberToken("(2.1)%")).toEqual({ value: -2.1, decimals: 1 });
    expect(parseNumberToken("(2.1%)")).toEqual({ value: -2.1, decimals: 1 });
    expect(parseNumberToken("181,712")).toEqual({ value: 181712, decimals: 0 });
    expect(parseNumberToken(" 64,601 ")).toEqual({ value: 64601, decimals: 0 });
  });

  it("treats dash and not-applicable cells as missing, never zero", () => {
    for (const raw of ["—", "–", "-", "−", "n/a", "N/A", "nm", "NM", "", "   ", "$ —"]) {
      expect(parseNumberToken(raw)).toBeNull();
    }
  });

  it("refuses text that is not one number", () => {
    for (const raw of ["abc", "12,99", "1,2345", "12.3.4", "5 (1)", "$", "()", "--5", "(-5)"]) {
      expect(parseNumberToken(raw)).toBeNull();
    }
  });
});

describe("toUnits and scaleFromNote", () => {
  it("converts a stated scale into units", () => {
    expect(toUnits(12.99, "billions")).toBeCloseTo(12.99e9, 0);
    expect(toUnits(64_601, "millions")).toBe(64_601e6);
    expect(toUnits(5, "thousands")).toBe(5000);
    expect(toUnits(7.25, "units")).toBe(7.25);
  });

  it("applies 'except per share' to per-share and percentage figures", () => {
    const note = "in millions, except per share amounts";
    expect(scaleFromNote(note, "usd_per_share")).toBe("units");
    expect(scaleFromNote(note, "percent")).toBe("units");
    expect(scaleFromNote(note, "usd")).toBe("millions");
    expect(scaleFromNote(note, "shares")).toBe("millions");
    expect(scaleFromNote(note, "count")).toBe("millions");
  });

  it("returns null when there is no note", () => {
    expect(scaleFromNote(null, "usd")).toBeNull();
    expect(scaleFromNote("", "usd")).toBeNull();
    expect(scaleFromNote("Condensed Consolidated Statements", "usd")).toBeNull();
  });

  it("reads 'except share and per share' as exempting share counts", () => {
    const note = "(In thousands, except share and per share data)";
    expect(scaleFromNote(note, "usd")).toBe("thousands");
    expect(scaleFromNote(note, "shares")).toBe("units");
    expect(scaleFromNote(note, "usd_per_share")).toBe("units");
  });

  it("reads a separate share scale", () => {
    const note = "(Dollars in millions, shares in thousands, except per share amounts)";
    expect(scaleFromNote(note, "usd")).toBe("millions");
    expect(scaleFromNote(note, "shares")).toBe("thousands");
  });

  it("cannot tell a per-share scale when the note does not exempt it", () => {
    expect(scaleFromNote("(in millions)", "usd_per_share")).toBeNull();
    expect(scaleFromNote("(in millions)", "other")).toBeNull();
    expect(scaleFromNote("(in billions)", "usd")).toBe("billions");
  });
});

describe("matchesWithRounding (R4)", () => {
  it("matches the spec example and refuses a value outside half a unit", () => {
    expect(matchesWithRounding({ value: 12.99, decimals: 2, scale: "billions" }, 12_988e6)).toBe(true);
    expect(matchesWithRounding({ value: 12.99, decimals: 2, scale: "billions" }, 12_984e6)).toBe(false);
  });

  it("is inclusive at exactly half a unit, on both sides", () => {
    const s = { value: 12.99, decimals: 2, scale: "billions" as const };
    expect(matchesWithRounding(s, 12_995e6)).toBe(true);
    expect(matchesWithRounding(s, 12_996e6)).toBe(false);
    expect(matchesWithRounding(s, 12_985e6)).toBe(true);
    expect(matchesWithRounding(s, 12_984e6)).toBe(false);
  });

  it("uses the stated figure's own last digit", () => {
    expect(matchesWithRounding({ value: 13, decimals: 0, scale: "billions" }, 12_988e6)).toBe(true);
    expect(matchesWithRounding({ value: 13, decimals: 0, scale: "billions" }, 13_500e6)).toBe(true);
    expect(matchesWithRounding({ value: 13, decimals: 0, scale: "billions" }, 13_501e6)).toBe(false);
    expect(matchesWithRounding({ value: 64_601, decimals: 0, scale: "millions" }, 64_601e6)).toBe(true);
    expect(matchesWithRounding({ value: 7.25, decimals: 2, scale: "units" }, 7.25)).toBe(true);
    expect(matchesWithRounding({ value: 7.25, decimals: 2, scale: "units" }, 7.26)).toBe(false);
  });

  it("never matches across a sign", () => {
    expect(matchesWithRounding({ value: -5.3, decimals: 1, scale: "billions" }, -5_313e6)).toBe(true);
    expect(matchesWithRounding({ value: 5.3, decimals: 1, scale: "billions" }, -5_313e6)).toBe(false);
  });
});

describe("parsePeriodHeader (R5)", () => {
  it("reads a quarter column", () => {
    expect(parsePeriodHeader("Three Months Ended September 30, 2026")).toEqual({
      kind: "quarter",
      role: "actual",
      endDate: "2026-09-30",
      fiscalYear: null,
      fiscalQuarter: null,
    });
  });

  it("takes the year from a later header part", () => {
    expect(parsePeriodHeader("Nine Months Ended September 30, / 2026")).toEqual({
      kind: "year_to_date",
      role: "actual",
      endDate: "2026-09-30",
      fiscalYear: null,
      fiscalQuarter: null,
    });
    expect(parsePeriodHeader("Three Months Ended / September 30, / 2025")?.endDate).toBe("2025-09-30");
  });

  it("reads year, twelve-month and instant columns", () => {
    expect(parsePeriodHeader("Year Ended December 31, 2025")?.kind).toBe("fiscal_year");
    expect(parsePeriodHeader("Twelve Months Ended June 30, 2026")?.kind).toBe("fiscal_year");
    expect(parsePeriodHeader("Fiscal Year Ended January 26, 2026")?.endDate).toBe("2026-01-26");
    expect(parsePeriodHeader("As of September 30, 2026")).toEqual({
      kind: "instant",
      role: "actual",
      endDate: "2026-09-30",
      fiscalYear: null,
      fiscalQuarter: null,
    });
    expect(parsePeriodHeader("At December 31, / 2025")?.kind).toBe("instant");
    expect(parsePeriodHeader("Six Months Ended June 30, 2026")?.kind).toBe("year_to_date");
    expect(parsePeriodHeader("Quarter Ended Sept. 30, 2026")?.endDate).toBe("2026-09-30");
    expect(parsePeriodHeader("13 Weeks Ended October 26, 2026")?.kind).toBe("quarter");
    expect(parsePeriodHeader("Q3 2026")).toEqual({
      kind: "quarter",
      role: "actual",
      endDate: null,
      fiscalYear: 2026,
      fiscalQuarter: 3,
    });
  });

  it("returns null when it cannot tell", () => {
    expect(parsePeriodHeader("September 30, 2026")).toBeNull(); // no duration
    expect(parsePeriodHeader("Three Months Ended September 30,")).toBeNull(); // no year
    expect(parsePeriodHeader("Three Months Ended")).toBeNull();
    expect(parsePeriodHeader("Three Months Ended September 30, / 2026 / 2025")).toBeNull();
    expect(parsePeriodHeader("Three Months Ended / Nine Months Ended / September 30, 2026")).toBeNull();
    expect(parsePeriodHeader("Three Months Ended February 30, 2026")).toBeNull();
    expect(parsePeriodHeader("")).toBeNull();
  });
});

describe("parsePeriodPhrase (R5)", () => {
  const ev = "2026-10-21";

  it("returns null for a quarter word without a year", () => {
    expect(parsePeriodPhrase("in the third quarter", ev)).toBeNull();
    expect(parsePeriodPhrase("Revenue grew in Q3.", ev)).toBeNull();
  });

  it("reads quarter phrases", () => {
    const q3 = { kind: "quarter", role: "actual", endDate: null, fiscalYear: 2026, fiscalQuarter: 3 };
    expect(parsePeriodPhrase("Revenue for the third quarter 2026 was $64.6 billion.", ev)).toEqual(q3);
    expect(parsePeriodPhrase("Revenue for the third quarter of 2026 was up.", ev)).toEqual(q3);
    expect(parsePeriodPhrase("Q3 2026 revenue", ev)).toEqual(q3);
    expect(parsePeriodPhrase("Q3 FY26 revenue", ev)).toEqual(q3);
    expect(parsePeriodPhrase("3Q26 revenue", ev)).toEqual(q3);
    expect(parsePeriodPhrase("third quarter of fiscal 2026", ev)).toEqual(q3);
    expect(parsePeriodPhrase("fiscal 2026 third quarter revenue", ev)).toEqual(q3);
  });

  it("reads dated durations", () => {
    expect(parsePeriodPhrase("For the nine months ended September 30, 2026, cash rose.", ev)).toEqual({
      kind: "year_to_date",
      role: "actual",
      endDate: "2026-09-30",
      fiscalYear: null,
      fiscalQuarter: null,
    });
    expect(parsePeriodPhrase("for the quarter ended September 30, 2026", ev)?.endDate).toBe("2026-09-30");
  });

  it("reads full-year phrases and outlook wording", () => {
    expect(parsePeriodPhrase("Full year 2025 revenue was $200 billion.", ev)).toEqual({
      kind: "fiscal_year",
      role: "actual",
      endDate: null,
      fiscalYear: 2025,
      fiscalQuarter: null,
    });
    expect(parsePeriodPhrase("The company now expects full-year 2026 revenue of $250 billion.", ev)).toEqual({
      kind: "fiscal_year",
      role: "outlook",
      endDate: null,
      fiscalYear: 2026,
      fiscalQuarter: null,
    });
    expect(parsePeriodPhrase("Fiscal 2026 guidance", ev)?.role).toBe("outlook");
    expect(parsePeriodPhrase("FY2026 revenue", ev)?.fiscalYear).toBe(2026);
  });

  it("reads year-to-date phrases without a date", () => {
    expect(parsePeriodPhrase("in the first nine months of 2026", ev)).toEqual({
      kind: "year_to_date",
      role: "actual",
      endDate: null,
      fiscalYear: 2026,
      fiscalQuarter: 3,
    });
    expect(parsePeriodPhrase("first half of 2026", ev)?.fiscalQuarter).toBe(2);
  });

  it("marks a dated period that ends after the event as outlook", () => {
    expect(parsePeriodPhrase("for the quarter ending December 31, 2026", ev)?.role).toBe("outlook");
  });

  it("returns null when the sentence names two different periods or an unresolved one", () => {
    expect(parsePeriodPhrase("third quarter 2026 compared with third quarter 2025", ev)).toBeNull();
    expect(parsePeriodPhrase("third quarter results and fiscal 2026 outlook", ev)).toBeNull();
    expect(parsePeriodPhrase("Q3 2026 revenue, up from Q3 2026 last call", ev)).not.toBeNull();
    expect(parsePeriodPhrase("Revenue rose sharply.", ev)).toBeNull();
  });
});

describe("samePeriod (R5)", () => {
  const p = (o: Partial<{ kind: string; role: string; endDate: string | null; fiscalYear: number | null; fiscalQuarter: number | null }>) => ({
    kind: "quarter" as const,
    role: "actual" as const,
    endDate: null,
    fiscalYear: null,
    fiscalQuarter: null,
    ...o,
  }) as Parameters<typeof samePeriod>[0];

  it("equal kind, role and end date are the same", () => {
    expect(samePeriod(p({ endDate: "2026-09-30" }), p({ endDate: "2026-09-30" }))).toBe(true);
    expect(samePeriod(p({ endDate: "2026-09-30" }), p({ endDate: "2025-09-30" }))).toBe(false);
  });

  it("without end dates compares fiscal year and quarter", () => {
    expect(samePeriod(p({ fiscalYear: 2026, fiscalQuarter: 3 }), p({ fiscalYear: 2026, fiscalQuarter: 3 }))).toBe(true);
    expect(samePeriod(p({ fiscalYear: 2026, fiscalQuarter: 3 }), p({ fiscalYear: 2026, fiscalQuarter: 2 }))).toBe(false);
    expect(samePeriod(p({ kind: "fiscal_year", fiscalYear: 2026 }), p({ kind: "fiscal_year", fiscalYear: 2026 }))).toBe(true);
  });

  it("different kind or role is different", () => {
    expect(samePeriod(p({ endDate: "2026-09-30" }), p({ kind: "year_to_date", endDate: "2026-09-30" }))).toBe(false);
    expect(samePeriod(p({ fiscalYear: 2026, fiscalQuarter: 4 }), p({ role: "outlook", fiscalYear: 2026, fiscalQuarter: 4 }))).toBe(false);
  });

  it("cannot tell when the evidence is partial", () => {
    expect(samePeriod(p({ endDate: "2026-09-30" }), p({ fiscalYear: 2026, fiscalQuarter: 3 }))).toBeNull();
    expect(samePeriod(p({ fiscalYear: 2026 }), p({ fiscalYear: 2026, fiscalQuarter: 3 }))).toBeNull();
    expect(samePeriod(p({}), p({}))).toBeNull();
    expect(samePeriod(p({ kind: "instant" }), p({ kind: "instant" }))).toBeNull();
  });
});

describe("checkRelation (R7)", () => {
  it("decides above and below on the sign of the difference (spec example)", () => {
    const below = checkRelation("below", usd(64.601e9), usd(64.57e9));
    expect(below.verdict).toBe("contradicted");
    expect(below.difference).toBeCloseTo(0.031e9, -3);
    expect(below.differencePct).toBeCloseTo(0.048, 3);
    expect(below.shownText).toBe("+0.05%");
    const above = checkRelation("above", usd(64.601e9), usd(64.57e9));
    expect(above.verdict).toBe("matches");
    expect(above.shownText).toBe("+0.05%");
  });

  it("an equal figure is neither above nor below", () => {
    expect(checkRelation("above", usd(100), usd(100)).verdict).toBe("contradicted");
    expect(checkRelation("below", usd(100), usd(100)).verdict).toBe("contradicted");
    // scale noise from billions vs millions is not a difference
    expect(checkRelation("above", usd(toUnits(12.99, "billions")), usd(toUnits(12_990, "millions"))).verdict).toBe("contradicted");
  });

  it("in line is inclusive at exactly half a percent", () => {
    expect(checkRelation("in_line", usd(100.5e6), usd(100e6)).verdict).toBe("matches");
    expect(checkRelation("in_line", usd(99.5e6), usd(100e6)).verdict).toBe("matches");
    expect(checkRelation("in_line", usd(100.51e6), usd(100e6)).verdict).toBe("contradicted");
    expect(checkRelation("in_line", usd(64.57e9 * 1.005), usd(64.57e9)).verdict).toBe("matches");
    expect(checkRelation("in_line", usd(64.57e9 * 1.0051), usd(64.57e9)).verdict).toBe("contradicted");
  });

  it("above inside the band is still above", () => {
    expect(checkRelation("above", usd(100.1), usd(100)).verdict).toBe("matches");
  });

  it("a zero comparator leaves in line unconfirmed but still decides direction", () => {
    const inLine = checkRelation("in_line", usd(0), usd(0));
    expect(inLine.verdict).toBe("unconfirmed");
    expect(inLine.reasons.map((r) => r.code)).toContain("zero_comparator");
    expect(inLine.differencePct).toBeNull();
    expect(checkRelation("above", usd(5e6), usd(0)).verdict).toBe("matches");
    expect(checkRelation("below", usd(5e6), usd(0)).verdict).toBe("contradicted");
  });

  it("a negative comparator uses the signed difference", () => {
    const r = checkRelation("above", usd(-7.0e9), usd(-7.3e9));
    expect(r.verdict).toBe("matches");
    expect(r.difference).toBeCloseTo(0.3e9, -3);
    expect(r.differencePct).toBeCloseTo(4.11, 2);
    expect(r.shownText).toBe("+4.11%");
    expect(checkRelation("below", usd(-7.3e9), usd(-7.0e9)).verdict).toBe("matches");
  });

  it("percent operands show percentage points with the same relative band", () => {
    const r = checkRelation("above", pct(45.3), pct(45.0));
    expect(r.verdict).toBe("matches");
    expect(r.difference).toBeCloseTo(0.3, 9);
    expect(r.shownText).toBe("+0.3 pp");
    expect(checkRelation("below", pct(44.7), pct(45.0)).shownText).toBe("-0.3 pp");
    expect(checkRelation("in_line", pct(45.2), pct(45.0)).verdict).toBe("matches"); // 0.44% relative
    expect(checkRelation("in_line", pct(45.3), pct(45.0)).verdict).toBe("contradicted"); // 0.67% relative
  });

  it("a range comparator: in line inside, above and below outside", () => {
    const g = range(60e9, 62e9);
    expect(checkRelation("in_line", usd(60e9), g).verdict).toBe("matches");
    expect(checkRelation("in_line", usd(62e9), g).verdict).toBe("matches");
    expect(checkRelation("in_line", usd(62.1e9), g).verdict).toBe("contradicted");
    const above = checkRelation("above", usd(62.62e9), g);
    expect(above.verdict).toBe("matches");
    expect(above.difference).toBeCloseTo(0.62e9, -3);
    expect(above.shownText).toBe("+1.00% vs high end");
    expect(checkRelation("above", usd(61e9), g).verdict).toBe("contradicted");
    expect(checkRelation("below", usd(59e9), g).verdict).toBe("matches");
    expect(checkRelation("below", usd(59e9), g).shownText).toBe("-1.67% vs low end");
    expect(checkRelation("in_line", usd(61.5e9), g).shownText).toBe("+0.82% vs midpoint");
  });

  it("raised and lowered compare midpoints", () => {
    expect(checkRelation("raised", range(10.1, 10.3), range(10.0, 10.2)).verdict).toBe("matches");
    expect(checkRelation("raised", range(10.1, 10.3), range(10.0, 10.4)).verdict).toBe("contradicted");
    expect(checkRelation("lowered", range(9.8, 10.0), range(10.0, 10.2)).verdict).toBe("matches");
    expect(checkRelation("lowered", range(10.1, 10.3), range(10.0, 10.2)).verdict).toBe("contradicted");
    // a single-number guidance is a range of zero width
    expect(checkRelation("raised", usd(5.0), usd(4.8)).verdict).toBe("matches");
  });

  it("narrowed compares widths and unchanged needs equal ends", () => {
    expect(checkRelation("narrowed", range(10.0, 10.2), range(9.9, 10.3)).verdict).toBe("matches");
    expect(checkRelation("narrowed", range(10.0, 10.4), range(10.0, 10.4)).verdict).toBe("contradicted");
    expect(checkRelation("unchanged", range(10.0, 10.4), range(10.0, 10.4)).verdict).toBe("matches");
    expect(checkRelation("unchanged", range(10.1, 10.3), range(10.0, 10.4)).verdict).toBe("contradicted");
  });

  it("a range on the stated side of above/below/in line is unconfirmed", () => {
    const r = checkRelation("above", range(10, 12), usd(9));
    expect(r.verdict).toBe("unconfirmed");
    expect(r.reasons[0].code).toBe("range_operand_unsupported");
  });

  it("different units are unconfirmed", () => {
    const r = checkRelation("above", pct(5), usd(4));
    expect(r.verdict).toBe("unconfirmed");
    expect(r.reasons[0].code).toBe("unit_mismatch");
  });

  it("exports every emitted reason code", () => {
    expect([...FIGURE_REASON_CODES].sort()).toEqual(
      ["non_finite_operand", "range_operand_unsupported", "unit_mismatch", "zero_comparator"].sort(),
    );
    expect(IN_LINE_BAND).toBe(0.005);
  });
});

describe("computeOp (R8)", () => {
  it("growth is new / old − 1 and refuses a non-positive old value", () => {
    expect(computeOp("growth", [181_712, 141_073])).toBeCloseTo(0.2881, 4);
    expect(computeOp("growth", [10, -5])).toBeNull();
    expect(computeOp("growth", [10, 0])).toBeNull();
    expect(computeOp("growth", [10])).toBeNull();
  });

  it("ratio is a percentage, difference and sum are plain", () => {
    expect(computeOp("ratio", [25, 200])).toBe(12.5);
    expect(computeOp("ratio", [25, 0])).toBeNull();
    expect(computeOp("difference", [15_000, 3_951])).toBe(11_049);
    expect(computeOp("difference", [1, 2, 3])).toBeNull();
    expect(computeOp("sum", [1, 2, 3])).toBe(6);
    expect(computeOp("sum", [1])).toBeNull();
    expect(computeOp("sum", [1, Number.NaN])).toBeNull();
  });
});
