import { describe, it, expect } from "vitest";
import { extractDocText } from "@/lib/filing-summary/doc-text";
import { FIGURE_REASON_CODES } from "@/lib/filing-summary/figures";
import { CHECKER_VERSION, REASON_CODES, countStatuses, reasonStatus, renderClaimText } from "@/lib/filing-summary/evaluate";
import type { CheckedClaim, ClaimStatus, DocText, ModelClaim, ModelComparison, ModelFigure } from "@/lib/filing-summary/types";
import {
  AT_Q3_26,
  EX991,
  FY_OUTLOOK,
  NM_25,
  NM_26,
  Q3_26,
  bogey,
  bogeyFig,
  cite,
  claim,
  cmp,
  codes,
  computedFig,
  exhibit,
  incomeDoc,
  one,
  period,
  quoteFig,
  revenueQ3,
  run,
} from "./evaluate-helpers";
// ---------------------------------------------------------------------------
// Spec acceptance cases
// ---------------------------------------------------------------------------

describe("spec acceptance cases", () => {
  it("A: revenue 'below' a $64.57B consensus against 64,601 millions is contradicted, shown +0.05%", () => {
    const c = one(
      claim(
        "Revenue of {f1} was below the {f2} Synthetic Weekly consensus.",
        [cite("q1", "Revenue | 64,601")],
        [revenueQ3(), bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions" })],
        [cmp("f1", "f2", "below")],
      ),
      { bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("contradicted");
    expect(c.comparisonChecks[0].verdict).toBe("contradicted");
    expect(c.comparisonChecks[0].shownText).toBe("+0.05%");
    expect(c.figureChecks.every((f) => f.established)).toBe(true);
    expect(c.figureChecks[0].foundValue).toBe(64601e6);
    expect(codes(c)).toContain("relation_contradicted");
    expect(c.renderedText).toBe("Revenue of $64,601 million was below the $64.57B Synthetic Weekly consensus.");
  });

  it("A (control): the same comparison stated 'above' is checked", () => {
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue | 64,601")],
        [revenueQ3(), bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions" })],
        [cmp("f1", "f2", "above")]),
      { bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("checked");
    expect(c.comparisonChecks[0].verdict).toBe("matches");
  });

  it("B: nine-month FCF 11,049 against a full-year (FY_guide) bogey of -7.3B is periods_differ, never contradicted", () => {
    const c = one(
      claim(
        "Free cash flow of {f1} for the nine months was above the {f2} full-year Street figure.",
        [cite("q1", "Free cash flow | 11,049")],
        [
          quoteFig("f1", "q1", { valueText: "$11,049 million", value: 11049, metric: "free cash flow", label: "Free cash flow", period: NM_26, basis: "non_gaap" }),
          bogeyFig("f2", "b9.x.fcf", { valueText: "−$7.3 billion", value: -7.3, scale: "billions", period: NM_26 }),
        ],
        [cmp("f1", "f2", "above")],
      ),
      { bogeys: [bogey("b9.x.fcf", -7.3e9, { label: "Free cash flow", period: FY_OUTLOOK, basis: "non_gaap" })] },
    );
    expect(c.status).toBe("periods_differ");
    expect(c.comparisonChecks[0].verdict).toBe("periods_differ");
    expect(c.figureChecks.every((f) => f.established)).toBe(true);
  });

  it("C1: a '29%' growth figure with no inputs is not_in_filing", () => {
    const c = one(
      claim("Revenue grew {f1} for the nine months.", [cite("q1", "Revenue | 181,712 | 141,073")], [
        computedFig("f1", { valueText: "29%", value: 29, metric: "revenue growth", period: NM_26, operation: "growth", inputs: [] }),
      ]),
    );
    expect(c.status).toBe("not_in_filing");
    expect(codes(c)).toContain("no_inputs");
  });

  const growthClaim = (stated: string, value: number, inputs = ["f2", "f3"]) =>
    claim("Revenue grew {f1} for the nine months, to {f2} from {f3}.", [cite("q1", "Revenue | 181,712 | 141,073")], [
      computedFig("f1", { valueText: stated, value, metric: "revenue growth", period: NM_26, operation: "growth", inputs }),
      quoteFig("f2", "q1", { valueText: "$181,712 million", value: 181712, metric: "revenue", label: "Revenue", period: NM_26 }),
      quoteFig("f3", "q1", { valueText: "$141,073 million", value: 141073, metric: "revenue", label: "Revenue", period: NM_25 }),
    ]);

  it("C2: '29%' with cited inputs 181,712 and 141,073 (nine months 2026/2025) recomputes 28.8% and is checked (computed)", () => {
    const c = one(growthClaim("29%", 29));
    expect(c.status).toBe("checked");
    const f1 = c.figureChecks.find((f) => f.figureId === "f1");
    expect(f1?.established).toBe(true);
    expect(f1?.foundValue).toBeCloseTo(28.81, 2);
    expect(f1?.reasons.map((r) => r.code)).toEqual(["computed"]);
  });

  it("C3: the same growth stated as 28% is contradicted (inputs established, arithmetic disagrees)", () => {
    const c = one(growthClaim("28%", 28));
    expect(c.status).toBe("contradicted");
    expect(codes(c)).toContain("computed_mismatch");
  });

  it("C4: growth with the inputs swapped (old first) is periods_differ, not contradicted", () => {
    const c = one(growthClaim("29%", 29, ["f3", "f2"]));
    expect(c.status).toBe("periods_differ");
    expect(codes(c)).not.toContain("computed_mismatch");
  });

  it("D: '$12.99B' operating income against table '12,988' in millions is checked", () => {
    const c = one(
      claim("Operating income was {f1}.", [cite("q1", "Income from operations | 12,988")], [
        quoteFig("f1", "q1", { valueText: "$12.99B", value: 12.99, scale: "billions", metric: "operating income", label: "Income from operations" }),
      ]),
    );
    expect(c.status).toBe("checked");
    expect(c.figureChecks[0].foundValue).toBe(12988e6);
  });
});

// ---------------------------------------------------------------------------
// R18 cases
// ---------------------------------------------------------------------------

describe("R18 cases", () => {
  it("wrong metric, right number: net income's number labelled operating income is unconfirmed (metric_unconfirmed)", () => {
    const c = one(
      claim("Operating income was {f1}.", [cite("q1", "Net income | 9,860")], [
        quoteFig("f1", "q1", { valueText: "$9,860 million", value: 9860, metric: "operating income", label: "Net income" }),
      ]),
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["metric_unconfirmed"]);
  });

  it("swapped columns: the 2025 value claimed as Q3 2026 is periods_differ", () => {
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 51,242")], [revenueQ3({ valueText: "$51,242 million", value: 51242 })]));
    expect(c.status).toBe("periods_differ");
    expect(c.figureChecks[0].established).toBe(false);
  });

  it("omitted typed figure: 'revenue fell 10%' with no placeholder is figure_not_bound", () => {
    const c = one(claim("Revenue fell 10% in the quarter.", [cite("q1", "Revenue | 64,601")]));
    expect(c.status).toBe("figure_not_bound");
    expect(codes(c)).toContain("unbound_digit");
  });

  it("a digit outside a placeholder next to a bound figure is still figure_not_bound", () => {
    const c = one(claim("Revenue of {f1} rose 26%.", [cite("q1", "Revenue | 64,601")], [revenueQ3()]));
    expect(c.status).toBe("figure_not_bound");
    expect(c.figureChecks[0].established).toBe(true);
  });

  it("EPS 7.25 under 'in millions, except per share' is read at units and checked", () => {
    const c = one(
      claim("Diluted EPS was {f1}.", [cite("q1", "Diluted | 7.25")], [
        quoteFig("f1", "q1", { valueText: "$7.25", value: 7.25, unit: "usd_per_share", scale: "units", metric: "diluted EPS", label: "Diluted" }),
      ]),
    );
    expect(c.status).toBe("checked");
  });

  it("EPS under a plain 'in millions' heading (no per-share exemption) is scale_unconfirmed", () => {
    const doc = incomeDoc([["Diluted", "7.25", "1.05", "20.60", "14.70"]], "(In millions)");
    const c = one(
      claim("Diluted EPS was {f1}.", [cite("q1", "Diluted | 7.25")], [
        quoteFig("f1", "q1", { valueText: "$7.25", value: 7.25, unit: "usd_per_share", scale: "units", metric: "diluted EPS", label: "Diluted" }),
      ]),
      { docs: [{ fileName: EX991, text: doc }] },
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("scale_unconfirmed");
  });

  it("vendor EPS consensus (basis unknown) 'above' is not checked: unconfirmed with basis_unconfirmed", () => {
    const c = one(
      claim("Diluted EPS of {f1} topped the {f2} vendor consensus.", [cite("q1", "Diluted | 7.25")], [
        quoteFig("f1", "q1", { valueText: "$7.25", value: 7.25, unit: "usd_per_share", scale: "units", metric: "diluted EPS", label: "Diluted" }),
        bogeyFig("f2", "b3.eps_consensus_vendor", { valueText: "$6.80", value: 6.8, unit: "usd_per_share", scale: "units" }),
      ], [cmp("f1", "f2", "above")]),
      { bogeys: [bogey("b3.eps_consensus_vendor", 6.8, { unit: "usd_per_share", basis: "unknown", label: "EPS consensus (vendor)", rowKind: "vendor" })] },
    );
    expect(c.status).toBe("unconfirmed");
    expect(c.comparisonChecks[0].verdict).toBe("unconfirmed");
    expect(c.comparisonChecks[0].reasons.map((r) => r.code)).toEqual(["basis_unconfirmed"]);
  });

  const otherIncome = (bogeyValue: number, relation: ModelComparison["relation"]) =>
    one(
      claim("Other income of {f1} was {f2} expected.", [cite("q1", "Other income (expense), net | (1,200")], [
        quoteFig("f1", "q1", { valueText: "−$1,200 million", value: -1200, metric: "other income", label: "Other income (expense), net" }),
        bogeyFig("f2", "b4.x.oie", { valueText: `$${bogeyValue / 1e9}B`, value: bogeyValue / 1e9, scale: "billions" }),
      ], [cmp("f1", "f2", relation)]),
      { bogeys: [bogey("b4.x.oie", bogeyValue, { label: "Other income" })] },
    );

  it("zero comparator 'in_line' is unconfirmed (zero_comparator)", () => {
    const c = otherIncome(0, "in_line");
    expect(c.status).toBe("unconfirmed");
    expect(c.figureChecks.every((f) => f.established)).toBe(true);
    expect(codes(c)).toContain("zero_comparator");
  });

  it("negative comparator 'above': -1,200M above -1.5B is checked", () => {
    const c = otherIncome(-1.5e9, "above");
    expect(c.status).toBe("checked");
    expect(c.comparisonChecks[0].difference).toBeCloseTo(0.3e9, -3);
  });

  it("rounding boundary: 12.99B against 12,995 million (exactly half a unit) is checked", () => {
    const doc = incomeDoc([["Income from operations", "12,995", "20,535", "50,212", "50,973"]]);
    const c = one(
      claim("Operating income was {f1}.", [cite("q1", "Income from operations | 12,995")], [
        quoteFig("f1", "q1", { valueText: "$12.99B", value: 12.99, scale: "billions", metric: "operating income", label: "Income from operations" }),
      ]),
      { docs: [{ fileName: EX991, text: doc }] },
    );
    expect(c.status).toBe("checked");
  });

  it("rounding boundary: 12.99B against 12,996 million is unconfirmed (value_not_in_quote), never contradicted", () => {
    const doc = incomeDoc([["Income from operations", "12,996", "20,535", "50,212", "50,973"]]);
    const c = one(
      claim("Operating income was {f1}.", [cite("q1", "Income from operations | 12,996")], [
        quoteFig("f1", "q1", { valueText: "$12.99B", value: 12.99, scale: "billions", metric: "operating income", label: "Income from operations" }),
      ]),
      { docs: [{ fileName: EX991, text: doc }] },
    );
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["value_not_in_quote"]);
  });

  it("a quote found twice is ambiguous_quote", () => {
    const c = one(claim("Management stressed efficiency.", [cite("q1", "We remain focused on efficiency.")]));
    expect(c.status).toBe("ambiguous_quote");
    expect(c.footnotes[0].status).toBe("ambiguous");
  });

  it("countStatuses gives the exact counts on a mixed list", () => {
    const mk = (status: ClaimStatus): CheckedClaim => ({
      claimId: status, renderedText: "", status, top: false, routine: false, footnotes: [], figureChecks: [],
      comparisonChecks: [], reasons: [], correction: null,
    });
    const list = (["checked", "checked", "contradicted", "periods_differ", "not_in_filing", "quote_not_found", "ambiguous_quote",
      "figure_not_bound", "unconfirmed", "unconfirmed", "qualitative"] as ClaimStatus[]).map(mk);
    expect(countStatuses(list)).toEqual({ claims: 11, checked: 2, contradicted: 1, warning: 5, unconfirmed: 2, qualitative: 1 });
  });
});

// ---------------------------------------------------------------------------
// Controller rulings and further rules
// ---------------------------------------------------------------------------

describe("table binding rules", () => {
  it("ruling 1: a colspan-spread value (two adjacent identical cells under one header) is one candidate", () => {
    const c = one(
      claim("Costs and expenses were {f1}.", [cite("q1", "Costs and expenses | 51,613")], [
        quoteFig("f1", "q1", { valueText: "$51,613 million", value: 51613, metric: "costs and expenses", label: "Costs and expenses" }),
      ]),
    );
    expect(c.status).toBe("checked");
  });

  it("ruling 3: a bare-date balance-sheet column is an instant", () => {
    const c = one(
      claim("Cash and cash equivalents were {f1}.", [cite("q1", "Cash and cash equivalents | 11,222")], [
        quoteFig("f1", "q1", { valueText: "$11,222 million", value: 11222, metric: "cash and cash equivalents", label: "Cash and cash equivalents", period: AT_Q3_26 }),
      ]),
    );
    expect(c.status).toBe("checked");
  });

  it("ruling 4: numbers bind per whole cell, so 64,601 never matches a cell 164,601", () => {
    const doc = incomeDoc([["Revenue", "164,601", "51,242", "181,712", "141,073"]]);
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3()]), { docs: [{ fileName: EX991, text: doc }] });
    // Whole-cell locate: the quote's "64,601" is no cell of that row, so the quote is not found …
    expect(c.footnotes[0].status).toBe("not_found");
    // … and the figure is never checked.
    expect(c.figureChecks[0].established).toBe(false);
    expect(c.status).not.toBe("checked");
    expect(c.status).toBe("quote_not_found");
  });

  it("a negative split across two cells ('(1,200' then ')') reads as -1,200", () => {
    const c = one(
      claim("Other income was {f1}.", [cite("q1", "Other income (expense), net | (1,200")], [
        quoteFig("f1", "q1", { valueText: "−$1,200 million", value: -1200, metric: "other income", label: "Other income (expense), net" }),
      ]),
    );
    expect(c.status).toBe("checked");
  });

  it("the label must be in the located line", () => {
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3({ label: "Total revenue" })]));
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("label_not_in_quote");
  });

  it("a value matched only in a column with no period header is period_unconfirmed", () => {
    const doc = extractDocText(
      "<p>(In millions)</p><table><tr><td></td><td>Total</td><td>Change</td></tr><tr><td>Revenue</td><td>64,601</td><td>13,359</td></tr></table>",
    );
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3()]), { docs: [{ fileName: EX991, text: doc }] });
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["period_unconfirmed"]);
  });

  it("the same value under two columns of the same period is column_ambiguous", () => {
    const doc = extractDocText(
      "<p>(In millions)</p><table>" +
        "<tr><td></td><td>Three Months Ended September 30, 2026</td><td>Three Months Ended September 30, 2026</td></tr>" +
        "<tr><td>Revenue</td><td>64,601</td><td>$</td></tr><tr><td>Other</td><td>1</td><td>64,601</td></tr></table>",
    );
    // Build a row with the value twice, separated, under identical headers.
    doc.tables[0].rows[0] = ["Revenue", "64,601", "64,601"];
    doc.tables[0].columnHeaders = ["", "Three Months Ended September 30, 2026", "Three Months Ended September 30, 2026 / restated"];
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3()]), { docs: [{ fileName: EX991, text: doc }] });
    expect(codes(c)).toEqual(["column_ambiguous"]);
    expect(c.status).toBe("unconfirmed");
  });

  it("the shown valueText must state the typed value", () => {
    const c = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3({ valueText: "$64.5 billion" })]));
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toContain("value_text_mismatch");
  });
});

