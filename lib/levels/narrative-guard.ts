/**
 * Numeric-plausibility guard for AI-generated suggested-level narratives.
 *
 * QA regression security-detail-suggested-levels--narrative-magnitude-
 * contradiction-regression-6 (6th recurrence, 2026-08-16): the Haiku
 * narrative for a suggested level ("price currently N% above/below this
 * historical level") sometimes states a number that contradicts the level's
 * own structured fields. Example (META, support $495.60, price $591.33):
 * the model wrote "price currently 1619% above this historical level" —
 * the true distance is +19.3%, ~84x off. The pivot-cluster math (the chip,
 * the chart) was correct; this is model noise on the PROSE only. Worst
 * case: ACCEPT persisted the wrong sentence verbatim as `security_levels
 * .thesis` on an armed, auto_approved level.
 *
 * This module is a pure, zero-runtime-import helper (mirrors
 * lib/earnings/plausibility.ts's "single source, zero imports" shape) so it
 * is safe to call from server code (lib/chart/narrate-levels.ts storage
 * path) AND from a 'use client' component (LevelsPanel.tsx render + accept
 * paths) without dragging in DB or Node-only deps.
 *
 * Applied at THREE seams per project convention ("sanitize model prose at
 * storage AND render"):
 *   1. Storage — lib/chart/narrate-levels.ts, before INSERT.
 *   2. Render  — app/dashboard/components/LevelsPanel.tsx suggested-level
 *      cards (defense for rows stored before this fix shipped).
 *   3. Accept  — app/dashboard/components/LevelsPanel.tsx `accept()`,
 *      before the narrative is written into `security_levels.thesis`.
 *
 * Owner rulings built 2026-10-07:
 *   - The FACTS (touch count, touch dates) are a templated sentence written
 *     from the level's own metadata (`buildFactSentence`) — the same fields
 *     the card's chip renders, so the two cannot disagree. The model's
 *     sentence is only the rationale that follows it, and it is shown only
 *     when every figure it states agrees with the chip
 *     (`composeLevelNarrative`). Render and ACCEPT use that one string.
 *   - A distance the prose states is judged on the CHIP's denominator
 *     (distance over the current price), to rounding. A sentence that
 *     disagrees is hidden, never rewritten: stored AI prose is not edited.
 *   - The templated sentence carries no distance at all. A percentage is true
 *     only at the price it was written at; the chip is the one live figure.
 */

export type NarrativeLevelType = "support" | "resistance";

/** Minimal structural shape the guard needs from a suggested level. Kept
 *  local (not imported from lib/chart/suggested-levels) so this file stays
 *  import-free — any object with these fields (e.g. SuggestedLevel) works. */
export interface NarrativeLevelContext {
  price: number;
  type: NarrativeLevelType;
  touches: number;
  lastTouchDate: string;
  /** YYYY-MM-DD of the first touch. Optional: without it the date checks that
   *  need a start of the touch window are skipped (fail open). */
  firstTouchDate?: string;
}

export interface NarrativeClaim {
  /** Raw matched substring (trimmed), for logging/debugging. */
  raw: string;
  /** The claim as a percent. A percent claim is the stated number; a dollar
   *  or points claim is the amount over the LEVEL price (kept for callers that
   *  read it — the plausibility check converts `claimedAmount` itself).
   *  Meaningless (0) for `kind: "price"` claims — check `claimedPrice`. */
  claimedPct: number;
  /** Set only for a dollar / points distance claim — the stated amount. */
  claimedAmount?: number;
  direction: "above" | "below";
  /**
   * "distance" — the sentence asserts how FAR price is from the level
   * ("19.3% above", "$95.73 above"); checked against the true distance.
   * "price"    — the sentence asserts a price LEVEL ("above current 207
   * level"); checked against the real current/level prices.
   */
  kind: "distance" | "price";
  /** Set only for `kind: "price"` — the bare price the sentence asserts. */
  claimedPrice?: number;
  /** True when the sentence explicitly tied the price to the CURRENT price
   *  ("above current 207", "above the current price of 207"), which pins the
   *  comparison to currentPrice alone. */
  refersToCurrent?: boolean;
}

export interface NarrativePlausibilityResult {
  plausible: boolean;
  reason?: string;
}

