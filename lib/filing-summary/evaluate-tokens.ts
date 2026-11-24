/**
 * Number tokens of free text (valueText, prose sentences) for the
 * filing-summary checker, and the small shared types that figure binding
 * (`evaluate-figures.ts`, `evaluate-prose.ts`) builds on. Pure.
 */
import { matchesWithRounding, parseNumberToken, toUnits } from "./figures";
import type { CheckReason, FigureScale, ModelFigure } from "./types";
import type { SourcePeriod, TableContext } from "./evaluate-periods";

export const reason = (code: string, figureId: string | null, detail: string): CheckReason => ({ code, figureId, detail });

/** What binding a figure to one source yields; `units` is the SOURCE value in plain units, `half` its rounding half-unit. */
export interface Binding {
  established: boolean; units: number | null; half: number; period: SourcePeriod | null;
  table: TableContext | null; basisConfirmed: boolean; reasons: CheckReason[];
}
export const failed = (reasons: CheckReason[]): Binding => ({
  established: false, units: null, half: 0, period: null, table: null, basisConfirmed: false, reasons,
});

const WORD_SCALE: Record<string, FigureScale> = {
  billion: "billions", billions: "billions", bn: "billions", b: "billions",
  million: "millions", millions: "millions", mn: "millions", mm: "millions", m: "millions",
  thousand: "thousands", thousands: "thousands", k: "thousands",
};
export const SCALE_FACTOR: Record<FigureScale, number> = { units: 1, thousands: 1e3, millions: 1e6, billions: 1e9 };