describe("prose binding", () => {
  const prose = (over: Partial<ModelFigure>) =>
    claim("Revenue was {f1}.", [cite("q1", "Revenue was $64.60 billion for the third quarter of 2026.")], [
      quoteFig("f1", "q1", {
        valueText: "$64.60 billion", value: 64.6, scale: "billions", metric: "revenue", label: "Revenue",
        period: period({ endDate: null, fiscalYear: 2026, fiscalQuarter: 3 }), ...over,
      }),
    ]);

  it("a number and a period read from the sentence are checked", () => {
    expect(one(prose({})).status).toBe("checked");
  });

  it("a sentence period with no end date against a dated figure period is period_unconfirmed (R5)", () => {
    const c = one(prose({ period: Q3_26 }));
    expect(c.status).toBe("unconfirmed");
    expect(codes(c)).toEqual(["period_unconfirmed"]);
  });

  it("a different year in the figure's period is periods_differ", () => {
    expect(one(prose({ period: period({ endDate: null, fiscalYear: 2025, fiscalQuarter: 3 }) })).status).toBe("periods_differ");
  });

  it("a number is paired with its own label: the costs figure in the same sentence does not bind as revenue", () => {
    const doc = extractDocText(
      "<p>Revenue was $64.60 billion and costs and expenses were $51.61 billion for the third quarter of 2026.</p>",
    );
    const q = "Revenue was $64.60 billion and costs and expenses were $51.61 billion";
    const fig = (label: string, metric: string, valueText: string, value: number) =>
      claim("Line was {f1}.", [cite("q1", q)], [
        quoteFig("f1", "q1", { valueText, value, scale: "billions", metric, label, period: period({ endDate: null, fiscalYear: 2026, fiscalQuarter: 3 }) }),
      ]);
    const docs = [{ fileName: EX991, text: doc }];
    expect(one(fig("Revenue", "revenue", "$64.60 billion", 64.6), { docs }).status).toBe("checked");
    expect(one(fig("costs and expenses", "costs and expenses", "$51.61 billion", 51.61), { docs }).status).toBe("checked");
    const wrong = one(fig("Revenue", "revenue", "$51.61 billion", 51.61), { docs });
    expect(wrong.status).toBe("unconfirmed");
    expect(codes(wrong)).toEqual(["value_not_in_quote"]);
  });

  it("a sentence with no period is period_unconfirmed", () => {
    const c = one(
      claim("Capex was {f1}.", [cite("q1", "Capital expenditures, including principal payments on finance leases, were $19.37 billion.")], [
        quoteFig("f1", "q1", { valueText: "$19.37 billion", value: 19.37, scale: "billions", metric: "capital expenditures", label: "Capital expenditures" }),
      ]),
    );
    expect(codes(c)).toEqual(["period_unconfirmed"]);
  });
});

