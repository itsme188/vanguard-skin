/**
 * Word-level rules of the filing-summary checker: metric identity (R2) and
 * basis evidence (R6). Pure.
 *
 * Metric identity, as a finance reader would apply it:
 * - Qualifiers ("net", "total", "other", "GAAP", "adjusted", "consolidated")
 *   never identify a line item, so they never count as shared words.
 * - The MEASURE (revenue, income, expense, cash, flow, margin, EPS, …) must
 *   agree: "net revenue" is not "Net income", "operating income" is not
 *   "Operating expenses". When only one side names a measure, it cannot be
 *   confirmed.
 * - The DISTINCTIVE words must agree with the label (and with its table
 *   section when the section supplies the measure): "Advertising revenue" is
 *   not "revenue", "Family of Apps revenue" is not total "Revenue",
 *   "Weighted-average shares …: Diluted" is not "diluted EPS".
 * - A basis word in the metric ("non-GAAP", "adjusted", "excluding",
 *   "constant currency") must appear in the source's label or context.
 */
import type { Basis } from "./types";

// Phrases folded to one token before splitting into words.
const PHRASES: Array<[RegExp, string]> = [
  [/\b(?:net\s+)?(?:earnings|income|loss|\(loss\)|income\s*\(loss\))\s+per\s+(?:diluted\s+|basic\s+)?share\b/g, " eps "],
  [/\bcapital\s+expenditures?\b/g, " capex "],
  [/\bcosts?\s+of\s+(?:revenues?|sales|goods\s+sold)\b/g, " cost "],
  [/\bnon[\s-]+gaap\b/g, " nongaap "],
  // A standard GAAP tail names no different line item (fix round 2). The
  // noncontrolling-interest tail is NOT stripped: that row is a different figure.
  [/\battributable\s+to\s+(?:common\s+)?(?:stockholders|shareholders)\b/g, " "],
];

// Words that never identify anything: function words, period words, filler.
const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "per", "its", "our", "into", "over", "under", "than", "are", "was", "were",
  "this", "that", "all", "including", "provided", "used", "attributable", "activities", "activity", "related",
  "quarter", "quarterly", "first", "second", "third", "fourth", "year", "years", "annual", "month", "months",
  "three", "six", "nine", "twelve", "fiscal", "full", "ytd", "period", "ended", "ending",
]);
// Qualifiers: never shared words (a basis word is handled separately).
const QUALIFIERS = new Set(["net", "total", "other", "gaap", "nongaap", "non", "adjusted", "consolidated", "reported"]);
// Measure nouns, each mapped to its class (synonyms share a class).
const MEASURES: Record<string, string> = {
  revenue: "revenue", revenues: "revenue", sales: "revenue", sale: "revenue",
  income: "income", earnings: "income", profit: "income", profits: "income", loss: "income", losses: "income",
  expense: "expense", expenses: "expense", cost: "expense", costs: "expense",
  cash: "cash", flow: "flow", flows: "flow", margin: "margin", margins: "margin", eps: "eps",
  share: "share", shares: "share", asset: "assets", assets: "assets",
  liability: "liabilities", liabilities: "liabilities", debt: "debt", borrowings: "debt", capex: "capex",
};

function stem(w: string): string {
  for (const suf of ["ies", "ing", "ions", "ion", "es", "ed", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length) + (suf === "ies" ? "y" : "");
  }
  return w;
}

interface Words { measures: Set<string>; distinct: Set<string> }

function words(text: string): Words {
  let t = ` ${text.toLowerCase()} `;
  for (const [re, rep] of PHRASES) t = t.replace(re, rep);
  const measures = new Set<string>();
  const distinct = new Set<string>();
  for (const w of t.split(/[^a-z]+/)) {
    if (w.length < 3 || STOP_WORDS.has(w) || QUALIFIERS.has(w)) continue;
    if (MEASURES[w]) measures.add(MEASURES[w]);
    else distinct.add(stem(w));
  }
  return { measures, distinct };
}

/** The measure classes a metric names ("revenue", "income", "eps", …). */
export function measureClasses(text: string): Set<string> {
  return words(text).measures;
}

