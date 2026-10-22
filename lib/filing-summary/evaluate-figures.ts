/**
 * Binding one typed figure to its evidence (spec §Figure checking, Codex
 * round 2 R2–R6). Split out of `evaluate.ts`, which owns the claim-level
 * work (computed figures, comparisons, status). Everything here is pure.
 *
 * The rule throughout: a figure is ESTABLISHED only when the filing (or the
 * frozen bogey snapshot) shows the number, at a known scale, for a known
 * period, under a label that names the same metric. Anything less carries a
 * reason and stays unestablished. Nothing here ever decides "contradicted":
 * a sourced number that does not match is unconfirmed, never wrong (R9).
 */
import { normalizeForMatch, type LocatedQuote } from "./locate";
import {
  matchesWithRounding,
  parseNumberToken,
  parsePeriodHeader,
  parsePeriodPhrase,
  samePeriod,
  scaleFromNote,
  toUnits,
  type PeriodCore,
} from "./figures";
import type {
  Basis,
  BogeySnapshotFigure,
  CheckReason,
  DocText,
  FigureScale,
  FigureUnit,
  ModelFigure,
  PeriodAnchor,
  TableGrid,
} from "./types";

/** A period as the SOURCE states it; `anchor` only on bogey periods (R6). */
export type SourcePeriod = PeriodCore & { anchor: PeriodAnchor };

/** The table a figure was read from, kept so an anchored bogey period can resolve against it. */
export interface TableContext { grid: TableGrid; bareDateIsInstant: boolean }

/** A figure after binding. `units` is the SOURCE value in plain units (not the model's). */
export interface ResolvedFigure {
  figure: ModelFigure;
  established: boolean;
  /** A computed figure whose established inputs give a different result (R8/R9). */
  contradicted: boolean;
  units: number | null;
  unit: FigureUnit;
  period: SourcePeriod | null;
  basis: Basis;
  table: TableContext | null;
  reasons: CheckReason[];
}

export const reason = (code: string, figureId: string | null, detail: string): CheckReason => ({ code, figureId, detail });

// ---------------------------------------------------------------------------
// Number tokens in free text (valueText, prose sentences)
// ---------------------------------------------------------------------------

const WORD_SCALE: Record<string, FigureScale> = {
  billion: "billions", billions: "billions", bn: "billions", b: "billions",
  million: "millions", millions: "millions", mn: "millions", mm: "millions", m: "millions",
  thousand: "thousands", thousands: "thousands", k: "thousands",
};

// Optional sign, optional "$", optional sign after it ("$-1.5B"), optional "(", the number, optional ")", then an
// optional percent and an optional scale word. The look-behind keeps a token
// from starting inside a word or an identifier ("Q3", "EX-99.1", "$64").
const TOKEN_RE =
  /(?<![\w.$\-−–])([-−–]?\s?\$?\s?[-−–]?\(?\s?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s?\)?)(\s?%|\s+percent\b)?(?:\s?(billions?|millions?|thousands?|bn|mn|mm|[bmk])(?![a-z]))?/gi;

export interface NumberToken {
  value: number;
  decimals: number;
  /** The scale the text's own word gives, or null when there is none. */
  wordScale: FigureScale | null;
  isPercent: boolean;
  /** Character offsets of the token in the scanned text. */
  start: number;
  end: number;
}

/** Every number in a piece of text, skipping bare years and form-name digits ("10-Q"). */
export function scanNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    // "10-Q", "8-K": a number glued to a letter by a hyphen is a form name.
    if (/^-[A-Za-z]/.test(text.slice(end, end + 2))) continue;
    let core = m[1].replace(/\s+/g, "");
    if (core.includes("(") && !core.includes(")")) core = core.replace("(", "");
    if (core.includes(")") && !core.includes("(")) core = core.replace(")", "");
    const isPercent = m[2] !== undefined;
    const word = m[3]?.toLowerCase() ?? null;
    if (!isPercent && !word && /^(?:19|20)\d\d$/.test(core)) continue;
    const parsed = parseNumberToken(core);
    if (!parsed) continue;
    out.push({
      value: parsed.value, decimals: parsed.decimals, wordScale: word ? WORD_SCALE[word] : null, isPercent,
      start: m.index ?? 0, end,
    });
  }
  return out;
}