describe("references, quotes and status", () => {
  it("ruling 8: a placeholder with no figure is figure_not_bound and names the id", () => {
    const c = one(claim("Revenue was {f9}.", [cite("q1", "Revenue | 64,601")], [revenueQ3()]));
    expect(c.status).toBe("figure_not_bound");
    expect(c.reasons.find((r) => r.code === "dangling_placeholder")?.detail).toContain("f9");
  });

  it("ruling 8: an unknown citationId, operand or input is figure_not_bound and names the id", () => {
    const badCite = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3({ citationId: "q7" })]));
    expect(badCite.status).toBe("figure_not_bound");
    expect(badCite.reasons.find((r) => r.code === "dangling_citation")?.detail).toContain("q7");

    const badOperand = one(claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3()], [cmp("f1", "f8", "above")]));
    expect(badOperand.status).toBe("figure_not_bound");
    expect(badOperand.reasons.find((r) => r.code === "dangling_operand")?.detail).toContain("f8");

    const badInput = one(
      claim("Revenue grew {f1}.", [cite("q1", "Revenue | 64,601")], [
        computedFig("f1", { valueText: "26%", value: 26, operation: "growth", inputs: ["f2", "f6"] }),
      ]),
    );
    expect(badInput.status).toBe("figure_not_bound");
    expect(badInput.reasons.some((r) => r.code === "dangling_input" && r.detail.includes("f6"))).toBe(true);
  });

  it("a quote that is not in the filing is quote_not_found and its footnote says so", () => {
    const c = one(claim("Management sounded upbeat.", [cite("q1", "We had a record quarter.")]));
    expect(c.status).toBe("quote_not_found");
    expect(c.footnotes[0].status).toBe("not_found");
  });

  it("a qualitative claim with a found quote is qualitative", () => {
    const c = one(claim("The release covers Item 2.02 of the 8-K and EX-99.1 for 2026.", [cite("q1", "today reported financial results")]));
    expect(c.status).toBe("qualitative");
    expect(c.footnotes[0]).toMatchObject({ status: "found", page: 1, para: 2, document: EX991 });
  });

  it("a bogey key that is not in the snapshot, or a different value, is not_in_filing", () => {
    const mk = (value: number) =>
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue | 64,601")],
        [revenueQ3(), bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: `$${value}B`, value, scale: "billions" })],
        [cmp("f1", "f2", "above")]);
    expect(one(mk(64.57)).status).toBe("not_in_filing");
    const wrong = one(mk(64.2), { bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] });
    expect(wrong.status).toBe("not_in_filing");
    expect(codes(wrong)).toContain("bogey_value_mismatch");
  });

  it("ruling 6: the bogey's period and basis come from the snapshot, not the model's copy", () => {
    // The model claims the bogey is a nine-month figure on a non-GAAP basis; the snapshot says this quarter, reported.
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue | 64,601")],
        [revenueQ3(), bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$64.57B", value: 64.57, scale: "billions", period: NM_26, basis: "non_gaap" })],
        [cmp("f1", "f2", "above")]),
      { bogeys: [bogey("b7.revenue_consensus_usd", 64.57e9)] },
    );
    expect(c.status).toBe("checked");
  });

  it("a this-quarter bogey compared with the prior-year quarter column's period is periods_differ via the figure", () => {
    const c = one(
      claim("Revenue of {f1} beat the {f2} consensus.", [cite("q1", "Revenue | 51,242")],
        [revenueQ3({ valueText: "$51,242 million", value: 51242, period: period({ endDate: "2025-09-30", label: "Q3 2025" }) }),
          bogeyFig("f2", "b7.revenue_consensus_usd", { valueText: "$50B", value: 50, scale: "billions" })],
        [cmp("f1", "f2", "above")]),
      { bogeys: [bogey("b7.revenue_consensus_usd", 50e9)] },
    );
    expect(c.status).toBe("periods_differ");
    expect(c.comparisonChecks[0].verdict).toBe("periods_differ");
  });

  it("ruling 5: the footnote page follows the LOCATED document's page-break flag", () => {
    const flat: DocText = { ...exhibit, pageBreaksReliable: false, blocks: exhibit.blocks.slice(0, 1) };
    const c = one(claim("Results were reported.", [cite("q1", "today reported financial results", false, "cover.htm")]), {
      docs: [{ fileName: "cover.htm", text: flat }, { fileName: EX991, text: exhibit }],
    });
    expect(c.footnotes[0]).toMatchObject({ status: "found", document: EX991, page: 1 });
  });

  it("ruling 7: a headline carrying a number is blanked; a clean one is kept", () => {
    expect(run([], { headline: "Revenue up 26% on ads" }).headline).toBe("");
    expect(run([], { headline: "New Class C stock and a founder agreement in the 8-K" }).headline).toBe(
      "New Class C stock and a founder agreement in the 8-K",
    );
  });

  it("R17: a correction resolves only with its own quote found and the earlier claim present", () => {
    const corr = (citeQuote: string): ModelClaim => ({
      ...claim("The amendment restates the release.", [cite("q1", citeQuote)]),
      corrects: { claimId: "c4", citationId: "q1" },
    });
    const prior = [{ claimId: "c4" } as CheckedClaim];
    const ok = one(corr("today reported financial results"), { priorClaims: prior });
    expect(ok.correction).toMatchObject({ claimId: "c4", resolved: true });
    expect(ok.correction?.footnote?.status).toBe("found");
    expect(ok.status).toBe("qualitative");
    expect(one(corr("today reported financial results")).correction?.resolved).toBe(false);
    expect(one(corr("a sentence that is not there"), { priorClaims: prior }).correction?.resolved).toBe(false);
  });

  it("section bullets carry top/routine and counts", () => {
    const s = run([
      claim("Revenue was {f1}.", [cite("q1", "Revenue | 64,601")], [revenueQ3()]),
      claim("Revenue fell 10%.", [cite("q1", "Revenue | 64,601")], [], [], "c2"),
    ]);
    expect(s.claims.map((c) => [c.claimId, c.top, c.status])).toEqual([["c1", true, "checked"], ["c2", false, "figure_not_bound"]]);
    expect(s.counts).toEqual({ claims: 2, checked: 1, contradicted: 0, warning: 1, unconfirmed: 0, qualitative: 0 });
  });
});

