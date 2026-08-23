import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

/**
 * Shared type-identity contradiction detection — single source of truth for
 * "does this security's stored/incoming security_type contradict other
 * evidence?" (2026-08-21/23 audits: a statement transcription put a
 * name-fragment in the symbol column, colliding with a held equity ticker;
 * the incoming Bond type + Treasury name + derived maturity stamped bond
 * identity onto the equity row, sending a live position through the bond
 * ÷100 valuation path.)
 *
 * Two tiers, because the two callers see different data (Codex plan review
 * #8):
 *
 *  - `isBondlikeIdentityOnEquityFills` — candidate-level. `upsertSecurity`
 *    calls this BEFORE any row exists for the incoming write: it only has
 *    the PROPOSED identity (securityType/name/derivedMaturity) plus a fill
 *    count for the target row. Threshold is aggressive (1 fill refuses)
 *    because a genuine bond/fund is never CUSIP-typed onto a ticker with
 *    real equity trading history — see `lib/mutations/securities.ts`'s
 *    guard doc for the full story.
 *
 *  - `scanTypeContradictions` — DB-wide audit.
 *    `scripts/repair-security-type-corruption.ts`'s manual review scan: an
 *    OR-union of two predicates (fill-count dominance, equity-shaped
 *    fund_category metadata) preserved EXACTLY from the pre-extraction
 *    detector (see `tests/compute/type-contradictions.test.ts`'s pin tests)
 *    so the script's existing review output never drifts. Extended here
 *    with `held` (does this security currently sit in ANY account's latest
 *    holdings?) for `lib/queries/integrity-checks.ts`'s severity split — a
 *    held contradiction is critical (a live position is being mispriced
 *    through the wrong valuation convention right now); an unheld one is a
 *    warning (historical data quality, nothing currently mispriced).
 */

export interface TypeIdentityCandidate {
  securityType: string | null;
  name: string | null;
  derivedMaturity: string | null;
}

const BONDLIKE_TYPES = new Set(["bond", "mutual fund", "mutual_fund"]);

/**
 * Would this incoming identity contradict a target row that already has
 * `equityFillCount` real trade fills? Threshold = 1 fill — refuse new
 * writes aggressively rather than try to reason about "how many is too
 * many" (that judgment call belongs to the DB-wide audit's >10 floor, which
 * reviews ALREADY-LANDED data, not a proposed write).
 */
export function isBondlikeIdentityOnEquityFills(
  candidate: TypeIdentityCandidate,
  equityFillCount: number
): boolean {
  const type = (candidate.securityType ?? "").toLowerCase();
  return BONDLIKE_TYPES.has(type) && equityFillCount > 0;
}

// ─── DB-wide audit scan ──────────────────────────────────────────────
//
// PREDICATE_1_SQL / PREDICATE_2_SQL and the OR-union merge below are
// extracted VERBATIM from scripts/repair-security-type-corruption.ts's
// pre-existing detector — do not "simplify" the shape without re-reading
// tests/compute/type-contradictions.test.ts's pin tests first, including
// the quirk where a predicate-2-only hit reports equityFills=0 (predicate 2
// never computes a real fill count; only predicate 1 does, and the merge
// never backfills it).

const PREDICATE_1_SQL = `
  -- Predicate 1: bond/fund-typed securities whose ledger is dominated by equity fills
  -- (floor >10: genuine mutual funds legitimately show some fills; the audit's corrupted
  -- row sat far above every real fund).
  SELECT s.id, s.symbol, s.security_type,
         SUM(CASE WHEN UPPER(t.type) IN ('BUY','SELL','SHORT_SELL','BUY_TO_COVER')
                   AND t.quantity IS NOT NULL AND t.quantity <> 0 THEN 1 ELSE 0 END) AS equity_fills,
         s.fund_category
    FROM securities s JOIN transactions t ON t.security_id = s.id
   WHERE LOWER(COALESCE(s.security_type,'')) IN ('bond','mutual fund','mutual_fund')
   GROUP BY s.id
  HAVING equity_fills > 10
`;

const PREDICATE_2_SQL = `
  -- Predicate 2: equity-shaped classification metadata contradicting a bond/fund type.
  -- Bond/mutual-fund types ONLY — never 'etf' (sector ETFs legitimately carry
  -- "US Sector Equity%" fund categories; an ETF-typed contradiction needs
  -- contract-details stockType evidence, which is TWS territory, not this detector).
  SELECT id, symbol, security_type, 0 AS equity_fills, fund_category
    FROM securities
   WHERE fund_category LIKE 'US Sector Equity%'
     AND LOWER(COALESCE(security_type,'')) IN ('bond','mutual fund','mutual_fund')
`;

interface RawContradictionRow {
  id: number;
  symbol: string;
  security_type: string | null;
  equity_fills: number;
  fund_category: string | null;
}

interface MergedContradiction {
  id: number;
  symbol: string;
  securityType: string;
  equityFills: number;
}

/**
 * The OR-union merge itself — keyed by security id, predicate 1 wins the
 * equityFills value on overlap (predicate 2 never overwrites an existing
 * entry). `excludeIds` is applied to BOTH predicates before merging, same
 * as the pre-extraction detector.
 */
function mergeContradictionPredicates(
  db: Database.Database,
  excludeIds: number[]
): MergedContradiction[] {
  const excludeSet = new Set(excludeIds);
  const byId = new Map<number, MergedContradiction>();

  const predicate1 = db.prepare(PREDICATE_1_SQL).all() as RawContradictionRow[];
  for (const row of predicate1) {
    if (excludeSet.has(row.id)) continue;
    byId.set(row.id, {
      id: row.id,
      symbol: row.symbol,
      securityType: row.security_type ?? "",
      equityFills: row.equity_fills,
    });
  }

  const predicate2 = db.prepare(PREDICATE_2_SQL).all() as RawContradictionRow[];
  for (const row of predicate2) {
    if (excludeSet.has(row.id)) continue;
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id,
        symbol: row.symbol,
        securityType: row.security_type ?? "",
        equityFills: row.equity_fills,
      });
    }
  }

  return Array.from(byId.values());
}

/**
 * DB-wide audit scan: existing rows, repair-script semantics preserved
 * exactly (see mergeContradictionPredicates), extended with `held` — true
 * when the security appears in ANY account's latest holdings
 * (latestHoldingsPredicate, quantity != 0).
 */
export function scanTypeContradictions(
  db: Database.Database,
  opts: { excludeIds?: number[] } = {}
): Array<{
  securityId: number;
  symbol: string;
  securityType: string;
  equityFills: number;
  held: boolean;
}> {
  const merged = mergeContradictionPredicates(db, opts.excludeIds ?? []);
  if (merged.length === 0) return [];

  const ids = merged.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const heldRows = db
    .prepare(
      `SELECT DISTINCT h.security_id FROM holdings h
        WHERE h.security_id IN (${placeholders})
          AND ${latestHoldingsPredicate({ keyBy: "account_security" })}`
    )
    .all(...ids) as { security_id: number }[];
  const heldSet = new Set(heldRows.map((r) => r.security_id));

  return merged.map((r) => ({
    securityId: r.id,
    symbol: r.symbol,
    securityType: r.securityType,
    equityFills: r.equityFills,
    held: heldSet.has(r.id),
  }));
}
