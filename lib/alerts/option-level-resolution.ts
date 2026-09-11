/**
 * Option -> underlying-equity resolution for price levels.
 *
 * A price level is compared against the security's own price series. A level
 * quoted in SHARE dollars ("trimmed at $52/share") that lands on an OCC
 * OPTION row is therefore compared against the option PREMIUM, so it can only
 * fire if the premium reaches $52 — and the deliberate option exemption from
 * the plausibility band (lib/levels/scan-range.ts) hides the absurdity instead
 * of flagging it. The bug this module fixes: a share-price exit level quoted
 * by a newsletter landed on a held call of a dual-class issuer, where it was
 * compared against the option premium and could never fire.
 *
 * Root cause: newsletter extraction (lib/alerts/extract-newsletter-levels.ts)
 * is the ONLY symbol-string -> security_id resolution that creates levels, and
 * its tracked-symbol query had no option filter, so OCC rows such as
 * "FOXA  270618C00030000" entered the list Claude was asked to quote levels
 * for. Newsletters never quote option premiums by OCC symbol; when an author
 * says "FOXA 52" they mean the share.
 *
 * Two consumers, one rule set:
 *
 *   1. resolveTrackedSymbolsToEquities() — extraction-time. Folds every option
 *      row in the tracked set into its underlying EQUITY (issuer-family aware,
 *      so a held FOXA contract folds into a held FOX share row), and DROPS
 *      an option whose underlying has no equity row anywhere. A level must
 *      never attach to an option row again.
 *
 *   2. classifyOptionAttachedLevel() — repair-time, for the levels that were
 *      created before rule 1 existed. Judges an existing option-attached level
 *      against BOTH the underlying equity's price and the option's own premium
 *      using the scanner's own band predicate (imported, never forked), so a
 *      genuine premium level ("enter this call at $8.25") is left alone and
 *      only a share-priced level is re-pointed.
 *
 * Pure resolution + a couple of read-only lookups. No writes live here —
 * scripts/repair-option-attached-levels.ts owns the UPDATE.
 */

import type Database from "better-sqlite3";
import { parseOptionSymbol } from "@/lib/import/occ-symbol";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { isLevelBeyondScanRange } from "@/lib/levels/scan-range";
import type { RelevantSymbol } from "@/lib/alerts/extract-newsletter-levels";

// ─── Type predicates ────────────────────────────────────────────────

/** Case-insensitive security_type comparison — project convention. */
export function isOptionType(securityType: string | null | undefined): boolean {
  return (securityType ?? "").trim().toLowerCase() === "option";
}

/**
 * Types that can legitimately carry a SHARE-priced level. Used only to RANK
 * candidate rows, never to filter them: a stub row with a NULL type is still
 * a possible target, it is just a worse one than a typed, priced sibling.
 */
const EQUITY_LIKE_TYPES = new Set([
  "stock",
  "etf",
  "adr",
  "reit",
  "mutual fund",
  "fund",
  "equity",
]);

function isEquityLikeType(securityType: string | null | undefined): boolean {
  return EQUITY_LIKE_TYPES.has((securityType ?? "").trim().toLowerCase());
}

/**
 * The underlying ticker for an option row. Prefers the stored
 * `underlying_symbol` column when the caller carries one (statement imports
 * populate it even for non-OCC spellings) and otherwise parses the symbol —
 * parseOptionSymbol accepts both canonical OCC and the Vanguard-compact
 * spelling. Null when neither yields an underlying.
 */
export function underlyingSymbolOf(row: {
  symbol: string;
  underlying_symbol?: string | null;
}): string | null {
  const stored = row.underlying_symbol?.trim();
  if (stored) return stored.toUpperCase();
  const parsed = parseOptionSymbol(row.symbol);
  return parsed ? parsed.underlying.toUpperCase() : null;
}

/** Uppercased issuer family for `symbol`, always non-empty for a real ticker. */
function siblingKeys(symbol: string): string[] {
  return issuerSiblings(symbol).map((s) => s.toUpperCase());
}