/** The stated number for the rounding rule: the valueText's own digits, at its own scale. */
export interface StatedNumber { value: number; decimals: number; scale: FigureScale }

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Read the figure's `valueText` (what the owner sees) and require it to say the
 * same number as `value`/`scale` (what the app checks). The text's digit count
 * sets the rounding precision (R4). Null when the text holds no single number,
 * when its sign or size disagrees with `value`, or when a percent figure is not
 * written as a percent.
 */
export function statedNumber(fig: ModelFigure): StatedNumber | null {
  const tokens = scanNumbers(fig.valueText);
  if (tokens.length !== 1) return null;
  const t = tokens[0];
  if ((fig.unit === "percent") !== t.isPercent) return null;
  if (t.wordScale) {
    if (!nearlyEqual(toUnits(t.value, t.wordScale), toUnits(fig.value, fig.scale))) return null;
    return { value: t.value, decimals: t.decimals, scale: t.wordScale };
  }
  if (!nearlyEqual(t.value, fig.value)) return null;
  return { value: t.value, decimals: t.decimals, scale: fig.unit === "percent" ? "units" : fig.scale };
}

// ---------------------------------------------------------------------------
// Metric identity (R2)
// ---------------------------------------------------------------------------

// Function words: never content.
const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "per", "its", "our", "into", "over", "under", "than",
  "provided", "used", "attributable", "are", "was", "were", "this", "that", "all", "including",
]);
// Measure nouns and qualifiers shared by many different line items ("Net
// income" and "Operating income" share "income"). They count only when
// neither side has a distinctive word.
const GENERIC_WORDS = [
  "net", "total", "income", "revenue", "revenues", "sales", "cash", "cost", "costs", "expense", "expenses",
  "amount", "amounts", "other", "margin", "margins", "profit", "profits", "loss", "losses", "earnings",
  "share", "shares", "flow", "flows", "gaap", "adjusted",
];

function stem(w: string): string {
  for (const suf of ["ies", "ing", "ions", "ion", "es", "ed", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
  }
  return w;
}
const GENERIC_STEMS = new Set(GENERIC_WORDS.map(stem));

function contentStems(text: string): { distinct: Set<string>; generic: Set<string> } {
  const distinct = new Set<string>();
  const generic = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    const s = stem(w);
    (GENERIC_STEMS.has(s) ? generic : distinct).add(s);
  }
  return { distinct, generic };
}

/**
 * The metric and the source label share a content word (R2). A distinctive
 * word must be shared when either side has one ("operating income" vs "Net
 * income" fails; "diluted EPS" vs "Diluted" passes); when neither side has
 * one, a shared measure word is enough ("net income" vs "Net income").
 */
