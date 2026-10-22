/**
 * Binding one typed figure to a PROSE sentence (spec §Figure checking R2, R5,
 * R6; fix rounds 2–5; task 8b). `evaluate-figures.ts` owns table rows and the
 * quote/bogey entry points; this file owns everything a sentence needs:
 * clauses for basis words, ranges, change sentences, spelled-out numbers,
 * the label pairing and the period a heading supplies. Pure.
 *
 * As a finance reader would check a note against the release:
 * - "rose from $X to $Y", "increased $X, or N%, to $Y": the figure is Y; X is
 *   the earlier value or the change, N% is the change (task 8b ruling 4).
 * - "between $X and $Y", "$X–$Y", "$73-76 billion", "in a range from $X to
 *   $Y": X is the LOW end and Y the HIGH end; guidance_low binds only X and
 *   guidance_high only Y; neither is a reported figure (rulings 2 and 5).
 * - ", or $X on a non-GAAP basis" restates the number before it on another
 *   basis only when both are the same kind of number, the basis words follow
 *   at once (no comma) and no "each" / "both" / "respectively" is in the
 *   sentence (ruling 1).
 * - A period stated by the nearest heading above the sentence on the same
 *   page counts when the sentence and its paragraph name none (ruling 6).
 */
import { normalizeForMatch, type LocatedQuote } from "./locate";
import { matchesWithRounding, parsePeriodPhrase, toUnits, type PeriodCore } from "./figures";
import { extendLabelLeft, isDefinitionalNonGaap, isLossMetric, kindsIn, measureClasses, metricMatchesLabel, proseBasisConfirmed } from "./evaluate-words";
import { periodsMatch } from "./evaluate-periods";
import { failed, halfUnit, reason, scanNumbers, type Binding, type NumberToken, type StatedNumber } from "./evaluate-tokens";
import type { CheckReason, DocText, FigureUnit, ModelFigure, TextBlock } from "./types";

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

// ---------------------------------------------------------------------------
// Clauses and basis words
// ---------------------------------------------------------------------------

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

/** The kind of number a token is, for ", or X" restatements: percent, per-share, a scaled amount or a plain one. */
function tokenKind(text: string, t: NumberToken): string {
  if (t.isPercent) return "percent";
  if (/^\s*per\s+(?:\w+\s+)?share\b/i.test(text.slice(t.end))) return "per-share";
  return t.wordScale ? `scaled:${t.wordScale}` : "plain";
}

/**
 * Is the sentence's last quantity a ", or X on a … basis" restatement of the
 * number before it (task 8b, ruling 1)? Only when X is the same kind of number
 * as that one, the basis words follow X directly with no comma between, and
 * the sentence has no "each", "both" or "respectively".
 */
export function isOrRestatement(text: string, tokens: NumberToken[], lastIndex: number): boolean {
  const last = tokens[lastIndex];
  const prev = tokens[lastIndex - 1];
  if (!last || !prev) return false;
  if (!/(?:^|[,;]\s*|\s)or\s+$/.test(text.slice(prev.end, last.start))) return false;
  if (tokenKind(text, prev) !== tokenKind(text, last)) return false;
  if (/\b(?:each|both|respectively)\b/.test(text)) return false;
  const tail = text.slice(last.end);
  const basisAt = tail.search(/\bnon[\s-]*gaap\b|\badjusted\b|\bexclud(?:ing|es|ed)\b|\bconstant[\s-]+currency\b|\bgaap\b/);
  if (basisAt < 0) return false;
  return !/[,;]/.test(tail.slice(0, basisAt));
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
  // Fix round 5: the text after the sentence's LAST quantity is a trailing
  // clause for every figure, comma or not ("…$9.0 billion and EPS of $2.10,
  // on a non-GAAP basis"; "…, each excluding the tax benefit"). It can deny
  // "reported", never confirm. The one exception (narrowed in task 8b) is a
  // ", or X on a … basis" restatement: there the words belong to X alone.
  const qs = quantityTokens(text);
  const lastQ = qs[qs.length - 1];
  if (lastQ) {
    const tail = text.slice(lastQ.end);
    if (!isOrRestatement(text, qs, qs.length - 1) && /[a-z]/.test(tail) && !others.includes(tail)) others.push(tail);
  }
  return { own: clauses[ownIndex].text, attached, others };
}