describe("renderClaimText and reason codes", () => {
  it("fills placeholders and allows years, Item, exhibit and form numbers", () => {
    const c = claim("Item 2.02 of the 8-K and EX-99.1 show {f1} for 2026; a PRE 14C followed.", [], [revenueQ3()]);
    expect(renderClaimText(c)).toEqual({ text: "Item 2.02 of the 8-K and EX-99.1 show $64,601 million for 2026; a PRE 14C followed.", unbound: false });
  });

  it("an unknown placeholder or a stray digit is unbound", () => {
    expect(renderClaimText(claim("Up {f2}.", [], [revenueQ3()])).unbound).toBe(true);
    expect(renderClaimText(claim("Up {f1} and 3 points.", [], [revenueQ3()])).unbound).toBe(true);
    expect(renderClaimText(claim("Q3 was strong.", [])).unbound).toBe(true);
  });

  it("REASON_CODES covers figures.ts codes, is de-duplicated and every code maps to a status", () => {
    expect(CHECKER_VERSION).toBe(1);
    for (const code of FIGURE_REASON_CODES) expect(REASON_CODES).toContain(code);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const code of REASON_CODES) expect(code).toMatch(/^[a-z][a-z_]*$/);
    expect(reasonStatus("periods_differ")).toBe("periods_differ");
    expect(reasonStatus("computed")).toBe("info");
  });
});