export function metricMatchesLabel(metric: string, label: string): boolean {
  const a = contentStems(metric);
  const b = contentStems(label);
  for (const s of a.distinct) if (b.distinct.has(s)) return true;
  if (a.distinct.size > 0 || b.distinct.size > 0) return false;
  for (const s of a.generic) if (b.generic.has(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const DURATION_WORD = /\b(?:three|six|nine|twelve)\s+months\b|\bquarters?\b|\byears?\s+end(?:ed|ing)\b|\bweeks\s+end(?:ed|ing)\b/i;

/** Controller ruling 3: a bare date heads an instant only in a table with no duration header. */
export function tableContext(grid: TableGrid): TableContext {
  return { grid, bareDateIsInstant: !grid.columnHeaders.some((h) => DURATION_WORD.test(h)) };
}

/** A column header's period; a period ending after the event date is an outlook, not an actual. */
function columnPeriod(ctx: TableContext, col: number, eventDate: string): PeriodCore | null {
  const p = parsePeriodHeader(ctx.grid.columnHeaders[col] ?? "", { bareDateIsInstant: ctx.bareDateIsInstant });
  if (!p) return null;
  return p.endDate && p.endDate > eventDate ? { ...p, role: "outlook" } : p;
}

/** R6: the reported quarter = the quarter column with the latest end date in the table. */
export function latestQuarterEnd(ctx: TableContext): string | null {
  let latest: string | null = null;
  for (let c = 0; c < ctx.grid.columnHeaders.length; c++) {
    const p = parsePeriodHeader(ctx.grid.columnHeaders[c] ?? "", { bareDateIsInstant: ctx.bareDateIsInstant });
    if (p && p.kind === "quarter" && p.endDate && (latest === null || p.endDate > latest)) latest = p.endDate;
  }
  return latest;
}

export function figurePeriod(fig: ModelFigure): PeriodCore {
  const p = fig.period;
  return { kind: p.kind, role: p.role, endDate: p.endDate, fiscalYear: p.fiscalYear, fiscalQuarter: p.fiscalQuarter };
}

/**
 * Do two bound figures speak of the same period? Kind or role differ → false
 * (a nine-month actual is never a full-year outlook). An anchored bogey period
 * resolves against the other figure's table (reported_quarter only); two
 * figures with the same anchor are the same period. Otherwise R5 `samePeriod`.
 * Null = cannot tell.
 */
export function periodsEqual(a: ResolvedFigure, b: ResolvedFigure): boolean | null {
  const pa = a.period;
  const pb = b.period;
  if (!pa || !pb) return null;
  if (pa.kind !== pb.kind || pa.role !== pb.role) return false;
  if (pa.anchor || pb.anchor) {
    if (pa.anchor && pb.anchor) return pa.anchor === pb.anchor ? true : null;
    const [anchored, other] = pa.anchor ? [pa, b] : [pb, a];
    if (anchored.anchor !== "reported_quarter" || !other.table || !other.period?.endDate) return null;
    const end = latestQuarterEnd(other.table);
    return end === null ? null : end === other.period.endDate;
  }
  return samePeriod(pa, pb);
}

// ---------------------------------------------------------------------------
// Quote figures
// ---------------------------------------------------------------------------

interface Cell { col: number; text: string; value: number }

/**
 * The numeric cells of a body row, whole cell by whole cell (controller
 * ruling 4), skipping the label columns. A negative split across two cells
 * ("(1,200" then ")") is read as one. Adjacent cells with identical text and
 * an identical column header are one colspan cell (ruling 1).
 */
function numericCells(grid: TableGrid, rowIndex: number): Cell[] {
  const row = grid.rows[rowIndex] ?? [];
  const label = grid.rowLabels[rowIndex] ?? "";
  let start = 0;
  while (start < row.length && row[start] === label) start++;
  const out: Cell[] = [];
  for (let c = start; c < row.length; c++) {
    let text = row[c].trim();
    if (/^\(\s*\$?\s*[\d,.]+$/.test(text) && /^\)/.test((row[c + 1] ?? "").trim())) text = `${text})`;
    const parsed = parseNumberToken(text);
    if (!parsed) continue;
    const prev = out[out.length - 1];
    if (prev && prev.col === c - 1 && prev.text === row[c].trim() && grid.columnHeaders[c] === grid.columnHeaders[prev.col]) {
      prev.col = c; // extend the run; the run counts once
      continue;
    }
    out.push({ col: c, text: row[c].trim(), value: parsed.value });
  }
  return out;
}

interface QuoteBinding { established: boolean; units: number | null; period: SourcePeriod | null; table: TableContext | null; reasons: CheckReason[] }

function bindTableRow(
  fig: ModelFigure, stated: StatedNumber, doc: DocText, tableId: number, rowIndex: number, eventDate: string,
): QuoteBinding {
  const reasons: CheckReason[] = [];
  const fail = (code: string, detail: string): QuoteBinding => {
    reasons.push(reason(code, fig.id, detail));
    return { established: false, units: null, period: null, table: null, reasons };
  };
  const grid = doc.tables.find((t) => t.id === tableId);
  if (!grid || !grid.rows[rowIndex]) return fail("value_not_in_quote", "the cited row is not a table body row");
  const ctx = tableContext(grid);
  const rowLabel = grid.rowLabels[rowIndex] ?? "";
  if (!metricMatchesLabel(fig.metric, rowLabel)) {
    reasons.push(reason("metric_unconfirmed", fig.id, `metric "${fig.metric}" does not name row "${rowLabel}"`));
  }
  const scale: FigureScale | null = fig.unit === "percent"
    ? "units"
    : scaleFromNote(grid.scaleNote ?? doc.documentScaleNote, fig.unit);
  if (!scale) return fail("scale_unconfirmed", "no scale note in or above the table, or none that covers this unit");

  const matched = numericCells(grid, rowIndex).filter((c) => matchesWithRounding(stated, toUnits(c.value, scale)));
  if (matched.length === 0) return fail("value_not_in_quote", `${fig.valueText} is not in row "${rowLabel}"`);
  const want = figurePeriod(fig);
  const dated = matched
    .map((c) => ({ c, p: columnPeriod(ctx, c.col, eventDate) }))
    .filter((x): x is { c: Cell; p: PeriodCore } => x.p !== null); // ruling 2: spacer/label columns out
  const same = dated.filter((x) => samePeriod(x.p, want) === true);
  if (same.length > 1) return fail("column_ambiguous", `${fig.valueText} matches ${same.length} columns for that period`);
  if (same.length === 0) {
    const other = dated.find((x) => samePeriod(x.p, want) === false);
    if (other) {
      return fail("periods_differ", `${fig.valueText} sits under "${grid.columnHeaders[other.c.col]}", not ${fig.period.label}`);
    }
    return fail("period_unconfirmed", `no column header names the period of ${fig.valueText}`);
  }
  const hit = same[0];
  return {
    established: reasons.length === 0,
    units: toUnits(hit.c.value, scale),
    period: { ...hit.p, anchor: null },
    table: ctx,
    reasons,
  };
}

function bindProse(fig: ModelFigure, stated: StatedNumber, located: LocatedQuote, eventDate: string): QuoteBinding {
  const reasons: CheckReason[] = [];
  const sentence = located.sentence ?? "";
  const label = fig.label ?? "";
  if (!metricMatchesLabel(fig.metric, label)) {
    reasons.push(reason("metric_unconfirmed", fig.id, `metric "${fig.metric}" does not match the phrase "${label}"`));
  }
  // Pair the number with its label: the first number of the same kind after
  // the label, else the nearest one before it. A sentence often carries
  // several figures ("revenue was X and costs were Y"); any-number matching
  // would let Y pass as revenue.
  const percent = fig.unit === "percent";
  const ns = normalizeForMatch(sentence);
  const nl = normalizeForMatch(label);
  const tokens = scanNumbers(ns).filter((t) => t.isPercent === percent);
  const matches = (t: NumberToken) => matchesWithRounding(stated, toUnits(t.value, t.wordScale ?? "units"));
  const at = nl ? ns.indexOf(nl) : -1;
  let hit: NumberToken | undefined;
  if (at >= 0) {
    const paired = tokens.find((t) => t.start >= at + nl.length) ?? [...tokens].reverse().find((t) => t.end <= at);
    hit = paired && matches(paired) ? paired : undefined;
  } else {
    if (nl && normalizeForMatch(located.block?.text ?? "").includes(nl)) {
      reasons.push(reason("label_not_in_quote", fig.id, `"${label}" is not in the cited sentence`));
    }
    hit = tokens.find(matches);
  }
  if (!hit) {
    reasons.push(reason("value_not_in_quote", fig.id, `${fig.valueText} is not the number ${at >= 0 ? `next to "${label}"` : "in the cited sentence"}`));
    return { established: false, units: null, period: null, table: null, reasons };
  }
  const period = parsePeriodPhrase(sentence, eventDate) ?? parsePeriodPhrase(located.block?.text ?? "", eventDate);
  if (!period) {
    reasons.push(reason("period_unconfirmed", fig.id, "neither the sentence nor its paragraph names a period"));
  } else {
    const same = samePeriod(period, figurePeriod(fig));
    if (same === false) reasons.push(reason("periods_differ", fig.id, `the sentence speaks of another period than ${fig.period.label}`));
    if (same === null) reasons.push(reason("period_unconfirmed", fig.id, `the sentence's period cannot be matched to ${fig.period.label}`));
  }
  return {
    established: reasons.length === 0,
    units: toUnits(hit.value, hit.wordScale ?? "units"),
    period: period ? { ...period, anchor: null } : null,
    table: null,
    reasons,
  };
}

/**
 * Bind a quote figure to its located citation: the label is in the located
 * block, the number is in the row (whole cell) or sentence, the scale and the
 * period come from the source, and the metric names the row or phrase.
 */
export function bindQuoteFigure(
  fig: ModelFigure,
  located: LocatedQuote,
  docs: Array<{ fileName: string; text: DocText }>,
  eventDate: string,
): ResolvedFigure {
  const base: ResolvedFigure = {
    figure: fig, established: false, contradicted: false, units: null, unit: fig.unit,
    period: null, basis: fig.basis, table: null, reasons: [],
  };
  const add = (code: string, detail: string) => base.reasons.push(reason(code, fig.id, detail));
  if (located.status === "not_found") { add("quote_not_found", "the cited quote is not in the filing"); return base; }
  if (located.status === "ambiguous" || !located.block) { add("ambiguous_quote", "the cited quote matches more than one place"); return base; }

  const stated = statedNumber(fig);
  if (!stated) { add("value_text_mismatch", `the shown text "${fig.valueText}" does not state the typed value`); return base; }
  const label = fig.label?.trim() ?? "";
  if (!label) add("label_missing", "the figure names no row label or phrase");
  else if (!normalizeForMatch(located.block.text).includes(normalizeForMatch(label))) {
    add("label_not_in_quote", `"${label}" is not in the cited line`);
  }

  const block = located.block;
  const doc = docs.find((d) => d.fileName === located.fileName)?.text;
  let binding: QuoteBinding;
  if (block.tableId !== null) {
    binding = doc && block.rowIndex !== null
      ? bindTableRow(fig, stated, doc, block.tableId, block.rowIndex, eventDate)
      : { established: false, units: null, period: null, table: null, reasons: [reason("value_not_in_quote", fig.id, "the cited line is a table heading")] };
  } else {
    binding = bindProse(fig, stated, located, eventDate);
  }
  base.reasons.push(...binding.reasons);
  base.units = binding.units;
  base.period = binding.period;
  base.table = binding.table;
  base.established = binding.established && base.reasons.length === 0;
  return base;
}

// ---------------------------------------------------------------------------
// Bogey figures (R6, controller ruling 6)
// ---------------------------------------------------------------------------

/** Period, unit and basis come from the frozen snapshot; the model's copy is ignored. */
export function bindBogeyFigure(fig: ModelFigure, bogeys: BogeySnapshotFigure[]): ResolvedFigure {
  const base: ResolvedFigure = {
    figure: fig, established: false, contradicted: false, units: null, unit: fig.unit,
    period: null, basis: "unknown", table: null, reasons: [],
  };
  const snap = fig.bogeyKey ? bogeys.find((b) => b.key === fig.bogeyKey) : undefined;
  if (!snap) {
    base.reasons.push(reason("bogey_not_found", fig.id, `no pre-print bogey has the key ${fig.bogeyKey ?? "(none)"}`));
    return base;
  }
  base.unit = snap.unit;
  base.basis = snap.basis;
  const p = snap.period;
  base.period = { kind: p.kind, role: p.role, endDate: p.endDate, fiscalYear: p.fiscalYear, fiscalQuarter: p.fiscalQuarter, anchor: p.anchor };
  const stated = statedNumber({ ...fig, unit: snap.unit });
  if (!stated) {
    base.reasons.push(reason("value_text_mismatch", fig.id, `the shown text "${fig.valueText}" does not state the typed value`));
    return base;
  }
  if (!matchesWithRounding(stated, toUnits(snap.value, snap.scale))) {
    base.reasons.push(reason("bogey_value_mismatch", fig.id, `${fig.valueText} is not the ${snap.provenance} figure`));
    return base;
  }
  base.units = toUnits(snap.value, snap.scale);
  base.established = true;
  return base;
}

// ---------------------------------------------------------------------------
// Basis (R6)
// ---------------------------------------------------------------------------

/**
 * Can these figures be compared on basis? `unknown` anywhere → "unknown"
 * (basis unconfirmed, never contradicted). guidance_low / high / mid name a
 * position in a range, not an accounting basis, so they pass. Two different
 * known accounting bases → "differ"; two "excluding_item" with different notes
 * cannot be told apart → "unknown".
 */
export function basisCompat(figs: ResolvedFigure[]): "ok" | "unknown" | "differ" {
  if (figs.some((f) => f.basis === "unknown")) return "unknown";
  const acct = figs.filter((f) => !f.basis.startsWith("guidance_"));
  const kinds = new Set(acct.map((f) => f.basis));
  if (kinds.size > 1) return "differ";
  if (kinds.has("excluding_item")) {
    const notes = new Set(acct.map((f) => normalizeForMatch(f.figure.basisNote ?? "")));
    if (notes.size > 1 || notes.has("")) return "unknown";
  }
  return "ok";
}