// Optional sign, optional "$", optional sign after it ("$-1.5B"), optional "(", the number, optional ")", then an
// optional percent and an optional scale word. The look-behind keeps a token
// from starting inside a word or an identifier ("Q3", "EX-99.1", "$64"). A minus is a sign only when it touches
// the number: "$64.5 billion - $64.7 billion" is a range, not a negative (fix round 5).
const TOKEN_RE =
  /(?<![\w.$\-−–])((?:[-−–](?=[$\d(]))?\$?\s?(?:[-−–](?=[\d(]))?\(?\s?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s?\)?)(\s?%|\s+percent\b)?(?:\s?(billions?|millions?|thousands?|bn|mn|mm|[bmk])(?![a-z]))?/gi;

// A dash that joins the two ends of a compact range is not a sign (task 8b, ruling 5):
// "$64.5 billion–$64.7 billion" (a scale word or "%" before the dash) and "$73-76 billion",
// "15-17%", "$1.50-$1.60" (a digit before it, a unit or "$" on the right-hand end).
const SCALE_DASH = /(billions?|millions?|thousands?|bn|mn|mm|[bmk]|%)([-−–])(?=\s?\$?\d)/gi;
const DIGIT_DASH =
  /(\d)([-−–])(?=\$?\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|billions?\b|millions?\b|thousands?\b|bn\b|mn\b|mm\b|[bmk]\b)|\$\d)/g;

// "negative $2.12 billion", "minus 3%", "a net loss of $1.2 billion": the words give the sign (task 8b, ruling 6).
const NEGATIVE_WORDS = /\b(negative|minus|(?:net\s+)?loss(?:es)?\s+of)\s*$/i;

export interface NumberToken {
  value: number;
  decimals: number;
  /** The scale the text's own word gives, or null when there is none. */
  wordScale: FigureScale | null;
  isPercent: boolean;
  /** Character offsets of the token in the scanned text. */
  start: number;
  end: number;
  /** The word that made the number negative, when one did: "negative" / "minus", or "loss of". */
  signWord?: "negative" | "loss";
}

/**
 * Every number in a piece of text, skipping bare years and form-name digits
 * ("10-Q"). The two ends of a compact range are two tokens, and an end with no
 * unit of its own takes the unit the range states once ("$73-76 billion" is
 * 73 billion and 76 billion; "15-17%" is 15% and 17%).
 */
export function scanNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  // Same length as `text`, so every offset still points into the original.
  const masked = text.replace(SCALE_DASH, "$1 ").replace(DIGIT_DASH, "$1 ");
  for (const m of masked.matchAll(TOKEN_RE)) {
    const end = (m.index ?? 0) + m[0].replace(/\s+$/, "").length;
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
    const value = parsed.value;
    const sw = NEGATIVE_WORDS.exec(text.slice(0, m.index ?? 0));
    const tok: NumberToken = { value, decimals: parsed.decimals, wordScale: word ? WORD_SCALE[word] : null, isPercent, start: m.index ?? 0, end };
    if (value > 0 && sw) {
      tok.value = -value;
      tok.signWord = /^loss|^net/i.test(sw[1]) ? "loss" : "negative";
    }
    out.push(tok);
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i];
    const b = out[i + 1];
    // "$2.415 to $2.48 billion" (QA 2026-11-21): the scale word written once, after the second number,
    // is the first number's too, when nothing but "to" sits between them, the first has no unit of its
    // own, neither is a percent, and both are dollar amounts or neither is.
    if (/^\s+to\s+$/.test(text.slice(a.end, b.start)) && !a.wordScale && b.wordScale && !a.isPercent && !b.isPercent
      && text.slice(a.start, a.end).includes("$") === text.slice(b.start, b.end).includes("$")) {
      a.wordScale = b.wordScale;
      continue;
    }
    if (!/^\s?[-−–]\s?$/.test(text.slice(a.end, b.start))) continue;
    // A compact range: an end with no unit takes the range's unit; a sign given by a word before the
    // first end ("losses of $18-19 billion") carries to the second (review round 1, item 6).
    if (!a.isPercent && !a.wordScale && (b.isPercent || b.wordScale)) {
      a.isPercent = b.isPercent;
      a.wordScale = b.wordScale;
    }
    if (a.signWord && a.value < 0 && b.value > 0) {
      b.value = -b.value;
      b.signWord = a.signWord;
    }
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

/**
 * Display rounding only (QA 2026-11-21): the typed value, rounded to exactly the
 * decimals the text shows at the text's unit, is the written number. Half a unit
 * of the last shown digit either way, inclusive (the R4 rule `matchesWithRounding`
 * applies to a source); one unit off in that digit is a mismatch. Never a
 * percentage tolerance.
 */
function roundsTo(written: number, decimals: number, scale: FigureScale, typedUnits: number): boolean {
  return matchesWithRounding({ value: written, decimals, scale }, typedUnits);
}

/** The whole shown text is one bracketed number: "($41.3 million)", "(0.3%)", an accounting negative. */
const BRACKETED = /^\(\s*[^()]*\)$/;

/** The words just before a placeholder sign it: "a loss of {f1}", "negative {f1}" (the rule `scanNumbers` applies in text). */
export function signedByWordBefore(textBefore: string): boolean {
  return NEGATIVE_WORDS.test(textBefore);
}

/**
 * Read the figure's `valueText` (what the owner sees) and require it to say the
 * same number as `value`/`scale` (what the app checks). The text's digit count
 * sets the rounding precision (R4), and the typed value may carry more digits
 * than are shown (display rounding, `roundsTo`). Null when the text holds no
 * single number, when its sign or size disagrees with `value`, or when a percent
 * figure is not written as a percent.
 *
 * Sign: a text wrapped in brackets is negative. `signedByWord` (the claim's words
 * before the placeholder are a loss or negative word) makes an unsigned text
 * negative, and only for a negative typed value. Scale: a scale word in the text
 * is its scale; with none the text is read at the typed scale, else as plain
 * units ("$64,000" for 64 thousands).
 */
export function statedNumber(fig: ModelFigure, opts: { signedByWord?: boolean } = {}): StatedNumber | null {
  const tokens = scanNumbers(fig.valueText);
  if (tokens.length !== 1) return null;
  const t = tokens[0];
  if ((fig.unit === "percent") !== t.isPercent) return null;
  let written = t.value;
  if (written > 0 && BRACKETED.test(fig.valueText.trim())) written = -written;
  else if (written > 0 && fig.value < 0 && opts.signedByWord) written = -written;
  const typedUnits = fig.unit === "percent" ? fig.value : toUnits(fig.value, fig.scale);
  if (t.wordScale) {
    if (!roundsTo(written, t.decimals, t.wordScale, typedUnits)) return null;
    return { value: written, decimals: t.decimals, scale: t.wordScale };
  }
  const scale: FigureScale = fig.unit === "percent" ? "units" : fig.scale;
  if (roundsTo(written, t.decimals, scale, typedUnits)) return { value: written, decimals: t.decimals, scale };
  if (fig.unit !== "percent" && scale !== "units" && roundsTo(written, t.decimals, "units", typedUnits)) {
    return { value: written, decimals: t.decimals, scale: "units" };
  }
  return null;
}

/** Half a unit of a printed number's last digit, in plain units. */
export function halfUnit(decimals: number, scale: FigureScale): number {
  return 0.5 * 10 ** -decimals * SCALE_FACTOR[scale];
}