const BASIS_WORDS = /\bnon[\s-]*gaap\b|\badjusted\b|\bexclud(?:ing|es|ed)\b|\bconstant[\s-]+currency\b/i;

/**
 * Does the metric name the same line item as the source label? `section` is
 * the table section header above the row ("Revenue:" over "Family of Apps"),
 * `context` the column header and caption (where a basis word may sit).
 */
export function metricMatchesLabel(
  metric: string,
  label: string,
  opts: { section?: string | null; context?: string } = {},
): boolean {
  const m = words(metric);
  const own = words(label);
  const sec = words(opts.section ?? "");
  // The metric IS the label, word for word: nothing to confirm beyond a basis word (task 8b; the
  // section header's measure, "Cash flows from financing activities", does not change that).
  const same = (a: Words, b: Words) => a.measures.size === b.measures.size && a.distinct.size === b.distinct.size
    && [...a.measures].every((x) => b.measures.has(x)) && [...a.distinct].every((x) => b.distinct.has(x));
  const identical = same(m, own) && (m.measures.size > 0 || m.distinct.size > 0);
  // Measures: the label's own, else its section's. Both named and agreeing, or neither named.
  const lm = own.measures.size > 0 ? own.measures : sec.measures;
  if (!identical && (m.measures.size > 0 || lm.size > 0)) {
    if (m.measures.size === 0 || lm.size === 0) return false;
    if (![...m.measures].some((x) => lm.has(x))) return false;
  }
  // Distinctive words: the metric names every word of the label, and every
  // word of the section too when the section supplies the measure (a sub-row
  // like "Diluted"): "Weighted-average shares …: Diluted" is not "diluted EPS".
  // The metric may use a section word ("current assets"), never a foreign one.
  const required = new Set([...own.distinct, ...(own.measures.size === 0 && !identical ? sec.distinct : [])]);
  for (const d of required) if (!m.distinct.has(d)) return false;
  for (const d of m.distinct) if (!own.distinct.has(d) && !sec.distinct.has(d)) return false;
  // A basis word in the metric must be backed by the source.
  const basisWord = BASIS_WORDS.exec(metric);
  if (basisWord) {
    const src = `${label} ${opts.section ?? ""} ${opts.context ?? ""}`;
    if (!BASIS_WORDS.test(src)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Basis evidence (R6)
// ---------------------------------------------------------------------------

type EvidenceKind = "reported" | "non_gaap" | "excluding_item" | "constant_currency";

/** The basis the source text supports, read from the most specific level that says one. */
export interface BasisEvidence { decided: Set<EvidenceKind> | null; mixedSeen: boolean }

// "adjusted" as a verb ("we adjusted our outlook", "adjusted downward") names no basis (fix rounds 4-5).
// Only a pronoun subject or a possessive/direction object marks the verb: "that adjusted EPS",
// "management adjusted EPS" and "adjusted the same way" all keep the word as basis evidence.
const ADJUSTED_BASIS = /(?<!\b(?:we|they|it)\s+)\badjusted\b(?!\s+(?:our|its|their|down|downward|up|upward|lower|higher|accordingly)\b)/i;

function kindsIn(text: string): Set<EvidenceKind> {
  const k = new Set<EvidenceKind>();
  if (/\bnon[\s-]*gaap\b/i.test(text) || ADJUSTED_BASIS.test(text)) k.add("non_gaap");
  if (/\bexclud(?:ing|es|ed)\b|\bexclusive\s+of\b/i.test(text)) k.add("excluding_item");
  if (/\bconstant[\s-]+currency\b/i.test(text)) k.add("constant_currency");
  if (/(?<!non[\s-]{0,2})\bgaap\b/i.test(text)) k.add("reported");
  return k;
}

/**
 * Read basis words level by level, most specific first (column header, row
 * label with its section, caption; or the sentence for prose). The first
 * level that names a basis decides. A level naming GAAP AND a non-GAAP basis
 * (a reconciliation caption) is mixed: it decides nothing and it means
 * silence elsewhere can no longer be read as "reported".
 */
export function basisEvidence(levels: string[]): BasisEvidence {
  let mixedSeen = false;
  for (const level of levels) {
    const k = kindsIn(level);
    if (k.size === 0) continue;
    if (k.has("reported") && k.size > 1) {
      mixedSeen = true;
      continue;
    }
    return { decided: k, mixedSeen };
  }
  return { decided: null, mixedSeen };
}

/**
 * Is the figure's typed basis what the source says? non_gaap / excluding_item
 * / constant_currency need their words; reported needs explicit GAAP or no
 * basis words at all. guidance_* names a range end, not an accounting basis,
 * and is not checked here; unknown is never confirmed.
 */
export function basisConfirmed(typed: Basis, ev: BasisEvidence): boolean {
  if (typed.startsWith("guidance_")) return true;
  if (typed === "unknown") return false;
  if (typed === "reported") return ev.decided ? ev.decided.has("reported") && ev.decided.size === 1 : !ev.mixedSeen;
  return ev.decided?.has(typed as EvidenceKind) ?? false;
}

/**
 * The prose rule (fix round 4, asymmetric). `own` is the figure's clause,
 * `attached` the numberless clauses that attach to it, `others` the rest of
 * the sentence's numberless clauses (see `proseBasisClauses`).
 * - non_gaap / excluding_item / constant_currency: the word must be in the
 *   own clause or an attached clause.
 * - reported: explicit GAAP in the own clause confirms it; otherwise the own
 *   clause has no basis word AND no numberless clause anywhere has one.
 *   Basis words inside OTHER numbers' clauses do not count against it.
 * - An own clause that says both GAAP and a non-GAAP basis is mixed and
 *   confirms nothing.
 */
// "on both a reported and constant currency basis": the figure is the same either way, so the
// clause denies "reported" to nothing (task 8b; found on the real Meta revenue line).
const BOTH_BASES =
  /\b(?:reported|gaap)\s+(?:and|or)\s+(?:a\s+|an\s+)?(?:constant[\s-]+currency|non[\s-]*gaap|adjusted)\b|\b(?:constant[\s-]+currency|non[\s-]*gaap|adjusted)\s+(?:and|or)\s+(?:a\s+)?(?:reported|gaap)\b/i;

export function saysBothBases(text: string): boolean {
  return BOTH_BASES.test(text);
}

export function proseBasisConfirmed(typed: Basis, c: { own: string; attached: string[]; others: string[] }): boolean {
  if (typed.startsWith("guidance_")) return true;
  if (typed === "unknown") return false;
  const own = kindsIn(c.own);
  if (own.has("reported") && own.size > 1) return false;
  const nonReported = (k: Set<EvidenceKind>) => [...k].some((x) => x !== "reported");
  if (typed === "reported") {
    if (own.has("reported")) return true;
    if (own.size > 0) return false;
    return ![...c.attached, ...c.others].some((t) => nonReported(kindsIn(t)) && !saysBothBases(t));
  }
  const want = typed as EvidenceKind;
  return own.has(want) || c.attached.some((t) => kindsIn(t).has(want));
}

// ---------------------------------------------------------------------------
// Prose labels
// ---------------------------------------------------------------------------

// Words that end a noun phrase going left: function words, pronouns and reporting verbs.
const LEFT_STOP = new Set([
  "the", "a", "an", "our", "its", "their", "and", "or", "of", "in", "for", "to", "was", "were", "is", "be", "been",
  "with", "by", "on", "at", "as", "that", "which", "we", "they", "it", "us", "company",
  "had", "has", "have", "expect", "expects", "expected", "anticipate", "anticipates", "anticipated", "see", "sees",
  "guide", "guides", "guided", "forecast", "forecasts", "project", "projects", "projected", "reported", "reports",
  "generated", "delivered", "posted", "grew", "rose", "fell", "increased", "decreased", "declined", "least", "most",
  "about", "approximately",
]);

/**
 * The noun phrase a label sits in: up to three words directly before it,
 * stopping at punctuation, a number, or a function word. "Operating income"
 * is what a sentence says even when the label quoted is only "income".
 */
export function extendLabelLeft(before: string): string {
  const parts = before.split(/\s+/).filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && out.length < 3; i--) {
    const w = parts[i];
    if (/[.,;:!?)]$/.test(w) || /[\d$%]/.test(w)) break;
    if (LEFT_STOP.has(w.toLowerCase())) break;
    out.unshift(w);
  }
  return out.join(" ");
}
