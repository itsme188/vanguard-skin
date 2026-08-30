import type Database from "better-sqlite3";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { todayET } from "@/lib/calendar/date-utils";

// ── Types ────────────────────────────────────────────────────────────

export interface PriceFreshness {
  securityId: number;
  symbol: string;
  securityType: string | null;
  latestPriceDate: string | null;
  priceSource: string | null;
  daysStalePrices: number | null;
  priceCount: number;
  hasHoldings: boolean;
}

export interface AccountCoverage {
  accountId: number;
  accountName: string;
  totalHoldings: number;
  pricedHoldings: number;
  coveragePct: number;
  holdingsWithCostBasis: number;
  latestSnapshotDate: string | null;
  latestHoldingsDate: string | null;
}

export interface DataGaps {
  securitiesNoPrices: { id: number; symbol: string; securityType: string | null }[];
  securitiesNoTransactions: { id: number; symbol: string; securityType: string | null }[];
  accountsNoSnapshots: { id: number; name: string }[];
  staleHoldings: { symbol: string; accountName: string; asOfDate: string; daysSince: number }[];
}

export interface CrossSourceDiscrepancy {
  symbol: string;
  date: string;
  sourceA: string;
  priceA: number;
  sourceB: string;
  priceB: number;
  diffPct: number;
}

export interface SnapshotReconciliation {
  accountId: number;
  accountName: string;
  snapshotDate: string;
  snapshotTotal: number;
  computedTotal: number | null;
  difference: number | null;
  diffPct: number | null;
  holdingsCount: number | null;
  pricedCount: number | null;
}

export interface SectorDisagreement {
  symbol: string;
  sector: string | null;
  fund_category: string;
  industry: string | null;
  impliedSector: string; // normalizeSector(X) from "US Sector Equity (X)"
}

export interface DataHealthSummary {
  totalSecurities: number;
  securitiesWithPrices: number;
  securitiesWithoutPrices: number;
  avgStaleDays: number | null;
  maxStaleDays: number | null;
  worstStaleSymbol: string | null;
  overallCoveragePct: number;
  totalGaps: number;
  totalDiscrepancies: number;
  totalReconciliationFlags: number;
}

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Price freshness for each security that has current holdings.
 * Sorted by staleness (most stale first).
 */
export function getPriceFreshness(db: Database.Database): PriceFreshness[] {
  const today = todayET();

  return db
    .prepare(
      `
      SELECT
        s.id AS securityId,
        s.symbol,
        s.security_type AS securityType,
        lp.latest_date AS latestPriceDate,
        lp.source AS priceSource,
        CASE WHEN lp.latest_date IS NOT NULL
          THEN CAST(julianday(?) - julianday(lp.latest_date) AS INTEGER)
          ELSE NULL
        END AS daysStalePrices,
        COALESCE(pc.cnt, 0) AS priceCount,
        CASE WHEN hc.cnt > 0 THEN 1 ELSE 0 END AS hasHoldings
      FROM securities s
      -- Latest price per security
      LEFT JOIN (
        SELECT security_id, MAX(date) AS latest_date, source
        FROM prices
        GROUP BY security_id
      ) lp ON lp.security_id = s.id
      -- Price count
      LEFT JOIN (
        SELECT security_id, COUNT(*) AS cnt FROM prices GROUP BY security_id
      ) pc ON pc.security_id = s.id
      -- Has current holdings — same per-(account, security) definition as
      -- getDataHealthSummary's heldCte, so the Max Stale headline and this
      -- panel can never disagree on the held universe
      LEFT JOIN (
        SELECT h.security_id, COUNT(*) AS cnt
        FROM holdings h
        WHERE ${latestHoldingsPredicate()}
        GROUP BY h.security_id
      ) hc ON hc.security_id = s.id
      WHERE hc.cnt > 0 OR pc.cnt > 0
      ORDER BY
        CASE WHEN hc.cnt > 0 THEN 0 ELSE 1 END,
        daysStalePrices DESC NULLS FIRST
      `,
    )
    .all(today) as PriceFreshness[];
}

/**
 * Per-account coverage: how many holdings are priced, have cost basis, etc.
 *
 * Cost-basis counting uses the COALESCE-to-latest-non-null fallback (the
 * getHoldingsByAccount / getCrossAccountPositions idiom): the Plaid daily
 * sync writes cost_basis NULL on every row, so the newest as_of_date is
 * always all-NULL and a newest-date-only count permanently reported
 * "Cost basis: 0/N" while the Accounts tab rendered real statement values.
 */
