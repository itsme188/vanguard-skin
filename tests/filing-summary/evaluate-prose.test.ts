/**
 * Task 8b: the prose binder's rules, named one by one (spec §Figure checking;
 * rulings 1–6 of the task brief). Every sentence here is synthetic.
 */
import { describe, it, expect } from "vitest";
import { extractDocText } from "@/lib/filing-summary/doc-text";
import { normalizeForMatch } from "@/lib/filing-summary/locate";
import { scanNumbers, statedNumber } from "@/lib/filing-summary/evaluate-tokens";
import {
  changeRoles, headingPeriod, isHeadingBlock, isOrRestatement, leadInBlock, proseBasisClauses, quantityTokens, rangeBounds, spelledNumbers,
} from "@/lib/filing-summary/evaluate-prose";
import { isDefinitionalNonGaap, isLossMetric, proseBasisConfirmed, saysBothBases } from "@/lib/filing-summary/evaluate-words";
import type { DocText, ModelFigure, PeriodSpec } from "@/lib/filing-summary/types";
import {
  EX991, bogey, bogeyFig, cite, claim, cmp, codes, exhibit, one, period, quoteFig,
} from "./evaluate-helpers";

const P = " for the three months ended September 30, 2026";
const Q4_26: PeriodSpec = period({ role: "outlook", endDate: "2026-12-31", fiscalYear: 2026, fiscalQuarter: 4, label: "Q4 2026 outlook" });
const FY_26: PeriodSpec = period({ kind: "fiscal_year", role: "outlook", endDate: "2026-12-31", fiscalYear: 2026, label: "FY 2026 outlook" });

const docsOf = (html: string) => [{ fileName: EX991, text: extractDocText(html) }, { fileName: "t.htm", text: exhibit }];
const prose = (sentence: string, heading = "Third Quarter 2026 Results") => docsOf(`<p>${heading}</p><p>${sentence}</p>`);
type Fig = Parameters<typeof quoteFig>[2];
const usdB = (valueText: string, value: number, metric: string, label: string, over: Partial<ModelFigure> = {}): Fig =>
  ({ valueText, value, scale: "billions", unit: "usd", metric, label, ...over });
const pct = (valueText: string, value: number, metric: string, label: string, over: Partial<ModelFigure> = {}): Fig =>
  ({ valueText, value, scale: "units", unit: "percent", metric, label, ...over });
const count = (valueText: string, value: number, metric: string, label: string): Fig =>
  ({ valueText, value, scale: "units", unit: "count", metric, label });
/** One prose figure cited from `sentence`, its status and reason codes. */
function bind(sentence: string, fig: Fig, docs = prose(sentence)) {
  const c = one(claim("X {f1}.", [cite("q1", sentence.replace(/\.$/, ""), false)], [quoteFig("f1", "q1", fig)]), { docs });
  return { status: c.status, codes: codes(c), claim: c };
}
/** One prose figure compared with a reported revenue bogey of `units` dollars. */
function vsBogey(sentence: string, fig: Fig, units: number, relation: "above" | "below" | "in_line" = "above") {
  const c = one(
    claim("It was {f1} against {f2}.", [cite("q1", sentence.replace(/\.$/, ""), false)], [
      quoteFig("f1", "q1", fig),
      bogeyFig("f2", "bg", { valueText: `$${units / 1e9} billion`, value: units / 1e9, unit: "usd", scale: "billions" }),
    ], [cmp("f1", "f2", relation)]),
    { docs: prose(sentence), bogeys: [bogey("bg", units, { unit: "usd", basis: "reported", label: "Consensus" })] },
  );
  return { status: c.status, codes: codes(c) };
}

describe("ruling 1: the ', or X on a … basis' restatement exception is narrow", () => {
  const ni = (vt = "$9.0 billion", v = 9) => usdB(vt, v, "net income", "net income");
  it("o1: a different kind of number after 'or' (per share), basis after a comma: $9.0B typed reported is not checked", () => {
    const r = vsBogey(`Net income was $9.0 billion, or $2.10 per diluted share, on a non-GAAP basis${P}.`, ni(), 8e9);
    expect(r.status).toBe("unconfirmed");
    expect(r.codes).toContain("basis_unconfirmed");
  });
  it("o2: the same with no comma before the basis words is still not a restatement of $9.0B", () => {
    expect(vsBogey(`Net income was $9.0 billion, or $2.10 per diluted share on a non-GAAP basis${P}.`, ni(), 8e9).status).not.toBe("checked");
  });
  it("o3: a trailing 'excluding' clause after the or-clause denies reported", () => {
    const r = vsBogey(`Net income${P} was $9.0 billion, or $2.10 per diluted share, excluding the tax benefit.`, ni(), 8e9);
    expect(r.status).not.toBe("checked");
    expect(r.codes).toContain("basis_unconfirmed");
  });
  it("o5: 'each on a constant currency basis' covers both numbers: $64.6B typed reported is not checked", () => {
    const r = vsBogey(`Revenue was $64.6 billion${P}, or $65.1 billion, each on a constant currency basis.`, usdB("$64.6 billion", 64.6, "revenue", "revenue"), 60e9);
    expect(r.status).not.toBe("checked");
    expect(r.codes).toContain("basis_unconfirmed");
  });
  it("b5 and q2 stay checked: same kind of number, basis words directly after, no each/both/respectively", () => {
    const b5 = `Revenue was $64.60 billion${P}, an increase of 26% year-over-year, or 27% on a constant currency basis.`;
    expect(vsBogey(b5, usdB("$64.60 billion", 64.6, "revenue", "Revenue"), 64e9).status).toBe("checked");
    const q2 = `Diluted earnings per share was $1.80, or $2.10 (non-GAAP),${P}.`;
    const c = one(
      claim("EPS {f1} against {f2}.", [cite("q1", q2.replace(/\.$/, ""), false)], [
        quoteFig("f1", "q1", { valueText: "$1.80", value: 1.8, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "diluted earnings per share" }),
        bogeyFig("f2", "bg", { valueText: "$2.00", value: 2, unit: "usd_per_share", scale: "units" }),
      ], [cmp("f1", "f2", "below")]),
      { docs: prose(q2), bogeys: [bogey("bg", 2, { unit: "usd_per_share", basis: "reported", label: "EPS consensus" })] },
    );
    expect(c.status).toBe("checked");
  });
  it("isOrRestatement: unit, comma and each/both/respectively decide", () => {
    const t = (s: string) => { const ns = normalizeForMatch(s); const q = quantityTokens(ns); return isOrRestatement(ns, q, q.length - 1); };
    expect(t("revenue grew 26%, or 27% on a constant currency basis")).toBe(true);
    expect(t("EPS was $1.80, or $2.10 (non-GAAP)")).toBe(true);
    expect(t("net income was $9.0 billion, or $2.10 per diluted share on a non-GAAP basis")).toBe(false);
    expect(t("revenue grew 26%, or 27%, on a constant currency basis")).toBe(false);
    expect(t("revenue grew 26%, or 27% on a constant currency basis, respectively")).toBe(false);
    expect(t("revenue was $64.6 billion, or $65.1 billion, each on a constant currency basis")).toBe(false);
  });
});