// ─── Equity lookup ──────────────────────────────────────────────────

export interface EquityTarget {
  security_id: number;
  symbol: string;
  security_type: string | null;
  current_price: number | null;
}

interface EquityCandidateRow {
  security_id: number;
  symbol: string;
  security_type: string | null;
  current_price: number | null;
}

/**
 * Best non-option security for `underlying` (or any of its issuer siblings).
 *
 * A case this has to survive: a bare ticker stub with no type and no price
 * sits alongside a typed, priced sibling row for the same issuer family (e.g.
 * a bare "FOXA" stub next to a typed, priced "FOX" row). Attaching a level to
 * the stub would be technically "not an option" and still useless — the
 * scanner needs a price. Ranking, highest first:
 *
 *   +8 an equity-family security_type (a typed row beats an untyped stub)
 *   +4 has at least one price row (a level on a priceless row never scans)
 *   +2 the symbol IS the underlying (exact beats sibling, all else equal)
 *   tie-break: lowest id (deterministic across runs)
 *
 * Null when the underlying has no non-option row at all.
 */
export function resolveEquityForUnderlying(
  db: Database.Database,
  underlying: string,
): EquityTarget | null {
  const keys = siblingKeys(underlying);
  if (keys.length === 0) return null;
  const placeholders = keys.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `SELECT s.id AS security_id, s.symbol, s.security_type,
              (SELECT p.close_price FROM prices p
                WHERE p.security_id = s.id
                ORDER BY p.date DESC LIMIT 1) AS current_price
         FROM securities s
        WHERE UPPER(s.symbol) IN (${placeholders})
          AND LOWER(COALESCE(s.security_type, '')) != 'option'`,
    )
    .all(...keys) as EquityCandidateRow[];

  if (rows.length === 0) return null;

  const target = underlying.toUpperCase();
  const scored = rows.map((r) => ({
    row: r,
    score:
      (isEquityLikeType(r.security_type) ? 8 : 0) +
      (r.current_price != null ? 4 : 0) +
      (r.symbol.toUpperCase() === target ? 2 : 0),
  }));
  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.row.security_id - b.row.security_id,
  );

  const best = scored[0].row;
  return {
    security_id: best.security_id,
    symbol: best.symbol,
    security_type: best.security_type,
    current_price: best.current_price,
  };
}

// ─── Extraction-time folding ────────────────────────────────────────

export interface FoldedOption {
  /** The OCC (or compact) contract symbol that was folded away. */
  optionSymbol: string;
  /** Underlying ticker parsed off the contract, uppercased. */
  underlying: string;
  /** Equity the contract folded into. */
  equitySymbol: string;
  equitySecurityId: number;
  /** True when the equity was pulled in from `securities` rather than already
   *  being in the tracked set. */
  addedToTrackedSet: boolean;
}

export interface DroppedOption {
  optionSymbol: string;
  /** Null when the symbol did not parse as an option at all. */
  underlying: string | null;
  reason: "no_underlying" | "no_equity_security";
}

export interface EquityFoldResult {
  /** Equity-only tracked set: no row here is an option. */
  symbols: RelevantSymbol[];
  folded: FoldedOption[];
  dropped: DroppedOption[];
}

/**
 * Fold every option row of a tracked set into its underlying equity.
 *
 * Order of resolution for one option:
 *   1. a non-option row ALREADY in the tracked set whose symbol is the
 *      underlying or an issuer sibling of it (held FOXA call -> held FOX);
 *   2. otherwise the best equity row in `securities` (resolveEquityForUnderlying),
 *      added to the set tagged "held_via_option" so the prompt still explains
 *      why the user cares about the name;
 *   3. otherwise DROPPED with one warning — better no level than a share level
 *      on a contract.
 *
 * Non-option rows pass through untouched and keep their original relationship;
 * an equity that is both tracked and an option underlying is never duplicated.
 */
