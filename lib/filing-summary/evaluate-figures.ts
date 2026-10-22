/**
 * Binding one typed figure to its evidence (spec §Figure checking, Codex
 * round 2 R2–R6). `evaluate.ts` owns the claim-level work; word rules live in
 * `evaluate-words.ts`, period rules in `evaluate-periods.ts`. Pure.
 *
 * A figure is ESTABLISHED only when the filing (or the frozen bogey snapshot)
 * shows the number, at a known scale, for a known period, under a label that
 * names the same metric. Nothing here decides "contradicted": a sourced number
 * that does not match is unconfirmed, never wrong (R9).
 *
 * Every bound figure carries the INTERVAL its printed source allows (± half a
 * unit of the printed precision; a bogey is exact), so arithmetic downstream
 * can tell "wrong" from "within rounding" (fix-round ruling 4).
 */
import { normalizeForMatch, type LocatedQuote } from "./locate";
import { matchesWithRounding, parseNumberToken, scaleFromNote, toUnits } from "./figures";
import { basisConfirmed, basisEvidence, isDefinitionalNonGaap, isLossMetric, metricMatchesLabel } from "./evaluate-words";
import { bindProse } from "./evaluate-prose";
import { failed, halfUnit, reason, statedNumber, type Binding, type StatedNumber } from "./evaluate-tokens";
import {
  columnPeriod,
  periodsMatch,
  resolveAnchor,
  tableContext,
  type SectionAnchors,
  type SourcePeriod,
  type TableContext,
} from "./evaluate-periods";
import type { Basis, BogeySnapshotFigure, CheckReason, DocText, FigureScale, FigureUnit, ModelFigure, TableGrid } from "./types";

export { metricMatchesLabel } from "./evaluate-words";
// Moved out in task 8b; re-exported so existing importers (tests, probes) keep working.
export { halfUnit, reason, scanNumbers, statedNumber, valueTextHasExtraDigit, type NumberToken, type StatedNumber } from "./evaluate-tokens";
export {
  changeRoles, clauseAt, headingPeriod, isHeadingBlock, isOrRestatement, proseBasisClauses, quantityTokens, rangeBounds,
  rangeBoundStarts, spelledNumbers, splitClauses, type ChangeRole, type ProseBasisClauses,
} from "./evaluate-prose";

/** A figure after binding. `units`/`lo`/`hi` are the SOURCE value and its rounding interval, in plain units. */
export interface ResolvedFigure {
  figure: ModelFigure;
  established: boolean;
  /** A computed figure whose established inputs give a different result over the whole interval (R8/R9). */
  contradicted: boolean;
  units: number | null;
  lo: number | null;
  hi: number | null;
  unit: FigureUnit;
  period: SourcePeriod | null;
  basis: Basis;
  /** The source supports the typed basis (column, row, caption or sentence words; a bogey row always). */
  basisConfirmed: boolean;
  table: TableContext | null;
  reasons: CheckReason[];
}