describe("ruling 2: guidance_low binds only the low end, guidance_high only the high end", () => {
  const s = `For the three months ending December 31, 2026, we expect revenue to be between $64.5 billion and $64.7 billion.`;
  const g = (vt: string, v: number, basis: ModelFigure["basis"]) => usdB(vt, v, "revenue", "revenue", { basis, period: Q4_26 });
  it("guidance_low $64.7 billion (the upper bound) is not checked", () => {
    const r = bind(s, g("$64.7 billion", 64.7, "guidance_low"));
    expect(r.status).not.toBe("checked");
    expect(r.codes).toContain("value_not_in_quote");
  });
  it("guidance_low $64.5 billion is checked", () => {
    expect(bind(s, g("$64.5 billion", 64.5, "guidance_low")).status).toBe("checked");
  });
  it("guidance_high $64.7 billion is checked; guidance_high $64.5 billion is not", () => {
    expect(bind(s, g("$64.7 billion", 64.7, "guidance_high")).status).toBe("checked");
    expect(bind(s, g("$64.5 billion", 64.5, "guidance_high")).status).not.toBe("checked");
  });
  it("either end typed reported is range_bound", () => {
    expect(bind(s, g("$64.5 billion", 64.5, "reported")).codes).toContain("range_bound");
    expect(bind(s, g("$64.7 billion", 64.7, "reported")).codes).toContain("range_bound");
  });
  it("rangeBounds names each end's side", () => {
    const ns = normalizeForMatch(s);
    expect([...rangeBounds(ns, quantityTokens(ns)).values()]).toEqual(["low", "high"]);
  });
});

describe("ruling 3: spelled-out numbers", () => {
  it("never matches inside a hyphenated compound: 'one-time', 'ten-year', 'twenty-year'", () => {
    expect(spelledNumbers("a one-time charge under a ten-year lease and a twenty-year note")).toEqual([]);
    expect(bind(`The lease is a twenty-year lease${P}.`, count("20", 20, "lease term", "lease")).status).not.toBe("checked");
  });
  it("'twenty-five' is 25, not 5; 'ninety-nine' is 99, not 9", () => {
    expect(spelledNumbers("runs for twenty-five years").map((t) => t.value)).toEqual([25]);
    expect(spelledNumbers("a ninety-nine year lease").map((t) => t.value)).toEqual([99]);
    expect(bind(`The commitment term is twenty-five years${P}.`, count("25", 25, "commitment term", "commitment term")).status).toBe("checked");
    expect(bind(`The commitment term is twenty-five years${P}.`, count("5", 5, "commitment term", "commitment term")).status).not.toBe("checked");
    expect(bind(`The lease term is ninety-nine years${P}.`, count("9", 9, "lease term", "lease term")).status).not.toBe("checked");
  });
  it("'eight (8) years' binds 8 once: one token, never a negative", () => {
    const ns = "for eight (8) years following the date";
    expect(spelledNumbers(ns)).toEqual([{ value: 8, decimals: 0, wordScale: null, isPercent: false, start: 4, end: 13 }]);
    expect(bind(`The residency commitment runs for eight (8) years${P}.`, count("8 years", 8, "residency commitment", "residency commitment")).status).toBe("checked");
    expect(bind(`The residency commitment runs for eight (8) years${P}.`, count("-8", -8, "residency commitment", "residency commitment")).status).not.toBe("checked");
    expect(spelledNumbers("for eight (9) years")).toEqual([]);
  });
});

describe("ruling 4: change sentences", () => {
  it("'rose from $X to $Y': the current figure is Y; X typed as the current figure is not checked (r1b)", () => {
    const s = `Revenue rose from $1.5 billion to $1.6 billion${P}.`;
    expect(bind(s, usdB("$1.6 billion", 1.6, "revenue", "revenue")).status).toBe("checked");
    const x = bind(s, usdB("$1.5 billion", 1.5, "revenue", "revenue"));
    expect(x.status).not.toBe("checked");
    expect(x.codes).toContain("period_unconfirmed");
  });
  it("'increased $X to $Y' and 'decreased $X to $Y' are changes, not ranges: Y binds, X does not", () => {
    const s = `Revenue increased $9.6 billion to $64.6 billion${P}.`;
    const y = bind(s, usdB("$64.6 billion", 64.6, "revenue", "revenue"));
    expect(y.status).toBe("checked");
    expect(y.codes).not.toContain("range_bound");
    const x = bind(s, usdB("$9.6 billion", 9.6, "revenue", "revenue"));
    expect(x.status).not.toBe("checked");
    expect(x.codes).toContain("value_not_in_quote");
    expect(bind(`Net income decreased $1.0 billion to $8.0 billion${P}.`, usdB("$8.0 billion", 8, "net income", "net income")).status).toBe("checked");
  });
  it("'increased $X, or N%, to $Y': Y is the figure, N% is the growth, X is the change", () => {
    const s = `Revenue increased $9.6 billion, or 17%, to $64.6 billion${P}.`;
    expect(bind(s, usdB("$64.6 billion", 64.6, "revenue", "revenue")).status).toBe("checked");
    expect(bind(s, pct("17%", 17, "revenue", "revenue")).status).toBe("checked"); // a percent of a money measure is its growth
    const x = bind(s, usdB("$9.6 billion", 9.6, "revenue", "revenue"));
    expect(x.status).not.toBe("checked");
    expect(x.codes).toContain("value_not_in_quote");
    const ns = normalizeForMatch(s);
    expect([...changeRoles(ns, quantityTokens(ns)).values()].map((r) => r.role)).toEqual(["change", "change", "current"]);
  });
  it("'in a range from $X to $Y' is a range (r8): the lower bound typed reported is not checked", () => {
    const r = bind(`Revenue was in a range from $64.5 billion to $64.7 billion${P}.`, usdB("$64.5 billion", 64.5, "revenue", "revenue"));
    expect(r.status).not.toBe("checked");
    expect(r.codes).toContain("range_bound");
  });
  it("'A of $X would have increased by $Z to $Y': Y binds only as an excluding_item / non_gaap figure the sentence states", () => {
    const s = `Excluding the charge, income from operations of $12.99 billion would have increased by $9.89 billion to $22.88 billion${P}.`;
    const ex = usdB("$22.88 billion", 22.88, "income from operations", "income from operations", { basis: "excluding_item", basisNote: "excludes the litigation charge" });
    expect(bind(s, ex).status).toBe("checked");
    const rep = bind(s, usdB("$22.88 billion", 22.88, "income from operations", "income from operations"));
    expect(rep.status).not.toBe("checked");
    expect(rep.codes).toContain("basis_unconfirmed");
    // Without the word, even an excluding_item figure is unconfirmed (review round 1: basis on every figure).
    const bare = `Income from operations of $12.99 billion would have increased by $9.89 billion to $22.88 billion${P}.`;
    expect(bind(bare, ex).codes).toContain("basis_unconfirmed");
    expect(bind(bare, usdB("$12.99 billion", 12.99, "income from operations", "Income from operations")).status).toBe("checked");
  });
  it("a percent figure of a money metric may be the growth ('revenue grew 27%'); a margin may not be its own change", () => {
    expect(bind(`Revenue grew 27%${P}.`, pct("27%", 27, "revenue", "revenue")).status).toBe("checked");
    const m = bind(`Operating margin increased 5% to 40%${P}.`, pct("5%", 5, "operating margin", "operating margin"));
    expect(m.status).not.toBe("checked");
    expect(bind(`Operating margin increased 5% to 40%${P}.`, pct("40%", 40, "operating margin", "operating margin")).status).toBe("checked");
  });
});

