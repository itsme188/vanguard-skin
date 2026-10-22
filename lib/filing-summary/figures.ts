/**
 * Pure rules for numbers, periods and relations (spec R4, R5, R7, R8).
 *
 * The filing-summary checker (`evaluate.ts`) uses these to decide whether a
 * figure the model states matches a cell or sentence in the filing, which
 * period a column or sentence speaks of, and whether a stated relation
 * ("above consensus", "raised guidance") holds. Every function here is pure:
 * no database, no clock, no I/O.
 *
 * Conservative by design (R9): when a rule cannot tell, it answers `null` or
 * "unconfirmed", never a guess. A dash or "n/a" cell is missing, never zero.
 */
import type {
  CheckReason,
  ComputeOp,
  FigureScale,
  FigureUnit,
  PeriodSpec,
  Relation,
} from "./types";

/** The "in line" band: |difference| ≤ 0.5% of |comparator|, inclusive (R7). */
export const IN_LINE_BAND = 0.005;

/** Every reason code this file emits; `evaluate.ts` merges them into its list. */
export const FIGURE_REASON_CODES = [
  "zero_comparator",
  "unit_mismatch",
  "range_operand_unsupported",
  "non_finite_operand",
] as const;
export type FigureReasonCode = (typeof FIGURE_REASON_CODES)[number];

/** The period fields a rule reads or produces (no anchor, no label). */
export type PeriodCore = Omit<PeriodSpec, "anchor" | "label">;

// ---------------------------------------------------------------------------
// Numbers (R4)
// ---------------------------------------------------------------------------

const MISSING_TOKENS = new Set(["", "-", "—", "–", "−", "n/a", "na", "nm", "n.m.", "*"]);
const MINUS_CHARS = /[−–—]/g; // unicode minus and dashes used as a leading minus

/**
 * Read one table cell or number token. Commas, a currency sign, a trailing
 * "%", parentheses (negative) and a leading minus are accepted; a dash, "n/a",
 * "nm" or an empty cell is missing (null), never zero. Anything else that is
 * not exactly one number is null.
 */
export function parseNumberToken(raw: string): { value: number; decimals: number } | null {
  let s = raw.trim();
  if (MISSING_TOKENS.has(s.toLowerCase())) return null;

  let negative = false;
  // Leading sign (before or after a currency sign): "-$1.20", "−3.2", "+3.1%".
  const leadSign = /^([+\-−–])\s*/.exec(s);
  if (leadSign) {
    negative = leadSign[1] !== "+";
    s = s.slice(leadSign[0].length);
  }
  s = s.replace(/^\$\s*/, "");
  if (!leadSign) {
    const afterCurrencySign = /^([+\-−–])\s*/.exec(s);
    if (afterCurrencySign) {
      negative = afterCurrencySign[1] !== "+";
      s = s.slice(afterCurrencySign[0].length);
    }
  }
  s = s.replace(/\s*%$/, ""); // "(2.1)%"
  const paren = /^\(\s*\$?\s*([^()]*?)\s*\)$/.exec(s);
  if (paren) {
    if (negative) return null; // "-(5)" is not a filing number
    negative = true;
    s = paren[1];
  }
  s = s.replace(/\s*%$/, "");
  s = s.replace(MINUS_CHARS, "-");
  if (MISSING_TOKENS.has(s.toLowerCase())) return null;

  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const intPart = (m[1] ?? "0").replace(/,/g, "");
  const frac = m[2] ?? "";
  const value = Number(frac ? `${intPart}.${frac}` : intPart);
  if (!Number.isFinite(value)) return null;
  return { value: negative && value !== 0 ? -value : value, decimals: frac.length };
}

const SCALE_FACTOR: Record<FigureScale, number> = {
  units: 1,
  thousands: 1e3,
  millions: 1e6,
  billions: 1e9,
};

/** A value stated in `scale` expressed in plain units. */
export function toUnits(value: number, scale: FigureScale): number {
  return value * SCALE_FACTOR[scale];
}

