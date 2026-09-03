// Callout verification (spec §4.4 "Callouts, verified"; §9 ruling 3; Codex
// round 1 amendments; controller rulings R-D1/R-D6/R-D7/R-D8). A callout is a
// MODEL-PROPOSED figure. Nothing the model says is trusted: the guidance must
// name the metric, the sheet must not already have a line for it, the
// snippet must occur verbatim in the document's normalised text, the number
// must parse from inside that snippet in the same unit, and the label must
// be anchored either to the text around the snippet OR to the guidance that
// named it. Everything stored about a callout except its label is computed
// here, in code.
import fs from "node:fs/promises";
import { textPathFor } from "./pdf";
import { sha256Hex } from "./delivery";
import { decodeEntities } from "./representations";
import { deltaPctNumber } from "./read-facts";
import type { DocumentRow, LineContract } from "./types";
import { INLINE_BAND_PCT } from "./first-pass-types";
import type { CalloutProposal, CalloutUnit } from "./first-pass-types";

export const VERIFIER_VERSION = 1;
export const LABEL_WINDOW_CHARS = 240;
// R-D7: the desk's guidance notes use "Watch" as an imperative ("Watch ARR
// growth (guide ~24%)") — it carries no metric identity and must not survive
// into a label/guidance key.
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "per", "vs", "versus", "total", "net", "non", "gaap", "year", "quarter", "fiscal",
  "of", "to", "in", "on", "a", "an", "q1", "q2", "q3", "q4", "fy", "yoy", "y/y", "basis", "watch",
]);

export function stripHtmlToText(html: string): string {
  const noScripts = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const noTags = noScripts.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(noTags);
  return decoded.replace(/\s+/g, " ").trim();
}

export async function documentText(doc: Pick<DocumentRow, "bytes_path">): Promise<string> {
  if (doc.bytes_path.endsWith(".pdf")) return fs.readFile(textPathFor(doc.bytes_path), "utf8");
  const raw = await fs.readFile(doc.bytes_path, "utf8");
  return doc.bytes_path.endsWith(".html") ? stripHtmlToText(raw) : raw;
}

export function evidenceSha256(text: string): string {
  return sha256Hex(text);
}

export interface ParsedValue {
  value: number;
  value_high: number | null;
  unit: CalloutUnit;
}

// R-D17: ONE spelling of the scale-word alternation, reused by every regex
// below (MONEY_RE, COUNT_RE, POINT_TOKEN, RANGE_TOKEN) and by the R-D6
// inheritance suffix. Order matters — "million"/"billion" must be tried
// before their single-letter abbreviations "m"/"b" or the longer word is
// only ever partially consumed (the bug the old "illion" hack papered over
// and, for a fully spelled-out range like "$875 million to $878 million",
// never actually matched).
const SCALE_WORDS = "billion|million|thousand|bn|mm|m|b|k";
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const NUM = "(-?\\d[\\d,]*(?:\\.\\d+)?)";
const MONEY_RE = new RegExp("\\$\\s?" + NUM + "\\s*(" + SCALE_WORDS + ")?\\b", "gi");
const PCT_RE = new RegExp(NUM + "\\s?%", "g");
const COUNT_RE = new RegExp("(?<![\\$\\d.,])" + NUM + "(?![\\d,.]*\\s?(%|" + SCALE_WORDS + ")\\b)", "gi");
const PER_SHARE_WORDS = /per (diluted )?share/i;

// A four-digit 19xx/20xx token right after "fiscal"/"FY"/"calendar"/"year"/
// "into"/"through"/"in"/"for" is a YEAR, not a count ("backlog visibility
// into fiscal 2026" must never read as a count of 2026). Checked on the
// matched value itself (shape) plus the one word immediately before the
// match (numbersIn's "count" branch only — the shape check means a real
// 3-digit count like "712 customers" is never touched by this).
const YEAR_LEAD_WORDS = new Set(["fiscal", "fy", "calendar", "year", "into", "through", "in", "for"]);
const YEAR_SHAPE_RE = /^(?:19|20)\d{2}$/;