export function resolveTrackedSymbolsToEquities(
  db: Database.Database,
  tracked: RelevantSymbol[],
): EquityFoldResult {
  const symbols: RelevantSymbol[] = [];
  const seenIds = new Set<number>();
  const folded: FoldedOption[] = [];
  const dropped: DroppedOption[] = [];

  const optionRows: RelevantSymbol[] = [];
  for (const row of tracked) {
    if (isOptionType(row.security_type)) {
      optionRows.push(row);
      continue;
    }
    if (seenIds.has(row.security_id)) continue;
    seenIds.add(row.security_id);
    symbols.push(row);
  }

  for (const opt of optionRows) {
    const underlying = underlyingSymbolOf(opt);
    if (!underlying) {
      dropped.push({ optionSymbol: opt.symbol, underlying: null, reason: "no_underlying" });
      console.warn(
        `[levels/extract] Dropping "${opt.symbol}" from level extraction — cannot parse an underlying ticker off the contract symbol; a price level must never attach to an option row.`,
      );
      continue;
    }

    const keys = new Set(siblingKeys(underlying));
    // Prefer an exact-underlying tracked equity over a sibling one.
    const inSet =
      symbols.find((s) => s.symbol.toUpperCase() === underlying) ??
      symbols.find((s) => keys.has(s.symbol.toUpperCase()));
    if (inSet) {
      folded.push({
        optionSymbol: opt.symbol,
        underlying,
        equitySymbol: inSet.symbol,
        equitySecurityId: inSet.security_id,
        addedToTrackedSet: false,
      });
      continue;
    }

    const equity = resolveEquityForUnderlying(db, underlying);
    if (!equity) {
      dropped.push({ optionSymbol: opt.symbol, underlying, reason: "no_equity_security" });
      console.warn(
        `[levels/extract] Dropping "${opt.symbol}" from level extraction — no equity security exists for underlying ${underlying}; a price level must never attach to an option row.`,
      );
      continue;
    }

    if (!seenIds.has(equity.security_id)) {
      seenIds.add(equity.security_id);
      symbols.push({
        symbol: equity.symbol,
        security_id: equity.security_id,
        current_price: equity.current_price,
        relationship: opt.relationship === "watchlist" ? "watchlist" : "held_via_option",
        security_type: equity.security_type,
      });
    }
    folded.push({
      optionSymbol: opt.symbol,
      underlying,
      equitySymbol: equity.symbol,
      equitySecurityId: equity.security_id,
      addedToTrackedSet: true,
    });
  }

  return { symbols, folded, dropped };
}

/**
 * Index a tracked set by symbol for resolving the model's returned ticker,
 * issuer-family aware: the prompt lists FOX but a newsletter (and therefore
 * the model) may well say FOXA, and the two are the same issuer. Exact
 * symbols are inserted first and never overwritten by a sibling alias, so a
 * set that tracks BOTH classes still resolves each to its own row.
 */
export function indexTrackedSymbols(
  tracked: RelevantSymbol[],
): Map<string, RelevantSymbol> {
  const bySymbol = new Map<string, RelevantSymbol>();
  for (const s of tracked) bySymbol.set(s.symbol.toUpperCase(), s);
  for (const s of tracked) {
    for (const alias of siblingKeys(s.symbol)) {
      if (!bySymbol.has(alias)) bySymbol.set(alias, s);
    }
  }
  return bySymbol;
}

// ─── Repair-time classification ─────────────────────────────────────

export type OptionLevelVerdict = "move" | "leave" | "review" | "duplicate";

export interface OptionLevelClassification {
  verdict: OptionLevelVerdict;
  reason: string;
}

/**
 * Is `levelPrice` a believable quote against `currentPrice`?
 *
 * Delegates to the scanner's own band (isLevelBeyondScanRange) with the
 * security type deliberately OMITTED, so the band actually applies. The
 * option exemption in that predicate is correct for scanning — an option
 * premium really can double overnight — but here we are asking the opposite
 * question: "does this number read like a price on this series at all?", and
 * for that we want the plain band on both sides. The threshold itself is
 * never re-typed here; only that function knows it.
 */