// ---------------------------------------------------------------------------
// Ranges and change sentences
// ---------------------------------------------------------------------------

/** What a number is in a change sentence: the earlier value, the change itself, or the figure reached. */
export interface ChangeRole {
  role: "prior" | "change" | "current";
  current: NumberToken | null;
  /** "would have increased … to $Y": Y is a restated, not a reported, figure. */
  hypothetical: boolean;
}

const CHANGE_VERB = /\b(?:increased|decreased|rose|risen|grew|grown|fell|fallen|declined|dropped|climbed|jumped|improved|expanded|contracted|up|down)\s+(?:by\s+)?$/;
const CHANGE_FROM = /\b(?:increased|decreased|rose|risen|grew|grown|fell|fallen|declined|dropped|climbed|jumped|improved|expanded|contracted|up|down|went|moved|changed|narrowed|widened|raised|lowered)\s+from\s+$|(?<!\brang(?:e|es|ing)\s+(?:of\s+)?)(?<!\bin\s+a\s+range\s+)\bfrom\s+$/;
const RANGE_FROM = /\brang(?:e|es|ing)\s+(?:of\s+)?from\s*$|\bin\s+a\s+range\s+from\s*$/;

/**
 * The numbers of a change sentence (task 8b, ruling 4): "rose from $X to $Y",
 * "increased $X to $Y", "increased $X, or N%, to $Y", "up from $X". X after
 * "from" is the earlier value; X after a change verb, and the N%, are the
 * change; Y after "to" is the current figure. "In a range from $X to $Y" is
 * a range, not a change.
 */
export function changeRoles(ns: string, all: NumberToken[]): Map<number, ChangeRole> {
  const out = new Map<number, ChangeRole>();
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const before = ns.slice(0, a.start);
    if (RANGE_FROM.test(before)) continue;
    const prior = CHANGE_FROM.test(before);
    const change = !prior && CHANGE_VERB.test(before);
    if (!prior && !change) continue;
    // Walk the change rates between X and "to": ", or 17%," / "(17%)".
    const changes: NumberToken[] = [];
    let j = i + 1;
    while (j < all.length && all[j].isPercent && /^\s*(?:,\s*or\s+|\(|,\s*|or\s+)$/.test(ns.slice(all[j - 1].end, all[j].start))) {
      changes.push(all[j]);
      j++;
    }
    const link = j < all.length ? ns.slice(all[j - 1].end, all[j].start) : "";
    const current = /^\s*[,)]*\s*to\s+$/.test(link) ? all[j] : null;
    const hypothetical = /\bwould\s+(?:have\s+)?(?:been\s+)?(?:\w+\s+){0,2}$/.test(before);
    out.set(a.start, { role: prior ? "prior" : "change", current, hypothetical });
    for (const c of changes) out.set(c.start, { role: "change", current, hypothetical });
    if (current) out.set(current.start, { role: "current", current, hypothetical });
  }
  return out;
}

/**
 * The bounds of every stated range, by token start, each with its side
 * (fix round 5; task 8b rulings 2 and 5): "between X and Y", "X to Y" not in
 * a change sentence, "in a range from X to Y", and "X - Y" however the dash
 * is written. Both numbers must be of one kind: "grew 26% to $64.6 billion"
 * is no range.
 */
export function rangeBounds(ns: string, all: NumberToken[], changes: Map<number, ChangeRole> = changeRoles(ns, all)): Map<number, "low" | "high"> {
  const out = new Map<number, "low" | "high">();
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i];
    const b = all[i + 1];
    if (a.isPercent !== b.isPercent) continue;
    if (changes.has(a.start) || changes.has(b.start)) continue;
    const between = ns.slice(a.end, b.start).trim();
    const before = ns.slice(0, a.start);
    const isRange = (between === "and" && /\bbetween\s*$/.test(before))
      || (between === "to" && (!/\bfrom\s*$/.test(before) || RANGE_FROM.test(before)))
      || between === "-";
    if (isRange) { out.set(a.start, "low"); out.set(b.start, "high"); }
  }
  return out;
}

/** Backwards-compatible view of `rangeBounds`: the token starts of every bound. */
export function rangeBoundStarts(ns: string, all: NumberToken[]): Set<number> {
  return new Set(rangeBounds(ns, all).keys());
}