export function getAccountCoverage(db: Database.Database): AccountCoverage[] {
  const today = todayET();

  return db
    .prepare(
      `
      SELECT
        a.id AS accountId,
        a.name AS accountName,
        COUNT(DISTINCT h.security_id) AS totalHoldings,
        COUNT(DISTINCT CASE
          WHEN p.latest_date IS NOT NULL
            AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= 7
          THEN h.security_id
        END) AS pricedHoldings,
        CASE WHEN COUNT(DISTINCT h.security_id) > 0
          THEN ROUND(
            100.0 * COUNT(DISTINCT CASE
              WHEN p.latest_date IS NOT NULL
                AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= 7
              THEN h.security_id
            END) / COUNT(DISTINCT h.security_id),
            1
          )
          ELSE 100.0
        END AS coveragePct,
        COUNT(DISTINCT CASE WHEN COALESCE(
          h.cost_basis,
          (SELECT h3.cost_basis FROM holdings h3
            WHERE h3.account_id = h.account_id
              AND h3.security_id = h.security_id
              AND h3.cost_basis IS NOT NULL
            ORDER BY h3.as_of_date DESC LIMIT 1)
        ) IS NOT NULL THEN h.security_id END) AS holdingsWithCostBasis,
        ms.latest_snapshot AS latestSnapshotDate,
        MAX(h.as_of_date) AS latestHoldingsDate
      FROM accounts a
      LEFT JOIN holdings h ON h.account_id = a.id
        AND ${latestHoldingsPredicate()}
      LEFT JOIN (
        SELECT security_id, MAX(date) AS latest_date
        FROM prices GROUP BY security_id
      ) p ON p.security_id = h.security_id
      LEFT JOIN (
        SELECT account_id, MAX(month_end_date) AS latest_snapshot
        FROM monthly_snapshots GROUP BY account_id
      ) ms ON ms.account_id = a.id
      GROUP BY a.id
      ORDER BY a.name
      `,
    )
    .all(today, today) as AccountCoverage[];
}

/**
 * Find data gaps: securities without prices, without transactions,
 * accounts without snapshots, stale holdings.
 */
export function getDataGaps(db: Database.Database): DataGaps {
  const today = todayET();

  // Securities with CURRENT holdings (latest per-(account,security) row,
  // shorts included) but no prices at all. A bare `h.quantity > 0` with no
  // latest-row filter would keep flagging a position sold years ago (its old
  // non-zero rows still match) even after a qty=0 tombstone row supersedes it.
  const securitiesNoPrices = db
    .prepare(
      `
      SELECT DISTINCT s.id, s.symbol, s.security_type AS securityType
      FROM securities s
      JOIN holdings h ON h.security_id = s.id AND ${latestHoldingsPredicate()}
      WHERE NOT EXISTS (SELECT 1 FROM prices p WHERE p.security_id = s.id)
      ORDER BY s.symbol
      `,
    )
    .all() as DataGaps["securitiesNoPrices"];

  // Securities with CURRENT holdings but no transactions (can't compute tax
  // lots). Same latest-row scoping as securitiesNoPrices above — a security
  // that was sold long ago must not resurface here via a stale non-zero row.
  // Excludes cash positions and money market funds (no transactions expected).
  const securitiesNoTransactions = db
    .prepare(
      `
      SELECT DISTINCT s.id, s.symbol, s.security_type AS securityType
      FROM securities s
      JOIN holdings h ON h.security_id = s.id AND ${latestHoldingsPredicate()}
      WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.security_id = s.id)
        AND LOWER(COALESCE(s.security_type, '')) NOT IN ('cash', 'money_market', 'money market')
        AND s.symbol NOT LIKE 'CUSIP:%'
      ORDER BY s.symbol
      `,
    )
    .all() as DataGaps["securitiesNoTransactions"];

  // Accounts with no monthly snapshots
  const accountsNoSnapshots = db
    .prepare(
      `
      SELECT a.id, a.name
      FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM monthly_snapshots ms WHERE ms.account_id = a.id
      )
      ORDER BY a.name
      `,
    )
    .all() as DataGaps["accountsNoSnapshots"];

  // Holdings whose OWN latest row (per (account, security), shorts included —
  // see latestHoldingsPredicate) is >90 days old. A global account-wide
  // MAX(as_of_date) would hide a fund that only gets restated on statement
  // day while other positions in the same account get daily Plaid rows — the
  // fund never equals the account's newest date, so it could never surface
  // here even though it IS the stale position Account Coverage counts.
  const staleHoldings = db
    .prepare(
      `
      SELECT s.symbol, a.name AS accountName,
             h.as_of_date AS asOfDate,
             CAST(julianday(?) - julianday(h.as_of_date) AS INTEGER) AS daysSince
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      JOIN accounts a ON a.id = h.account_id
      WHERE ${latestHoldingsPredicate()}
      AND CAST(julianday(?) - julianday(h.as_of_date) AS INTEGER) > 90
      ORDER BY daysSince DESC
      `,
    )
    .all(today, today) as DataGaps["staleHoldings"];

  return { securitiesNoPrices, securitiesNoTransactions, accountsNoSnapshots, staleHoldings };
}

