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
import { matchesWithRounding, parseNumberToken, parsePeriodPhrase, scaleFromNote, toUnits } from "./figures";
import { basisConfirmed, basisEvidence, extendLabelLeft, metricMatchesLabel, proseBasisConfirmed } from "./evaluate-words";
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

export const reason = (code: string, figureId: string | null, detail: string): CheckReason => ({ code, figureId, detail });

export function emptyResolved(fig: ModelFigure, reasons: CheckReason[] = []): ResolvedFigure {
  return {
    figure: fig, established: false, contradicted: false, units: null, lo: null, hi: null, unit: fig.unit,
    period: null, basis: fig.basis, basisConfirmed: false, table: null, reasons,
  };
}

// ---------------------------------------------------------------------------
// Number tokens in free text (valueText, prose sentences)
// ---------------------------------------------------------------------------

const WORD_SCALE: Record<string, FigureScale> = {
  billion: "billions", billions: "billions", bn: "billions", b: "billions",
  million: "millions", millions: "millions", mn: "millions", mm: "millions", m: "millions",
  thousand: "thousands", thousands: "thousands", k: "thousands",
};
const SCALE_FACTOR: Record<FigureScale, number> = { units: 1, thousands: 1e3, millions: 1e6, billions: 1e9 };

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

/**
 * R1 for the shown text: a figure's valueText is ONE number. Any digit left
 * once that number is removed ("$64.6B, a 3-year high", "$64.6B (10-Q)") is a
 * number the owner sees that nothing checked.
 */
