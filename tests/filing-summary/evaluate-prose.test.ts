/**
 * Task 8b: the prose binder's rules, named one by one (spec §Figure checking;
 * rulings 1–6 of the task brief). Every sentence here is synthetic.
 */
import { describe, it, expect } from "vitest";
import { extractDocText } from "@/lib/filing-summary/doc-text";
import { normalizeForMatch } from "@/lib/filing-summary/locate";
import { scanNumbers, statedNumber } from "@/lib/filing-summary/evaluate-tokens";
import {
  changeRoles, headingPeriod, isHeadingBlock, isOrRestatement, proseBasisClauses, quantityTokens, rangeBounds, spelledNumbers,
} from "@/lib/filing-summary/evaluate-prose";
import { proseBasisConfirmed, saysBothBases } from "@/lib/filing-summary/evaluate-words";
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
  it("'A of $X would have increased by $Z to $Y': Y binds only as an excluding_item / non_gaap figure", () => {
    const s = `Income from operations of $12.99 billion would have increased by $9.89 billion to $22.88 billion${P}.`;
    const ex = usdB("$22.88 billion", 22.88, "income from operations", "Income from operations", { basis: "excluding_item", basisNote: "excludes the litigation charge" });
    expect(bind(s, ex).status).toBe("checked");
    const rep = bind(s, usdB("$22.88 billion", 22.88, "income from operations", "Income from operations"));
    expect(rep.status).not.toBe("checked");
    expect(rep.codes).toContain("basis_unconfirmed");
    expect(bind(s, usdB("$12.99 billion", 12.99, "income from operations", "Income from operations")).status).toBe("checked");
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
