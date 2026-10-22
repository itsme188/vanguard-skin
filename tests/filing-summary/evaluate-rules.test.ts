/**
 * Review round 1 regressions for the filing-summary checker: each case once
 * produced a false Checked or a false Contradicted.
 */
import { describe, it, expect } from "vitest";
import { extractDocText } from "@/lib/filing-summary/doc-text";
import { metricMatchesLabel } from "@/lib/filing-summary/evaluate-words";
import { clauseAt } from "@/lib/filing-summary/evaluate-figures";
import { latestQuarterEnd, sectionAnchors, tableContext } from "@/lib/filing-summary/evaluate-periods";
import { REASON_CODES, renderClaimText } from "@/lib/filing-summary/evaluate";
import type { DocText, PeriodSpec } from "@/lib/filing-summary/types";
import {
  EVENT_DATE, EX991, Q3_26, NM_26, THIS_QUARTER, FY_OUTLOOK,
  bogey, bogeyFig, cite, claim, cmp, codes, computedFig, exhibit, one, period, quoteFig, revenueQ3,
} from "./evaluate-helpers";

const docs = (text: DocText, fileName = EX991) => [{ fileName, text }];
const P3_25 = period({ endDate: "2025-09-30", label: "Q3 2025" });
const Q3_FY = (role: "actual" | "outlook") => period({ endDate: null, fiscalYear: 2026, fiscalQuarter: 3, role });
const NEXT_QUARTER: PeriodSpec = { ...THIS_QUARTER, role: "outlook", anchor: "next_quarter", label: "next quarter outlook" };

describe("item 1: metric identity", () => {
  it.each([
    ["net revenue", "Net income"],
    ["net sales", "Net income"],
    ["total revenue", "Total costs and expenses"],
    ["operating income", "Operating expenses"],
    ["operating income", "Total operating expenses"],
    ["operating cash flow", "Income from operations"],
    ["non-GAAP diluted EPS", "Diluted"],
    ["gross margin", "Gross profit"],
  ])("metric %j never confirms label %j", (metric, label) => {
    expect(metricMatchesLabel(metric, label)).toBe(false);
  });

  it.each([
    ["revenue", "Total revenue"],
    ["net income", "Net income"],
    ["operating income", "Income from operations"],
    ["diluted EPS", "Diluted earnings per share (EPS)"],
    ["free cash flow", "Free cash flow"],
    ["operating cash flow", "Net cash provided by operating activities"],
  ])("metric %j still confirms label %j", (metric, label) => {
    expect(metricMatchesLabel(metric, label)).toBe(true);
  });

  it("the row's section header is part of its label: 'Diluted' under 'Earnings per share:' is EPS", () => {
    expect(metricMatchesLabel("diluted EPS", "Diluted", { section: "Earnings per share:" })).toBe(true);
    expect(metricMatchesLabel("diluted EPS", "Diluted", { section: "Weighted-average shares used to compute earnings per share:" })).toBe(false);
  });

  const segment = extractDocText(
    "<p>(In millions)</p><table>" +
      "<tr><td></td><td>Three Months Ended September 30, 2026</td><td>Three Months Ended September 30, 2025</td></tr>" +
      "<tr><td>Revenue:</td><td></td><td></td></tr><tr><td>Family of Apps</td><td>63,000</td><td>50,000</td></tr>" +
      "<tr><td>Income (loss) from operations:</td><td></td><td></td></tr><tr><td>Family of Apps</td><td>24,965</td><td>21,000</td></tr>" +
      "</table>",
  );
  const famRev = (quote: string, value: number) =>
    claim("Family of Apps revenue was {f1}.", [cite("q1", quote)], [
      quoteFig("f1", "q1", { valueText: `$${value.toLocaleString("en-US")} million`, value, metric: "Family of Apps revenue", label: "Family of Apps" }),
    ]);

  it("segment: 'Family of Apps revenue' bound to the row under 'Income (loss) from operations:' is metric_unconfirmed", () => {
    const c = one(famRev("Family of Apps | 24,965", 24965), { docs: docs(segment) });
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["metric_unconfirmed"]);
  });

  it("segment: the same label under 'Revenue:' is checked", () => {
    expect(one(famRev("Family of Apps | 63,000", 63000), { docs: docs(segment) }).status).toBe("checked");
  });
});