function isYearToken(raw: string, text: string, matchIndex: number): boolean {
  if (!YEAR_SHAPE_RE.test(raw)) return false;
  const before = text.slice(0, matchIndex).match(/([a-z]+)\s*$/i);
  return !!before && YEAR_LEAD_WORDS.has(before[1].toLowerCase());
}

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

/** Every number of one unit inside a snippet, scaled the same way parseValueText scales. */
export function numbersIn(text: string, unit: CalloutUnit): number[] {
  const out: number[] = [];
  if (unit === "usd" || unit === "per_share") {
    for (const m of text.matchAll(MONEY_RE)) {
      const n = toNumber(m[1]);
      const scale = m[2] ? SCALE[m[2].toLowerCase()] : null;
      const isPerShare = !scale && (/\.\d{2}$/.test(m[1]) || PER_SHARE_WORDS.test(text.slice(m.index ?? 0, (m.index ?? 0) + 40)));
      if (unit === "per_share" && isPerShare) out.push(n);
      if (unit === "usd" && !isPerShare) out.push(scale ? n * scale : n);
    }
  } else if (unit === "percent") {
    for (const m of text.matchAll(PCT_RE)) out.push(toNumber(m[1]));
  } else {
    for (const m of text.matchAll(COUNT_RE)) {
      if (isYearToken(m[1], text, m.index ?? 0)) continue;
      out.push(toNumber(m[1]));
    }
  }
  return out;
}

const RANGE_SPLIT = /\s*(?:–|—|-|\bto\b|\band\b)\s*/i;

export function parseValueText(text: string): ParsedValue | null {
  const t = text.trim().replace(/^between\s+/i, "");
  const parts = t.split(RANGE_SPLIT).filter(Boolean);
  const parseOne = (s: string): { value: number; unit: CalloutUnit } | null => {
    for (const unit of ["percent", "per_share", "usd", "count"] as CalloutUnit[]) {
      const ns = numbersIn(s, unit);
      if (ns.length === 1) return { value: ns[0], unit };
    }
    return null;
  };
  if (parts.length === 2) {
    const b = parseOne(parts[1]);
    let a = parseOne(parts[0]);
    // R-D6: a bare-left range ("16-17%") carries its unit only on the right
    // side. When the left side parses only as a bare count, re-parse it with
    // the right side's unit suffix inherited (percent: append "%"; dollar
    // units: prefix "$" and carry the right side's scale word, if any).
    if (a && a.unit === "count" && b && b.unit !== "count") {
      if (b.unit === "percent") {
        a = parseOne(parts[0] + "%");
      } else if (b.unit === "usd" || b.unit === "per_share") {
        const scaleWord = parts[1].match(new RegExp("(" + SCALE_WORDS + ")\\b", "i"))?.[0] ?? "";
        a = parseOne(`$${parts[0]}${scaleWord ? " " + scaleWord : ""}`);
      }
    }
    if (a && b && a.unit === b.unit) return { value: a.value, value_high: b.value, unit: a.unit };
    return null;
  }
  const one = parseOne(t);
  return one ? { value: one.value, value_high: null, unit: one.unit } : null;
}

// A fiscal-period token WITH its digits attached ("fy26", "q427") tokenizes
// as one alphanumeric run (no non-alnum separator between the letters and
// the digits) and so never matches the bare STOPWORDS entries ("fy",
// "q1".."q4") by string equality — a label that is nothing but period
// scaffolding ("Q4 FY26") must still reduce to no content words. But a
// period token disambiguates real content ("FY27 framework" is a distinct
// metric from "FY28 framework"), so it is dropped ONLY when no other
// (non-period) word survives alongside it — never when it sits next to real
// content.
const FISCAL_PERIOD_RE = /^(?:fy|q[1-4]|h[12])\d*$/;

export function contentWords(label: string): string[] {
  const tokens = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const hasOther = tokens.some((w) => !FISCAL_PERIOD_RE.test(w));
  return hasOther ? tokens : [];
}

export function labelNorm(label: string): string {
  return contentWords(label).join(" ");
}

export interface GuidanceMetric {
  key: string;
  unit: CalloutUnit | null;
  value: number | null;
  value_high: number | null;
  source_index: number;
}