/**
 * Find prices that differ >2% between sources on the same security+date.
 * Compares all pairs of source records where the same security has multiple
 * prices from different sources on the same date.
 */
export function getCrossSourceDiscrepancies(
  db: Database.Database,
): CrossSourceDiscrepancy[] {
  // Since prices has UNIQUE(security_id, date), there's at most one price per
  // security per date. Cross-source discrepancies happen when we compare the
  // current price source against what a different source would have provided.
  // For now, compare the prices table against the most recent ohlcv_bars close
  // price for the same security on the same date (TWS chart data vs import data).
  // Both stored prices are in the security's NATIVE currency; the UI renders
  // these through <Money> with a $ prefix, so convert here (a KRW row rendered
  // "$919,000.00" for a ~$611 stock — ~1,500x overstated). diffPct is
  // currency-invariant and needs no factor.
  return db
    .prepare(
      `
      SELECT
        s.symbol,
        p.date,
        p.source AS sourceA,
        p.close_price * COALESCE(fx.usd_per_unit, 1) AS priceA,
        'ohlcv' AS sourceB,
        ob.close * COALESCE(fx.usd_per_unit, 1) AS priceB,
        ROUND(ABS(p.close_price - ob.close) / NULLIF(p.close_price, 0) * 100, 2) AS diffPct
      FROM prices p
      JOIN securities s ON s.id = p.security_id
      JOIN ohlcv_bars ob ON ob.security_id = p.security_id AND ob.bar_date = p.date
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE ABS(p.close_price - ob.close) / NULLIF(p.close_price, 0) > 0.02
      ORDER BY diffPct DESC
      LIMIT 50
      `,
    )
    .all() as CrossSourceDiscrepancy[];
}

/**
 * Compare monthly snapshot totals vs daily valuation computed totals.
 * Flags discrepancies >2%.
 */
export function getSnapshotReconciliation(
  db: Database.Database,
): SnapshotReconciliation[] {
  return db
    .prepare(
      `
      SELECT
        ms.account_id AS accountId,
        a.name AS accountName,
        ms.month_end_date AS snapshotDate,
        ms.total_value AS snapshotTotal,
        dv.total_value AS computedTotal,
        CASE WHEN dv.total_value IS NOT NULL
          THEN ROUND(dv.total_value - ms.total_value, 2)
          ELSE NULL
        END AS difference,
        CASE WHEN dv.total_value IS NOT NULL AND ms.total_value != 0
          THEN ROUND((dv.total_value - ms.total_value) / ABS(ms.total_value) * 100, 2)
          ELSE NULL
        END AS diffPct,
        dv.holdings_count AS holdingsCount,
        dv.priced_count AS pricedCount
      FROM monthly_snapshots ms
      JOIN accounts a ON a.id = ms.account_id
      LEFT JOIN daily_valuations dv
        ON dv.account_id = ms.account_id
        AND dv.valuation_date = ms.month_end_date
      ORDER BY ms.month_end_date DESC, a.name
      `,
    )
    .all() as SnapshotReconciliation[];
}

const SECTOR_SHAPE = /^US Sector Equity \((.+)\)$/;

/**
 * fund_category-ONLY implied-sector aliases. `normalizeSector` deliberately
 * demotes "Financial" / "Communications" (see normalize-sector.ts's DEMOTED
 * comment) because a SECURITY tagged with one of those Bloomberg buckets is
 * genuinely ambiguous (spans several GICS sectors). But a fund_category
 * label like "US Sector Equity (Financial)" is a human-written THEME name,
 * not a per-security classification — "Financial" here unambiguously means
 * "Financials", not "could be Real Estate/Financials/whatever". So this
 * panel consults its own alias map first, local to the fund_category
 * context, rather than promoting these back into the global ALIASES (which
 * would re-introduce the ambiguity the demotion exists to prevent). Keys are
 * lowercase to match how fund_category labels are written/compared
 * elsewhere in this module.
 */
const FUND_CATEGORY_SECTOR_ALIASES: Record<string, string> = {
  "financial": "Financials",
  "communications": "Communication Services",
};