// ---------------------------------------------------------------------------
// Spelled-out numbers
// ---------------------------------------------------------------------------

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES_RE = Object.keys(ONES).join("|");
const TENS_RE = Object.keys(TENS).join("|");
const UNITS_RE = "one|two|three|four|five|six|seven|eight|nine";
// "twenty-five", "ninety nine", "twenty", "eight", then an optional "(8)" restatement, then a noun
// ("years", "directors"). Never inside a hyphenated compound ("one-time", "ten-year"), never
// "one of", never "no one" / "any one".
const NUMBER_WORD_RE = new RegExp(
  `(?<![a-z-])(?<!\\b(?:no|any)\\s)(?:(${TENS_RE})(?:[\\s-](${UNITS_RE}))?|(${ONES_RE}))(?![a-z-])(\\s*\\((\\d+)\\))?\\s+(?!of\\b)[a-z]`,
  "g",
);

/** Spelled-out numbers of a sentence ("eight years", "twenty-five years", "eight (8) years" once). */
export function spelledNumbers(ns: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of ns.matchAll(NUMBER_WORD_RE)) {
    const start = m.index ?? 0;
    let value: number;
    let wordEnd: number;
    if (m[1] !== undefined) {
      value = TENS[m[1]] + (m[2] !== undefined ? ONES[m[2]] : 0);
      wordEnd = start + m[1].length + (m[2] !== undefined ? 1 + m[2].length : 0);
    } else {
      value = ONES[m[3]];
      wordEnd = start + m[3].length;
    }
    const paren = m[4];
    if (paren !== undefined && Number(m[5]) !== value) continue; // "eight (9)" says two things: bind neither
    out.push({ value, decimals: 0, wordScale: null, isPercent: false, start, end: paren !== undefined ? wordEnd + paren.length : wordEnd });
  }
  return out;
}

/**
 * The quantities of a sentence for pairing. For a count/other figure a
 * spelled-out number before a noun counts too (fix round 5, task 8b); a
 * digit restating it, "eight (8) years", is the same token.
 */