// Matches "1619% above", "$95.73 above", "96+ points above", "12.5 pts below"
// — a number (optional leading $, optional trailing +), an optional unit
// (%, points, pts), then a mandatory "above"/"below". The mandatory
// whitespace-then-direction tail keeps this from matching unrelated numbers
// elsewhere in the sentence (dates, touch counts, SMA periods, …).
const CLAIM_RE =
  /(\$)?(-?\d[\d,]*(?:\.\d+)?)\+?(?:\s*(%|pts?\.?|points?))?\s+(above|below)\b/gi;

// QA regression security-detail-levels--suggestion-narrative-contradicts-chip-
// accept-persists-regression-1 (2026-08-24): CLAIM_RE above requires the
// number to come FIRST, so it read right past the live sentence "…with last
// bounce in January establishing a floor above current 207 level." (direction
// word first, number second) on a security actually trading at 278.91. The
// guard extracted zero claims, the hallucinated price rendered on the card
// next to the correct chip, and ACCEPT persisted it verbatim as a thesis.
//
// This second pattern catches the WORD-then-number order. The optional
// hedge/article words between them ("the", "a", "its", "current", "price of",
// "around", …) are what make "above current 207" and "above the current price
// of 207" one case instead of several.
//
// GROUP 2 IS AN OUTER GROUP AROUND THE WHOLE REPETITION — deliberately, and it
// must stay that way. A repeated CAPTURE (`(word\s+){0,4}`) keeps only its
// LAST iteration, so "above the current price of 250.40" used to capture just
// "of ": `refersToCurrent` came back false, the claim was then allowed to match
// either known price, it matched the LEVEL (250.40), and a sentence asserting
// the CURRENT price is 250.40 on a security trading at 278.91 passed the guard
// (and could be persisted as a thesis on ACCEPT). Wrapping the repetition in an
// outer group with a NON-capturing alternation inside keeps the complete hedge
// phrase, which is what the "current"/"currently" test below reads.
const WORD_FIRST_CLAIM_RE =
  /\b(above|below)\s+((?:(?:the|a|an|its|current|currently|price|prices|level|levels|of|at|around|near|about|roughly|approximately|nearly|some)\s+){0,4})(\$)?(\d[\d,]*(?:\.\d+)?)\s*(%|pts?\.?|points?)?/gi;

// A number in the word-first position is only a PRICE assertion when it isn't
// really a lookback window ("above the 50-day average", "above its 20-week
// base"), a count ("above 4 times"), or a calendar year ("above the 2024
// breakout"). Flagging any of those would discard good prose, so both filters
// below deliberately fail OPEN — an ambiguous number yields no claim, and a
// narrative with no claims passes through untouched.
const PERIOD_UNIT_RE =
  /^[-\s]?(day|week|month|year|quarter|session|bar|period|minute|hour|time|handle|touch|test)s?\b/i;
const CALENDAR_YEAR_RE = /^(19|20)\d{2}$/;

/** Distance tolerance, in percentage points on the chip's basis. The chip
 *  prints one decimal and a model usually rounds to a whole percent, so half a
 *  point is rounding and anything wider is a different number. (Until
 *  2026-10-07 this was "30% relative AND 3 points", which forgave exactly the
 *  gap between the two denominators — 10.7% in the prose beside a 12.0% chip.) */
const DISTANCE_TOLERANCE_PP = 0.5;

/** Price-restatement tolerance: a word-first price claim may miss the real
 *  current/level price by up to 10% (model rounding — "the 250 mark" for a
 *  250.40 level) before it counts as a contradiction. The live defect missed
 *  by 25.8%. */
const PRICE_TOLERANCE = 0.1;

/**
 * The chip's figure: signed percent distance of the LEVEL from the current
 * price, over the CURRENT price — (level - current) / current * 100, the same
 * formula as SuggestedLevel.distancePct (lib/chart/suggested-levels.ts).
 * Positive = the level is above the price. One card, one denominator: prose
 * that states a distance is held to this number.
 */
export function chipDistancePct(currentPrice: number, levelPrice: number): number {
  return ((levelPrice - currentPrice) / currentPrice) * 100;
}

/**
 * Extract every "N% above/below" (and $N / N points variant) claim from a
 * narrative sentence, normalized to a percent-of-`levelPrice` basis.
 * Exported for direct unit testing.
 */