describe("ruling 5: dash ranges", () => {
  it("scanNumbers: an end with no unit takes the range's unit; a scale word before the dash is no sign", () => {
    expect(scanNumbers("$73-76 billion").map((t) => [t.value, t.wordScale])).toEqual([[73, "billions"], [76, "billions"]]);
    expect(scanNumbers("between 15-17%").map((t) => [t.value, t.isPercent])).toEqual([[15, true], [17, true]]);
    expect(scanNumbers("$64.5 billion–$64.7 billion").map((t) => t.value)).toEqual([64.5, 64.7]);
    expect(scanNumbers("$1.50-$1.60").map((t) => t.value)).toEqual([1.5, 1.6]);
    expect(scanNumbers("a 2026-09-30 date").map((t) => t.value)).toEqual([]); // no unit on the right: untouched
    expect(scanNumbers("was -5%").map((t) => t.value)).toEqual([-5]);
  });
  it("'$64.5 billion–$64.7 billion' (en dash, scale on both ends) is a range: the low end typed reported is not checked (r6)", () => {
    const r = bind(`Revenue was $64.5 billion–$64.7 billion${P}.`, usdB("$64.5 billion", 64.5, "revenue", "revenue"));
    expect(r.status).not.toBe("checked");
    expect(r.codes).toContain("range_bound");
  });
  it("'$73-76 billion' (shared scale): each guidance end binds its own end only", () => {
    const s = `We expect fourth quarter 2026 total revenue to be in the range of $73-76 billion.`;
    const g = (vt: string, v: number, basis: ModelFigure["basis"]) => usdB(vt, v, "revenue", "fourth quarter 2026 total revenue", { basis, period: Q4_26 });
    expect(bind(s, g("$73 billion", 73, "guidance_low")).status).toBe("checked");
    expect(bind(s, g("$76 billion", 76, "guidance_high")).status).toBe("checked");
    expect(bind(s, g("$76 billion", 76, "guidance_low")).status).not.toBe("checked");
    expect(bind(s, g("$73 billion", 73, "guidance_high")).status).not.toBe("checked");
    expect(bind(s, g("$73 billion", 73, "reported")).codes).toContain("range_bound");
  });
  it("'between 15-17%' is a percent range", () => {
    const s = `Absent any changes to our tax landscape, we expect our fourth quarter 2026 tax rate to be between 15-17%.`;
    const g = (vt: string, v: number, basis: ModelFigure["basis"]) => pct(vt, v, "tax rate", "fourth quarter 2026 tax rate", { basis, period: Q4_26 });
    expect(bind(s, g("15%", 15, "guidance_low")).status).toBe("checked");
    expect(bind(s, g("17%", 17, "guidance_high")).status).toBe("checked");
    expect(bind(s, g("15%", 15, "guidance_high")).status).not.toBe("checked");
  });
});