function proseTokens(ns: string, unit: FigureUnit): NumberToken[] {
  const out = quantityTokens(ns);
  if (unit !== "count" && unit !== "other") return out;
  const words = spelledNumbers(ns);
  const kept = out.filter((t) => !words.some((w) => t.start >= w.start && t.end <= w.end));
  return [...kept, ...words].sort((a, b) => a.start - b.start);
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

// ---------------------------------------------------------------------------
// The period a heading supplies
// ---------------------------------------------------------------------------

/** A short line with no sentence inside it: a section heading, a table title. */
export function isHeadingBlock(b: TextBlock): boolean {
  if (b.tableId !== null) return b.rowIndex === null;
  const t = b.text.trim();
  if (t.length === 0 || t.length > 100 || /^[•\-–]/.test(t)) return false;
  if (t.split(/\s+/).length > 14) return false;
  return !/[.!?]\s/.test(t) && !/[.!?]$/.test(t);
}

/**
 * The period of the nearest heading or table title ABOVE the block on the
 * same page (task 8b, ruling 6). Body rows of a table and paragraphs are
 * passed over, but a paragraph that names a different period on the way up
 * means the heading does not speak for this sentence (null).
 */
export function headingPeriod(doc: DocText, block: TextBlock, eventDate: string): PeriodCore | null {
  const passed: PeriodCore[] = [];
  for (let i = block.index - 1; i >= 0; i--) {
    const b = doc.blocks[i];
    if (!b || b.page !== block.page) return null;
    if (b.tableId !== null) return null; // a table's headers belong to that table, never to a later paragraph
    const p = parsePeriodPhrase(b.text, eventDate);
    if (!isHeadingBlock(b)) {
      if (p && p.kind !== "instant") passed.push(p); // a balance "as of" a date is not another period for a quarter heading
      continue;
    }
    if (!p) return null; // the nearest heading names no period: a sub-section of its own, not the quarter's
    return passed.every((q) => periodsMatch({ ...q, anchor: null }, { ...p, anchor: null }) !== false) ? p : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

// "would have been $7.40", "would otherwise have been", "would have come to", "would have amounted to": a
// restated, hypothetical figure, as in a "would have increased … to" sentence (review rounds 1–2). "would",
// up to two adverbs, "have", any verb (with an optional "to" / "at" / "in"), then the number, all in the
// figure's own clause.
const WOULD_HAVE = /\bwould\b(?:\s+\w+){0,2}\s+have\b/;

const CHANGE_METRIC = /\b(?:growth|increase|decrease|change|decline|rise|gain|drop|improvement|reduction|delta|up|down)\b/i;
// A percent figure whose metric is a money measure ("revenue", 27%) can only be a rate of change; a
// margin, a tax rate or a share of something is a level.
const MONEY_MEASURES = new Set(["revenue", "income", "expense", "cash", "flow", "eps", "assets", "liabilities", "debt", "capex"]);

/** May this figure be the change a sentence states ("increased $X", "grew N%")? */
function isChangeFigure(fig: ModelFigure): boolean {
  if (CHANGE_METRIC.test(fig.metric)) return true;
  return fig.unit === "percent" && [...measureClasses(fig.metric)].some((m) => MONEY_MEASURES.has(m));
}

export function bindProse(fig: ModelFigure, stated: StatedNumber, located: LocatedQuote, doc: DocText | undefined, eventDate: string): Binding {
  const reasons: CheckReason[] = [];
  const sentence = located.sentence ?? "";
  const ns = normalizeForMatch(sentence);
  const nl = normalizeForMatch(fig.label ?? "");
  // Every place the label sits at word boundaries ("income" never matches inside "incomes").
  const starts = nl ? [...ns.matchAll(new RegExp(`(?<![a-z0-9])${escapeRe(nl)}(?![a-z0-9])`, "g"))].map((x) => x.index ?? 0) : [];
  if (starts.length === 0 && nl) reasons.push(reason("label_not_in_quote", fig.id, `"${fig.label}" is not a phrase of the cited sentence`));
  // Pair the number with its label: a number inside the label phrase when it IS the value ("20% of the
  // outstanding shares"), else the first number of the same kind after the label, else (first place only)
  // the nearest before it. "Revenue and net income were $X and $Y, respectively": the k-th label takes the
  // k-th number after it. A label used twice ("EPS was $1.80; non-GAAP EPS was $2.10") is tried at each
  // place; a later place pairs only forward and never a number an earlier place already took (fix round 5).
  const percent = fig.unit === "percent";
  const all = proseTokens(ns, fig.unit); // years and date days are never the figure
  // A loss word anywhere earlier in the number's own clause signs it ("a loss before income taxes of $1.2
  // billion" is −1.2; review round 3). A parenthesised "(loss)" or "income/loss" is a label, not a sign.
  const clauses = splitClauses(ns);
  for (const t of all) {
    if (t.signWord || t.value <= 0) continue;
    const c = clauses.find((x) => t.start < x.end);
    const before = (c ? ns.slice(c.start, t.start) : ns.slice(0, t.start)).replace(/\(\s*loss(?:es)?\s*\)/g, " ").replace(/\b\w+\s*\/\s*loss(?:es)?\b/g, " ");
    if (/\bloss(?:es)?\b/.test(before)) { t.value = -t.value; t.signWord = "loss"; }
  }
  const tokens = all.filter((t) => t.isPercent === percent);
  // "losses of $18 billion" is a positive loss figure: a number signed only by a loss word matches a
  // loss-named metric by its size (review round 1, item 6; the negative-typed case is loss_sign_double).
  const matches = (t: NumberToken) =>
    matchesWithRounding(stated, toUnits(lossMetric && t.signWord === "loss" ? Math.abs(t.value) : t.value, t.wordScale ?? "units"));
  const taken = new Set<number>();
  const changes = changeRoles(ns, all);
  const bounds = rangeBounds(ns, all, changes);
  // A sign a word gives the first end of a range carries to the second ("losses of between $18 billion
  // and $19 billion"); a range whose ends still disagree in sign is refused (review round 1, item 6).
  const refused = new Set<number>();
  for (const [start, side] of bounds) {
    if (side !== "low") continue;
    const low = all.find((t) => t.start === start);
    const high = low && all[all.indexOf(low) + 1];
    if (!low || !high || bounds.get(high.start) !== "high") continue;
    if (low.signWord && low.value < 0 && high.value > 0 && !high.signWord) { high.value = -high.value; high.signWord = low.signWord; }
    if (Math.sign(low.value) !== Math.sign(high.value)) { refused.add(low.start); refused.add(high.start); }
  }
  const changeMetric = isChangeFigure(fig);
  const lossMetric = isLossMetric(fig.metric);
  // Each range's ends are ORDERED BY VALUE once signs are applied (review round 2): "losses of $18-19
  // billion" under an income-or-loss metric runs from −19 (low) to −18 (high); under a loss metric,
  // which matches by size, from 18 to 19.
  const eff = (t: NumberToken) => (lossMetric && t.signWord === "loss" ? Math.abs(t.value) : t.value);
  const pairs = new Map<number, { low: NumberToken; high: NumberToken }>();
  for (const [start, side] of bounds) {
    if (side !== "low") continue;
    const a = all.find((t) => t.start === start);
    const b = a && all[all.indexOf(a) + 1];
    if (!a || !b || bounds.get(b.start) !== "high" || refused.has(a.start)) continue;
    const pair = eff(a) <= eff(b) ? { low: a, high: b } : { low: b, high: a };
    pairs.set(a.start, pair);
    pairs.set(b.start, pair);
    bounds.set(pair.low.start, "low");
    bounds.set(pair.high.start, "high");
  }
  const pairedAt = (at: number, firstPlace: boolean): NumberToken | undefined => {
    const end = at + nl.length;
    const inside = tokens.find((t) => t.start >= at && t.end <= end && matches(t));
    if (inside) return inside;
    const k = respectivelyIndex(ns, at, all);
    const after = all.filter((t) => t.start >= end && !taken.has(t.start));
    let paired = k > 0
      ? after[k]
      : after.find((t) => t.isPercent === percent) ?? (firstPlace ? [...tokens].reverse().find((t) => t.end <= at) : undefined);
    if (paired && !matches(paired)) {
      // "rose from $X to $Y" / "increased $X to $Y": a level figure reaches past X to Y (ruling 4). So does
      // "A of $X would have increased by $Z to $Y", where the pattern starts right after the paired X (a
      // "would have" figure is a restatement; the basis check below holds a reported figure back).
      const next = all[all.indexOf(paired) + 1];
      const ch = changes.get(paired.start) ?? (next && !matches(next) && changes.get(next.start)?.role === "change" ? changes.get(next.start) : undefined);
      if (ch && ch.role !== "current" && ch.current && !changeMetric && matches(ch.current)) paired = ch.current;
      // The label introduces a range by its first-written end; a figure for the other end reaches it:
      // guidance_low takes the pair's low end and guidance_high its high end (ordered by value), and any
      // other basis reaches the other end only to get `range_bound` (ruling 2; review round 2 item 5).
      else if (pairs.has(paired.start)) {
        const pair = pairs.get(paired.start) as { low: NumberToken; high: NumberToken };
        const want = fig.basis === "guidance_low" ? pair.low : fig.basis === "guidance_high" ? pair.high : paired === pair.low ? pair.high : pair.low;
        if (want !== paired && matches(want)) paired = want;
      }
    }
    if (paired) taken.add(paired.start);
    return paired && paired.isPercent === percent && matches(paired) ? paired : undefined;
  };
  let hit: NumberToken | undefined;
  let labelAt = starts[0];
  starts.forEach((at, i) => {
    if (hit) return;
    hit = pairedAt(at, i === 0);
    if (hit) labelAt = at;
  });
  if (starts.length === 0) hit = tokens.find(matches);
  // The label widened to its noun phrase, at the place that paired (else the first).
  const phrase = labelAt !== undefined ? `${extendLabelLeft(ns.slice(0, labelAt))} ${nl}`.trim() : nl;
  if (!metricMatchesLabel(fig.metric, phrase, { context: sentence })) {
    reasons.push(reason("metric_unconfirmed", fig.id, `metric "${fig.metric}" does not match "${phrase}"`));
  }
  if (!hit) {
    return failed([...reasons, reason("value_not_in_quote", fig.id, `${fig.valueText} is not the number ${starts.length ? `next to "${fig.label}"` : "in the cited sentence"}`)]);
  }
  if (refused.has(hit.start)) {
    return failed([...reasons, reason("value_not_in_quote", fig.id, `${fig.valueText} is one end of a range whose ends disagree in sign`)]);
  }
  const ch = changes.get(hit.start);
  if (ch?.role === "change" && !changeMetric) {
    return failed([...reasons, reason("value_not_in_quote", fig.id, `${fig.valueText} is the change the sentence states, not the ${fig.metric} figure`)]);
  }
  // "would … have …" anywhere in the figure's own clause before the number, words between allowed; when the
  // number opens its clause ("would have been, in that case, $7.40") the clauses before it, as long as they
  // hold no quantity, are part of the same statement (review round 3).
  const ownIdx = clauses.findIndex((c) => hit!.start < c.end);
  let scopeStart = clauses[ownIdx]?.start ?? 0;
  if (ownIdx >= 0 && !/[a-z]/.test(ns.slice(scopeStart, hit.start))) {
    for (let k = ownIdx - 1; k >= 0 && quantityTokens(clauses[k].text.replace(DATE_RE, " ")).length === 0; k--) scopeStart = clauses[k].start;
  }
  const hypothetical = (ch?.role === "current" && ch.hypothetical) || WOULD_HAVE.test(ns.slice(scopeStart, hit.start));
  if (hypothetical && fig.basis !== "excluding_item" && fig.basis !== "non_gaap") {
    return failed([...reasons, reason("basis_unconfirmed", fig.id, `${fig.valueText} is a "would have" figure, not a ${fig.basis} one`)]);
  }
  // A bound of a stated range is a guidance end, never an actual (fix round 5); each end answers only its own side (ruling 2).
  const side = bounds.get(hit.start);
  if (side && !fig.basis.startsWith("guidance_")) {
    reasons.push(reason("range_bound", fig.id, `${fig.valueText} is one end of a range the sentence states, not a ${fig.basis} figure`));
  } else if (side && side !== (fig.basis === "guidance_low" ? "low" : "high")) {
    return failed([...reasons, reason("value_not_in_quote", fig.id, `${fig.valueText} is the ${side} end of the range, not its ${fig.basis === "guidance_low" ? "low" : "high"} end`)]);
  }
  let period: PeriodCore | null = null;
  if (ch?.role === "prior") {
    reasons.push(reason("period_unconfirmed", fig.id, `${fig.valueText} is the earlier value the sentence moves from; its period is not the sentence's`));
  } else {
    const block = located.block ?? undefined;
    period = parsePeriodPhrase(sentence, eventDate);
    const fromSentence = period !== null;
    if (!period) period = parsePeriodPhrase(block?.text ?? "", eventDate) ?? (doc && block ? headingPeriod(doc, block, eventDate) : null);
    if (!period) {
      reasons.push(reason("period_unconfirmed", fig.id, "neither the sentence, its paragraph nor a heading above names a period"));
    } else {
      let same = periodsMatch({ ...period, anchor: null }, { ...fig.period, anchor: null });
      // A quarter named by the paragraph or a heading does not speak AGAINST a figure typed as another
      // kind (an agreement term as an instant, a balance): weaker evidence than the sentence's own words,
      // so cannot tell, never "differ".
      if (same === false && !fromSentence && period.kind !== fig.period.kind) same = null;
      if (same === false) reasons.push(reason("periods_differ", fig.id, `the sentence speaks of another period than ${fig.period.label}`));
      if (same === null) reasons.push(reason("period_unconfirmed", fig.id, `the sentence's period cannot be matched to ${fig.period.label}`));
      // Matched by fiscal year and quarter ("Third Quarter 2026"): the typed end date names the same
      // period, so a comparison downstream can meet a dated column or bogey anchor.
      if (same === true) {
        period = {
          ...period,
          endDate: period.endDate ?? fig.period.endDate,
          fiscalYear: period.fiscalYear ?? fig.period.fiscalYear,
          fiscalQuarter: period.fiscalQuarter ?? fig.period.fiscalQuarter,
        };
      }
    }
  }
  const scale = hit.wordScale ?? "units";
  return {
    established: reasons.length === 0,
    units: toUnits(hit.value, scale),
    half: halfUnit(hit.decimals, scale),
    period: period ? { ...period, anchor: null } : null,
    table: null,
    basisConfirmed: proseBasisConfirmed(fig.basis, proseBasis(ns, hit.start, fig, doc, located.block)),
    reasons,
  };
}

// A genuine list item (review rounds 3–4): a bullet glyph; a list marker and a space; or an HTML <li>
// (extractor 2, `listItem`). A glyph that also occurs in running text (*, -, –, —) needs a space after it;
// a pure bullet glyph (•·▪◦‣) does not, because EDGAR filers set it in its own span and the extractor
// squashes the gap ("•Income from operations …"). A letter marker is a lowercase single letter ("a.",
// "a)", "(a)") or a parenthesised letter or roman numeral ("(A)", "(iv)"); digits are "1.", "1)", "(1)".
// "A. Smith", "St. Louis", "No. 5", "vs. …" and "U.S. …" are not markers.
const BULLET_GLYPH = /^\s*(?:[•·▪◦‣]|[*\-–—]\s)/;
const LIST_MARKER = /^\s*(?:\(\s*(?:[A-Za-z]|[ivxIVX]{1,4}|\d{1,2})\s*\)|[a-z][.)]|\d{1,2}[.)])\s/;

export function isListItem(b: TextBlock): boolean {
  if (b.listItem) return true;
  return BULLET_GLYPH.test(b.text) || LIST_MARKER.test(b.text);
}

const BASIS_WORDS_RE = /\bnon[\s-]*gaap\b|\bexclud(?:ing|es|ed)\b|\bconstant[\s-]+currency\b|\badjusted\b|\bgaap\b/i;

/** What a lead-in does for a figure's block: deny "reported" (every governed block) and, for a genuine list item, confirm its basis. */
export interface LeadIn { text: string; confirms: boolean }

/**
 * The lead-in that governs `block` (review rounds 2–3, asymmetric by ruling): a block ending in ":" whose
 * text carries basis words ("Excluding this charge, the third quarter 2026:", "On a non-GAAP basis:").
 * Its DENIAL of "reported" reaches the blocks after it, list items or not, until a heading or a second
 * plain paragraph; its CONFIRMATION of a non-reported basis reaches only the contiguous run of genuine
 * list items directly after it (a plain paragraph in between ends it). A mixed
 * lead-in ("Reconciliation of GAAP to non-GAAP results:") governs nothing. Null when none governs.
 */
export function leadInBlock(doc: DocText, block: TextBlock): LeadIn | null {
  // `plain` counts the plain paragraphs between the lead-in and the figure's block (its own block included).
  // Confirmation needs the block to sit in the CONTIGUOUS run of list items right after the lead-in
  // (plain === 0, review round 4); denial reaches one plain paragraph further.
  let plain = isListItem(block) ? 0 : 1;
  let i = block.index - 1;
  while (i >= 0) {
    const b = doc.blocks[i];
    if (b.page !== block.page || b.tableId !== null) return null;
    const colon = /:\s*$/.test(b.text);
    if (!colon) {
      if (isListItem(b)) { i--; continue; }
      if (isHeadingBlock(b) || ++plain > 1) return null; // a heading, or a second plain paragraph, ends the reach
      i--;
      continue;
    }
    // A short lead-in ("Excluding the charge, results were as follows:") looks like a heading; the colon decides first.
    if (!BASIS_WORDS_RE.test(b.text)) return null;
    const k = kindsIn(b.text);
    if (k.has("reported") && k.size > 1) return null; // mixed: confirms nothing, denies nothing
    return { text: b.text, confirms: plain === 0 };
  }
  return null;
}

/** The clauses that speak for a prose figure's basis, plus a governing lead-in and a definitional non-GAAP measure. */
function proseBasis(ns: string, at: number, fig: ModelFigure, doc: DocText | undefined, block: TextBlock | null): ProseBasisClauses {
  const c = proseBasisClauses(ns, at);
  const lead = doc && block ? leadInBlock(doc, block) : null;
  // `attached` confirms and denies; `others` only denies "reported" (fix round 4 asymmetry).
  if (lead) (lead.confirms ? c.attached : c.others).push(normalizeForMatch(lead.text));
  // Free cash flow, adjusted EBITDA, …: the measure's own name is non-GAAP evidence in the figure's clause.
  if (isDefinitionalNonGaap(fig.metric) || isDefinitionalNonGaap(fig.label ?? "")) c.own = `${c.own} (non-gaap by definition)`;
  return c;
}