const SCALE_WORD = /\b(thousands|millions|billions)\b/gi;

function scaleWord(word: string): FigureScale {
  return word.toLowerCase() as FigureScale;
}

/**
 * The scale a table's note gives a figure of `unit` (R3).
 *
 * - No note, or a note naming no scale → null (the caller tries the document
 *   note, then gives up).
 * - Percentages are never scaled → "units".
 * - "except per share" (any wording with "per share" / "per-share" in the
 *   except clause) → "units" for `usd_per_share`; without that exemption a
 *   per-share figure under a scaled note cannot be told → null.
 * - "except share and per share" exempts share counts too → "units" for
 *   `shares`; a separate "shares in thousands" sets the share scale.
 * - `other` → null (an unknown unit cannot be scaled safely).
 */
export function scaleFromNote(note: string | null, unit: FigureUnit): FigureScale | null {
  if (!note) return null;
  const text = note.replace(/\s+/g, " ");
  const exceptIdx = text.search(/\bexcept\b/i);
  const exceptClause = exceptIdx >= 0 ? text.slice(exceptIdx) : "";
  const exemptsPerShare = /\bper[\s-]share\b/i.test(exceptClause);
  // "share" or "shares" in the except clause that is not part of "per share".
  const exemptsShares = /\bshares?\b/i.test(exceptClause.replace(/\bper[\s-]shares?\b/gi, " "));

  // Separate share scale: "shares in thousands", "in thousands of shares".
  const shareScaleMatch =
    /\bshares?(?:\s+amounts?)?\s+(?:are\s+)?in\s+(thousands|millions|billions)\b/i.exec(text) ??
    /\bin\s+(thousands|millions|billions)\s+of\s+shares\b/i.exec(text);
  // The general scale: the first scale word that is not the share scale.
  let general: FigureScale | null = null;
  for (const m of text.matchAll(SCALE_WORD)) {
    if (shareScaleMatch && m.index >= shareScaleMatch.index && m.index < shareScaleMatch.index + shareScaleMatch[0].length) {
      continue;
    }
    general = scaleWord(m[1]);
    break;
  }

  switch (unit) {
    case "percent":
      return general || shareScaleMatch ? "units" : null;
    case "usd_per_share":
      if (!general && !shareScaleMatch) return null;
      return exemptsPerShare ? "units" : null;
    case "shares":
      if (shareScaleMatch) return scaleWord(shareScaleMatch[1]);
      if (!general) return null;
      return exemptsShares ? "units" : general;
    case "usd":
    case "count":
    case "people":
      return general;
    case "other":
      return null;
  }
}

/**
 * R4 rounding rule: the stated figure matches when the source, expressed in
 * the stated scale, is within half a unit of the stated figure's last digit,
 * inclusive (12.99 billions matches 12,985 to 12,995 millions).
 */
export function matchesWithRounding(
  stated: { value: number; decimals: number; scale: FigureScale },
  sourceUnits: number,
): boolean {
  if (!Number.isFinite(stated.value) || !Number.isFinite(sourceUnits)) return false;
  if (!Number.isInteger(stated.decimals) || stated.decimals < 0) return false;
  const source = sourceUnits / SCALE_FACTOR[stated.scale];
  const half = 0.5 * 10 ** -stated.decimals;
  // Floating-point slack only: far below any real half-unit, so exactly-half
  // stays inclusive and anything a digit beyond stays out.
  const slack = half * 1e-9 + 8 * Number.EPSILON * Math.max(Math.abs(source), Math.abs(stated.value));
  return Math.abs(source - stated.value) <= half + slack;
}

// ---------------------------------------------------------------------------
// Periods (R5)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const YEAR_RE = "((?:19|20)\\d\\d)";