// R-D17: a period only splits when it is NOT a decimal point (a digit on
// neither side); "and" only splits when it is NOT a range connector — i.e.
// NOT immediately followed by the start of another figure ($/~/digit). The
// old unconditional split broke "$206.5M" into two clauses at the decimal
// and "$206M and $208M" into two clauses at the range's own "and".
const CLAUSE_SPLIT = /[;\n]|(?<!\d)\.(?!\d)|\band\b(?!\s*(?:\$|~|\d))/i;
const FIGURE_LEAD = /\s*(?:\(|of|at|to|~|about|around|guide[sd]?|consensus|of about)\s*$/i;
const RANGE_NUM = "\\$?-?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:%|" + SCALE_WORDS + ")?";
const RANGE_TOKEN = new RegExp("(?:between\\s+)?" + RANGE_NUM + "\\s*(?:–|—|-|to|and)\\s*" + RANGE_NUM + "(?:\\s*per (?:diluted )?share)?", "i");
const POINT_TOKEN = new RegExp("~?\\$?-?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:%|" + SCALE_WORDS + ")?(?:\\s*per (?:diluted )?share)?", "i");

/** One typed metric per guidance clause: the words BEFORE the first figure
 *  are the key; a clause with no figure still names a metric (unit null). */
export function extractGuidanceMetrics(guidanceTexts: string[]): GuidanceMetric[] {
  const out: GuidanceMetric[] = [];
  guidanceTexts.forEach((text, source_index) => {
    for (const rawClause of text.split(CLAUSE_SPLIT)) {
      const clause = rawClause.replace(/\(|\)/g, " ").trim();
      if (!clause) continue;
      const range = clause.match(RANGE_TOKEN);
      const point = range ? null : clause.match(POINT_TOKEN);
      const m = range ?? point;
      if (!m || m.index === undefined) {
        const key = labelNorm(clause);
        if (key) out.push({ key, unit: null, value: null, value_high: null, source_index });
        continue;
      }
      const key = labelNorm(clause.slice(0, m.index).replace(FIGURE_LEAD, ""));
      if (!key) continue;
      const parsed = parseValueText(m[0].replace(/^~/, ""));
      out.push(
        parsed
          ? { key, unit: parsed.unit, value: parsed.value, value_high: parsed.value_high, source_index }
          : { key, unit: null, value: null, value_high: null, source_index },
      );
    }
  });
  return out;
}

export function sheetLineKeys(contracts: LineContract[]): string[] {
  const keys = new Set<string>();
  for (const c of contracts) {
    const k = labelNorm(c.label);
    if (k) keys.add(k);
    if (c.segment) {
      const s = labelNorm(c.segment);
      if (s) keys.add(s);
    }
  }
  return [...keys];
}

export interface VerifyInput {
  proposal: CalloutProposal;
  text: string;
  guidanceMetrics: GuidanceMetric[];
  sheetLineKeys: string[];
}
export type VerifyResult = { ok: true; parsed: ParsedValue; snippetIndex: number; labelNorm: string } | { ok: false; reason: string };

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
}

/** R-D8: word-SUBSET match — every content word of `words` appears among the
 *  words of some guidance metric's key. Used for the eligibility gate and
 *  for the guidance branch of anchoring (both differ from `vsBogeyText`'s
 *  strict key equality — that function's association is typed, this one's
 *  is topical). */
function namedByGuidance(words: string[], guidanceMetrics: GuidanceMetric[]): boolean {
  return guidanceMetrics.some((m) => {
    const metricWords = m.key.split(" ");
    return words.every((w) => metricWords.includes(w));
  });
}

/**
 * Order of checks (R-D1): content words -> guidance names it -> sheet lacks
 * it -> snippet length -> verbatim -> value_text parses -> value in snippet
 * in that unit -> anchoring.
 *
 * Anchoring (R-D1) is an OR, matching spec §4.4: the label's content words
 * either all sit within LABEL_WINDOW_CHARS of the snippet, OR all match
 * words of SOME guidance metric key (not necessarily the same one that
 * satisfied the eligibility gate below — any guidance mention counts). Both
 * eligibility gates below (guidance names it, sheet lacks it) stay required
 * regardless of which anchoring branch fires.
 */