export function valueTextHasExtraDigit(valueText: string): boolean {
  const tokens = scanNumbers(valueText);
  if (tokens.length > 1) return true;
  if (tokens.length === 0) return /\d/.test(valueText);
  return /\d/.test(valueText.slice(0, tokens[0].start) + valueText.slice(tokens[0].end));
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

/** Half a unit of a printed number's last digit, in plain units. */
export function halfUnit(decimals: number, scale: FigureScale): number {
  return 0.5 * 10 ** -decimals * SCALE_FACTOR[scale];
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

interface Binding {
  established: boolean; units: number | null; half: number; period: SourcePeriod | null;
  table: TableContext | null; basisConfirmed: boolean; reasons: CheckReason[];
}
const failed = (reasons: CheckReason[]): Binding => ({
  established: false, units: null, half: 0, period: null, table: null, basisConfirmed: false, reasons,
});

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

  const matched = numericCells(grid, rowIndex).filter((c) => matchesWithRounding(stated, toUnits(c.value, scale)));
  if (matched.length === 0) return fail("value_not_in_quote", `${fig.valueText} is not in row "${rowLabel}"`);
  const want: SourcePeriod = { ...fig.period, anchor: null };
  const dated = matched
    .map((c) => ({ c, p: columnPeriod(ctx, c.col, eventDate) }))
    .filter((x): x is { c: Cell; p: NonNullable<ReturnType<typeof columnPeriod>> } => x.p !== null); // ruling 2
  const evidenceAt = (col: number) =>
    basisEvidence([grid.columnHeaders[col] ?? "", `${section ?? ""} ${rowLabel}`, caption]);
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
  if (!metricMatchesLabel(fig.metric, rowLabel, { section, context: `${grid.columnHeaders[hit.c.col] ?? ""} ${caption}` })) {
    reasons.push(reason("metric_unconfirmed", fig.id, `metric "${fig.metric}" does not name row "${section ? `${section} ` : ""}${rowLabel}"`));
  }
  return {
    established: reasons.length === 0,
    units: toUnits(hit.c.value, scale),
    half: halfUnit(hit.c.decimals, scale),
    period: { ...hit.p, anchor: null },
    table: ctx,
    basisConfirmed: basisConfirmed(fig.basis, evidenceAt(hit.c.col)),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MONTH_WORD = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const MONTH_BEFORE = new RegExp(`\\b${MONTH_WORD}\\s+$`, "i");
const DATE_RE = new RegExp(`\\b${MONTH_WORD}\\s+\\d{1,2}(?:,\\s*(?:19|20)\\d\\d)?\\b`, "gi");

/** A token that is the day of a date ("September 30"), not a quantity. */
function isDateDay(text: string, t: NumberToken): boolean {
  return !t.isPercent && t.wordScale === null && Number.isInteger(t.value) && t.value >= 1 && t.value <= 31
    && !/\$/.test(text.slice(t.start, t.end)) && MONTH_BEFORE.test(text.slice(0, t.start));
}

/** Numbers of a text that are quantities: no bare year (scanNumbers skips those) and no date day. */
export function quantityTokens(text: string): NumberToken[] {
  return scanNumbers(text).filter((t) => !isDateDay(text, t));
}

/**
 * Cut a (normalised) sentence into clauses (fix rounds 2–4). Breaks: ", or", " or", ";", and a comma or an
 * " and " whose following stretch (up to the next comma or semicolon) holds a quantity. A comma inside a
 * date ("September 30, 2026") or before a four-digit year is never a break; "the three and nine months
 * ended" is not either (a date day is not a quantity).
 */
export function splitClauses(text: string): Array<{ start: number; end: number; text: string }> {
  const cuts: Array<[number, number]> = [];
  const sep = /,\s*or\s+|\s+or\s+|;\s*|\s+and\s+|,\s*/g;
  for (const m of text.matchAll(sep)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const sepText = m[0].trim();
    if (sepText === "or" || sepText === ";" || /^,\s*or$/.test(sepText)) {
      cuts.push([start, end]);
      continue;
    }
    if (sepText !== "and") {
      if (/^(?:19|20)\d\d\b/.test(text.slice(end))) continue; // "September 30, 2026", "in 2025, 2026"
      if (new RegExp(`\\b${MONTH_WORD}\\s+\\d{1,2}$`, "i").test(text.slice(0, start))) continue;
    }
    const next = text.slice(end).search(/[,;]/);
    const stretch = next < 0 ? text.slice(end) : text.slice(end, end + next);
    if (quantityTokens(stretch).length > 0) cuts.push([start, end]);
  }
  const out: Array<{ start: number; end: number; text: string }> = [];
  let from = 0;
  for (const [start, end] of cuts) {
    out.push({ start: from, end: start, text: text.slice(from, start) });
    from = end;
  }
  out.push({ start: from, end: text.length, text: text.slice(from) });
  return out;
}

/** The clause holding the character at `at`. */
export function clauseAt(text: string, at: number): string {
  const clauses = splitClauses(text);
  return (clauses.find((c) => at < c.end) ?? clauses[clauses.length - 1]).text;
}

/**
 * The clauses that speak for a prose figure's basis (fix round 4 ruling).
 * `own` is the clause holding the number. A numberless clause ATTACHES to a
 * number clause only when that clause is its nearest number clause on one
 * side and no number clause sits on its other side: "On a non-GAAP basis,
 * EPS was $2.10" and "EPS was $2.10, on a non-GAAP basis" both speak of the
 * $2.10, but in "…$1.80…; on a non-GAAP basis, … $2.10" the middle clause
 * attaches to neither number. `others` are the remaining numberless clauses
 * (they can still deny "reported", never confirm anything).
 */
export interface ProseBasisClauses { own: string; attached: string[]; others: string[] }

export function proseBasisClauses(text: string, at: number): ProseBasisClauses {
  const clauses = splitClauses(text);
  const found = clauses.findIndex((c) => at < c.end);
  const ownIndex = found < 0 ? clauses.length - 1 : found;
  const isNumber = clauses.map((c) => quantityTokens(c.text.replace(DATE_RE, " ")).length > 0);
  const first = isNumber.indexOf(true);
  const last = isNumber.lastIndexOf(true);
  const attached: string[] = [];
  const others: string[] = [];
  clauses.forEach((c, i) => {
    if (isNumber[i]) return;
    const leads = i < first && ownIndex === first;
    const trails = i > last && ownIndex === last;
    (leads || trails ? attached : others).push(c.text);
  });
  return { own: clauses[ownIndex].text, attached, others };
}

/**
 * In a sentence that lists figures "respectively", the k-th label takes the
 * k-th number after the labels: k is the count of list separators (",",
 * "and", "as well as") between the label and the nearest quantity before it.
 * A count that overshoots the numbers binds nothing (a safe miss).
 */
function respectivelyIndex(ns: string, labelStart: number, tokens: NumberToken[]): number {
  if (!/\brespectively\b/.test(ns)) return 0;
  const prev = [...tokens].reverse().find((t) => t.end <= labelStart);
  const before = ns.slice(prev ? prev.end : 0, labelStart);
  return (before.match(/,|\band\b|\bas well as\b/g) ?? []).length;
}

function bindProse(fig: ModelFigure, stated: StatedNumber, located: LocatedQuote, eventDate: string): Binding {
  const reasons: CheckReason[] = [];
  const sentence = located.sentence ?? "";
  const ns = normalizeForMatch(sentence);
  const nl = normalizeForMatch(fig.label ?? "");
  // Every place the label sits at word boundaries ("income" never matches inside "incomes").
  const starts = nl ? [...ns.matchAll(new RegExp(`(?<![a-z0-9])${escapeRe(nl)}(?![a-z0-9])`, "g"))].map((x) => x.index ?? 0) : [];
  if (starts.length === 0 && nl) reasons.push(reason("label_not_in_quote", fig.id, `"${fig.label}" is not a phrase of the cited sentence`));
  // Pair the number with its label: the first number of the same kind after it, else the nearest before it.
  // "Revenue and net income were $X and $Y, respectively": the k-th label takes the k-th number after it.
  // A label used twice ("EPS was $1.80; non-GAAP EPS was $2.10") is tried at each place (fix round 4).
  const percent = fig.unit === "percent";
  const all = quantityTokens(ns); // years and date days are never the figure
  const tokens = all.filter((t) => t.isPercent === percent);
  const matches = (t: NumberToken) => matchesWithRounding(stated, toUnits(t.value, t.wordScale ?? "units"));
  const pairedAt = (at: number): NumberToken | undefined => {
    const k = respectivelyIndex(ns, at, all);
    const paired = k > 0
      ? all.filter((t) => t.start >= at + nl.length)[k]
      : tokens.find((t) => t.start >= at + nl.length) ?? [...tokens].reverse().find((t) => t.end <= at);
    return paired && paired.isPercent === percent && matches(paired) ? paired : undefined;
  };
  let hit: NumberToken | undefined;
  let labelAt = starts[0];
  for (const at of starts) {
    hit = pairedAt(at);
    if (hit) { labelAt = at; break; }
  }
  if (starts.length === 0) hit = tokens.find(matches);
  // The label widened to its noun phrase, at the place that paired (else the first).
  const phrase = labelAt !== undefined ? `${extendLabelLeft(ns.slice(0, labelAt))} ${nl}`.trim() : nl;
  if (!metricMatchesLabel(fig.metric, phrase, { context: sentence })) {
    reasons.push(reason("metric_unconfirmed", fig.id, `metric "${fig.metric}" does not match "${phrase}"`));
  }
  if (!hit) {
    return failed([...reasons, reason("value_not_in_quote", fig.id, `${fig.valueText} is not the number ${starts.length ? `next to "${fig.label}"` : "in the cited sentence"}`)]);
  }
  const period = parsePeriodPhrase(sentence, eventDate) ?? parsePeriodPhrase(located.block?.text ?? "", eventDate);
  if (!period) {
    reasons.push(reason("period_unconfirmed", fig.id, "neither the sentence nor its paragraph names a period"));
  } else {
    const same = periodsMatch({ ...period, anchor: null }, { ...fig.period, anchor: null });
    if (same === false) reasons.push(reason("periods_differ", fig.id, `the sentence speaks of another period than ${fig.period.label}`));
    if (same === null) reasons.push(reason("period_unconfirmed", fig.id, `the sentence's period cannot be matched to ${fig.period.label}`));
  }
  const scale = hit.wordScale ?? "units";
  return {
    established: reasons.length === 0,
    units: toUnits(hit.value, scale),
    half: halfUnit(hit.decimals, scale),
    period: period ? { ...period, anchor: null } : null,
    table: null,
    basisConfirmed: proseBasisConfirmed(fig.basis, proseBasisClauses(ns, hit.start)),
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
  const label = fig.label?.trim() ?? "";
  if (!label) add("label_missing", "the figure names no row label or phrase");
  else if (!normalizeForMatch(located.block.text).includes(normalizeForMatch(label))) add("label_not_in_quote", `"${label}" is not in the cited line`);

  const block = located.block;
  const doc = docs.find((d) => d.fileName === located.fileName)?.text;
  const binding: Binding = block.tableId !== null
    ? (doc && block.rowIndex !== null
      ? bindTableRow(fig, stated, doc, block.tableId, block.rowIndex, eventDate)
      : failed([reason("value_not_in_quote", fig.id, "the cited line is a table heading")]))
    : bindProse(fig, stated, located, eventDate);
  for (const r of binding.reasons) if (!out.reasons.some((x) => x.code === r.code)) out.reasons.push(r);
  out.units = binding.units;
  out.lo = binding.units === null ? null : binding.units - binding.half;
  out.hi = binding.units === null ? null : binding.units + binding.half;
  out.period = binding.period;
  out.table = binding.table;
  out.basisConfirmed = binding.basisConfirmed;
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
