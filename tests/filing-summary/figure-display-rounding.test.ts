/**
 * QA finding 2026-11-21: correctly quoted figures were refused.
 *
 * 1. A figure written at DISPLAY rounding ("$2,318.5 million") whose typed value
 *    is more precise (2318.47 millions) was "The number as written does not
 *    match its value". The written number must equal the typed value rounded to
 *    exactly the digits shown, at the shown unit; one unit off in the last digit
 *    still fails.
 * 2. Written in plain dollars ("$64,000") while typed in thousands (64).
 * 3. An accounting negative written with the unit inside the brackets
 *    ("($41.306 million)") was read as positive.
 * 4. "a loss of {f1}" with an unsigned shown text and a negative typed value: the
 *    words before the placeholder give the sign, as they do inside a sentence.
 * 5. "a range of $3.415 to $3.48 billion": the unit written once after the
 *    second number applies to the first too.
 *
 * Every company, sentence and number here is invented.
 */
import { describe, it, expect } from "vitest";
import { extractDocText } from "@/lib/filing-summary/doc-text";
import { scanNumbers, statedNumber } from "@/lib/filing-summary/evaluate-tokens";
import type { ModelFigure, PeriodSpec } from "@/lib/filing-summary/types";
import { EX991, bogey, bogeyFig, cite, claim, cmp, codes, exhibit, incomeDoc, one, period, quoteFig } from "./evaluate-helpers";

const FY_26: PeriodSpec = period({ kind: "fiscal_year", role: "outlook", endDate: "2026-12-31", fiscalYear: 2026, label: "FY 2026 outlook" });
const docsOf = (html: string) => [{ fileName: EX991, text: extractDocText(html) }, { fileName: "t.htm", text: exhibit }];
const fig = (over: Partial<ModelFigure>) => quoteFig("f", "q", over);

describe("statedNumber: display rounding of the typed value", () => {
  const cases: Array<[string, Partial<ModelFigure>, boolean]> = [
    // [why, figure, accepted]
    ["one decimal of a two-decimal value", { valueText: "$2,318.5 million", value: 2318.47, scale: "millions" }, true],
    ["one below the rounded value fails", { valueText: "$2,318.4 million", value: 2318.47, scale: "millions" }, false],
    ["one above the rounded value fails", { valueText: "$2,318.6 million", value: 2318.47, scale: "millions" }, false],
    ["billions shown, millions typed", { valueText: "$53.8 billion", value: 53817, scale: "millions" }, true],
    ["billions shown, millions typed, last digit off", { valueText: "$53.9 billion", value: 53817, scale: "millions" }, false],
    ["two decimals shown", { valueText: "$53.82 billion", value: 53817, scale: "millions" }, true],
    ["more digits shown than typed fails", { valueText: "$2,318.47 million", value: 2318.5, scale: "millions" }, false],
    ["per share, four decimals typed", { valueText: "$2.37", value: 2.3684, scale: "units", unit: "usd_per_share" }, true],
    ["per share, last digit off", { valueText: "$2.36", value: 2.3684, scale: "units", unit: "usd_per_share" }, false],
    ["negative per share", { valueText: "-$0.43", value: -0.4271, scale: "units", unit: "usd_per_share" }, true],
    ["sign disagrees", { valueText: "$0.43", value: -0.4271, scale: "units", unit: "usd_per_share" }, false],
    ["a percent", { valueText: "41.7%", value: 41.68, scale: "units", unit: "percent" }, true],
    ["a percent, last digit off", { valueText: "41.6%", value: 41.68, scale: "units", unit: "percent" }, false],
    ["wrong unit word fails", { valueText: "$53.8 million", value: 53817, scale: "millions" }, false],
    ["a real mismatch still fails", { valueText: "$64.5 billion", value: 64601, scale: "millions" }, false],
  ];
  it.each(cases)("%s", (_why, over, accepted) => {
    expect(statedNumber(fig({ unit: "usd", ...over })) !== null).toBe(accepted);
  });
  it("the stated number is the WRITTEN one, at its own precision", () => {
    expect(statedNumber(fig({ valueText: "$53.8 billion", value: 53817, scale: "millions" }))).toEqual({ value: 53.8, decimals: 1, scale: "billions" });
  });
});

