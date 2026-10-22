/**
 * Shared types for the armed-print filing summary (`lib/filing-summary/`).
 * Written by Task 1 and read by every later task; the declarations below are
 * the agreed contract (shared-types.md) and change only by agreement.
 *
 * Sections: the model choice; extracted document text; the model's structured
 * output; the bogey snapshot a run is judged against; and the mechanical
 * check results with their display severity.
 */
export type SummaryFamily = "sonnet" | "opus" | "fable";
export type SummaryEffort = "medium" | "high";
export interface SummaryChoice { family: SummaryFamily; effort: SummaryEffort }

// ---- extracted document text (Task 3) ----
export interface TextBlock { index: number; page: number; para: number; text: string; tableId: number | null; rowIndex: number | null }
export interface TableGrid {
  id: number; page: number;
  rows: string[][];            // body rows, colspan spread across covered columns (R3)
  columnHeaders: string[];     // per column: all header-row texts above it joined with " / "
  rowLabels: string[];         // first non-empty cell per body row
  scaleNote: string | null;    // nearest "in millions…" statement in/just above the table
}
export interface DocText {
  extractorVersion: number; pageCount: number; pageBreaksReliable: boolean;
  blocks: TextBlock[]; tables: TableGrid[]; documentScaleNote: string | null;
}

// ---- model output (Task 7 schema) ----
export type FigureUnit = "usd" | "usd_per_share" | "percent" | "shares" | "count" | "people" | "other";
export type FigureScale = "units" | "thousands" | "millions" | "billions";
export type PeriodKind = "quarter" | "year_to_date" | "fiscal_year" | "instant";
export type PeriodAnchor = "reported_quarter" | "next_quarter" | "fiscal_year" | null;
export interface PeriodSpec {
  kind: PeriodKind; role: "actual" | "outlook";
  endDate: string | null; fiscalYear: number | null; fiscalQuarter: number | null;
  anchor: PeriodAnchor;        // set only on bogey figures (R6)
  label: string;
}
export type Basis = "reported" | "non_gaap" | "constant_currency" | "excluding_item"
  | "guidance_low" | "guidance_high" | "guidance_mid" | "unknown";
export type FigureSourceKind = "quote" | "bogey" | "computed";
export type ComputeOp = "difference" | "sum" | "ratio" | "growth";
export interface ModelFigure {
  id: string; valueText: string; value: number; unit: FigureUnit; scale: FigureScale;
  metric: string; period: PeriodSpec; basis: Basis; basisNote: string | null;
  sourceKind: FigureSourceKind;
  citationId: string | null; label: string | null;        // quote
  bogeyKey: string | null;                                  // bogey
  operation: ComputeOp | null; inputs: string[];           // computed (ordered)
}
export interface ModelCitation { id: string; document: string; quote: string; isTableRow: boolean }
export type Relation = "above" | "below" | "in_line" | "raised" | "lowered" | "narrowed" | "unchanged";
export interface ModelComparison { left: string; leftHigh: string | null; right: string; rightHigh: string | null; relation: Relation }
export interface ModelClaim {
  id: string; text: string;               // template with {f1}… placeholders (R1)
  citations: ModelCitation[]; figures: ModelFigure[]; comparisons: ModelComparison[];
  corrects: { claimId: string; citationId: string } | null;   // 8-K/A only (R17)
}
export interface ModelBullet { top: boolean; routine: boolean; claims: ModelClaim[] }
export interface ModelSectionOutput { headline: string; bullets: ModelBullet[] }

// ---- bogey snapshot (Task 7) ----
export interface BogeySnapshotFigure {
  key: string;                 // `b<rowId>.<field>` or `b<rowId>.x.<extraId>`
  label: string; value: number; unit: FigureUnit; scale: "units";
  period: PeriodSpec; basis: Basis;
  provenance: string;          // public-safe (R15)
  asOf: string;                // YYYY-MM-DD Eastern
  rowKind: "manual" | "upload" | "deep_read" | "newsletter" | "vendor";
}

// ---- checks (Tasks 4, 5, 8) ----
export type ClaimStatus = "contradicted" | "figure_not_bound" | "periods_differ" | "not_in_filing"
  | "quote_not_found" | "ambiguous_quote" | "unconfirmed" | "checked" | "qualitative";
export interface CheckReason { code: string; figureId: string | null; detail: string }
export interface Footnote {
  citationId: string; document: string; status: "found" | "not_found" | "ambiguous";
  page: number | null; para: number | null; sentence: string | null; url: string | null;
}
export interface FigureCheck { figureId: string; established: boolean; foundValue: number | null; reasons: CheckReason[] }
export interface ComparisonCheck {
  relation: Relation; verdict: "matches" | "contradicted" | "periods_differ" | "unconfirmed";
  difference: number | null; differencePct: number | null; shownText: string | null; reasons: CheckReason[];
}
export interface CheckedClaim {
  claimId: string; renderedText: string; status: ClaimStatus; top: boolean; routine: boolean;
  footnotes: Footnote[]; figureChecks: FigureCheck[]; comparisonChecks: ComparisonCheck[];
  reasons: CheckReason[]; correction: { claimId: string; resolved: boolean; footnote: Footnote | null } | null;
}
export interface StatusCounts { claims: number; checked: number; contradicted: number; warning: number; unconfirmed: number; qualitative: number }
export interface CheckedSection { headline: string; claims: CheckedClaim[]; counts: StatusCounts }
export interface CoverageEntry { fileName: string; docType: string; status: "read" | "skipped" | "failed"; reason: string | null }

export const STATUS_SEVERITY: Record<ClaimStatus, "danger" | "warning" | "muted" | "ok"> = {
  contradicted: "danger", figure_not_bound: "warning", periods_differ: "warning", not_in_filing: "warning",
  quote_not_found: "warning", ambiguous_quote: "warning", unconfirmed: "muted", checked: "ok", qualitative: "ok",
};
