/** Shared helpers for the filing-summary checker tests (evaluate*.test.ts). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractDocText } from "@/lib/filing-summary/doc-text";
import { evaluateSection } from "@/lib/filing-summary/evaluate";
import type {
  BogeySnapshotFigure,
  CheckedClaim,
  DocText,
  ModelCitation,
  ModelClaim,
  ModelComparison,
  ModelFigure,
  PeriodSpec,
} from "@/lib/filing-summary/types";

// ---------------------------------------------------------------------------
// Fixtures: a synthetic Q3 2026 exhibit shaped like the real Meta tables
// ---------------------------------------------------------------------------

export const FIXTURE = path.join(__dirname, "../fixtures/filing-summary/synthetic-q3-exhibit.htm");
export const EX991 = "ex991.htm";
export const exhibit: DocText = extractDocText(readFileSync(FIXTURE, "utf8"));
export const CIK = "1234567";
export const ACCESSION = "0001234567-26-000123";
export const EVENT_DATE = "2026-10-29";

/** A one-table income statement with the given rows (values: Q3 2026, Q3 2025, 9M 2026, 9M 2025). */
export function incomeDoc(rows: Array<[string, string, string, string, string]>, note = "(In millions, except per share amounts)"): DocText {
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return extractDocText(
    `<p>${note}</p><table>` +
      '<tr><td></td><td colspan="2">Three Months Ended September 30,</td><td colspan="2">Nine Months Ended September 30,</td></tr>' +
      "<tr><td></td><td>2026</td><td>2025</td><td>2026</td><td>2025</td></tr>" +
      `${body}</table>`,
  );
}

export const period = (over: Partial<PeriodSpec>): PeriodSpec => ({
  kind: "quarter", role: "actual", endDate: "2026-09-30", fiscalYear: null, fiscalQuarter: null, anchor: null, label: "Q3 2026", ...over,
});
export const Q3_26 = period({});
export const NM_26 = period({ kind: "year_to_date", label: "nine months 2026" });
export const NM_25 = period({ kind: "year_to_date", endDate: "2025-09-30", label: "nine months 2025" });
export const AT_Q3_26 = period({ kind: "instant", label: "September 30, 2026" });
export const THIS_QUARTER: PeriodSpec = {
  kind: "quarter", role: "actual", endDate: null, fiscalYear: null, fiscalQuarter: null, anchor: "reported_quarter", label: "this print's quarter",
};
export const FY_OUTLOOK: PeriodSpec = {
  kind: "fiscal_year", role: "outlook", endDate: null, fiscalYear: null, fiscalQuarter: null, anchor: "fiscal_year", label: "fiscal year outlook",
};

export function quoteFig(id: string, citationId: string, over: Partial<ModelFigure>): ModelFigure {
  return {
    id, valueText: "", value: 0, unit: "usd", scale: "millions", metric: "", period: Q3_26, basis: "reported", basisNote: null,
    sourceKind: "quote", citationId, label: null, bogeyKey: null, operation: null, inputs: [], ...over,
  };
}
export function bogeyFig(id: string, bogeyKey: string, over: Partial<ModelFigure>): ModelFigure {
  return quoteFig(id, "", { sourceKind: "bogey", citationId: null, bogeyKey, period: THIS_QUARTER, ...over });
}
export function computedFig(id: string, over: Partial<ModelFigure>): ModelFigure {
  return quoteFig(id, "", { sourceKind: "computed", citationId: null, unit: "percent", scale: "units", ...over });
}
export function cite(id: string, quote: string, isTableRow = quote.includes(" | "), document = EX991): ModelCitation {
  return { id, document, quote, isTableRow };
}
export function claim(
  text: string,
  citations: ModelCitation[],
  figures: ModelFigure[] = [],
  comparisons: ModelComparison[] = [],
  id = "c1",
): ModelClaim {
  return { id, text, citations, figures, comparisons, corrects: null };
}
export const cmp = (left: string, right: string, relation: ModelComparison["relation"]): ModelComparison => ({
  left, leftHigh: null, right, rightHigh: null, relation,
});
export function bogey(key: string, value: number, over: Partial<BogeySnapshotFigure> = {}): BogeySnapshotFigure {
  return {
    key, label: "Revenue consensus", value, unit: "usd", scale: "units", period: THIS_QUARTER, basis: "reported",
    provenance: "Synthetic Weekly", asOf: "2026-10-27", rowKind: "newsletter", ...over,
  };
}

export function run(
  claims: ModelClaim[],
  opts: { bogeys?: BogeySnapshotFigure[]; docs?: Array<{ fileName: string; text: DocText }>; priorClaims?: CheckedClaim[]; headline?: string } = {},
) {
  return evaluateSection({
    output: { headline: opts.headline ?? "Results headline", bullets: claims.map((c, i) => ({ top: i === 0, routine: false, claims: [c] })) },
    docs: opts.docs ?? [{ fileName: EX991, text: exhibit }],
    cik: CIK,
    accession: ACCESSION,
    eventDate: EVENT_DATE,
    bogeys: opts.bogeys ?? [],
    priorClaims: opts.priorClaims ?? [],
  });
}
export const one = (c: ModelClaim, opts: Parameters<typeof run>[1] = {}) => run([c], opts).claims[0];
export const codes = (c: CheckedClaim) => c.reasons.map((r) => r.code);

// Reusable claims
export const revenueQ3 = (over: Partial<ModelFigure> = {}) =>
  quoteFig("f1", "q1", { valueText: "$64,601 million", value: 64601, metric: "revenue", label: "Revenue", ...over });