describe("item 2: prose labels", () => {
  const sentence = extractDocText("<p>Operating income was $12.99 billion in the third quarter of 2026, compared with $10.0 billion.</p>");
  const prose = (metric: string, label: string) =>
    claim("It was {f1}.", [cite("q1", "Operating income was $12.99 billion in the third quarter of 2026")], [
      quoteFig("f1", "q1", { valueText: "$12.99 billion", value: 12.99, scale: "billions", metric, label, period: Q3_FY("actual") }),
    ]);

  it("metric 'net income' with label 'income' in 'Operating income was …' is not checked (metric_unconfirmed)", () => {
    const c = one(prose("net income", "income"), { docs: docs(sentence) });
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("metric_unconfirmed");
  });

  it("the full phrase with the right metric is checked", () => {
    expect(one(prose("operating income", "income"), { docs: docs(sentence) }).status).toBe("checked");
  });

  it("a label must sit at word boundaries ('come' is not a phrase of 'income')", () => {
    const c = one(prose("operating income", "come"), { docs: docs(sentence) });
    expect(codes(c)).toContain("label_not_in_quote");
  });
});

describe("item 3: basis needs source evidence", () => {
  it("a GAAP 'Diluted' row typed non_gaap, compared above a non-GAAP consensus, is unconfirmed (basis_unconfirmed)", () => {
    const c = one(
      claim("Diluted EPS of {f1} beat the {f2} adjusted consensus.", [cite("q1", "Diluted | 7.25")], [
        quoteFig("f1", "q1", { valueText: "$7.25", value: 7.25, unit: "usd_per_share", scale: "units", metric: "diluted EPS", label: "Diluted", basis: "non_gaap" }),
        bogeyFig("f2", "b5.x.eps", { valueText: "$7.00", value: 7, unit: "usd_per_share", scale: "units" }),
      ], [cmp("f1", "f2", "above")]),
      { bogeys: [bogey("b5.x.eps", 7, { unit: "usd_per_share", basis: "non_gaap", label: "Adjusted EPS" })] },
    );
    expect(c.status).toBe("unconfirmed");
    expect(c.comparisonChecks[0].reasons.map((r) => r.code)).toEqual(["basis_unconfirmed"]);
  });

  const recon = extractDocText(
    "<p>Reconciliation of GAAP to Non-GAAP Results</p><p>(In millions, except per share amounts)</p><table>" +
      '<tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>' +
      "<tr><td></td><td>GAAP</td><td>Non-GAAP</td></tr>" +
      "<tr><td>Revenue</td><td>64,601</td><td>64,601</td></tr>" +
      "<tr><td>Earnings per share:</td><td></td><td></td></tr>" +
      "<tr><td>Diluted</td><td>7.25</td><td>7.40</td></tr></table>",
  );
  const epsVs = (basis: "non_gaap" | "reported", metric: string) =>
    one(
      claim("Diluted EPS of {f1} beat the {f2} consensus.", [cite("q1", "Diluted | 7.25 | 7.40")], [
        quoteFig("f1", "q1", { valueText: "$7.40", value: 7.4, unit: "usd_per_share", scale: "units", metric, label: "Diluted", basis }),
        bogeyFig("f2", "b5.x.eps", { valueText: "$7.30", value: 7.3, unit: "usd_per_share", scale: "units" }),
      ], [cmp("f1", "f2", "above")]),
      { docs: docs(recon), bogeys: [bogey("b5.x.eps", 7.3, { unit: "usd_per_share", basis: "non_gaap", label: "Adjusted EPS" })] },
    );

  it("reconciliation table: the non-GAAP column's EPS typed non_gaap is checked against a non-GAAP consensus", () => {
    expect(epsVs("non_gaap", "non-GAAP diluted EPS").status).toBe("checked");
  });

  it("reconciliation table: the same non-GAAP cell typed reported is basis_unconfirmed, never checked", () => {
    const c = epsVs("reported", "diluted EPS");
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("basis_unconfirmed");
  });

  it("reconciliation table: a value printed in both columns binds to the column of the typed basis", () => {
    const rev = (basis: "reported" | "non_gaap") =>
      one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3({ basis })]), { docs: docs(recon) });
    expect(rev("reported").status).toBe("checked");
    expect(rev("non_gaap").status).toBe("checked");
  });
});