describe("review round 1", () => {
  const Q3 = period({ fiscalYear: 2026, fiscalQuarter: 3 });
  it("A1: basis is judged on every quote figure: a non_gaap figure on a plain GAAP sentence is unconfirmed", () => {
    const r = bind(`Diluted earnings per share was $3.83${P}.`, { valueText: "$3.83", value: 3.83, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "Diluted earnings per share", basis: "non_gaap" });
    expect(r.status).toBe("unconfirmed");
    expect(r.codes).toEqual(["basis_unconfirmed"]);
    // reported stands absent any basis word, and fails on a contrary word in its own clause
    expect(bind(`Diluted earnings per share was $3.83${P}.`, { valueText: "$3.83", value: 3.83, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "Diluted earnings per share" }).status).toBe("checked");
    expect(bind(`Non-GAAP diluted earnings per share was $3.83${P}.`, { valueText: "$3.83", value: 3.83, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "Diluted earnings per share" }).codes).toContain("basis_unconfirmed");
  });
  it("A1 table: a row without basis words confirms reported and not non_gaap; a computed figure takes its inputs' basis", () => {
    const html = `<p>In millions</p><table><tr><td></td><td colspan="2">Three Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr><tr><td>Revenue</td><td>64,601</td><td>51,242</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(html) }];
    const row = "Revenue | 64,601 | 51,242";
    const rev = (basis: ModelFigure["basis"]) => quoteFig("f1", "q1", { valueText: "$64,601 million", value: 64601, metric: "revenue", label: "Revenue", basis });
    expect(one(claim("Revenue {f1}.", [cite("q1", row)], [rev("reported")]), { docs }).status).toBe("checked");
    expect(codes(one(claim("Revenue {f1}.", [cite("q1", row)], [rev("non_gaap")]), { docs }))).toEqual(["basis_unconfirmed"]);
    const growth = (basis: ModelFigure["basis"]) => one(claim("Revenue grew {f3} ({f1} from {f2}).", [cite("q1", row)], [
      rev("reported"),
      quoteFig("f2", "q1", { valueText: "$51,242 million", value: 51242, metric: "revenue", label: "Revenue", period: period({ endDate: "2025-09-30", label: "Q3 2025" }) }),
      { ...quoteFig("f3", "", { valueText: "26%", value: 26, unit: "percent", scale: "units", metric: "revenue", basis }), sourceKind: "computed", citationId: null, operation: "growth", inputs: ["f1", "f2"] },
    ]), { docs });
    expect(growth("reported").status).toBe("checked");
    expect(codes(growth("non_gaap"))).toContain("basis_unconfirmed");
  });
  it("A3: 'would have been $7.40' is a hypothetical figure, not a reported one", () => {
    const s = `Excluding the litigation charge, diluted earnings per share would have been $7.40${P}.`;
    const f = (basis: ModelFigure["basis"]) => ({ valueText: "$7.40", value: 7.4, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "diluted earnings per share", basis }) as Fig;
    expect(bind(s, f("reported")).codes).toContain("basis_unconfirmed");
    expect(bind(s, f("reported")).status).not.toBe("checked");
    expect(bind(s, f("excluding_item")).status).toBe("checked");
  });
  it("B1/B2: a period label never swallows the number after it ('Q3 26%', 'Q4 12 new')", () => {
    const f = usdB("$64.6 billion", 64.6, "revenue", "Revenue");
    const c1 = one(claim("Revenue was {f1} in Q3 26% above plan.", [cite("q1", `Revenue was $64.6 billion${P}`, false)], [quoteFig("f1", "q1", f)]), { docs: prose(`Revenue was $64.6 billion${P}.`) });
    expect(c1.status).toBe("figure_not_bound");
    const c2 = one(claim("Revenue was {f1}; Q4 12 new data centers.", [cite("q1", `Revenue was $64.6 billion${P}`, false)], [quoteFig("f1", "q1", f)]), { docs: prose(`Revenue was $64.6 billion${P}.`) });
    expect(c2.status).toBe("figure_not_bound");
    const ok = one(claim("Revenue was {f1} in Q3 2026, 3Q26 and Q3'26, FY26 and Q3 FY26.", [cite("q1", `Revenue was $64.6 billion${P}`, false)], [quoteFig("f1", "q1", f)]), { docs: prose(`Revenue was $64.6 billion${P}.`) });
    expect(ok.status).toBe("checked");
  });
  it("C1/C2: the cash-use sign flip refuses a gain/loss line and a label with a parenthetical; it needs a cash flow table", () => {
    const pl = `<p>(In millions)</p><table><tr><td></td><td colspan="2">Three Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr>
      <tr><td>Cash flows from investing activities</td><td></td><td></td></tr>
      <tr><td>Gain (loss) on acquisitions</td><td>(500)</td><td>20</td></tr>
      <tr><td>Net purchases (sales) of marketable securities</td><td>(700)</td><td>30</td></tr>
      <tr><td>Purchases of marketable securities</td><td>(900)</td><td>40</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(pl) }];
    const f = (vt: string, v: number, metric: string, label: string) => quoteFig("f1", "q1", { valueText: vt, value: v, scale: "millions", metric, label });
    expect(one(claim("Gain of {f1}.", [cite("q1", "Gain (loss) on acquisitions | (500) | 20")], [f("$500 million", 500, "gain (loss) on acquisitions", "Gain (loss) on acquisitions")]), { docs }).status).not.toBe("checked");
    expect(one(claim("Purchases of {f1}.", [cite("q1", "Net purchases (sales) of marketable securities | (700) | 30")], [f("$700 million", 700, "net purchases (sales) of marketable securities", "Net purchases (sales) of marketable securities")]), { docs }).status).not.toBe("checked");
    expect(one(claim("Purchases of {f1}.", [cite("q1", "Purchases of marketable securities | (900) | 40")], [f("$900 million", 900, "purchases of marketable securities", "Purchases of marketable securities")]), { docs }).status).toBe("checked");
    const noCf = [{ fileName: EX991, text: extractDocText(pl.replace("Cash flows from investing activities", "Investing")) }];
    expect(one(claim("Purchases of {f1}.", [cite("q1", "Purchases of marketable securities | (900) | 40")], [f("$900 million", 900, "purchases of marketable securities", "Purchases of marketable securities")]), { docs: noCf }).status).not.toBe("checked");
  });
  it("D1: the identical-label bypass needs a unique row label ('Family of Apps' under Revenue: and under Income from operations:)", () => {
    const seg = `<p>(In millions)</p><table><tr><td></td><td colspan="2">Three Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr>
      <tr><td>Revenue:</td><td></td><td></td></tr><tr><td>Family of Apps</td><td>63,000</td><td>50,000</td></tr>
      <tr><td>Income (loss) from operations:</td><td></td><td></td></tr><tr><td>Family of Apps</td><td>30,000</td><td>25,000</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(seg) }];
    const c = one(claim("Family of Apps revenue was {f1}.", [cite("q1", "Family of Apps | 30,000 | 25,000")], [quoteFig("f1", "q1", { valueText: "$30,000 million", value: 30000, metric: "Family of Apps", label: "Family of Apps" })]), { docs });
    expect(c.status).not.toBe("checked");
    expect(codes(c)).toContain("metric_unconfirmed");
  });
  it("E1b/E2: the heading walk stops at a periodless heading and at any table block", () => {
    const leak1 = `<p>Third Quarter 2026 Results</p><p>Revenue was $64.6 billion.</p><p>CFO Outlook Commentary</p><p>We expect total expenses to be $50.0 billion.</p>`;
    expect(bind("We expect total expenses to be $50.0 billion", usdB("$50.0 billion", 50, "total expenses", "total expenses", { period: Q3 }), docsOf(leak1)).codes).toContain("period_unconfirmed");
    const leak2 = `<table><tr><td></td><td>Three Months Ended September 30, 2026</td></tr><tr><td>Revenue</td><td>64,601</td></tr></table><p>Headcount was 66,775.</p><p>Capital expenditures are expected to be $35.0 billion.</p>`;
    expect(bind("Capital expenditures are expected to be $35.0 billion", usdB("$35.0 billion", 35, "capital expenditures", "Capital expenditures"), docsOf(leak2)).codes).toContain("period_unconfirmed");
  });
  it("F2/F3: a loss metric typed negative is loss_sign_double; a loss word signs both ends of a range; a positive loss figure still binds", () => {
    const s = "We expect Reality Labs operating losses of $18-19 billion for full year 2026";
    const fy = period({ kind: "fiscal_year", role: "outlook", endDate: "2026-12-31", fiscalYear: 2026, label: "FY 2026" });
    const rl = (vt: string, v: number, basis: ModelFigure["basis"]) => usdB(vt, v, "Reality Labs operating losses", "Reality Labs operating losses", { basis, period: fy });
    const d = docsOf(`<p>${s}.</p>`);
    const f2 = bind(s, rl("-$18 billion", -18, "guidance_low"), d);
    expect(f2.status).toBe("figure_not_bound");
    expect(f2.codes).toContain("loss_sign_double");
    const f3 = one(claim("RL losses between {f1} and {f2}.", [cite("q1", s, false)], [quoteFig("f1", "q1", rl("-$18 billion", -18, "guidance_low")), quoteFig("f2", "q1", rl("$19 billion", 19, "guidance_high"))]), { docs: d });
    expect(f3.status).toBe("figure_not_bound");
    expect(bind(s, rl("$19 billion", 19, "guidance_high"), d).status).toBe("checked");
    expect(scanNumbers("losses of $18-19 billion").map((t) => [t.value, t.signWord])).toEqual([[-18, "loss"], [-19, "loss"]]);
    // "between X and Y" / "X to Y": the sign carries too, and a loss metric typed −19 is still refused
    const b = "We expect Reality Labs operating losses of between $18 billion and $19 billion for full year 2026";
    expect(bind(b, rl("$19 billion", 19, "guidance_high"), docsOf(`<p>${b}.</p>`)).status).toBe("checked");
    expect(bind(b, rl("-$19 billion", -19, "guidance_high"), docsOf(`<p>${b}.</p>`)).codes).toContain("loss_sign_double");
  });
  it("spec case B still flags periods even when an operand's basis is unconfirmed", () => {
    const html = `<p>In millions</p><table><tr><td></td><td colspan="2">Nine Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr><tr><td>Free cash flow</td><td>11,049</td><td>29,508</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(html) }, { fileName: "t.htm", text: exhibit }];
    const c = one(claim("FCF of {f1} above the {f2} full-year figure.", [cite("q1", "Free cash flow | 11,049 | 29,508")], [
      quoteFig("f1", "q1", { valueText: "$11,049 million", value: 11049, metric: "free cash flow", label: "Free cash flow", basis: "non_gaap", period: period({ kind: "year_to_date", label: "nine months 2026" }) }),
      bogeyFig("f2", "b9", { valueText: "−$7.3 billion", value: -7.3, scale: "billions" }),
    ], [cmp("f1", "f2", "above")]), { docs, bogeys: [bogey("b9", -7.3e9, { label: "FCF", period: { kind: "fiscal_year", role: "outlook", endDate: null, fiscalYear: null, fiscalQuarter: null, anchor: "fiscal_year", label: "FY" }, basis: "non_gaap" })] });
    expect(c.status).toBe("periods_differ");
    // Free cash flow is non-GAAP by definition (review round 2), so the figure itself is established here;
    // the period difference is still the claim's status.
    expect(c.figureChecks[0].established).toBe(true);
    const rep = one(claim("FCF of {f1} above the {f2} full-year figure.", [cite("q1", "Free cash flow | 11,049 | 29,508")], [
      quoteFig("f1", "q1", { valueText: "$11,049 million", value: 11049, metric: "free cash flow", label: "Free cash flow", period: period({ kind: "year_to_date", label: "nine months 2026" }) }),
      bogeyFig("f2", "b9", { valueText: "−$7.3 billion", value: -7.3, scale: "billions" }),
    ], [cmp("f1", "f2", "above")]), { docs, bogeys: [bogey("b9", -7.3e9, { label: "FCF", period: { kind: "fiscal_year", role: "outlook", endDate: null, fiscalYear: null, fiscalQuarter: null, anchor: "fiscal_year", label: "FY" }, basis: "non_gaap" })] });
    expect(codes(rep)).toContain("basis_unconfirmed");
    expect(rep.status).toBe("periods_differ");
  });
});