export function emptyResolved(fig: ModelFigure, reasons: CheckReason[] = []): ResolvedFigure {
  return {
    figure: fig, established: false, contradicted: false, units: null, lo: null, hi: null, unit: fig.unit,
    period: null, basis: fig.basis, basisConfirmed: false, table: null, reasons,
  };
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

interface Cell { col: number; text: string; value: number; decimals: number }

function cellNumber(row: string[], c: number): { value: number; decimals: number } | null {
  let text = row[c].trim();
  // A negative split across two cells ("(1,200" then ")") is one number.
  if (/^\(\s*\$?\s*[\d,.]+$/.test(text) && /^\)/.test((row[c + 1] ?? "").trim())) text = `${text})`;
  return parseNumberToken(text);
}

function labelColumns(row: string[], label: string): number {
  let start = 0;
  while (start < row.length && row[start] === label) start++;
  return start;
}

/**
 * The numeric cells of a body row, whole cell by whole cell (ruling 4),
 * skipping the label columns. Adjacent cells with identical text and an
 * identical column header are one colspan cell (ruling 1).
 */
function numericCells(grid: TableGrid, rowIndex: number): Cell[] {
  const row = grid.rows[rowIndex] ?? [];
  const out: Cell[] = [];
  for (let c = labelColumns(row, grid.rowLabels[rowIndex] ?? ""); c < row.length; c++) {
    const parsed = cellNumber(row, c);
    if (!parsed) continue;
    const prev = out[out.length - 1];
    if (prev && prev.col === c - 1 && prev.text === row[c].trim() && grid.columnHeaders[c] === grid.columnHeaders[prev.col]) {
      prev.col = c; // extend the run; the run counts once
      continue;
    }
    out.push({ col: c, text: row[c].trim(), value: parsed.value, decimals: parsed.decimals });
  }
  return out;
}

/** The nearest section header above a row: a body row with a label and no numeric cell ("Revenue:"). */
export function sectionHeader(grid: TableGrid, rowIndex: number): string | null {
  for (let r = rowIndex - 1; r >= 0; r--) {
    const row = grid.rows[r] ?? [];
    const label = grid.rowLabels[r] ?? "";
    if (!label) continue;
    let numeric = false;
    for (let c = labelColumns(row, label); c < row.length && !numeric; c++) numeric = cellNumber(row, c) !== null;
    if (!numeric) return label;
  }
  return null;
}

/**
 * The table's caption: its title/header blocks, the scale note, and up to two
 * text blocks just above it ON THE SAME PAGE (a page's tail text, such as a
 * non-GAAP disclosure ending the page before, is not a caption).
 */
function tableCaption(doc: DocText, grid: TableGrid): string {
  const parts: string[] = [];
  const first = doc.blocks.findIndex((b) => b.tableId === grid.id);
  for (let i = first - 1, n = 0; i >= 0 && n < 2; i--) {
    if (doc.blocks[i].tableId !== null || doc.blocks[i].page !== grid.page) break;
    parts.push(doc.blocks[i].text);
    n++;
  }
  for (const b of doc.blocks) if (b.tableId === grid.id && b.rowIndex === null) parts.push(b.text);
  if (grid.scaleNote) parts.push(grid.scaleNote);
  return parts.join(" | ");
}

// A cash USE row of a cash flow statement: named at the START of the label, never a gain/loss, income,
// proceeds or sales line, never a label with a parenthetical alternative ("Net purchases (sales) of").
const CASH_USE_LABEL = /^(?:repurchases? of|purchases? of|payments? (?:of|for|on|to)|capital expenditures|acquisitions? of|dividends paid)\b/i;
const CASH_USE_REFUSED = /\(|\b(?:gain|gains|loss|losses|income|proceeds|sales)\b/i;
// A cash flow statement: "Cash flows from … activities" as the section, or a caption naming the statement.
// A "Cash flow hedges:" section of the comprehensive income statement is not one (review round 2).
const CASH_FLOW_SECTION = /\bcash flows from\b/i;
const CASH_FLOW_CAPTION = /\bstatements?\s+of\s+cash\s+flows?\b/i;

function bindTableRow(fig: ModelFigure, stated: StatedNumber, doc: DocText, tableId: number, rowIndex: number, eventDate: string): Binding {
  const reasons: CheckReason[] = [];
  const fail = (code: string, detail: string): Binding => failed([...reasons, reason(code, fig.id, detail)]);
  const grid = doc.tables.find((t) => t.id === tableId);
  if (!grid || !grid.rows[rowIndex]) return fail("value_not_in_quote", "the cited row is not a table body row");
  const ctx = tableContext(grid);
  const rowLabel = grid.rowLabels[rowIndex] ?? "";
  const section = sectionHeader(grid, rowIndex);
  const caption = tableCaption(doc, grid);
  const scale: FigureScale | null = fig.unit === "percent" ? "units" : scaleFromNote(grid.scaleNote ?? doc.documentScaleNote, fig.unit);
  if (!scale) return fail("scale_unconfirmed", "no scale note in or above the table, or none that covers this unit");

  let matched = numericCells(grid, rowIndex).filter((c) => matchesWithRounding(stated, toUnits(c.value, scale)));
  // A cash USE is printed in parentheses on the cash flow statement, "(26,248)", and stated as the amount
  // spent, "$26,248 million of repurchases" (task 8b, ruling 6). Only a row whose label names a use of
  // cash may match with the sign flipped; "Net income (loss)" never does.
  if (matched.length === 0 && stated.value > 0 && CASH_USE_LABEL.test(rowLabel.trim()) && !CASH_USE_REFUSED.test(rowLabel)
    && (CASH_FLOW_SECTION.test(section ?? "") || CASH_FLOW_CAPTION.test(caption))) {
    matched = numericCells(grid, rowIndex).filter((c) => c.value < 0 && matchesWithRounding(stated, -toUnits(c.value, scale)));
  }
  if (matched.length === 0) return fail("value_not_in_quote", `${fig.valueText} is not in row "${rowLabel}"`);
  const want: SourcePeriod = { ...fig.period, anchor: null };
  const dated = matched
    .map((c) => ({ c, p: columnPeriod(ctx, c.col, eventDate) }))
    .filter((x): x is { c: Cell; p: NonNullable<ReturnType<typeof columnPeriod>> } => x.p !== null); // ruling 2
  // A measure that is non-GAAP by definition (free cash flow, adjusted EBITDA) is row-level non-GAAP evidence.
  const definitional = isDefinitionalNonGaap(rowLabel) || isDefinitionalNonGaap(fig.metric) ? "non-GAAP" : "";
  const evidenceAt = (col: number) =>
    basisEvidence([grid.columnHeaders[col] ?? "", `${definitional} ${section ?? ""} ${rowLabel}`, caption]);
  let same = dated.filter((x) => periodsMatch({ ...x.p, anchor: null }, want) === true);
  // Two same-period columns (GAAP and non-GAAP side by side): the typed basis may pick one.
  if (same.length > 1) {
    const byBasis = same.filter((x) => basisConfirmed(fig.basis, evidenceAt(x.c.col)));
    if (byBasis.length === 1) same = byBasis;
  }
  if (same.length > 1) return fail("column_ambiguous", `${fig.valueText} matches ${same.length} columns for that period`);
  if (same.length === 0) {
    const other = dated.find((x) => periodsMatch({ ...x.p, anchor: null }, want) === false);
    if (other) return fail("periods_differ", `${fig.valueText} sits under "${grid.columnHeaders[other.c.col]}", not ${fig.period.label}`);
    return fail("period_unconfirmed", `no column header names the period of ${fig.valueText}`);
  }
  const hit = same[0];
  const labelUnique = grid.rowLabels.filter((l) => normalizeForMatch(l) === normalizeForMatch(rowLabel)).length === 1;
  if (!metricMatchesLabel(fig.metric, rowLabel, { section, context: `${grid.columnHeaders[hit.c.col] ?? ""} ${caption}`, labelUnique })) {
    reasons.push(reason("metric_unconfirmed", fig.id, `metric "${fig.metric}" does not name row "${section ? `${section} ` : ""}${rowLabel}"`));
  }
  return {
    established: reasons.length === 0,
    units: toUnits(hit.c.value, scale),
    half: halfUnit(hit.c.decimals, scale),
    // The column matched the typed period by end date; the typed fiscal year and quarter name the same
    // period, so a comparison downstream can meet a figure dated by a heading ("Fourth Quarter 2026").
    period: { ...hit.p, fiscalYear: hit.p.fiscalYear ?? fig.period.fiscalYear, fiscalQuarter: hit.p.fiscalQuarter ?? fig.period.fiscalQuarter, anchor: null },
    table: ctx,
    basisConfirmed: basisConfirmed(fig.basis, evidenceAt(hit.c.col)),
    reasons,
  };
}

/**
 * Bind a quote figure to its located citation: the label is in the located
 * block, the number is in the row (whole cell) or paired with the label in the
 * sentence, the scale and period come from the source, and the metric names
 * the row (with its section) or the phrase.
 */
export function bindQuoteFigure(
  fig: ModelFigure,
  located: LocatedQuote,
  docs: Array<{ fileName: string; text: DocText }>,
  eventDate: string,
): ResolvedFigure {
  const out = emptyResolved(fig);
  const add = (code: string, detail: string) => out.reasons.push(reason(code, fig.id, detail));
  if (located.status === "not_found") { add("quote_not_found", "the cited quote is not in the filing"); return out; }
  if (located.status === "ambiguous" || !located.block) { add("ambiguous_quote", "the cited quote matches more than one place"); return out; }

  const stated = statedNumber(fig);
  if (!stated) { add("value_text_mismatch", `the shown text "${fig.valueText}" does not state the typed value`); return out; }
  // A loss is a negative result already; "net loss" typed as a negative number says it twice (review round 1).
  if (fig.value < 0 && isLossMetric(fig.metric)) add("loss_sign_double", `"${fig.metric}" names a loss, and ${fig.valueText} is negative as well`);
  const label = fig.label?.trim() ?? "";
  if (!label) add("label_missing", "the figure names no row label or phrase");
  else if (!normalizeForMatch(located.block.text).includes(normalizeForMatch(label))) add("label_not_in_quote", `"${label}" is not in the cited line`);

  const block = located.block;
  const doc = docs.find((d) => d.fileName === located.fileName)?.text;
  const binding: Binding = block.tableId !== null
    ? (doc && block.rowIndex !== null
      ? bindTableRow(fig, stated, doc, block.tableId, block.rowIndex, eventDate)
      : failed([reason("value_not_in_quote", fig.id, "the cited line is a table heading")]))
    : bindProse(fig, stated, located, doc, eventDate);
  for (const r of binding.reasons) if (!out.reasons.some((x) => x.code === r.code)) out.reasons.push(r);
  out.units = binding.units;
  out.lo = binding.units === null ? null : binding.units - binding.half;
  out.hi = binding.units === null ? null : binding.units + binding.half;
  out.period = binding.period;
  out.table = binding.table;
  out.basisConfirmed = binding.basisConfirmed;
  // Basis is judged on EVERY quote figure (review round 1, item 1): a non-GAAP, excluding-item or
  // constant-currency figure needs its words in the source; a reported figure stands unless the source
  // carries a contrary basis word. (`basisConfirmed` already reads the row, caption or clauses that way.)
  if (binding.units !== null && !binding.basisConfirmed && fig.basis !== "unknown" && !fig.basis.startsWith("guidance_")) {
    add("basis_unconfirmed", fig.basis === "reported"
      ? `the source speaks of another basis than reported for ${fig.valueText}`
      : `the source does not say ${fig.valueText} is ${fig.basis.replace("_", " ")}`);
  }
  out.established = binding.established && out.reasons.length === 0;
  return out;
}


// ---------------------------------------------------------------------------
// Bogey figures (R6, ruling 6)
// ---------------------------------------------------------------------------

/** Unit, period and basis come from the frozen snapshot; the period's anchor resolves against the section. */
export function bindBogeyFigure(fig: ModelFigure, bogeys: BogeySnapshotFigure[], anchors: SectionAnchors): ResolvedFigure {
  const out = emptyResolved(fig);
  out.basis = "unknown";
  const snap = fig.bogeyKey ? bogeys.find((b) => b.key === fig.bogeyKey) : undefined;
  if (!snap) {
    out.reasons.push(reason("bogey_not_found", fig.id, `no pre-print bogey has the key ${fig.bogeyKey ?? "(none)"}`));
    return out;
  }
  out.unit = snap.unit;
  out.basis = snap.basis;
  out.basisConfirmed = true; // the row's own basis is the evidence (R6); "unknown" stays unknown
  const p = snap.period;
  out.period = resolveAnchor(
    { kind: p.kind, role: p.role, endDate: p.endDate, fiscalYear: p.fiscalYear, fiscalQuarter: p.fiscalQuarter, anchor: p.anchor },
    anchors,
  );
  const stated = statedNumber({ ...fig, unit: snap.unit });
  if (!stated) {
    out.reasons.push(reason("value_text_mismatch", fig.id, `the shown text "${fig.valueText}" does not state the typed value`));
    return out;
  }
  if (!matchesWithRounding(stated, toUnits(snap.value, snap.scale))) {
    out.reasons.push(reason("bogey_value_mismatch", fig.id, `${fig.valueText} is not the ${snap.provenance} figure`));
    return out;
  }
  out.units = toUnits(snap.value, snap.scale);
  out.lo = out.units;
  out.hi = out.units;
  out.established = true;
  return out;
}

// ---------------------------------------------------------------------------
// Basis across operands (R6)
// ---------------------------------------------------------------------------

/**
 * Can these figures be compared on basis? A typed basis the source does not
 * support, or `unknown` → "unknown" (basis unconfirmed, never contradicted).
 * guidance_* names a range position, not an accounting basis. Two different
 * known accounting bases → "differ"; two excluding_item with different notes
 * → "unknown".
 */
export function basisCompat(figs: ResolvedFigure[]): "ok" | "unknown" | "differ" {
  if (figs.some((f) => f.basis === "unknown" || !f.basisConfirmed)) return "unknown";
  const acct = figs.filter((f) => !f.basis.startsWith("guidance_"));
  const kinds = new Set(acct.map((f) => f.basis));
  if (kinds.size > 1) return "differ";
  if (kinds.has("excluding_item")) {
    const notes = new Set(acct.map((f) => normalizeForMatch(f.figure.basisNote ?? "")));
    if (notes.size > 1 || notes.has("")) return "unknown";
  }
  return "ok";
}