export function extractNarrativeClaims(
  narrative: string,
  levelPrice: number,
): NarrativeClaim[] {
  const claims: NarrativeClaim[] = [];
  if (!narrative || !Number.isFinite(levelPrice) || levelPrice === 0) return claims;

  for (const m of narrative.matchAll(CLAIM_RE)) {
    const [raw, dollarSign, numStr, unit, dirRaw] = m;
    const num = Number(numStr.replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    const direction = dirRaw.toLowerCase() as "above" | "below";
    const isDollarOrPoints = Boolean(dollarSign) || /^(pts?\.?|points?)$/i.test(unit ?? "");
    const claimedPct = isDollarOrPoints ? (num / Math.abs(levelPrice)) * 100 : num;
    claims.push({
      raw: raw.trim(),
      claimedPct,
      direction,
      kind: "distance",
      ...(isDollarOrPoints ? { claimedAmount: num } : {}),
    });
  }

  // Word-then-number order ("a floor above current 207 level").
  for (const m of narrative.matchAll(WORD_FIRST_CLAIM_RE)) {
    const [raw, dirRaw, hedgeRaw, dollarSign, numStr, unit] = m;
    const num = Number(numStr.replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    const direction = dirRaw.toLowerCase() as "above" | "below";
    const hedge = (hedgeRaw ?? "").toLowerCase();

    // What follows the number decides whether it is a price at all.
    const tail = narrative.slice(m.index + raw.length);
    const unitLower = (unit ?? "").toLowerCase();

    if (unitLower === "%") {
      // "above 1619% of this level" — a distance claim in the other order.
      claims.push({ raw: raw.trim(), claimedPct: num, direction, kind: "distance" });
      continue;
    }
    if (/^(pts?\.?|points?)$/i.test(unitLower)) {
      claims.push({
        raw: raw.trim(),
        claimedPct: (num / Math.abs(levelPrice)) * 100,
        direction,
        kind: "distance",
        claimedAmount: num,
      });
      continue;
    }

    // Bare (or $-prefixed) number: a price assertion — unless it's really a
    // lookback window, a count, or a calendar year. Fail open on all three.
    if (PERIOD_UNIT_RE.test(tail)) continue;
    if (!dollarSign && CALENDAR_YEAR_RE.test(numStr)) continue;

    claims.push({
      raw: raw.trim(),
      claimedPct: 0,
      direction,
      kind: "price",
      claimedPrice: num,
      refersToCurrent: /\bcurrent(ly)?\b/.test(hedge),
    });
  }
  return claims;
}

/**
 * A word-first PRICE claim is plausible when the number it states is a
 * recognisable restatement of a price we actually know. "current N" pins the
 * comparison to currentPrice; an unqualified "above N" may legitimately name
 * either the level being narrated or the current price.
 */
function isPriceClaimPlausible(
  claim: NarrativeClaim,
  currentPrice: number,
  levelPrice: number,
): boolean {
  const claimed = claim.claimedPrice;
  if (claimed == null || !Number.isFinite(claimed)) return true;

  const near = (ref: number): boolean =>
    Number.isFinite(ref) && ref !== 0 && Math.abs(claimed - ref) / Math.abs(ref) <= PRICE_TOLERANCE;

  if (claim.refersToCurrent) return near(currentPrice);
  return near(currentPrice) || near(levelPrice);
}

/**
 * `chipPctSigned` is the chip's figure (positive = level above price). The
 * claim's direction word describes the PRICE relative to the level ("price is
 * N% above this level"), so "above" must meet a level BELOW the price.
 */
function isClaimPlausible(
  claim: NarrativeClaim,
  chipPctSigned: number,
  currentPrice: number,
): boolean {
  if (Math.abs(chipPctSigned) > 1e-9) {
    const priceAboveLevel = chipPctSigned < 0;
    if ((claim.direction === "above") !== priceAboveLevel) return false;
  }

  // A dollar / points claim goes onto the chip's denominator too.
  const claimedMagnitude =
    claim.claimedAmount != null
      ? (Math.abs(claim.claimedAmount) / Math.abs(currentPrice)) * 100
      : Math.abs(claim.claimedPct);
  return Math.abs(claimedMagnitude - Math.abs(chipPctSigned)) <= DISTANCE_TOLERANCE_PP + 1e-9;
}

// "within 0.5% of current level", "within 2% of the current price" — a
// proximity claim: no above/below word, so neither pattern above reads it. The
// live sentence said "within 0.5% of current level" beside a +12.1% chip
// (ledger finding security-detail-suggested-levels--stale-narrative-price-and-
// direction-contradiction-regression-1). Only a phrase tied to the CURRENT
// price counts: "three touches within 1% of each other" describes how tight
// the cluster is and is left alone (fail open).
const PROXIMITY_CLAIM_RE =
  /\bwithin\s+(?:about\s+|roughly\s+|approximately\s+|just\s+|only\s+)?(\d[\d,]*(?:\.\d+)?)\s*%\s+of\s+(?:the\s+|its\s+|today's\s+)?(?:current|present|spot|latest|last)\b/gi;

/**
 * Upper bounds the prose puts on the distance between the price and the level
 * ("within N% of current …"), in percent. Exported for direct unit testing.
 */
export function extractProximityClaims(narrative: string): Array<{ raw: string; withinPct: number }> {
  const claims: Array<{ raw: string; withinPct: number }> = [];
  if (!narrative) return claims;
  for (const m of narrative.matchAll(PROXIMITY_CLAIM_RE)) {
    const withinPct = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(withinPct)) claims.push({ raw: m[0].trim(), withinPct });
  }
  return claims;
}

/**
 * Check every numeric claim in `narrative` against the chip's distance
 * between `currentPrice` and `levelPrice`. A narrative with zero
 * extractable claims passes through untouched (nothing to gate).
 */
export function checkNarrativePlausibility(
  narrative: string,
  currentPrice: number,
  levelPrice: number,
): NarrativePlausibilityResult {
  if (
    !narrative ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(levelPrice) ||
    levelPrice === 0 ||
    currentPrice === 0
  ) {
    return { plausible: true };
  }

  const chipPctSigned = chipDistancePct(currentPrice, levelPrice);
  const claims = extractNarrativeClaims(narrative, levelPrice);
  for (const claim of claims) {
    if (claim.kind === "price") {
      if (!isPriceClaimPlausible(claim, currentPrice, levelPrice)) {
        return {
          plausible: false,
          reason: `claim "${claim.raw}" contradicts ${
            claim.refersToCurrent ? "current price" : "the known prices"
          } (current ${currentPrice}, level ${levelPrice})`,
        };
      }
      continue;
    }
    if (!isClaimPlausible(claim, chipPctSigned, currentPrice)) {
      return {
        plausible: false,
        reason: `claim "${claim.raw}" contradicts the chip's distance ${chipPctSigned.toFixed(1)}%`,
      };
    }
  }
  // A proximity claim is a ceiling on the chip's figure, to the same rounding.
  for (const claim of extractProximityClaims(narrative)) {
    if (Math.abs(chipPctSigned) > claim.withinPct + DISTANCE_TOLERANCE_PP + 1e-9) {
      return {
        plausible: false,
        reason: `claim "${claim.raw}" contradicts the chip's distance ${chipPctSigned.toFixed(1)}%`,
      };
    }
  }
  return { plausible: true };
}

// ---------------------------------------------------------------------------
// Touch-count and date claims.
//
// QA finding security-detail-levels--suggestion-narrative-contradicts-chip-
// accept-persists-regression-3: a card whose chip read "1× · last 2026-05-29"
// carried prose saying the level was "tested multiple times in August". The
// distance check above never looked at counts or dates. These checks hold the
// prose to the same three fields the chip prints: `touches`, `firstTouchDate`,
// `lastTouchDate`. They are deliberately strict — a sentence that states a
// count or a date the metadata cannot back is hidden, and the templated fact
// sentence stands alone.
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

// "11 times", "four touches", "3 tests", "two-touch".
const COUNT_RE =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(?:times?|touch(?:es)?|tests?|retests?)\b/gi;
// "11×", "4x".
const COUNT_X_RE = /\b(\d+)\s*[x×](?![a-z0-9])/gi;
const TWICE_RE = /\b(twice|thrice)\b/gi;
// "once" is only a count next to a touch verb ("tested once", "held it once")
// — "once resistance, now support" is not a count.
const ONCE_RE =
  /\b(?:touched|tested|retested|held|defended|rejected|bounced|hit|tagged|visited|reached)\b(?:\s+\S+){0,2}?\s+once\b|\b(?:single|lone|sole)\s+(?:touch|test|retest|pivot)\b/gi;
const PLURAL_RE =
  /\b(?:multiple|several|numerous|many|repeated)\s+(?:times|touches|tests|retests|occasions)\b|\brepeatedly\b/gi;

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Capitalised month names only (case-sensitive on purpose: "may" the verb and
// "march higher" are not dates), with an optional day ("July 30", "August 3rd").
const MONTH_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?\b(?![\s-]*(?:%|x\b|×|times?\b|touch|tests?\b|days?\b|weeks?\b|sessions?\b)))?/g;
// A sentence-initial "May" is usually the verb; count it as the month only
// after a date preposition or when a day follows.
const MAY_CONTEXT_RE =
  /(?:\b(?:in|since|from|of|during|until|through|on|last|and|to|before|after|by|between)\s+|\b(?:early|mid|late)[-\s]+)$/i;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// The date that follows names the LAST touch ("most recently July 30",
// "last bounce in January").
const LAST_TOUCH_CONTEXT_RE =
  /\b(?:most\s+recent(?:ly)?|latest|last\s+(?:touch|test|retest|bounce|rejection)\w*|last\s+(?:touched|tested|bounced|held|hit))\b(?:\W+\w+){0,3}\W*$/i;
// The date that follows names the FIRST touch ("11 times since December").
const FIRST_TOUCH_CONTEXT_RE = /\bsince\s+(?:(?:early|mid|late)[-\s]+)?$/i;

function parseIsoDate(value: string | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Check every touch-count and date the prose states against the level's own
 * metadata. Prose with no such claim passes untouched.
 */
export function checkNarrativeFacts(
  narrative: string,
  level: NarrativeLevelContext,
): NarrativePlausibilityResult {
  if (!narrative) return { plausible: true };
  const touches = level.touches;

  // --- counts ---
  const counts: Array<{ raw: string; n: number }> = [];
  for (const m of narrative.matchAll(COUNT_RE)) {
    const token = m[1].toLowerCase();
    counts.push({ raw: m[0], n: NUMBER_WORDS[token] ?? Number(token) });
  }
  for (const m of narrative.matchAll(COUNT_X_RE)) counts.push({ raw: m[0], n: Number(m[1]) });
  for (const m of narrative.matchAll(TWICE_RE)) {
    counts.push({ raw: m[0], n: m[1].toLowerCase() === "twice" ? 2 : 3 });
  }
  for (const m of narrative.matchAll(ONCE_RE)) counts.push({ raw: m[0], n: 1 });
  for (const c of counts) {
    if (Number.isFinite(c.n) && c.n !== touches) {
      return {
        plausible: false,
        reason: `count "${c.raw.trim()}" contradicts the level's ${touches} touch(es)`,
      };
    }
  }
  for (const m of narrative.matchAll(PLURAL_RE)) {
    if (touches < 2) {
      return {
        plausible: false,
        reason: `"${m[0].trim()}" contradicts the level's ${touches} touch(es)`,
      };
    }
  }

  // --- dates ---
  const last = parseIsoDate(level.lastTouchDate);
  if (!last) return { plausible: true };
  const first = parseIsoDate(level.firstTouchDate);
  const lastIso = isoOf(last.y, last.m, last.d);
  const firstIso = first ? isoOf(first.y, first.m, first.d) : null;

  for (const m of narrative.matchAll(ISO_DATE_RE)) {
    const iso = m[0];
    if (iso > lastIso || (firstIso != null && iso < firstIso)) {
      return { plausible: false, reason: `date ${iso} is outside the level's touch dates` };
    }
  }

  for (const m of narrative.matchAll(MONTH_RE)) {
    const before = narrative.slice(0, m.index);
    const day = m[2] != null ? Number(m[2]) : null;
    if (m[1] === "May" && day == null && !MAY_CONTEXT_RE.test(before)) continue;
    const month = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    const said = m[0].trim();

    if (LAST_TOUCH_CONTEXT_RE.test(before)) {
      if (month !== last.m || (day != null && day !== last.d)) {
        return {
          plausible: false,
          reason: `"${said}" is not the level's last touch (${lastIso})`,
        };
      }
      continue;
    }
    if (!first || !firstIso) continue; // no start of the window: fail open
    if (FIRST_TOUCH_CONTEXT_RE.test(before)) {
      if (month !== first.m || (day != null && day !== first.d)) {
        return {
          plausible: false,
          reason: `"${said}" is not the level's first touch (${firstIso})`,
        };
      }
      continue;
    }
    // Any other date must fall inside the touch window, in some year of it.
    let inside = false;
    for (let y = first.y; y <= last.y && !inside; y++) {
      if (day != null) {
        const iso = isoOf(y, month, day);
        inside = iso >= firstIso && iso <= lastIso;
      } else {
        const ym = y * 12 + month;
        inside = ym >= first.y * 12 + first.m && ym <= last.y * 12 + last.m;
      }
    }
    if (!inside) {
      return {
        plausible: false,
        reason: `"${said}" is outside the level's touch dates (${firstIso} to ${lastIso})`,
      };
    }
  }

  return { plausible: true };
}

// ---------------------------------------------------------------------------
// The templated fact sentence and the composed card text.
// ---------------------------------------------------------------------------

const FACT_SENTENCE_RE =
  /^(?:Support|Resistance) touched (?:once, on \d{4}-\d{2}-\d{2}|\d+ times(?: between \d{4}-\d{2}-\d{2} and|, most recently on) \d{4}-\d{2}-\d{2})\.$/;

/**
 * The factual sentence for a suggested level, written from the same metadata
 * the card's chip prints (touch count, first and last touch date). No model
 * text and no distance: a percentage is true only at the price it was written
 * at, and this sentence is also what ACCEPT stores as the level's thesis.
 */
export function buildFactSentence(level: NarrativeLevelContext): string {
  const side = level.type === "resistance" ? "Resistance" : "Support";
  if (level.touches <= 1) return `${side} touched once, on ${level.lastTouchDate}.`;
  if (level.firstTouchDate && level.firstTouchDate !== level.lastTouchDate) {
    return `${side} touched ${level.touches} times between ${level.firstTouchDate} and ${level.lastTouchDate}.`;
  }
  return `${side} touched ${level.touches} times, most recently on ${level.lastTouchDate}.`;
}

/** True for a sentence this module wrote itself (`buildFactSentence`). The
 *  storage seam keeps one when the model's sentence fails the guard; render
 *  must not print it a second time after the fresh fact sentence. */
export function isFactSentence(text: string): boolean {
  return FACT_SENTENCE_RE.test(text.trim());
}

/**
 * Kept under its old name for the storage seam: the sentence that stands in
 * when the model's narrative fails the guard. It is the fact sentence —
 * `currentPrice` is no longer used, because the template states no distance.
 */
export function buildFallbackNarrative(
  level: NarrativeLevelContext,
  currentPrice?: number,
): string {
  void currentPrice;
  return buildFactSentence(level);
}

/**
 * The model's sentence when it may be shown as the rationale, otherwise null:
 * empty, one of our own fact sentences, or a sentence whose distance, price,
 * touch count or dates disagree with the level. The distance and price checks
 * need `currentPrice`; without it only the count and date checks run.
 */
export function narrativeRationale(
  narrative: string | null | undefined,
  currentPrice: number | null,
  level: NarrativeLevelContext,
): string | null {
  const trimmed = narrative?.trim();
  if (!trimmed) return null;
  if (isFactSentence(trimmed)) return null;
  if (
    currentPrice != null &&
    !checkNarrativePlausibility(trimmed, currentPrice, level.price).plausible
  ) {
    return null;
  }
  if (!checkNarrativeFacts(trimmed, level).plausible) return null;
  return trimmed;
}

/**
 * The one string a suggested-level card shows and ACCEPT stores: the templated
 * fact sentence, then the model's rationale when it passes every check.
 */
export function composeLevelNarrative(
  level: NarrativeLevelContext & { narrative?: string | null },
  currentPrice: number | null,
): string {
  const fact = buildFactSentence(level);
  const rationale = narrativeRationale(level.narrative, currentPrice, level);
  return rationale ? `${fact} ${rationale}` : fact;
}

/**
 * The storage seam (lib/chart/narrate-levels.ts): returns the model's sentence
 * unchanged when it passes every check, otherwise the templated fact sentence.
 * Returns null only when `narrative` itself is null/empty.
 */
export function guardNarrative(
  narrative: string | null | undefined,
  currentPrice: number,
  level: NarrativeLevelContext,
): string | null {
  const trimmed = narrative?.trim();
  if (!trimmed) return null;
  return narrativeRationale(trimmed, currentPrice, level) ?? buildFactSentence(level);
}

/**
 * ACCEPT-path thesis resolver — the exact string LevelsPanel's `accept()`
 * sends as `security_levels.thesis` for a suggested level. It is the same
 * string the card renders (`composeLevelNarrative`), so the thesis stored on
 * an armed level can never carry a sentence the card would have hidden.
 */
export function resolveAcceptedThesis(
  sug: NarrativeLevelContext & {
    narrative?: string | null;
    confidence: string;
  },
  currentPrice: number | null,
): string {
  return composeLevelNarrative(sug, currentPrice);
}