describe("statedNumber: plain dollars written for a figure typed in thousands", () => {
  it.each([
    ["$64,000", 64, true],
    ["$65,000", 64, false],
    ["negative $812,000", -812, true],
    ["$812,000", -812, false],
  ] as Array<[string, number, boolean]>)("%s typed %d thousands", (valueText, value, accepted) => {
    expect(statedNumber(fig({ valueText, value, scale: "thousands" })) !== null).toBe(accepted);
  });
  it("is read in units", () => {
    expect(statedNumber(fig({ valueText: "$64,000", value: 64, scale: "thousands" }))).toEqual({ value: 64000, decimals: 0, scale: "units" });
  });
});

describe("statedNumber: an accounting negative with the unit inside the brackets", () => {
  it.each([
    ["($41.306 million)", -41306, "thousands", "usd", true],
    ["($41.3 million)", -41.31, "millions", "usd", true],
    ["($41.4 million)", -41.31, "millions", "usd", false],
    ["($41.3 million)", 41.31, "millions", "usd", false], // the brackets say negative; the typed value does not
    ["(0.3%)", -0.3, "units", "percent", true],
    ["(0.3%)", 0.3, "units", "percent", false],
  ] as Array<[string, number, ModelFigure["scale"], ModelFigure["unit"], boolean]>)("%s typed %d %s", (valueText, value, scale, unit, accepted) => {
    expect(statedNumber(fig({ valueText, value, scale, unit })) !== null).toBe(accepted);
  });
});

describe("statedNumber: a loss word before the placeholder signs an unsigned shown text", () => {
  it("only when the caller says the words sign it, and only for a negative typed value", () => {
    const f = fig({ valueText: "$243 million", value: -243, scale: "millions" });
    expect(statedNumber(f)).toBeNull();
    expect(statedNumber(f, { signedByWord: true })).toMatchObject({ value: -243 });
    expect(statedNumber(fig({ valueText: "$244 million", value: -243, scale: "millions" }), { signedByWord: true })).toBeNull();
    // A positive typed value is untouched by the words (a loss metric matches by size).
    expect(statedNumber(fig({ valueText: "$243 million", value: 243, scale: "millions" }), { signedByWord: true })).toMatchObject({ value: 243 });
  });
});

describe("end to end: correctly rounded figures are checked", () => {
  const revDoc = incomeDoc([["Total revenues", "53,817", "48,902", "151,330", "139,004"]]);
  const rev = (valueText: string) =>
    quoteFig("f1", "q1", { valueText, value: 53817, metric: "total revenues", label: "Total revenues" });
  it("a billions rendering of a table in millions is checked", () => {
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Total revenues | 53,817 | 48,902")], [rev("$53.8 billion")]), { docs: [{ fileName: EX991, text: revDoc }] });
    expect(c.status).toBe("checked");
  });
  it("one off in the last shown digit is still refused", () => {
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Total revenues | 53,817 | 48,902")], [rev("$53.9 billion")]), { docs: [{ fileName: EX991, text: revDoc }] });
    expect(c.status).not.toBe("checked");
    expect(codes(c)).toContain("value_text_mismatch");
  });
  it("a consensus bogey written at display rounding is established; the comparison runs", () => {
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Total revenues | 53,817 | 48,902")], [
        rev("$53,817 million"),
        bogeyFig("f2", "b1", { valueText: "$52,318.5 million", value: 52318.47, unit: "usd", scale: "millions" }),
      ], [cmp("f1", "f2", "above")]),
      { docs: [{ fileName: EX991, text: revDoc }], bogeys: [bogey("b1", 52_318_471_903, { label: "Revenue consensus" })] },
    );
    expect(codes(c)).not.toContain("value_text_mismatch");
    expect(c.status).toBe("checked");
  });
  it("a bogey shown one unit off in the last digit is refused", () => {
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Total revenues | 53,817 | 48,902")], [
        rev("$53,817 million"),
        bogeyFig("f2", "b1", { valueText: "$52,318.4 million", value: 52318.47, unit: "usd", scale: "millions" }),
      ], [cmp("f1", "f2", "above")]),
      { docs: [{ fileName: EX991, text: revDoc }], bogeys: [bogey("b1", 52_318_471_903, { label: "Revenue consensus" })] },
    );
    expect(codes(c)).toContain("value_text_mismatch");
    expect(c.status).not.toBe("checked");
    expect(c.status).not.toBe("contradicted");
  });
  it("'a fair value loss of {f1}' beside a bracketed cell is checked; 'a gain of' is not", () => {
    const doc = incomeDoc([["Change in fair value of warrants", "(243)", "18", "(511)", "40"]]);
    const f = quoteFig("f1", "q1", { valueText: "$243 million", value: -243, metric: "change in fair value of warrants", label: "Change in fair value of warrants" });
    const q = [cite("q1", "Change in fair value of warrants | (243) | 18")];
    expect(one(claim("A fair value loss of {f1} weighed on results.", q, [f]), { docs: [{ fileName: EX991, text: doc }] }).status).toBe("checked");
    const gain = one(claim("A fair value gain of {f1} helped results.", q, [f]), { docs: [{ fileName: EX991, text: doc }] });
    expect(codes(gain)).toContain("value_text_mismatch");
  });
  it("a plain-dollar rendering of a table in thousands is checked", () => {
    const doc = incomeDoc([["Income from operations", "64", "(1,207)", "412", "(3,880)"]], "(In thousands, except per share amounts)");
    const f = quoteFig("f1", "q1", { valueText: "$64,000", value: 64, scale: "thousands", metric: "income from operations", label: "Income from operations" });
    expect(one(claim("Operating income was {f1}.", [cite("q1", "Income from operations | 64 | (1,207)")], [f]), { docs: [{ fileName: EX991, text: doc }] }).status).toBe("checked");
  });
});