function quotesLike(levelPrice: number, currentPrice: number | null): boolean {
  if (currentPrice == null || currentPrice <= 0) return false;
  return !isLevelBeyondScanRange(levelPrice, currentPrice);
}

export interface ClassifyOptionLevelInput {
  levelPrice: number;
  /** Latest close on the OPTION row the level is currently attached to. */
  optionPrice: number | null;
  /** Resolved underlying equity, or null when none exists. */
  equity: Pick<EquityTarget, "symbol" | "current_price"> | null;
  /** True when the target equity already carries an identical
   *  (level_type, direction, price) row. */
  duplicateOnEquity?: boolean;
}

/**
 * Decide what to do with a level that is attached to an option row.
 *
 *   move      — reads like a SHARE price (in band against the equity) and does
 *               NOT read like a premium (out of band against the option). The
 *               $52-share-level-on-a-$4-premium case.
 *   leave     — reads like a premium ("enter this call at $8.25" with the
 *               premium at $8.58). A genuine option level; re-pointing it to
 *               the equity would invent a level the author never named.
 *   review    — ambiguous: both readings are in band (a deep-ITM LEAP whose
 *               premium is share-scale), neither is, or a price is missing on
 *               the side that would decide it. Never written by --apply.
 *   duplicate — would move, but the equity already carries the same
 *               (level_type, direction, price). Skipped.
 *
 * Pure. All price inputs are native-currency closes from `prices`.
 */
export function classifyOptionAttachedLevel(
  input: ClassifyOptionLevelInput,
): OptionLevelClassification {
  const { levelPrice, optionPrice, equity } = input;

  if (!equity) {
    return {
      verdict: "review",
      reason: "no equity security exists for the underlying",
    };
  }

  const equityPrice = equity.current_price;
  if (equityPrice == null && optionPrice == null) {
    return {
      verdict: "review",
      reason: "no price on either the option or the equity",
    };
  }

  const readsAsShare = quotesLike(levelPrice, equityPrice);
  const readsAsPremium = quotesLike(levelPrice, optionPrice);

  if (readsAsShare && readsAsPremium) {
    return {
      verdict: "review",
      reason: `in band against both ${equity.symbol} and the option premium`,
    };
  }

  if (readsAsShare && optionPrice != null) {
    if (input.duplicateOnEquity) {
      return {
        verdict: "duplicate",
        reason: `${equity.symbol} already carries an identical level`,
      };
    }
    return {
      verdict: "move",
      reason: `share-scale level: in band against ${equity.symbol}, out of band against the option premium`,
    };
  }

  if (readsAsPremium) {
    return { verdict: "leave", reason: "in band against the option premium" };
  }

  if (readsAsShare) {
    // Equity price known and in band, but the option has no price to rule the
    // premium reading out. Not enough to rewrite a row.
    return {
      verdict: "review",
      reason: `in band against ${equity.symbol} but the option has no price to compare`,
    };
  }

  if (equityPrice == null) {
    return {
      verdict: "review",
      reason: `out of band against the option premium and ${equity.symbol} has no price`,
    };
  }
  if (optionPrice == null) {
    return {
      verdict: "review",
      reason: `out of band against ${equity.symbol} and the option has no price`,
    };
  }
  return {
    verdict: "review",
    reason: `out of band against both ${equity.symbol} and the option premium`,
  };
}

/** Provenance appended to `notes` when a level is re-pointed. Deterministic
 *  given (symbol, date) so a re-run can recognise its own handiwork. */
export function repairProvenanceNote(optionSymbol: string, isoDate: string): string {
  return `re-pointed from ${optionSymbol.trim()} by repair-option-attached-levels on ${isoDate}`;
}

/** Append the provenance line to an existing notes value, idempotently. */
export function appendProvenance(
  existingNotes: string | null,
  provenance: string,
): string {
  const trimmed = (existingNotes ?? "").trim();
  if (!trimmed) return provenance;
  if (trimmed.includes(provenance)) return trimmed;
  return `${trimmed}\n${provenance}`;
}