function impliedSectorFromFundCategoryLabel(raw: string): string | null {
  const alias = FUND_CATEGORY_SECTOR_ALIASES[raw.trim().toLowerCase()];
  if (alias) return alias;
  return normalizeSector(raw);
}

/**
 * Stocks whose GICS `sector` tag disagrees with the sector implied by their
 * `fund_category` ("US Sector Equity (X)" shape) and have NOT been verified
 * by the sweep (`scripts/verify-sector-tags.ts`). Verified rows are legit
 * divergences (e.g. GOOG: GICS Communication Services vs a Technology fund
 * category) and stay suppressed via `sector_verified_at`.
 */
export function getSectorDisagreements(db: Database.Database): SectorDisagreement[] {
  const rows = db
    .prepare(
      `SELECT symbol, sector, fund_category, industry
       FROM securities
       WHERE LOWER(security_type) IN ('stock','common stock')
         AND fund_category LIKE 'US Sector Equity (%'
         AND sector_verified_at IS NULL
       ORDER BY symbol`
    )
    .all() as { symbol: string; sector: string | null; fund_category: string; industry: string | null }[];
  const out: SectorDisagreement[] = [];
  for (const r of rows) {
    const m = SECTOR_SHAPE.exec(r.fund_category);
    if (!m) continue;
    const implied = impliedSectorFromFundCategoryLabel(m[1]);
    if (!implied) continue;             // "Semiconductors" etc — finer than GICS, not a disagreement
    if (r.sector === implied) continue; // agrees
    out.push({ ...r, impliedSector: implied });
  }
  return out;
}

/**
 * Aggregate summary of data health for the dashboard header.
 *
 * Universe = CURRENTLY-held securities (latest per-(account,security) row,
 * shorts included) and "priced" = a price row within the last 7 days — the
 * same semantics as getAccountCoverage below, so the headline KPI can never
 * contradict the page's own detail panels. Any-date holdings + any-age
 * prices previously pinned the headline near 100% while three current
 * holdings carried month-old prices.
 */
export function getDataHealthSummary(
  db: Database.Database,
): DataHealthSummary {
  const today = todayET();

  const heldCte = `held AS (
        SELECT DISTINCT h.security_id FROM holdings h
        WHERE ${latestHoldingsPredicate()}
      )`;

  const secCounts = db
    .prepare(
      `
      WITH ${heldCte}
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN EXISTS (
          SELECT 1 FROM prices p
          WHERE p.security_id = held.security_id
            AND CAST(julianday(?) - julianday(p.date) AS INTEGER) <= 7
        ) THEN 1 END) AS withPrices
      FROM held
      `,
    )
    .get(today) as { total: number; withPrices: number };

  const staleness = db
    .prepare(
      `
      WITH ${heldCte},
      per_sec AS (
        SELECT p.security_id,
               CAST(julianday(?) - julianday(MAX(p.date)) AS INTEGER) AS days_stale
        FROM prices p
        JOIN held ON held.security_id = p.security_id
        GROUP BY p.security_id
      )
      SELECT
        AVG(days_stale) AS avgDays,
        MAX(days_stale) AS maxDays,
        (SELECT s2.symbol FROM securities s2
         JOIN per_sec p2 ON p2.security_id = s2.id
         ORDER BY p2.days_stale DESC LIMIT 1
        ) AS worstSymbol
      FROM per_sec
      `,
    )
    .get(today) as {
      avgDays: number | null;
      maxDays: number | null;
      worstSymbol: string | null;
    };

  const gaps = getDataGaps(db);
  const totalGaps =
    gaps.securitiesNoPrices.length +
    gaps.securitiesNoTransactions.length +
    gaps.accountsNoSnapshots.length +
    gaps.staleHoldings.length;

  const discrepancies = getCrossSourceDiscrepancies(db);

  const reconciliation = getSnapshotReconciliation(db);
  const reconFlags = reconciliation.filter(
    (r) => r.diffPct !== null && Math.abs(r.diffPct) > 2,
  ).length;

  return {
    totalSecurities: secCounts.total,
    securitiesWithPrices: secCounts.withPrices,
    securitiesWithoutPrices: secCounts.total - secCounts.withPrices,
    avgStaleDays: staleness.avgDays !== null ? Math.round(staleness.avgDays) : null,
    maxStaleDays: staleness.maxDays,
    worstStaleSymbol: staleness.worstSymbol,
    overallCoveragePct:
      secCounts.total > 0
        ? Math.round((secCounts.withPrices / secCounts.total) * 100)
        : 100,
    totalGaps,
    totalDiscrepancies: discrepancies.length,
    totalReconciliationFlags: reconFlags,
  };
}
