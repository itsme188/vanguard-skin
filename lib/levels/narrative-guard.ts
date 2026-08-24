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
}

export interface NarrativeClaim {
  /** Raw matched substring (trimmed), for logging/debugging. */
  raw: string;
  /** The claim normalized onto a percent-of-level-price basis so percent,
   *  dollar, and points claims all run through one tolerance check.
   *  Meaningless (0) for `kind: "price"` claims — check `claimedPrice`. */
  claimedPct: number;
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
const WORD_FIRST_CLAIM_RE =
  /\b(above|below)\s+((?:the|a|an|its|current|currently|price|prices|level|levels|of|at|around|near|about|roughly|approximately|nearly|some)\s+){0,4}(\$)?(\d[\d,]*(?:\.\d+)?)\s*(%|pts?\.?|points?)?/gi;

// A number in the word-first position is only a PRICE assertion when it isn't
// really a lookback window ("above the 50-day average", "above its 20-week
// base"), a count ("above 4 times"), or a calendar year ("above the 2024
// breakout"). Flagging any of those would discard good prose, so both filters
// below deliberately fail OPEN — an ambiguous number yields no claim, and a
// narrative with no claims passes through untouched.
const PERIOD_UNIT_RE =
  /^[-\s]?(day|week|month|year|quarter|session|bar|period|minute|hour|time|handle|touch|test)s?\b/i;
const CALENDAR_YEAR_RE = /^(19|20)\d{2}$/;

/** Relative-deviation tolerance: >30% off truth. */
const RELATIVE_TOLERANCE = 0.3;

/** Price-restatement tolerance: a word-first price claim may miss the real
 *  current/level price by up to 10% (model rounding — "the 250 mark" for a
 *  250.40 level) before it counts as a contradiction. The live defect missed
 *  by 25.8%. */
const PRICE_TOLERANCE = 0.1;
/** Absolute-deviation tolerance: >3 percentage points off truth. A claim is
 *  only flagged implausible when it exceeds BOTH tolerances — either one
 *  alone is forgiven as rounding (a model saying "19%" for a true 19.3% is
 *  fine; "1619%" for 19.3% blows past both). */
const ABSOLUTE_TOLERANCE_PP = 3;

/**
 * True signed percent distance of `currentPrice` from `levelPrice` —
 * (current - level) / level * 100. Note this is deliberately NOT the same
 * figure as SuggestedLevel.distancePct (which is (level - current) /
 * CURRENT * 100 — the level's distance-TO from the chip). This is the
 * distance the narrative prose is actually trying to describe.
 */
function trueDistancePct(currentPrice: number, levelPrice: number): number {
  return ((currentPrice - levelPrice) / levelPrice) * 100;
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
    claims.push({ raw: raw.trim(), claimedPct, direction, kind: "distance" });
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
 * A single claim is implausible when its direction contradicts the true
 * sign, OR its magnitude misses the true distance by more than BOTH
 * tolerances above.
 */
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

function isClaimPlausible(claim: NarrativeClaim, truePctSigned: number): boolean {
  const claimedSigned =
    claim.direction === "above" ? Math.abs(claim.claimedPct) : -Math.abs(claim.claimedPct);

  if (Math.abs(truePctSigned) > 1e-9) {
    if (Math.sign(claimedSigned || 1) !== Math.sign(truePctSigned)) return false;
  }

  const trueMagnitude = Math.abs(truePctSigned);
  const absDeviationPp = Math.abs(Math.abs(claimedSigned) - trueMagnitude);
  const relativeDeviation =
    trueMagnitude > 0 ? absDeviationPp / trueMagnitude : absDeviationPp > 0 ? Infinity : 0;

  const exceedsRelative = relativeDeviation > RELATIVE_TOLERANCE;
  const exceedsAbsolute = absDeviationPp > ABSOLUTE_TOLERANCE_PP;
  return !(exceedsRelative && exceedsAbsolute);
}

/**
 * Check every numeric claim in `narrative` against the real distance
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
    levelPrice === 0
  ) {
    return { plausible: true };
  }

  const truePctSigned = trueDistancePct(currentPrice, levelPrice);
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
    if (!isClaimPlausible(claim, truePctSigned)) {
      return {
        plausible: false,
        reason: `claim "${claim.raw}" contradicts true distance ${truePctSigned.toFixed(1)}%`,
      };
    }
  }
  return { plausible: true };
}

/**
 * Computed-template sentence in the same voice as a correct model
 * narrative, built entirely from real structured fields (never from the
 * discarded model prose). Used whenever a narrative fails the plausibility
 * gate at storage or render time.
 */
export function buildFallbackNarrative(
  level: NarrativeLevelContext,
  currentPrice: number,
): string {
  const truePctSigned = trueDistancePct(currentPrice, level.price);
  const direction = truePctSigned >= 0 ? "above" : "below";
  const magnitude = Math.abs(truePctSigned);
  const touchWord = level.touches <= 1 ? "Single touch" : `${level.touches} touches`;
  const confirmWord =
    level.touches >= 3 ? "offers strong" : level.touches === 2 ? "offers moderate" : "offers minimal";
  return `${touchWord} on ${level.lastTouchDate} ${confirmWord} ${level.type} confirmation; price currently ${magnitude.toFixed(1)}% ${direction} this historical level.`;
}

/**
 * The single call site both storage and render should use: returns
 * `narrative` unchanged when plausible (or when there isn't enough data to
 * check), otherwise a computed fallback built from `level`/`currentPrice`.
 * Returns null only when `narrative` itself is null/empty.
 */
export function guardNarrative(
  narrative: string | null | undefined,
  currentPrice: number,
  level: NarrativeLevelContext,
): string | null {
  const trimmed = narrative?.trim();
  if (!trimmed) return null;

  const { plausible } = checkNarrativePlausibility(trimmed, currentPrice, level.price);
  if (plausible) return trimmed;

  return buildFallbackNarrative(level, currentPrice);
}

/**
 * ACCEPT-path thesis resolver — the exact string LevelsPanel's `accept()`
 * sends as `security_levels.thesis` for a suggested level. Single-sourced
 * here so the "never persist an implausible sentence" invariant lives in
 * one tested place instead of being re-derived inline in the component.
 * Mirrors the pre-existing fallback shape (pivot-clustering summary) for
 * the no-narrative-at-all case.
 */
export function resolveAcceptedThesis(
  sug: NarrativeLevelContext & {
    narrative?: string | null;
    confidence: string;
  },
  currentPrice: number | null,
): string {
  if (sug.narrative) {
    const guarded =
      currentPrice != null ? guardNarrative(sug.narrative, currentPrice, sug) : sug.narrative;
    if (guarded) return guarded;
  }
  return `Auto-suggested from pivot clustering · ${sug.touches}× touches, last ${sug.lastTouchDate} · confidence: ${sug.confidence}`;
}
