// Snippet-names-the-metric gate (QA finding `dashboard-today-earnings-hub-…-
// sheet-accepts-company-revenue-g`, owner ruling 2026-11-01). PURE, no I/O,
// never throws.
//
// Two readers can agree on a number lifted from a sentence about a DIFFERENT
// measure: a segment growth line read off the company-wide revenue sentence.
// Agreement on the figure is not agreement on the line. So a line's figure
// counts as agreed only when the cited snippet names the metric:
//   - the label's DISTINGUISHING words (the label minus generic measure words
//     such as revenue / growth / margin / EPS / total / adjusted / guidance)
//     must ALL appear in the snippet, after lower-casing, dropping
//     punctuation and a trailing plural "s";
//   - or, failing that, every distinguishing word of the stored segment name;
//   - or every proper-noun word (capitalised inside the text, never the first
//     word) of the line's definition.
// A label made only of generic words ("Revenue", "EPS (Adj.)") has nothing to
// require and passes. A null or empty snippet passes too: the gate only ever
// takes agreement AWAY, it never lets a line through that today's rules stop.
//
// KNOWN LIMIT: the gate does not judge basis. A generic "Revenue" line whose
// snippet names the GAAP total while the bogey is an adjusted figure still
// passes; telling those apart needs basis evidence this lexical check does not
// have, and a wrong guess would block correct base lines.
import type { LineContract } from "./types";

export const SNIPPET_NAMES_ANOTHER_MEASURE = "snippet names another measure";

const GENERIC = new Set([
  // measure words every line shares
  "revenue", "sale", "net", "total", "growth", "grew", "grow", "rate", "margin",
  "ep", "eps", "earning", "per", "share", "diluted", "basic", "income", "profit",
  "gaap", "non", "adj", "adjusted", "reported", "guidance", "guide", "outlook",
  // period and unit words
  "next", "q", "quarter", "quarterly", "year", "yoy", "fy", "full", "prior",
  "period", "month", "change", "increase", "decrease", "percent", "pct", "usd",
  "dollar", "basis", "point", "bp", "bps", "over", "ago",
  // function words
  "the", "of", "and", "in", "for", "on", "vs", "versus", "to", "a", "an", "from",
  "at", "by", "with", "as", "or", "its", "it", "y",
]);

function stem(word: string): string {
  let w = word;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length > 0)
    .map(stem);
}

/** Words that tell this measure apart from its siblings: not generic, not a
 *  bare number or period code (anything carrying a digit). */
function distinguishing(text: string): string[] {
  return [...new Set(tokens(text).filter((t) => !GENERIC.has(t) && !/\d/.test(t)))];
}

/** Capitalised words inside the definition (never its first word): names
 *  such as a product or segment the desk wrote into the definition. */
function definitionProperNouns(definition: string): string[] {
  const raw = definition.split(/[^A-Za-z0-9']+/).filter((w) => w.length > 0);
  const picked = raw.slice(1).filter((w) => /[A-Z]/.test(w));
  return distinguishing(picked.join(" "));
}

function allPresent(required: string[], snippetTokens: Set<string>, squashed: string): boolean {
  return required.every((t) => snippetTokens.has(t) || (t.length >= 4 && squashed.includes(t)));
}

/**
 * Returns `SNIPPET_NAMES_ANOTHER_MEASURE` when the snippet does not name the
 * line's metric, else null. Null on any missing or odd input.
 */
export function snippetMeasureMismatch(contract: LineContract | null | undefined, snippet: string | null | undefined): string | null {
  try {
    if (!contract || typeof snippet !== "string" || snippet.trim() === "") return null;
    const label = typeof contract.label === "string" ? contract.label : "";
    const required = distinguishing(label);
    if (required.length === 0) return null;

    const snippetTokens = new Set(tokens(snippet));
    const squashed = snippet.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (allPresent(required, snippetTokens, squashed)) return null;

    if (typeof contract.segment === "string") {
      const seg = distinguishing(contract.segment);
      if (seg.length > 0 && allPresent(seg, snippetTokens, squashed)) return null;
    }
    if (typeof contract.definition === "string") {
      const nouns = definitionProperNouns(contract.definition);
      if (nouns.length > 0 && allPresent(nouns, snippetTokens, squashed)) return null;
    }
    return SNIPPET_NAMES_ANOTHER_MEASURE;
  } catch {
    return null;
  }
}