describe("ranges written 'X to Y <unit>'", () => {
  it("scanNumbers: the unit after the second number applies to the first", () => {
    expect(scanNumbers("a range of $3.415 to $3.48 billion").map((t) => [t.value, t.wordScale])).toEqual([[3.415, "billions"], [3.48, "billions"]]);
    expect(scanNumbers("between 2.1 to 2.4 million shares").map((t) => [t.value, t.wordScale])).toEqual([[2.1, "millions"], [2.4, "millions"]]);
  });
  it("scanNumbers: no shared unit without the literal shape", () => {
    // A dollar end and a plain end are not one kind of number.
    expect(scanNumbers("$1.20 to 3.5 million shares").map((t) => [t.value, t.wordScale])).toEqual([[1.2, null], [3.5, "millions"]]);
    // The first end has its own unit: left alone.
    expect(scanNumbers("$900 million to $1.1 billion").map((t) => [t.value, t.wordScale])).toEqual([[900, "millions"], [1.1, "billions"]]);
    // Words in between: no range shape.
    expect(scanNumbers("$5 per share to $3.48 billion").map((t) => [t.value, t.wordScale])).toEqual([[5, null], [3.48, "billions"]]);
    // A percent end never borrows a scale word, and a scale word is never lent to a percent.
    expect(scanNumbers("15% to $3.48 billion").map((t) => [t.value, t.isPercent, t.wordScale])).toEqual([[15, true, null], [3.48, false, "billions"]]);
  });
  const s = "For full year 2026, we now expect operating expenses in a range of $3.415 to $3.48 billion.";
  const g = (valueText: string, value: number, basis: ModelFigure["basis"]) =>
    quoteFig("f1", "q1", { valueText, value, scale: "billions", unit: "usd", metric: "operating expenses", label: "operating expenses", basis, period: FY_26 });
  const bind = (f: ModelFigure) => one(claim("Expenses {f1}.", [cite("q1", s.replace(/\.$/, ""), false)], [f]), { docs: docsOf(`<p>Outlook</p><p>${s}</p>`) });
  it("both ends bind", () => {
    expect(bind(g("$3.415 billion", 3.415, "guidance_low")).status).toBe("checked");
    expect(bind(g("$3.48 billion", 3.48, "guidance_high")).status).toBe("checked");
  });
  it("a wrong end, a swapped end or a wrong unit still fails", () => {
    expect(codes(bind(g("$3.416 billion", 3.416, "guidance_low")))).toContain("value_not_in_quote");
    expect(codes(bind(g("$3.415 billion", 3.415, "guidance_high")))).toContain("value_not_in_quote");
    expect(codes(bind(g("$3.48 billion", 3.48, "guidance_low")))).toContain("value_not_in_quote");
    expect(codes(bind({ ...g("$3.415 million", 3.415, "guidance_low"), scale: "millions" }))).toContain("value_not_in_quote");
  });
});