describe("item 4: source rounding as intervals", () => {
  const epsDoc = extractDocText(
    "<p>(In millions, except per share amounts)</p><table>" +
      "<tr><td></td><td>Three Months Ended September 30, 2026</td><td>Three Months Ended September 30, 2025</td></tr>" +
      "<tr><td>Earnings per share:</td><td></td><td></td></tr><tr><td>Diluted</td><td>7.25</td><td>6.03</td></tr></table>",
  );
  const eps = (id: string, valueText: string, value: number, p: PeriodSpec) =>
    quoteFig(id, "q1", { valueText, value, unit: "usd_per_share", scale: "units", metric: "diluted EPS", label: "Diluted", period: p });

  it("diluted EPS 7.25 vs 6.03 with stated growth 20.4% is not contradicted (within_rounding)", () => {
    const c = one(
      claim("Diluted EPS of {f1} vs {f2} grew {f3}.", [cite("q1", "Diluted | 7.25 | 6.03")], [
        eps("f1", "$7.25", 7.25, Q3_26), eps("f2", "$6.03", 6.03, P3_25),
        computedFig("f3", { valueText: "20.4%", value: 20.4, metric: "EPS growth", operation: "growth", inputs: ["f1", "f2"] }),
      ]),
      { docs: docs(epsDoc) },
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["within_rounding"]);
  });

  it("the same inputs with a stated 25% are contradicted (outside the whole interval)", () => {
    const c = one(
      claim("Diluted EPS of {f1} vs {f2} grew {f3}.", [cite("q1", "Diluted | 7.25 | 6.03")], [
        eps("f1", "$7.25", 7.25, Q3_26), eps("f2", "$6.03", 6.03, P3_25),
        computedFig("f3", { valueText: "25%", value: 25, metric: "EPS growth", operation: "growth", inputs: ["f1", "f2"] }),
      ]),
      { docs: docs(epsDoc) },
    );
    expect(c.status).toBe("contradicted");
  });

  it("EPS $7.25 'below' a $7.2549 consensus is not contradicted, and not checked (within_rounding)", () => {
    const mk = (relation: "below" | "above") =>
      one(
        claim("Diluted EPS of {f1} vs the {f2} consensus.", [cite("q1", "Diluted | 7.25 | 6.03")], [
          eps("f1", "$7.25", 7.25, Q3_26),
          bogeyFig("f2", "b5.x.eps", { valueText: "$7.2549", value: 7.2549, unit: "usd_per_share", scale: "units" }),
        ], [cmp("f1", "f2", relation)]),
        { docs: docs(epsDoc), bogeys: [bogey("b5.x.eps", 7.2549, { unit: "usd_per_share", label: "EPS" })] },
      );
    for (const rel of ["below", "above"] as const) {
      const c = mk(rel);
      expect(c.status).toBe("unconfirmed");
      expect(codes(c)).toContain("within_rounding");
    }
  });

  it("Meta-shaped revenue 64,601 vs 64.57B 'below' is still contradicted (wrong over the whole interval)", () => {
    const c = one(
      claim("Revenue of {f1} was below the {f2} consensus.", [cite("q1", "Revenue | 64,601")],
        [revenueQ3(), bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions" })],
        [cmp("f1", "f2", "below")]),
      { bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("contradicted");
    expect(codes(c)).not.toContain("within_rounding");
  });
});

describe("item 5: actual vs guidance for the same quarter (comparisons only)", () => {
  const guide = extractDocText(
    "<p>Revenue was $64.60 billion for the third quarter of 2026.</p>" +
      "<p>Our outlook for third quarter 2026 revenue had a low end of $62.0 billion.</p>" +
      "<p>Our outlook for third quarter 2026 revenue had a high end of $65.0 billion.</p>",
  );
  it("Q3 actual revenue vs that quarter's guidance range is judged in_line, not periods_differ", () => {
    const c = one(
      claim("Revenue of {f1} landed inside the {f2} to {f3} outlook.", [
        cite("q1", "Revenue was $64.60 billion for the third quarter of 2026."),
        cite("q2", "Our outlook for third quarter 2026 revenue had a low end of $62.0 billion."),
        cite("q3", "Our outlook for third quarter 2026 revenue had a high end of $65.0 billion."),
      ], [
        quoteFig("f1", "q1", { valueText: "$64.60 billion", value: 64.6, scale: "billions", metric: "revenue", label: "Revenue", period: Q3_FY("actual") }),
        quoteFig("f2", "q2", { valueText: "$62.0 billion", value: 62, scale: "billions", metric: "revenue", label: "revenue", period: Q3_FY("outlook"), basis: "guidance_low" }),
        quoteFig("f3", "q3", { valueText: "$65.0 billion", value: 65, scale: "billions", metric: "revenue", label: "revenue", period: Q3_FY("outlook"), basis: "guidance_high" }),
      ], [{ left: "f1", leftHigh: null, right: "f2", rightHigh: "f3", relation: "in_line" }]),
      { docs: docs(guide) },
    );
    expect(c.comparisonChecks[0].verdict).toBe("matches");
    expect(c.status).toBe("checked");
  });
});

describe("item 6: anchors resolve across the section", () => {
  it("latestQuarterEnd ignores a quarter column ending after the event date", () => {
    const t = extractDocText(
      "<p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td><td>Three Months Ending December 31, 2026</td></tr>" +
        "<tr><td>Revenue</td><td>64,601</td><td>68,000</td></tr></table>",
    ).tables[0];
    expect(latestQuarterEnd(tableContext(t), EVENT_DATE)).toBe("2026-09-30");
  });

  it("reported_quarter resolves from any table of the section, so a prose operand in another document resolves", () => {
    const prose = extractDocText("<p>Revenue was $64.60 billion for the quarter ended September 30, 2026.</p>");
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue was $64.60 billion for the quarter ended September 30, 2026.", false, "cover.htm")],
        [quoteFig("f1", "q1", { valueText: "$64.60 billion", value: 64.6, scale: "billions", metric: "revenue", label: "Revenue" }),
          bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions" })],
        [cmp("f1", "f2", "above")]),
      { docs: [{ fileName: "cover.htm", text: prose }, { fileName: EX991, text: exhibit }], bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("checked");
  });

  it("with no quarter column anywhere, reported_quarter stays unconfirmed", () => {
    const prose = extractDocText("<p>Revenue was $64.60 billion for the quarter ended September 30, 2026.</p>");
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue was $64.60 billion for the quarter ended September 30, 2026.")],
        [quoteFig("f1", "q1", { valueText: "$64.60 billion", value: 64.6, scale: "billions", metric: "revenue", label: "Revenue" }),
          bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions" })],
        [cmp("f1", "f2", "above")]),
      { docs: docs(prose), bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("period_unconfirmed");
  });

  const outlook = extractDocText(
    "<p>For the quarter ending December 31, 2026, we expect revenue of at least $66.0 billion.</p>" +
      "<p>We expect full year 2026 total expenses of at most $118.0 billion.</p><p>Our fiscal year ends December 31, 2026.</p>",
  );
  const section = [{ fileName: "outlook.htm", text: outlook }, { fileName: EX991, text: exhibit }];

  it("next_quarter = the quarter ending three months after the reported quarter (month-end)", () => {
    expect(sectionAnchors([{ text: exhibit }], EVENT_DATE)).toEqual({ reportedQuarter: "2026-09-30", fiscalYearEnd: null });
    const c = one(
      claim("The fourth-quarter outlook low end of {f1} sits above the {f2} next-quarter consensus.", [
        cite("q1", "For the quarter ending December 31, 2026, we expect revenue of at least $66.0 billion.", false, "outlook.htm"),
      ], [
        quoteFig("f1", "q1", { valueText: "$66.0 billion", value: 66, scale: "billions", metric: "revenue", label: "revenue",
          period: period({ endDate: "2026-12-31", role: "outlook", label: "Q4 2026 outlook" }), basis: "guidance_low" }),
        bogeyFig("f2", "b8.x.nq", { valueText: "$65.5B", value: 65.5, scale: "billions" }),
      ], [cmp("f1", "f2", "above")]),
      { docs: section, bogeys: [bogey("b8.x.nq", 65.5e9, { period: NEXT_QUARTER, label: "Revenue next quarter" })] },
    );
    expect(c.status).toBe("checked");
  });

  it("fiscal_year resolves only when the filing states a year-end", () => {
    expect(sectionAnchors(section, EVENT_DATE).fiscalYearEnd).toBe("2026-12-31");
    const yearEndColumn = extractDocText(
      "<p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td><td>Year Ended December 31, 2025</td></tr>" +
        "<tr><td>Revenue</td><td>64,601</td><td>200,966</td></tr></table>",
    );
    expect(sectionAnchors([{ text: yearEndColumn }], EVENT_DATE).fiscalYearEnd).toBe("2026-12-31");

    const fyClaim = (d: Array<{ fileName: string; text: DocText }>) =>
      one(
        claim("Full-year expenses guided to {f1}, below the {f2} Street figure.", [
          cite("q1", "We expect full year 2026 total expenses of at most $118.0 billion", false, "outlook.htm"),
        ], [
          quoteFig("f1", "q1", { valueText: "$118.0 billion", value: 118, scale: "billions", metric: "total expenses", label: "total expenses",
            period: period({ kind: "fiscal_year", role: "outlook", endDate: null, fiscalYear: 2026, label: "FY 2026 outlook" }), basis: "guidance_high" }),
          bogeyFig("f2", "b9.x.exp", { valueText: "$120B", value: 120, scale: "billions" }),
        ], [cmp("f1", "f2", "below")]),
        { docs: d, bogeys: [bogey("b9.x.exp", 120e9, { period: FY_OUTLOOK, label: "Total expenses" })] },
      );
    expect(fyClaim(section).status).toBe("checked");
    const noYearEnd = extractDocText("<p>We expect full year 2026 total expenses of at most $118.0 billion.</p>");
    const c = fyClaim([{ fileName: "outlook.htm", text: noYearEnd }, { fileName: EX991, text: exhibit }]);
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("period_unconfirmed");
  });
});

describe("item 7: growth needs one measure", () => {
  it("growth of revenue over net income is unconfirmed (metric_unconfirmed), never contradicted", () => {
    const c = one(
      claim("It grew {f1}, from {f3} to {f2}.", [cite("q1", "Revenue | 181,712"), cite("q2", "Net income | 52,481 | 37,690")], [
        computedFig("f1", { valueText: "382%", value: 382, metric: "growth", period: NM_26, operation: "growth", inputs: ["f2", "f3"] }),
        quoteFig("f2", "q1", { valueText: "$181,712 million", value: 181712, metric: "revenue", label: "Revenue", period: NM_26 }),
        quoteFig("f3", "q2", { valueText: "$37,690 million", value: 37690, metric: "net income", label: "Net income",
          period: period({ kind: "year_to_date", endDate: "2025-09-30" }) }),
      ]),
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("metric_unconfirmed");
  });
});

describe("item 8: R1 digits", () => {
  it("'Item' is capital-I with a one- or two-digit number and an optional two-digit part", () => {
    expect(renderClaimText(claim("Under Item 2.02 the company reported.", [])).unbound).toBe(false);
    expect(renderClaimText(claim("Items 64.6 billion", [])).unbound).toBe(true);
    expect(renderClaimText(claim("under item 2.02", [])).unbound).toBe(true);
    expect(renderClaimText(claim("Item 123 was cited", [])).unbound).toBe(true);
  });

  it("a digit in a figure's valueText besides its number makes the claim figure_not_bound", () => {
    for (const vt of ["$64.6B, a 3-year high", "$64.6B (10-Q)", "$64.6B, up from 2019"]) {
      const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3({ valueText: vt, value: 64.6, scale: "billions" })]));
      expect(c.status).toBe("figure_not_bound");
      expect(codes(c)).toContain("unbound_value_text");
    }
  });
});

describe("item 9: precedence follows types.ts", () => {
  it("figure_not_bound outranks periods_differ", () => {
    const c = one(claim("Revenue of {f1} rose 26%.", [cite("q1", "Revenue | 51,242")], [revenueQ3({ valueText: "$51,242 million", value: 51242 })]));
    expect(codes(c)).toEqual(expect.arrayContaining(["unbound_digit", "periods_differ"]));
    expect(c.status).toBe("figure_not_bound");
  });

  it("new codes are listed", () => {
    for (const code of ["within_rounding", "unbound_value_text"]) expect(REASON_CODES).toContain(code);
  });
});

describe("real-shape follow-ups (smoke check on the Meta exhibit)", () => {
  it("a balance-sheet row under 'Current assets:' keeps its own label: cash and cash equivalents is checked", () => {
    const bs = extractDocText(
      "<p>(In millions)</p><table><tr><td></td><td>September 30, 2026</td><td>December 31, 2025</td></tr>" +
        "<tr><td>Current assets:</td><td></td><td></td></tr><tr><td>Cash and cash equivalents</td><td>11,222</td><td>35,873</td></tr></table>",
    );
    const c = one(
      claim("Cash was {f1}.", [cite("q1", "Cash and cash equivalents | 11,222")], [
        quoteFig("f1", "q1", { valueText: "$11,222 million", value: 11222, metric: "cash and cash equivalents", label: "Cash and cash equivalents",
          period: period({ kind: "instant" }) }),
      ]),
      { docs: docs(bs) },
    );
    expect(c.status).toBe("checked");
  });

  it("text ending the previous page (a non-GAAP disclosure) is not the caption of a table on the next page", () => {
    const html =
      "<p>We use the non-GAAP financial measures below; GAAP results are reconciled at the end.</p>" +
      '<hr style="page-break-after:always"/>' +
      "<p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td><td>Three Months Ended September 30, 2025</td></tr>" +
      "<tr><td>Revenue</td><td>64,601</td><td>51,242</td></tr></table>";
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue | 64,601")],
        [revenueQ3(), bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions" })],
        [cmp("f1", "f2", "above")]),
      { docs: docs(extractDocText(html)), bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("checked");
  });
});

describe("fix round 2", () => {
  const ccSentence =
    "Revenue was $64.60 billion for the three months ended September 30, 2026, an increase of 26% year-over-year, or 27% on a constant currency basis.";
  const ccDocs = [{ fileName: EX991, text: extractDocText(`<p>${ccSentence}</p>`) }, { fileName: "t.htm", text: exhibit }];
  const ccQuote = cite("q1", "Revenue was $64.60 billion for the three months ended September 30, 2026", false);

  it("clauses: basis words belong to the number in their own clause", () => {
    const s = ccSentence.toLowerCase();
    expect(clauseAt(s, s.indexOf("26%"))).toBe("an increase of 26% year-over-year");
    expect(clauseAt(s, s.indexOf("27%"))).toContain("constant currency");
    expect(clauseAt(s, s.indexOf("$64.60"))).not.toContain("constant currency");
  });

  it("item 1: the reported 26% typed constant_currency, 'below' a 26.8% constant-currency guide, is not checked (basis_unconfirmed)", () => {
    const c = one(
      claim("Revenue grew {f1}, below the {f2} constant-currency guide.", [ccQuote], [
        quoteFig("f1", "q1", { valueText: "26%", value: 26, unit: "percent", scale: "units", metric: "revenue", label: "Revenue", basis: "constant_currency" }),
        bogeyFig("f2", "g", { valueText: "26.8%", value: 26.8, unit: "percent", scale: "units" }),
      ], [cmp("f1", "f2", "below")]),
      { docs: ccDocs, bogeys: [bogey("g", 26.8, { unit: "percent", basis: "constant_currency", label: "Revenue growth cc" })] },
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("basis_unconfirmed");
  });

  it("item 1: reported revenue in a sentence that also gives a constant-currency rate is checked against a reported consensus", () => {
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [ccQuote], [
        quoteFig("f1", "q1", { valueText: "$64.60 billion", value: 64.6, scale: "billions", metric: "revenue", label: "Revenue" }),
        bogeyFig("f2", "rev", { valueText: "$64.0 billion", value: 64, scale: "billions" }),
      ], [cmp("f1", "f2", "above")]),
      { docs: ccDocs, bogeys: [bogey("rev", 64e9)] },
    );
    expect(c.status).toBe("checked");
  });

  it("item 2: 'attributable to common stockholders' is a standard tail; the noncontrolling-interest row is a different figure", () => {
    expect(metricMatchesLabel("net income", "Net income attributable to common stockholders")).toBe(true);
    expect(metricMatchesLabel("net income", "Net income attributable to Class A shareholders")).toBe(false);
    expect(metricMatchesLabel("net income", "Net income attributable to noncontrolling interests")).toBe(false);
    const nci = extractDocText(
      "<p>(In millions)</p><table><tr><td></td><td>Three Months Ended September 30, 2026</td><td>Three Months Ended September 30, 2025</td></tr>" +
        "<tr><td>Net income attributable to noncontrolling interests</td><td>120</td><td>95</td></tr></table>",
    );
    const c = one(
      claim("Net income was {f1}.", [cite("q1", "Net income attributable to noncontrolling interests | 120")], [
        quoteFig("f1", "q1", { valueText: "$120 million", value: 120, metric: "net income", label: "Net income attributable to noncontrolling interests" }),
      ]),
      { docs: docs(nci) },
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["metric_unconfirmed"]);
  });

  it("item 3: an Item number may end a sentence ('Item 2.02.', 'Item 7.')", () => {
    expect(renderClaimText(claim("Revenue {f1}, per Item 2.02.", [], [revenueQ3({ valueText: "$1B", value: 1, scale: "billions" })])).unbound).toBe(false);
    expect(renderClaimText(claim("The risk factors sit under Item 7.", [])).unbound).toBe(false);
    expect(renderClaimText(claim("Under Item 2.0 nothing changed.", [])).unbound).toBe(true);
  });
});

describe("fix round 3: basis from the number's clause plus quantity-free clauses; dates never pair", () => {
  const P = " for the three months ended September 30, 2026";
  const prose = (sentence: string) => [
    { fileName: EX991, text: extractDocText(`<p>Third Quarter 2026 Results</p><p>${sentence}</p>`) },
    { fileName: "t.htm", text: exhibit },
  ];
  const vsBogey = (
    sentence: string,
    fig: Parameters<typeof quoteFig>[2],
    b: { value: number; valueText: string; unit: "usd" | "usd_per_share" | "percent"; scale: "units" | "billions"; units: number; basis?: "reported" | "non_gaap" | "constant_currency" },
  ) =>
    one(
      claim("It was {f1} against {f2}.", [cite("q1", sentence.replace(/\.$/, ""), false)], [
        quoteFig("f1", "q1", fig),
        bogeyFig("f2", "bg", { valueText: b.valueText, value: b.value, unit: b.unit, scale: b.scale }),
      ], [cmp("f1", "f2", "above")]),
      { docs: prose(sentence), bogeys: [bogey("bg", b.units, { unit: b.unit, basis: b.basis ?? "reported", label: "Consensus" })] },
    );
  const eps = (basis: "reported" | "non_gaap") =>
    ({ valueText: "$2.10", value: 2.1, scale: "units", unit: "usd_per_share", metric: "diluted EPS", label: "diluted earnings per share", basis }) as const;
  const epsBogey = (basis: "reported" | "non_gaap") =>
    ({ valueText: "$2.00", value: 2, unit: "usd_per_share", scale: "units", units: 2, basis }) as const;

  it("p1: 'On a non-GAAP basis, diluted EPS was $2.10 …' typed reported is not checked (basis_unconfirmed)", () => {
    const c = vsBogey(`On a non-GAAP basis, diluted earnings per share was $2.10${P}.`, eps("reported"), epsBogey("reported"));
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("basis_unconfirmed");
  });

  it("p2: 'Excluding the legal accrual, income from operations was $5.0 billion …' typed reported is not checked", () => {
    const c = vsBogey(`Excluding the legal accrual, income from operations was $5.0 billion${P}.`,
      { valueText: "$5.0 billion", value: 5, scale: "billions", metric: "income from operations", label: "income from operations" },
      { valueText: "$4.8 billion", value: 4.8, unit: "usd", scale: "billions", units: 4.8e9 });
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("basis_unconfirmed");
  });

  it("p4: '… was $2.10 for the three months ended September 30, 2026, on a non-GAAP basis.' typed reported is not checked", () => {
    const c = vsBogey(`Diluted earnings per share was $2.10${P}, on a non-GAAP basis.`, eps("reported"), epsBogey("reported"));
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("basis_unconfirmed");
  });

  it("p4 control: the same sentence typed non_gaap against a non-GAAP consensus is checked", () => {
    expect(vsBogey(`Diluted earnings per share was $2.10${P}, on a non-GAAP basis.`, eps("non_gaap"), epsBogey("non_gaap")).status).toBe("checked");
  });

  it("p5: 'On a constant currency basis, revenue grew 27% …' typed constant_currency is checked", () => {
    const c = vsBogey(`On a constant currency basis, revenue grew 27%${P}.`,
      { valueText: "27%", value: 27, unit: "percent", scale: "units", metric: "revenue", label: "revenue", basis: "constant_currency" },
      { valueText: "25%", value: 25, unit: "percent", scale: "units", units: 25, basis: "constant_currency" });
    expect(c.status).toBe("checked");
  });

  it("a comma inside a date or before a year is not a clause break", () => {
    const s = `diluted earnings per share was $2.10${P.toLowerCase()}, on a non-gaap basis.`;
    expect(clauseAt(s, s.indexOf("$2.10"))).toBe(s);
  });

  it("p6: pairing skips the date: 'Non-GAAP diluted EPS for the three months ended September 30, 2026 was $2.10' binds $2.10", () => {
    const s6 = "Non-GAAP diluted earnings per share for the three months ended September 30, 2026 was $2.10.";
    expect(vsBogey(s6, eps("non_gaap"), epsBogey("non_gaap")).status).toBe("checked");
    const typedReported = vsBogey(s6, eps("reported"), epsBogey("reported"));
    expect(codes(typedReported)).not.toContain("value_not_in_quote");
    expect(codes(typedReported)).toContain("basis_unconfirmed");
  });

  it("p7: 'Excluding the tax benefit, net income for the three months ended September 30, 2026 was $9.0 billion' binds $9.0B and is not checked as reported", () => {
    const c = vsBogey("Excluding the tax benefit, net income for the three months ended September 30, 2026 was $9.0 billion.",
      { valueText: "$9.0 billion", value: 9, scale: "billions", metric: "net income", label: "net income" },
      { valueText: "$8.0 billion", value: 8, unit: "usd", scale: "billions", units: 8e9 });
    expect(codes(c)).not.toContain("value_not_in_quote");
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("basis_unconfirmed");
  });
});