describe("review round 2", () => {
  const Q3 = period({ fiscalYear: 2026, fiscalQuarter: 3 });
  const FY = period({ kind: "fiscal_year", role: "outlook", endDate: "2026-12-31", fiscalYear: 2026, label: "FY 2026" });
  const eps = (v: number, basis: ModelFigure["basis"]): Fig => ({ valueText: `$${v.toFixed(2)}`, value: v, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "diluted earnings per share", basis });

  it("1: one loss predicate: 'net loss' is a loss metric; 'net income (loss)', 'income/loss', 'gain (loss)' are not", () => {
    expect(isLossMetric("net loss")).toBe(true);
    expect(isLossMetric("Reality Labs operating losses")).toBe(true);
    expect(isLossMetric("net income (loss)")).toBe(false);
    expect(isLossMetric("income/loss from operations")).toBe(false);
    expect(isLossMetric("gain (loss) on acquisitions")).toBe(false);
    expect(isLossMetric("(loss)")).toBe(false);
  });
  it("1: inside an income-or-loss metric a reported loss keeps its sign (H6a–H6d)", () => {
    const s = `We reported a net loss of $1.2 billion${P}.`;
    expect(bind(s, usdB("$1.2 billion", 1.2, "net income (loss)", "net loss")).status).not.toBe("checked");
    expect(bind(s, usdB("-$1.2 billion", -1.2, "net income (loss)", "net loss")).status).toBe("checked");
    const r = "We expect operating income (loss) to reflect net losses of $1.2-1.5 billion for full year 2026";
    expect(bind(r, usdB("$1.5 billion", 1.5, "operating income (loss)", "operating income (loss)", { basis: "guidance_high", period: FY }), docsOf(`<p>${r}.</p>`)).status).not.toBe("checked");
    const html = `<p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td></tr><tr><td>Net income (loss)</td><td>(1,200)</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(html) }];
    const row = (vt: string, v: number) => one(claim("Net income (loss) of {f1}.", [cite("q1", "Net income (loss) | (1,200)")], [quoteFig("f1", "q1", { valueText: vt, value: v, scale: "millions", metric: "net income (loss)", label: "Net income (loss)" })]), { docs });
    expect(row("-$1,200 million", -1200).status).toBe("checked");
    expect(row("$1,200 million", 1200).status).not.toBe("checked");
    // a pure loss metric keeps the size match and the loss_sign_double refusal
    expect(bind(s, usdB("$1.2 billion", 1.2, "net loss", "net loss")).status).toBe("checked");
    expect(bind(s, usdB("-$1.2 billion", -1.2, "net loss", "net loss")).codes).toContain("loss_sign_double");
  });
  it("2: 'would otherwise have been' and 'would have come to' are hypothetical (H2a, H2b)", () => {
    for (const s of [`Without the tax benefit, diluted earnings per share would otherwise have been $7.40${P}.`, `Without the tax benefit, diluted earnings per share would have come to $7.40${P}.`]) {
      const r = bind(s, eps(7.4, "reported"));
      expect(r.status).not.toBe("checked");
      expect(r.codes).toContain("basis_unconfirmed");
    }
  });
  it("3: a lead-in block ending in ':' with basis words governs the list after it (H1; Meta's 'Excluding this charge:')", () => {
    const lead = `<p>Third Quarter 2026 Results</p><p>Excluding the litigation charge, our results would have been as follows:</p><p>Operating margin was 45%${P}.</p>`;
    const m = (basis: ModelFigure["basis"]) => pct("45%", 45, "operating margin", "Operating margin", { basis });
    expect(bind(`Operating margin was 45%${P}.`, m("reported"), docsOf(lead)).status).not.toBe("checked");
    expect(bind(`Operating margin was 45%${P}.`, m("excluding_item"), docsOf(lead)).status).toBe("checked");
    const meta = `<p>Third Quarter 2026 Financial Highlights</p><p>Third quarter 2026 costs and expenses includes a $9.89 billion charge related to this agreement. Excluding this charge, the third quarter 2026:</p><p>•Income from operations of $12.99 billion would have increased by $9.89 billion to $22.88 billion.</p><p>•Diluted EPS of $3.83 would have increased by $3.57 to $7.40.</p>`;
    const q = "Diluted EPS of $3.83 would have increased by $3.57 to $7.40";
    expect(bind(q, { ...eps(7.4, "excluding_item"), label: "Diluted EPS", period: Q3 }, docsOf(meta)).status).toBe("checked");
    expect(bind(q, { ...eps(7.4, "reported"), label: "Diluted EPS", period: Q3 }, docsOf(meta)).status).not.toBe("checked");
    // the list ends at a heading or a plain paragraph; a clause naming another basis is not overridden
    const ended = `<p>On a non-GAAP basis:</p><p>Revenue was $1.0 billion.</p><p>Later Developments</p><p>Operating margin was 45%${P}.</p>`;
    expect(bind(`Operating margin was 45%${P}.`, m("reported"), docsOf(ended)).status).toBe("checked");
    const conflict = `<p>Excluding the charge:</p><p>GAAP operating margin was 45%${P}.</p>`;
    expect(bind(`GAAP operating margin was 45%${P}.`, m("excluding_item"), docsOf(conflict)).status).not.toBe("checked");
    const doc = extractDocText(meta);
    expect(leadInBlock(doc, doc.blocks[3])).toMatch(/Excluding this charge/);
    expect(leadInBlock(doc, doc.blocks[1])).toBeNull();
  });
  it("4: free cash flow is non-GAAP by definition: typed non_gaap in a reconciliation table confirms, typed reported does not", () => {
    const html = `<p>Reconciliation of GAAP to Non-GAAP Results</p><p>(In millions)</p><table><tr><td></td><td colspan="2">Nine Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr><tr><td>Free cash flow</td><td>11,049</td><td>29,508</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(html) }];
    const nm = period({ kind: "year_to_date", label: "nine months 2026" });
    const f = (basis: ModelFigure["basis"]) => one(claim("FCF of {f1}.", [cite("q1", "Free cash flow | 11,049 | 29,508")], [quoteFig("f1", "q1", { valueText: "$11,049 million", value: 11049, metric: "free cash flow", label: "Free cash flow", period: nm, basis })]), { docs });
    expect(f("non_gaap").status).toBe("checked");
    expect(codes(f("reported"))).toEqual(["basis_unconfirmed"]);
    expect(isDefinitionalNonGaap("Adjusted EBITDA")).toBe(true);
    expect(isDefinitionalNonGaap("non-GAAP operating margin")).toBe(true);
    expect(isDefinitionalNonGaap("operating income")).toBe(false);
  });
  it("5: range ends are ordered by value after signs: 'losses of $18-19 billion' under a non-loss metric runs −19 to −18", () => {
    const s = "We expect the Reality Labs segment result to show losses of $18-19 billion for full year 2026";
    const d = docsOf(`<p>${s}.</p>`);
    const seg = (vt: string, v: number, basis: ModelFigure["basis"]) => usdB(vt, v, "Reality Labs segment result", "Reality Labs segment result", { basis, period: FY });
    expect(bind(s, seg("-$19 billion", -19, "guidance_low"), d).status).toBe("checked");
    expect(bind(s, seg("-$18 billion", -18, "guidance_high"), d).status).toBe("checked");
    expect(bind(s, seg("-$18 billion", -18, "guidance_low"), d).status).not.toBe("checked");
    expect(bind(s, seg("$19 billion", 19, "guidance_high"), d).status).not.toBe("checked");
    // under a loss metric the size match keeps 18 as the low end (H7a)
    const l = "We expect Reality Labs operating losses of $18 billion to $19 billion for full year 2026";
    expect(bind(l, usdB("$18 billion", 18, "Reality Labs operating losses", "Reality Labs operating losses", { basis: "guidance_low", period: FY }), docsOf(`<p>${l}.</p>`)).status).toBe("checked");
  });
  it("6: a 'Cash flow hedges:' section is not a cash flow statement (H5); 'Cash flows from …' and the statement's caption are", () => {
    const oci = `<p>Condensed Consolidated Statements of Comprehensive Income</p><p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td></tr><tr><td>Cash flow hedges:</td><td></td></tr><tr><td>Payments of hedge settlements reclassified</td><td>(300)</td></tr></table>`;
    const h = one(claim("Payments of {f1}.", [cite("q1", "Payments of hedge settlements reclassified | (300)")], [quoteFig("f1", "q1", { valueText: "$300 million", value: 300, scale: "millions", metric: "payments of hedge settlements reclassified", label: "Payments of hedge settlements reclassified" })]), { docs: [{ fileName: EX991, text: extractDocText(oci) }] });
    expect(h.status).not.toBe("checked");
    const cf = `<p>Condensed Consolidated Statements of Cash Flows</p><p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td></tr><tr><td>Investing</td><td></td></tr><tr><td>Purchases of marketable securities</td><td>(900)</td></tr></table>`;
    const c = one(claim("Purchases of {f1}.", [cite("q1", "Purchases of marketable securities | (900)")], [quoteFig("f1", "q1", { valueText: "$900 million", value: 900, scale: "millions", metric: "purchases of marketable securities", label: "Purchases of marketable securities" })]), { docs: [{ fileName: EX991, text: extractDocText(cf) }] });
    expect(c.status).toBe("checked");
  });
});