function isoDate(monthWord: string, day: number, year: number): string | null {
  const key = monthWord.toLowerCase().replace(/\.$/, "");
  const month = MONTHS[key.slice(0, 4) === "sept" ? "sept" : key.slice(0, 3)];
  if (!month || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type DurationKind = Exclude<PeriodCore["kind"], "instant">;

const QUARTER_DURATION =
  /\b(?:(?:three|3)[\s-]*months?|quarters?|(?:twelve|thirteen|fourteen|sixteen|12|13|14|16)[\s-]*weeks?)\s+end(?:ed|ing)\b/i;
const YTD_DURATION =
  /\b(?:(?:six|nine|6|9)[\s-]*months?|(?:twenty[\s-]+four|twenty[\s-]+six|twenty[\s-]+seven|twenty[\s-]+eight|thirty[\s-]+six|thirty[\s-]+nine|forty|24|26|27|28|36|39|40)[\s-]*weeks?)\s+end(?:ed|ing)\b|\byear[\s-]+to[\s-]+date\b/i;
const YEAR_DURATION =
  /\b(?:(?:fiscal\s+)?years?|(?:twelve|12)[\s-]*months?|(?:fifty[\s-]+two|fifty[\s-]+three|52|53)[\s-]*weeks?)\s+end(?:ed|ing)\b/i;
const INSTANT_LEAD = /(?:^|\/)\s*(?:as\s+of|at)\b/i;

function durationKinds(text: string): DurationKind[] {
  const kinds: DurationKind[] = [];
  if (QUARTER_DURATION.test(text)) kinds.push("quarter");
  if (YTD_DURATION.test(text)) kinds.push("year_to_date");
  if (YEAR_DURATION.test(text)) kinds.push("fiscal_year");
  return kinds;
}

/**
 * Read a table column header (all header rows joined with " / ") into a
 * period. "Three Months Ended" → quarter, "Six/Nine Months Ended" →
 * year_to_date, "Year Ended" / "Twelve Months Ended" → fiscal_year, "As of" /
 * "At" a date → instant. The year may sit in a later header part. A header
 * with no duration word but a quarter or fiscal-year label ("Q3 2026") is read
 * like a sentence. Two durations, two dates, two years, a bare date or an
 * impossible date → null. Role is always "actual".
 */
export function parsePeriodHeader(text: string): PeriodCore | null {
  if (!text || !text.trim()) return null;
  const kinds = durationKinds(text);
  const instant = INSTANT_LEAD.test(text);
  if (kinds.length + (instant ? 1 : 0) > 1) return null;

  if (kinds.length === 0 && !instant) {
    const labelled = scanLabelledPeriods(text);
    if (labelled.unresolved || labelled.periods.length !== 1) return null;
    return { ...labelled.periods[0], role: "actual" };
  }

  const dayMatches = [...text.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})\\b`, "gi"))];
  if (dayMatches.length !== 1) return null;
  const years = new Set([...text.matchAll(new RegExp(`\\b${YEAR_RE}\\b`, "g"))].map((m) => m[1]));
  if (years.size !== 1) return null;
  const endDate = isoDate(dayMatches[0][1], Number(dayMatches[0][2]), Number([...years][0]));
  if (!endDate) return null;
  return {
    kind: instant ? "instant" : kinds[0],
    role: "actual",
    endDate,
    fiscalYear: null,
    fiscalQuarter: null,
  };
}

const ORDINAL_QUARTER: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4,
};

function fullYear(token: string): number {
  return token.length === 2 ? 2000 + Number(token) : Number(token);
}

// A year after a quarter word: "2026", "of 2026", "fiscal 2026", "fiscal year 2026", "FY26", "FY 2026", "'26".
const QYEAR = "(?:,\\s*)?(?:of\\s+)?(?:(?:fiscal(?:\\s+year)?\\s+)?((?:19|20)\\d\\d)|FY\\s?'?(\\d{4}|\\d{2})|'(\\d{2}))\\b";

interface LabelledScan {
  periods: Array<Omit<PeriodCore, "role">>;
  unresolved: boolean;
}

/**
 * Find quarter, year-to-date and full-year labels with a year ("third quarter
 * of 2026", "Q3 FY26", "first nine months of 2026", "fiscal 2026"), and note
 * whether any period word is left without one ("third quarter", "prior year").
 */
function scanLabelledPeriods(input: string): LabelledScan {
  let text = ` ${input} `;
  const periods: Array<Omit<PeriodCore, "role">> = [];
  const take = (re: RegExp, build: (m: RegExpExecArray) => Omit<PeriodCore, "role"> | null) => {
    text = text.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const p = build(m);
      if (p) periods.push(p);
      return " ";
    });
  };
  const quarter = (q: number, y: number) => ({
    kind: "quarter" as const, endDate: null, fiscalYear: y, fiscalQuarter: q,
  });
  const yearOf = (a?: string, b?: string, c?: string) => fullYear((a ?? b ?? c) as string);

  // "third quarter of fiscal 2026", "fiscal third quarter 2026"
  take(
    new RegExp(`\\b(?:fiscal\\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)[\\s-]+(?:fiscal\\s+)?quarter\\s*${QYEAR}`, "gi"),
    (m) => quarter(ORDINAL_QUARTER[m[1].toLowerCase()], yearOf(m[2], m[3], m[4])),
  );
  // "fiscal 2026 third quarter", "2026 third quarter"
  take(
    new RegExp(`\\b(?:fiscal\\s+(?:year\\s+)?)?${YEAR_RE}\\s+(?:fiscal\\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)[\\s-]+quarter\\b`, "gi"),
    (m) => quarter(ORDINAL_QUARTER[m[2].toLowerCase()], Number(m[1])),
  );
  // "Q3 2026", "Q3 FY26", "Q3'26"
  take(new RegExp(`\\bQ([1-4])\\s*${QYEAR}`, "gi"), (m) => quarter(Number(m[1]), yearOf(m[2], m[3], m[4])));
  // "3Q26", "3Q 2026"
  take(/\b([1-4])Q\s?'?(\d{4}|\d{2})\b/gi, (m) => quarter(Number(m[1]), fullYear(m[2])));
  // "first nine months of 2026", "first half of fiscal 2026"
  take(
    new RegExp(`\\bfirst\\s+(nine\\s+months|six\\s+months|half)\\s*${QYEAR}`, "gi"),
    (m) => ({
      kind: "year_to_date",
      endDate: null,
      fiscalYear: yearOf(m[2], m[3], m[4]),
      fiscalQuarter: /nine/i.test(m[1]) ? 3 : 2,
    }),
  );
  // "full year 2026", "full-year 2026", "fiscal 2026", "fiscal year 2026", "FY2026"
  take(
    new RegExp(`\\b(?:full[\\s-]+(?:fiscal[\\s-]+)?year|fiscal(?:[\\s-]+year)?)\\s+(?:of\\s+)?${YEAR_RE}\\b`, "gi"),
    (m) => ({ kind: "fiscal_year", endDate: null, fiscalYear: Number(m[1]), fiscalQuarter: null }),
  );
  take(/\bFY\s?'?(\d{4}|\d{2})\b/gi, (m) => ({
    kind: "fiscal_year", endDate: null, fiscalYear: fullYear(m[1]), fiscalQuarter: null,
  }));

  const unresolved =
    /\b(?:first|second|third|fourth|1st|2nd|3rd|4th)[\s-]+(?:fiscal\s+)?quarter\b|\bQ[1-4]\b|\b[1-4]Q\b|\b(?:three|six|nine|twelve)\s+months\b|\bfirst\s+half\b|\bfull[\s-]+year\b|\bfiscal\s+year\b|\byear[\s-]+to[\s-]+date\b|\b(?:prior|previous|last|next|year[\s-]+ago|same)[\s-]+(?:fiscal\s+)?(?:year|quarter|period)\b|\ba\s+year\s+(?:earlier|ago)\b|\bsequential(?:ly)?\b/i.test(
      text,
    );
  return { periods, unresolved };
}

const OUTLOOK_WORDS =
  /\b(?:expects?|expecting|expected\s+to|outlook|guidance|guides?|guided|guiding|anticipates?|anticipated|anticipating|forecasts?|forecasted|projects|projected\s+to|projecting|sees|reaffirm(?:s|ed|ing)?|will\s+be|to\s+be\s+in\s+the\s+range)\b/i;

function periodKey(p: PeriodCore): string {
  return `${p.kind}|${p.role}|${p.endDate ?? ""}|${p.fiscalYear ?? ""}|${p.fiscalQuarter ?? ""}`;
}

/**
 * Read the period a sentence names (R5). Dated durations ("nine months ended
 * September 30, 2026"), quarter labels with a year ("third quarter 2026",
 * "Q3 2026", "3Q26"), year-to-date labels ("first nine months of 2026", whose
 * fiscalQuarter is the number of quarters covered) and full-year labels
 * ("full year 2026", "fiscal 2026", "FY26").
 *
 * Role is "outlook" when the sentence uses guidance wording (expects, outlook,
 * guidance, anticipates, …) or a dated period ends after `eventDate`;
 * otherwise "actual". A period word without a year ("in the third quarter"),
 * a relative period ("prior year") or two different periods → null.
 */
export function parsePeriodPhrase(sentence: string, eventDate: string): PeriodCore | null {
  let text = ` ${sentence} `;
  const dated: Array<Omit<PeriodCore, "role">> = [];

  const datedRe = new RegExp(
    `\\b((?:(?:three|six|nine|twelve|3|6|9|12)[\\s-]*months?|quarter|(?:fiscal\\s+)?year|\\d{1,2}[\\s-]*weeks?)\\s+end(?:ed|ing)|as\\s+of)\\s+${MONTH_RE}\\s+(\\d{1,2}),?\\s+${YEAR_RE}\\b`,
    "gi",
  );
  let invalid = false;
  text = text.replace(datedRe, (whole: string, lead: string, month: string, day: string, year: string) => {
    const endDate = isoDate(month, Number(day), Number(year));
    if (!endDate) {
      invalid = true;
      return " ";
    }
    if (/^as\s+of$/i.test(lead)) {
      dated.push({ kind: "instant", endDate, fiscalYear: null, fiscalQuarter: null });
      return " ";
    }
    const kinds = durationKinds(lead.replace(/\s+end(?:ing)$/i, " ended"));
    if (kinds.length !== 1) {
      invalid = true;
      return " ";
    }
    dated.push({ kind: kinds[0], endDate, fiscalYear: null, fiscalQuarter: null });
    return " ";
  });
  if (invalid) return null;

  const labelled = scanLabelledPeriods(text);
  if (labelled.unresolved) return null;

  const outlookWording = OUTLOOK_WORDS.test(sentence);
  const found: PeriodCore[] = [...dated, ...labelled.periods].map((p) => ({
    ...p,
    role: outlookWording || (p.endDate !== null && p.endDate > eventDate) ? "outlook" : "actual",
  }));
  const distinct = new Map(found.map((p) => [periodKey(p), p]));
  if (distinct.size !== 1) return null;
  return [...distinct.values()][0];
}

/**
 * R5 equality. Different kind or role → false. Both end dates known → equal
 * end dates. Otherwise fiscal year (and, for a quarter or year-to-date,
 * fiscal quarter) on both sides → equal values. Anything less → null
 * (cannot tell), never "different".
 */
export function samePeriod(a: PeriodCore, b: PeriodCore): boolean | null {
  if (a.kind !== b.kind || a.role !== b.role) return false;
  if (a.endDate && b.endDate) return a.endDate === b.endDate;
  if (a.endDate || b.endDate) return null;
  if (a.kind === "instant") return null;
  if (a.fiscalYear === null || b.fiscalYear === null) return null;
  if (a.kind === "fiscal_year") return a.fiscalYear === b.fiscalYear;
  if (a.fiscalQuarter === null || b.fiscalQuarter === null) return null;
  return a.fiscalYear === b.fiscalYear && a.fiscalQuarter === b.fiscalQuarter;
}

// ---------------------------------------------------------------------------
// Relations (R7)
// ---------------------------------------------------------------------------

/** One side of a relation, in plain units. `low` and `high` together = a range. */
export interface Operand {
  units: number;
  unit: FigureUnit;
  low?: number;
  high?: number;
}

export interface RelationResult {
  verdict: "matches" | "contradicted" | "unconfirmed";
  difference: number | null;
  differencePct: number | null;
  shownText: string | null;
  reasons: CheckReason[];
}

const reason = (code: FigureReasonCode, detail: string): CheckReason => ({ code, figureId: null, detail });

function unconfirmed(code: FigureReasonCode, detail: string): RelationResult {
  return { verdict: "unconfirmed", difference: null, differencePct: null, shownText: null, reasons: [reason(code, detail)] };
}

/** Relative float slack for "equal": scale noise (12.99e9 vs 12,990e6) is not a difference. */
function nearlyZero(d: number, ...magnitudes: number[]): boolean {
  return Math.abs(d) <= 1e-9 * Math.max(0, ...magnitudes.map(Math.abs));
}

function signed(x: number, decimals: number): string {
  const fixed = x.toFixed(decimals);
  if (Number(fixed) === 0) return (0).toFixed(decimals);
  return x > 0 ? `+${fixed}` : fixed;
}

/**
 * Shown difference: percentage points (1 decimal) for percent operands,
 * otherwise the relative difference in percent (2 decimals). Null when a
 * relative figure cannot be formed (zero comparator).
 */
function shown(unit: FigureUnit, difference: number, differencePct: number | null, suffix: string): string | null {
  if (unit === "percent") return `${signed(difference, 1)} pp${suffix}`;
  if (differencePct === null) return null;
  return `${signed(differencePct, 2)}%${suffix}`;
}

interface Span { low: number; high: number; mid: number; width: number; isRange: boolean }

function span(o: Operand): Span | null {
  const hasLow = o.low !== undefined;
  const hasHigh = o.high !== undefined;
  if (hasLow !== hasHigh) return null;
  if (hasLow && hasHigh) {
    const low = o.low as number;
    const high = o.high as number;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
    return { low, high, mid: (low + high) / 2, width: high - low, isRange: true };
  }
  return { low: o.units, high: o.units, mid: o.units, width: 0, isRange: false };
}

function measure(unit: FigureUnit, d: number, comparator: number, suffix: string) {
  const differencePct = comparator === 0 ? null : (d / Math.abs(comparator)) * 100;
  return { difference: d, differencePct, shownText: shown(unit, d, differencePct, suffix) };
}

/**
 * Check a stated relation between `left` (the stated figure, or the new
 * guidance) and `right` (the comparator, or the prior guidance), R7:
 *
 * - above ⇔ left − right > 0; below ⇔ < 0; in line ⇔ |d| ≤ 0.5% of |right|
 *   inclusive. "Above" inside the band is still true. A zero comparator makes
 *   in line unconfirmed (direction is still decided).
 * - A range comparator: in line = inside the range inclusive; above / below =
 *   outside it. The difference is measured against the end crossed ("vs high
 *   end" / "vs low end"), or the midpoint when inside.
 * - raised / lowered compare midpoints, narrowed compares widths, unchanged
 *   needs equal low and equal high. A single number is a range of zero width.
 * - Percent operands report the difference in percentage points ("+0.3 pp");
 *   `differencePct` is always difference / |comparator| × 100.
 */
export function checkRelation(relation: Relation, left: Operand, right: Operand): RelationResult {
  if (left.unit !== right.unit) {
    return unconfirmed("unit_mismatch", `${left.unit} compared with ${right.unit}`);
  }
  if (!Number.isFinite(left.units) || !Number.isFinite(right.units)) {
    return unconfirmed("non_finite_operand", "an operand is not a finite number");
  }
  const l = span(left);
  const r = span(right);
  if (!l || !r) return unconfirmed("range_operand_unsupported", "a range needs both a valid low and high");
  const unit = left.unit;

  if (relation === "above" || relation === "below" || relation === "in_line") {
    if (l.isRange) {
      return unconfirmed("range_operand_unsupported", `a range cannot be stated as ${relation} a comparator`);
    }
    const x = left.units;
    if (r.isRange) {
      const aboveHigh = x > r.high && !nearlyZero(x - r.high, x, r.high);
      const belowLow = x < r.low && !nearlyZero(x - r.low, x, r.low);
      const m = aboveHigh
        ? measure(unit, x - r.high, r.high, " vs high end")
        : belowLow
          ? measure(unit, x - r.low, r.low, " vs low end")
          : measure(unit, x - r.mid, r.mid, " vs midpoint");
      const holds = relation === "above" ? aboveHigh : relation === "below" ? belowLow : !aboveHigh && !belowLow;
      return { verdict: holds ? "matches" : "contradicted", ...m, reasons: [] };
    }

    const c = right.units;
    const raw = x - c;
    const d = nearlyZero(raw, x, c) ? 0 : raw;
    const m = measure(unit, d, c, "");
    if (relation === "in_line") {
      if (c === 0) {
        return { verdict: "unconfirmed", ...m, reasons: [reason("zero_comparator", "in line has no band around a zero comparator")] };
      }
      const band = IN_LINE_BAND * Math.abs(c);
      const holds = Math.abs(d) <= band + 1e-9 * Math.abs(c);
      return { verdict: holds ? "matches" : "contradicted", ...m, reasons: [] };
    }
    const holds = relation === "above" ? d > 0 : d < 0;
    return { verdict: holds ? "matches" : "contradicted", ...m, reasons: [] };
  }

  if (relation === "narrowed") {
    const raw = l.width - r.width;
    const d = nearlyZero(raw, l.width, r.width, l.mid, r.mid) ? 0 : raw;
    const m = measure(unit, d, r.width, " in width");
    return { verdict: d < 0 ? "matches" : "contradicted", ...m, reasons: [] };
  }

  const rawMid = l.mid - r.mid;
  const dMid = nearlyZero(rawMid, l.mid, r.mid) ? 0 : rawMid;
  const m = measure(unit, dMid, r.mid, " at midpoint");
  if (relation === "unchanged") {
    const same =
      nearlyZero(l.low - r.low, l.low, r.low) && nearlyZero(l.high - r.high, l.high, r.high);
    return { verdict: same ? "matches" : "contradicted", ...m, reasons: [] };
  }
  const holds = relation === "raised" ? dMid > 0 : dMid < 0;
  return { verdict: holds ? "matches" : "contradicted", ...m, reasons: [] };
}

// ---------------------------------------------------------------------------
// Computed figures (R8)
// ---------------------------------------------------------------------------

/**
 * The arithmetic of a computed figure, inputs in order:
 * difference(a, b) = a − b; sum(a, b, …) needs at least two inputs;
 * ratio(a, b) = a / b × 100 (a percentage); growth(new, old) = new / old − 1
 * (a fraction: 0.2881 for 28.81%). A zero divisor, a non-positive `old`, the
 * wrong number of inputs or a non-finite input → null.
 *
 * Unit, scale and period compatibility (R8) is the caller's job.
 */
export function computeOp(op: ComputeOp, inputs: number[]): number | null {
  if (inputs.some((v) => !Number.isFinite(v))) return null;
  switch (op) {
    case "difference":
      return inputs.length === 2 ? inputs[0] - inputs[1] : null;
    case "sum":
      return inputs.length >= 2 ? inputs.reduce((a, b) => a + b, 0) : null;
    case "ratio":
      if (inputs.length !== 2 || inputs[1] === 0) return null;
      return (inputs[0] / inputs[1]) * 100;
    case "growth":
      if (inputs.length !== 2 || inputs[1] <= 0) return null;
      return inputs[0] / inputs[1] - 1;
  }
}