export function verifyCallout({ proposal, text, guidanceMetrics, sheetLineKeys: lineKeys }: VerifyInput): VerifyResult {
  const key = labelNorm(proposal.label);
  const words = contentWords(proposal.label);
  if (!key || words.length === 0) return { ok: false, reason: "label has no content words" };
  const namedInGuidance = namedByGuidance(words, guidanceMetrics);
  if (!namedInGuidance) return { ok: false, reason: "guidance does not name this metric" };
  if (lineKeys.includes(key)) return { ok: false, reason: "the sheet already has a line for this metric" };
  const snippet = proposal.snippet.trim();
  if (snippet.length < 8) return { ok: false, reason: "snippet too short" };
  const idx = text.indexOf(snippet);
  if (idx === -1) return { ok: false, reason: "snippet is not verbatim in the document text" };
  const parsed = parseValueText(proposal.value_text);
  if (!parsed) return { ok: false, reason: "value_text does not parse" };
  const inSnippet = numbersIn(snippet, parsed.unit);
  const hasLow = inSnippet.some((n) => nearly(n, parsed.value));
  const hasHigh = parsed.value_high === null || inSnippet.some((n) => nearly(n, parsed.value_high!));
  if (!hasLow || !hasHigh) return { ok: false, reason: "value is not in the snippet in that unit" };
  const lo = Math.max(0, idx - LABEL_WINDOW_CHARS);
  const hi = Math.min(text.length, idx + snippet.length + LABEL_WINDOW_CHARS);
  const window = text.slice(lo, hi).toLowerCase();
  const nearSnippet = words.every((w) => window.includes(w));
  // Because the eligibility gate above already requires the guidance to name
  // this exact metric key, `namedInGuidance` is by construction true here —
  // so this OR's guidance branch is unreachable as a false-tipping factor in
  // practice once the gate has passed (reusing the same boolean rather than
  // recomputing it). Kept anyway: it is the spec's OR (R-D1, session
  // controller ruling — do not change), and a future relaxation of the
  // eligibility gate must not silently lose this alternative.
  if (!nearSnippet && !namedInGuidance) return { ok: false, reason: "label words are not anchored to the snippet or the guidance" };
  return { ok: true, parsed, snippetIndex: idx, labelNorm: key };
}

export function formatValue(value: number, unit: CalloutUnit): string {
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "per_share") return `$${value.toFixed(2)}`;
  if (unit === "count") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function deltaLabel(expected: number, actual: number): string {
  const d = deltaPctNumber(expected, actual);
  if (d === null) return "n/a";
  if (Math.abs(d) <= INLINE_BAND_PCT) return "in-line";
  return `${d > 0 ? "+" : ""}${d.toFixed(1)}%`;
}

/** Review #6 (R-D8): ONE explicitly associated, typed bogey — STRICT key
 *  equality against `labelNormKey` (typed association only, never a
 *  word-subset match) AND matching unit — or "no bogey on file". Ambiguity
 *  (more than one guidance metric under the same key with a value) also
 *  refuses rather than guessing. */
export function vsBogeyText(labelNormKey: string, parsed: ParsedValue, guidanceMetrics: GuidanceMetric[]): string {
  const matches = guidanceMetrics.filter((m) => m.key === labelNormKey && m.value !== null);
  if (matches.length !== 1) return "no bogey on file";
  const b = matches[0];
  if (b.unit !== parsed.unit) return "no bogey on file";
  const fmt = (v: number) => formatValue(v, parsed.unit);
  if (b.value_high !== null) {
    const shown = `${fmt(b.value!)}–${fmt(b.value_high)}`;
    if (parsed.value_high !== null) return `vs guide ${shown} (range ${fmt(parsed.value)}–${fmt(parsed.value_high)})`;
    const where = parsed.value < b.value! ? "below range" : parsed.value > b.value_high ? "above range" : "within range";
    return `vs guide ${shown} (${where})`;
  }
  if (parsed.value_high !== null) return `vs guide ${fmt(b.value!)} (range ${fmt(parsed.value)}–${fmt(parsed.value_high)})`;
  return `vs guide ${fmt(b.value!)} (${deltaLabel(b.value!, parsed.value)})`;
}