describe("ruling 6: classes from the real Meta 8-K, in synthetic form", () => {
  const Q3 = period({ fiscalYear: 2026, fiscalQuarter: 3 });
  const meta = `<p>Third Quarter 2026 Operational and Other Financial Highlights</p>
    <p>•Ad impressions – Ad impressions delivered across our Family of Apps increased by 10% year-over-year.</p>
    <p>•Revenue – Revenue was $64.60 billion, an increase of 26% year-over-year on both a reported and constant currency basis.</p>
    <p>•Cash flow – Cash flow from operating activities was $32.79 billion, and free cash flow was negative $2.12 billion.(1)</p>`;
  const rev = "Revenue was $64.60 billion, an increase of 26% year-over-year on both a reported and constant currency basis";

  it("a period stated in the section heading above (same page) dates the sentence: revenue is checked", () => {
    const r = bind(rev, usdB("$64.60 billion", 64.6, "revenue", "Revenue", { period: Q3 }), docsOf(meta));
    expect(r.status).toBe("checked");
  });
  it("a quarter word without a year in the heading is still unconfirmed (R5)", () => {
    const r = bind(rev, usdB("$64.60 billion", 64.6, "revenue", "Revenue", { period: Q3 }), docsOf(meta.replace("Third Quarter 2026", "Third Quarter")));
    expect(r.status).toBe("unconfirmed");
    expect(r.codes).toContain("period_unconfirmed");
  });
  it("a heading on the previous page does not count; a paragraph naming another period on the way up blocks it", () => {
    const prev = `<p>Third Quarter 2026 Highlights</p><hr style="page-break-after:always"><p>${rev}.</p>`;
    expect(bind(rev, usdB("$64.60 billion", 64.6, "revenue", "Revenue", { period: Q3 }), docsOf(prev)).codes).toContain("period_unconfirmed");
    const blocked = `<p>Third Quarter 2026 Highlights</p><p>For the nine months ended September 30, 2026, revenue was $181.7 billion.</p><p>${rev}.</p>`;
    expect(bind(rev, usdB("$64.60 billion", 64.6, "revenue", "Revenue", { period: Q3 }), docsOf(blocked)).codes).toContain("period_unconfirmed");
  });
  it("a quarter named by the paragraph (not the sentence) never says 'differ' against a figure typed as an instant", () => {
    const para = "In August 2026, we announced an agreement which provides for payments of up to approximately $18.59 billion. Third quarter 2026 costs include a $9.89 billion charge.";
    const q = "we announced an agreement which provides for payments of up to approximately $18.59 billion";
    const r = bind(q, usdB("$18.59 billion", 18.59, "settlement payments", "payments of up to approximately", { period: period({ kind: "instant", endDate: null, label: "agreement" }) }),
      docsOf(`<p>Agreement</p><p>${para}</p>`));
    expect(r.codes).toContain("period_unconfirmed");
    expect(r.codes).not.toContain("periods_differ");
    // The sentence's own period still says "differ".
    const own = bind(`Revenue was $64.60 billion for the nine months ended September 30, 2026.`, usdB("$64.60 billion", 64.6, "revenue", "revenue"));
    expect(own.codes).toContain("periods_differ");
  });
  it("a heading's quarter never says 'differ' against a figure typed as an instant", () => {
    const s = "The agreement provides for payments of up to $18.59 billion";
    const r = bind(s, usdB("$18.59 billion", 18.59, "settlement payments", "payments of up to", { period: period({ kind: "instant", endDate: null, label: "agreement" }) }),
      docsOf(`<p>Third Quarter 2026 Highlights</p><p>${s}.</p>`));
    expect(r.codes).toContain("period_unconfirmed");
    expect(r.codes).not.toContain("periods_differ");
  });
  it("a balance bullet ('as of September 30, 2026') on the way up does not block the heading", () => {
    const html = `<p>Third Quarter 2026 Operational and Other Financial Highlights</p>
      <p>•Cash, cash equivalents, and marketable securities – Cash, cash equivalents, and marketable securities were $82.45 billion as of September 30, 2026.</p>
      <p>•Cash flow – Cash flow from operating activities was $32.79 billion, and free cash flow was negative $2.12 billion.(1)</p>`;
    const fcf = "Cash flow from operating activities was $32.79 billion, and free cash flow was negative $2.12 billion";
    const r = bind(fcf, usdB("negative $2.12 billion", -2.12, "free cash flow", "free cash flow", { basis: "non_gaap", period: Q3 }), docsOf(html));
    expect(r.codes).not.toContain("period_unconfirmed");
    // Free cash flow is non-GAAP by definition (review round 2): typed non_gaap it is checked, typed reported it is not.
    expect(r.status).toBe("checked");
    expect(bind(fcf, usdB("negative $2.12 billion", -2.12, "free cash flow", "free cash flow", { period: Q3 }), docsOf(html)).codes).toEqual(["basis_unconfirmed"]);
  });
  it("a metric that is the row label word for word matches under any section header", () => {
    const html = `<p>In millions</p><table><tr><td></td><td colspan="2">Nine Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr>
      <tr><td>Cash flows from financing activities</td><td></td><td></td></tr>
      <tr><td>Repurchases of Class A common stock</td><td>—</td><td>(26,248)</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(html) }];
    const nm25 = period({ kind: "year_to_date", endDate: "2025-09-30", label: "nine months 2025" });
    const c = one(claim("Buybacks of {f1}.", [cite("q1", "Repurchases of Class A common stock | — | (26,248)")], [quoteFig("f1", "q1", { valueText: "-$26,248 million", value: -26248, scale: "millions", metric: "repurchases of Class A common stock", label: "Repurchases of Class A common stock", period: nm25 })]), { docs });
    expect(c.status).toBe("checked");
    const wrong = one(claim("Buybacks of {f1}.", [cite("q1", "Repurchases of Class A common stock | — | (26,248)")], [quoteFig("f1", "q1", { valueText: "-$26,248 million", value: -26248, scale: "millions", metric: "free cash flow", label: "Repurchases of Class A common stock", period: nm25 })]), { docs });
    expect(codes(wrong)).toContain("metric_unconfirmed");
  });
  it("isHeadingBlock / headingPeriod", () => {
    const doc: DocText = extractDocText(meta);
    expect(doc.blocks.map(isHeadingBlock)).toEqual([true, false, false, false]);
    expect(headingPeriod(doc, doc.blocks[2], "2026-10-21")).toMatchObject({ kind: "quarter", fiscalYear: 2026, fiscalQuarter: 3, role: "actual" });
  });
  it("'on both a reported and constant currency basis' denies reported to nothing; a one-basis clause still does", () => {
    expect(saysBothBases("year-over-year on both a reported and constant currency basis.")).toBe(true);
    expect(saysBothBases("on a constant currency basis.")).toBe(false);
    const ns = normalizeForMatch(rev);
    expect(proseBasisConfirmed("reported", proseBasisClauses(ns, ns.indexOf("$")))).toBe(true);
    const one1 = normalizeForMatch("Revenue was $64.60 billion, an increase of 26% year-over-year on a constant currency basis");
    expect(proseBasisConfirmed("reported", proseBasisClauses(one1, one1.indexOf("$")))).toBe(false);
  });
  it("the headline shape: heading-dated revenue against reported-quarter bogeys is checked, with the differences shown", () => {
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus and was in line with {f3}.", [cite("q6", rev, false)], [
        quoteFig("f1", "q6", usdB("$64.60 billion", 64.6, "revenue", "Revenue", { period: Q3 })),
        bogeyFig("f2", "b1", { valueText: "$63.3 billion", value: 63.3, unit: "usd", scale: "billions" }),
        bogeyFig("f3", "b2", { valueText: "$64.57 billion", value: 64.57, unit: "usd", scale: "billions" }),
      ], [cmp("f1", "f2", "above"), cmp("f1", "f3", "in_line")]),
      { docs: docsOf(meta), bogeys: [bogey("b1", 63.3e9, { label: "Consensus" }), bogey("b2", 64.57e9, { label: "Vendor consensus" })] },
    );
    expect(c.status).toBe("checked");
    expect(c.comparisonChecks.map((k) => k.verdict)).toEqual(["matches", "matches"]);
  });
  it("'negative $X' and 'a net loss of $X' are negative numbers, in valueText and in the sentence", () => {
    expect(statedNumber(quoteFig("f", "q", { valueText: "negative $2.12 billion", value: -2.12, scale: "billions" }))).toMatchObject({ value: -2.12 });
    const fcf = "Cash flow from operating activities was $32.79 billion, and free cash flow was negative $2.12 billion";
    const neg = usdB("negative $2.12 billion", -2.12, "free cash flow", "free cash flow", { basis: "non_gaap", period: Q3 });
    expect(bind(fcf, neg, docsOf(meta)).codes).not.toContain("value_not_in_quote");
    expect(bind(fcf, usdB("$2.12 billion", 2.12, "free cash flow", "free cash flow", { basis: "non_gaap", period: Q3 }), docsOf(meta)).codes).toContain("value_not_in_quote");
    const loss = `Net income was a net loss of $1.2 billion${P}.`;
    expect(bind(loss, usdB("-$1.2 billion", -1.2, "net income", "net income")).status).toBe("checked");
    expect(bind(loss, usdB("$1.2 billion", 1.2, "net income", "net income")).status).not.toBe("checked");
  });
  it("a split parenthesised table negative, '(26,248' and ')' in adjacent cells, is one number", () => {
    const html = `<p>In millions</p><table>
      <tr><td></td><td colspan="2">Nine Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr>
      <tr><td>Cash flows from financing activities</td><td></td><td></td></tr>
      <tr><td>Repurchases of Class A common stock</td><td>—</td><td>(26,248</td><td>)</td></tr>
      <tr><td>Net income (loss)</td><td>(1,200</td><td>)</td><td>900</td></tr></table>`;
    const docs = [{ fileName: EX991, text: extractDocText(html) }];
    const nm25 = period({ kind: "year_to_date", endDate: "2025-09-30", label: "nine months 2025" });
    const row = "Repurchases of Class A common stock | — | (26,248 | )";
    const buy = (vt: string, v: number) => one(claim("Buybacks of {f1}.", [cite("q1", row)], [quoteFig("f1", "q1", { valueText: vt, value: v, scale: "millions", metric: "repurchases of Class A common stock", label: "Repurchases of Class A common stock", period: nm25 })]), { docs });
    expect(buy("-$26,248 million", -26248).status).toBe("checked");
    // A cash USE stated as the amount spent matches the parenthesised outflow (financial sense, task 8b).
    expect(buy("$26,248 million", 26248).status).toBe("checked");
    const ni = "Net income (loss) | (1,200 | ) | 900";
    const net = one(claim("Net income of {f1}.", [cite("q1", ni)], [quoteFig("f1", "q1", { valueText: "$1,200 million", value: 1200, scale: "millions", metric: "net income", label: "Net income (loss)", period: period({ kind: "year_to_date", label: "nine months 2026" }) })]), { docs });
    expect(net.status).not.toBe("checked");
    expect(codes(net)).toContain("value_not_in_quote");
  });
  it("a bare year the sentence speaks for is that fiscal year; a comparison year is not", () => {
    const s = `We anticipate 2026 capital expenditures, including principal payments on finance leases, to be in the range of $135-145 billion, narrowed from our prior outlook of $130-145 billion.`;
    const d = docsOf(`<p>CFO Outlook Commentary</p><p>${s}</p>`);
    expect(bind(s, usdB("$135 billion", 135, "capital expenditures", "2026 capital expenditures", { basis: "guidance_low", period: FY_26 }), d).status).toBe("checked");
    expect(bind(s, usdB("$145 billion", 145, "capital expenditures", "2026 capital expenditures", { basis: "guidance_high", period: FY_26 }), d).status).toBe("checked");
    const rl = `At a segment level, we now expect Reality Labs losses to decline compared to 2025 to a range of $18-19 billion.`;
    const r = bind(rl, usdB("$18 billion", 18, "Reality Labs losses", "Reality Labs losses", { basis: "guidance_low", period: FY_26 }), docsOf(`<p>CFO Outlook Commentary</p><p>${rl}</p>`));
    expect(r.codes).toContain("period_unconfirmed");
  });
  it("a guidance range against the reported quarter's actual is periods_differ, not unconfirmed (the typed fiscal fields travel with a dated column)", () => {
    const s = `We expect our fourth quarter 2026 tax rate to be between 15-17%.`;
    const c = one(
      claim("Guided to {f1} to {f2}, below {f3}.", [cite("q1", s.replace(/\.$/, ""), false), cite("q2", "Effective tax rate | 24 | % | 87 | %")], [
        quoteFig("f1", "q1", pct("15%", 15, "tax rate", "fourth quarter 2026 tax rate", { basis: "guidance_low", period: Q4_26 })),
        quoteFig("f2", "q1", pct("17%", 17, "tax rate", "fourth quarter 2026 tax rate", { basis: "guidance_high", period: Q4_26 })),
        quoteFig("f3", "q2", pct("24%", 24, "effective tax rate", "Effective tax rate", { period: Q3 })),
      ], [{ left: "f1", leftHigh: "f2", right: "f3", rightHigh: null, relation: "below" }]),
      { docs: docsOf(`<p>CFO Outlook Commentary</p><p>${s}</p><p>In millions, except percentages</p><table><tr><td></td><td colspan="2">Three Months Ended September 30,</td></tr><tr><td></td><td>2026</td><td>2025</td></tr><tr><td>Effective tax rate</td><td>24</td><td>%</td><td>87</td><td>%</td></tr></table>`) },
    );
    expect(c.status).toBe("periods_differ");
  });
});
