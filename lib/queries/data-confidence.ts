/**
 * Data confidence scoring — 5-dimension assessment of portfolio data reliability.
 *
 * Designed to be lightweight enough for header polling (every 60s).
 * Uses focused queries instead of the heavier data-health.ts functions.
 */

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";
import { todayET } from "@/lib/calendar/date-utils";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { classifyHoldingSourceKey } from "@/lib/db/holding-sources";
import { runIntegrityChecks, sortWorstFirst } from "@/lib/queries/integrity-checks";
import { formatUSD, rendersAsZero } from "@/lib/format";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import {
  computeCashFlowResiduals,
  isUnexplainedCashFlow,
  isLikelyIbkrAccountName,
  collectSeamDatesByAccount,
  collectLiveAnchorDatesByAccount,
  CONFIDENCE_RESIDUAL_ABS_FLOOR,
  CONFIDENCE_RESIDUAL_REL_FLOOR,
  type CashFlowClassification,
} from "@/lib/compute/cash-flow-audit";

// ── Types ────────────────────────────────────────────────────────────

/** One run of popover copy. A plain string is generic wording that stays
 *  readable under Hide amounts; `{ private }` is a run taken from the
 *  portfolio (a held-security count, a ticker list, a dollar amount) that
 *  the popover masks. Account names and dates are public, as they are on
 *  Data Health. Where singular/plural wording would give a count away, the
 *  words that change sit inside the private run. */
export type CopyPart = string | { private: string };

/** The plain string for a list of runs — every `*Parts` field flattens to
 *  exactly its plain-string twin. */
export function copyText(parts: CopyPart[]): string {
  return parts.map(p => (typeof p === "string" ? p : p.private)).join("");
}

const priv = (value: string | number): CopyPart => ({ private: String(value) });

export interface DimensionScore {
  score: number; // 0-100
  detail: string; // human-readable summary
  /** `detail` as public/private runs. Absent → the popover masks the whole string. */
  detailParts?: CopyPart[];
  whyMatters: string; // static per-dimension explanation
  guidance: string; // conditional on score — reassurance when high, action when low
  /** `guidance` as public/private runs (see `detailParts`). */
  guidanceParts?: CopyPart[];
  /** Whether `guidance` names something to do (true) vs pure reassurance
   *  (false) — the SAME predicate that chose the guidance text above, never
   *  a re-derivation from `score`. Drives the popover's guidance text color
   *  (DataConfidenceIndicator) so a high score with a real named gap (e.g.
   *  39/40 = 98%, "1 of 40 ... has no recent price") can't render in the
   *  muted "nothing to do" color
   *  (qa:header-dataconfidence--guidance-contradicts-detail-and-actions). */
  guidanceActionable: boolean;
}

export interface PriceFreshnessScore extends DimensionScore {
  pricedToday: number;
  /** Held securities priced within RECENT_PRICE_WINDOW_DAYS — the SAME basis
   *  the dimension detail line and score use. The stale-prices action in
   *  deriveActions must compute its count as totalHeld - pricedRecent (not
   *  totalHeld - pricedToday) so it can never disagree with the detail line
   *  over the same population (qa:header-dataconfidence--prices-detail-
   *  fresh-count-disagrees-with-actions-stale-count). */
  pricedRecent: number;
  totalHeld: number;
  stalestSymbol: string | null;
  stalestDays: number | null;
}

export interface HoldingsRecencyScore extends DimensionScore {
  /** Share (0-1) of the book's weight sitting in positions more than a day
   *  old: the figure the guidance line quotes. Weights are the same ones the
   *  score averages over (see scoreHoldingsRecency). Null when nothing held
   *  can be valued, so there is no weight to take a share of. Portfolio-
   *  derived: render it masked. */
  staleValueShare: number | null;
  perAccount: {
    name: string;
    /** The STALEST held position's as_of_date, NOT the account's most recent
     *  import. Display and actions read it; the score is the value-weighted
     *  average over every position (owner ruling 2026-10-08), so one small
     *  carried row no longer sets it. */
    date: string | null;
    source: string | null;
    daysOld: number | null;
    /** The stalest position's symbol, so the drawer/guidance can name
     *  exactly what to refresh instead of just an age. */
    stalestSymbol: string | null;
    /** The account's LATEST held-position as_of_date (via
     *  latestHoldingsPredicate, keyBy:"account") — shown alongside `date` so
     *  this drawer can never contradict Data Health's "Last holdings"
     *  figure (qa:header-dataconfidence--holdings-date-is-oldest-position-
     *  not-latest). */
    latestDate: string | null;
    /** Held positions in this account. */
    heldCount: number;
    /** Positions more than a day old, oldest first — what the stale-holdings
     *  action names, so it never calls a whole account N days old over a
     *  few carried rows (qa:header-dataconfidence--actions-row-claims-
     *  account-121d-old-for-2-of-134-positions-regression-2). Display only:
     *  every stale row is listed whatever its size. */
    stalePositions: { symbol: string; date: string }[];
  }[];
}

/** A suppressed `live-anchor-residual` point that would otherwise have
 *  crossed the confidence floors — reported as a label, never as a cap (see
 *  findWorstUnexplainedCashFlow and CashAccuracyScore.timingResidual). */
export interface TimingResidualNote {
  date: string;
  accountName: string;
  amount: number;
}

export interface CashAccuracyScore extends DimensionScore {
  latestAnchorDate: string | null;
  daysSinceAnchor: number | null;
  /** Set when computeCashFlowResiduals finds cash_balance jumping between
   *  two daily_valuations rows with no matching transaction to explain it
   *  (see lib/compute/cash-flow-audit.ts). `classification` distinguishes
   *  an `external-flow-candidate` (total_value itself moved — a real fake
   *  return day, until repaired via scripts/repair-missing-external-flows.ts)
   *  from an `internal-shift` (total_value moved smoothly; only the
   *  cash/holdings split jumped — a valuation-source misattribution, not a
   *  missing flow, and NOT something the repair script will insert a row
   *  for). `source-seam` and `live-anchor-residual` points are excluded
   *  from this field entirely (see `timingResidual` for the latter). Null
   *  when no qualifying point is found. */
  unexplainedFlow: {
    accountName: string;
    date: string;
    residual: number;
    classification: CashFlowClassification;
  } | null;
  /** The worst suppressed `live-anchor-residual` point that would otherwise
   *  have crossed the confidence floors — a live-snapshot (Plaid/TWS) day
   *  whose cash_balance is an intraday-total-minus-close-priced-holdings
   *  plug, not literal cash. Labeled, not capped: see the warning
   *  application in scoreCashAccuracy. Null when none qualifies (including
   *  when a `source-seam` point already claimed the same date — source-seam
   *  points are always fully silent). */
  timingResidual: TimingResidualNote | null;
}

export interface EnrichmentScore extends DimensionScore {
  enriched: number;
  total: number;
  missing: string[]; // symbols
}

export interface ValuationCoverageScore extends DimensionScore {
  pricedCount: number;
  totalCount: number;
  /** Each currently-held account's latest daily_valuations date (null if
   *  that account has no daily_valuations row at all) — a later integrity
   *  check cross-references this against holdings as_of_date. */
  perAccountAsOf: Array<{ accountName: string; asOfDate: string | null }>;
}

export interface DataAction {
  severity: "critical" | "warning" | "info";
  message: string;
  /** `message` as public/private runs (see DimensionScore.detailParts). */
  messageParts?: CopyPart[];
  fix: string;
  /** `fix` as public/private runs. */
  fixParts?: CopyPart[];
  autoFixable: boolean;
  apiEndpoint?: string;
  apiBody?: Record<string, unknown>;
}

export interface DataConfidence {
  overallScore: number; // 0-100
  overallLevel: "high" | "medium" | "low" | "stale" | "unverified";
  priceFreshness: PriceFreshnessScore;
  holdingsRecency: HoldingsRecencyScore;
  cashAccuracy: CashAccuracyScore;
  enrichmentCompleteness: EnrichmentScore;
  valuationCoverage: ValuationCoverageScore;
  actions: DataAction[];
  /** Cross-cutting number-trust scan (runIntegrityChecks) — independent of
   *  the 5 weighted dimensions above. A critical hit caps overallScore/Level
   *  (see capReason); warnings never cap, they're informational only. */
  integrity: ReturnType<typeof runIntegrityChecks>;
  /** Set to the first critical integrity hit's reason when the cap applied;
   *  null when no critical hit exists. Never set from a warning. Order is
   *  module order across checks (type-identity, cash-residual, lot-drift)
   *  and worst-first WITHIN the lot-drift check, so among drift hits the
   *  cap line names the largest drift, not the lowest (account, security)
   *  key. */
  capReason: string | null;
  /** How many critical hits are position-to-tax-lot drift. Above zero, the
   *  popover offers the Tax Lots route (it used to offer it only while the
   *  scan had NOT run). Display only — the cap itself is unchanged. */
  lotDriftCriticalCount: number;
}

// ── Dimension weights ────────────────────────────────────────────────

const WEIGHTS = {
  priceFreshness: 0.4,
  holdingsRecency: 0.25,
  cashAccuracy: 0.15,
  enrichment: 0.1,
  valuationCoverage: 0.1,
} as const;

// ── Scoring functions ────────────────────────────────────────────────

/** "Recent" price window (days). PRICE_FRESHNESS_DAYS is the ONE window for the
 *  confidence chip AND the Data Health Price Coverage card/account rows
 *  (lib/queries/data-health.ts imports it). 3 calendar days keeps a Friday
 *  close fresh on Monday. Shared by the SQL query, the Prices
 *  dimension detail/score, and the stale-prices action message so all three
 *  can never disagree about what counts as stale (qa:header-dataconfidence--
 *  prices-detail-fresh-count-disagrees-with-actions-stale-count: the action
 *  used to report totalHeld - pricedToday, a 1-day threshold, while the
 *  detail/score used pricedRecent, a 3-day threshold, over the SAME
 *  population). */
export const PRICE_FRESHNESS_DAYS = 3;
const RECENT_PRICE_WINDOW_DAYS = PRICE_FRESHNESS_DAYS;

function scorePriceFreshness(db: Database.Database, now: Date = new Date()): PriceFreshnessScore {
  const today = todayET(now);

  // Count held securities with prices from today (or last trading day = within RECENT_PRICE_WINDOW_DAYS)
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT h.security_id) AS totalHeld,
      COUNT(DISTINCT CASE
        WHEN p.latest_date IS NOT NULL
          AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= 1
        THEN h.security_id
      END) AS pricedToday,
      COUNT(DISTINCT CASE
        WHEN p.latest_date IS NOT NULL
          AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= ${RECENT_PRICE_WINDOW_DAYS}
        THEN h.security_id
      END) AS pricedRecent
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN (
      SELECT security_id, MAX(date) AS latest_date
      FROM prices GROUP BY security_id
    ) p ON p.security_id = h.security_id
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
      AND ${liveOptionExpirationSql("s", today)}
  `).get(today, today) as { totalHeld: number; pricedToday: number; pricedRecent: number };

  // Find stalest currently-held security. A LEFT JOIN onto a pre-aggregated
  // latest-price-per-security subquery (not a bare JOIN prices, which
  // row-multiplies and can silently pick an old price) so a held security
  // with NO price rows at all still surfaces — and wins "stalest" first,
  // since missing data is worse than old data. When there's no price row,
  // the fallback age is the holding's own as_of_date (how old our knowledge
  // of the position itself is), and the symbol is prefixed "no price rows"
  // so the caller can distinguish "stale price" from "never priced."
  const stalest = db.prepare(`
    SELECT s.symbol,
           p.latest_date,
           CAST(julianday(?) - julianday(COALESCE(p.latest_date, agg.latest_as_of)) AS INTEGER) AS days_stale
    FROM securities s
    JOIN (
      SELECT h.security_id, MAX(h.as_of_date) AS latest_as_of
      FROM holdings h
      JOIN securities s2 ON s2.id = h.security_id
      WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
        AND ${liveOptionExpirationSql("s2", today)}
      GROUP BY h.security_id
    ) agg ON agg.security_id = s.id
    LEFT JOIN (
      SELECT security_id, MAX(date) AS latest_date
      FROM prices GROUP BY security_id
    ) p ON p.security_id = s.id
    ORDER BY (p.latest_date IS NULL) DESC, days_stale DESC
    LIMIT 1
  `).get(today) as { symbol: string; latest_date: string | null; days_stale: number } | undefined;

  const { totalHeld, pricedToday, pricedRecent } = row;
  const whyMatters =
    "Stale prices mean today's valuations, P&L, and change numbers are based on yesterday's market.";

  if (totalHeld === 0) {
    return {
      score: 100,
      detail: "No holdings to price",
      detailParts: ["No holdings to price"],
      whyMatters,
      guidance: "Import holdings to get started.",
      guidanceParts: ["Import holdings to get started."],
      guidanceActionable: false,
      pricedToday: 0,
      pricedRecent: 0,
      totalHeld: 0,
      stalestSymbol: null,
      stalestDays: null,
    };
  }

  // Score: 100 if all priced today, scale down by how many are stale
  const freshPct = pricedRecent / totalHeld;
  const score = Math.round(freshPct * 100);

  const detailParts: CopyPart[] = pricedToday === totalHeld
    ? ["All ", priv(totalHeld), " securities priced today"]
    : pricedRecent === totalHeld
      ? ["All ", priv(totalHeld), ` securities priced within ${RECENT_PRICE_WINDOW_DAYS} days`]
      : [priv(`${pricedRecent}/${totalHeld}`), " securities have recent prices"];
  const detail = copyText(detailParts);

  // Guidance is derived from pricedRecent/totalHeld — the SAME counts the
  // detail line above uses — never from the score alone
  // (qa:header-dataconfidence--guidance-contradicts-detail-and-actions). A
  // score like 98 can still mean "1 of 40 stale"; the reassurance sentence
  // may only appear when the count says nothing is missing.
  const staleCount = totalHeld - pricedRecent;
  const guidanceParts: CopyPart[] =
    pricedRecent === totalHeld
      ? ["Prices are fresh — nothing to do."]
      : score >= 50
        ? [
            priv(`${staleCount} of ${totalHeld} held securities ${staleCount === 1 ? "has" : "have"}`),
            " no recent price — run Quick Refresh, or connect TWS for live quotes.",
          ]
        : ["Open TWS and run Quick Refresh — many holdings have stale prices."];
  const guidance = copyText(guidanceParts);

  return {
    score,
    detail,
    detailParts,
    whyMatters,
    guidance,
    guidanceParts,
    // Same predicate the guidance ternary above branches on: actionable
    // whenever pricedRecent < totalHeld, regardless of the score bucket.
    guidanceActionable: pricedRecent !== totalHeld,
    pricedToday,
    pricedRecent,
    totalHeld,
    stalestSymbol: stalest
      ? stalest.latest_date === null
        ? `no price rows: ${stalest.symbol}`
        : stalest.symbol
      : null,
    stalestDays: stalest?.days_stale ?? null,
  };
}

/** Age bucket score for one position (days since its as_of_date). */
function holdingAgeBucketScore(daysOld: number): number {
  if (daysOld <= 1) return 100;
  if (daysOld <= 7) return 80;
  if (daysOld <= 30) return 50;
  if (daysOld <= 90) return 20;
  return 0;
}

/** A position with neither a price nor a cost basis counts as fully stale at
 *  this share of the valued total each ... */
const UNVALUED_HOLDING_WEIGHT_SHARE = 0.01;
/** ... and all such positions together never weigh more than this share of
 *  the valued total (owner ruling 2026-10-08). */
const UNVALUED_HOLDINGS_WEIGHT_CAP = 0.1;

/** A share of book value as a whole percent. A share that is above zero but
 *  rounds to 0 reads "<1%", and one short of everything reads ">99%", so the
 *  line never claims "0%" or "100%" when that is not so. */
function formatValueShare(share: number): string {
  const pct = Math.round(share * 100);
  if (pct === 0 && share > 0) return "<1%";
  if (pct === 100 && share < 1) return ">99%";
  return `${pct}%`;
}

function scoreHoldingsRecency(db: Database.Database, now: Date = new Date()): HoldingsRecencyScore {
  const today = todayET(now);

  const accounts = db.prepare(`SELECT id, name FROM accounts ORDER BY name`).all() as {
    id: number;
    name: string;
  }[];

  // Per-(account, security) latest rows — NOT a single per-account
  // MAX(as_of_date). An account can be "read today" for one live TWS row
  // while a carried statement position is 60 days old; the account's
  // reported staleness must reflect the WORST (oldest) currently-held
  // position, not the freshest, or a single intraday sync would silently
  // mask a stale carried position. Ordered oldest-first per account so a
  // tie between two equally-stale positions deterministically keeps the
  // first row encountered.
  //
  // Each row also carries what the score weighs it by: its market value in
  // USD at the latest stored price (the app's own adjusted-value expression:
  // bonds /100, options x multiplier, FX at read time) and its cost basis in
  // USD for a row with no price.
  const holdingRows = db.prepare(`
    SELECT h.account_id, h.as_of_date, h.source_key, s.symbol,
           lp.close_price AS close_price,
           ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS market_value_usd,
           h.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis_usd
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN (
      SELECT p.security_id, p.close_price
      FROM prices p
      JOIN (
        SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id
      ) pm ON pm.security_id = p.security_id AND pm.max_date = p.date
    ) lp ON lp.security_id = h.security_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
      AND ${liveOptionExpirationSql("s", today)}
    ORDER BY h.account_id, h.as_of_date ASC
  `).all() as {
    account_id: number;
    as_of_date: string;
    source_key: string | null;
    symbol: string;
    close_price: number | null;
    market_value_usd: number | null;
    cost_basis_usd: number | null;
  }[];

  const worstByAccount = new Map<
    number,
    { as_of_date: string; source_key: string | null; symbol: string }
  >();
  // Per account: how many positions are held, and which are more than a day
  // old (rows arrive oldest-first). Feeds the stale-holdings action only.
  const heldCountByAccount = new Map<number, number>();
  const staleByAccount = new Map<number, { symbol: string; date: string }[]>();
  for (const r of holdingRows) {
    heldCountByAccount.set(r.account_id, (heldCountByAccount.get(r.account_id) ?? 0) + 1);
    if (Math.round((Date.parse(today) - Date.parse(r.as_of_date)) / 86_400_000) > 1) {
      const list = staleByAccount.get(r.account_id) ?? [];
      list.push({ symbol: r.symbol, date: r.as_of_date });
      staleByAccount.set(r.account_id, list);
    }
  }
  for (const r of holdingRows) {
    if (!worstByAccount.has(r.account_id)) {
      worstByAccount.set(r.account_id, {
        as_of_date: r.as_of_date,
        source_key: r.source_key,
        symbol: r.symbol,
      });
    }
  }

  // The account's LATEST (freshest) held-position as_of_date — via the same
  // shared predicate (keyBy:"account" = per-account max, never a hand-rolled
  // global MAX(as_of_date)) — so the drawer can quote a "latest" figure that
  // agrees with Data Health's "Last holdings <date>" instead of only ever
  // showing the stalest position's date under the account name.
  const latestRows = db.prepare(`
    SELECT h.account_id, MAX(h.as_of_date) AS latest_date
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    WHERE ${latestHoldingsPredicate({ keyBy: "account", includeShorts: true })}
      AND ${liveOptionExpirationSql("s", today)}
    GROUP BY h.account_id
  `).all() as { account_id: number; latest_date: string }[];
  const latestByAccount = new Map(latestRows.map(r => [r.account_id, r.latest_date]));

  const perAccount = accounts.map(a => {
    const worst = worstByAccount.get(a.id);
    const daysOld = worst
      ? Math.round((Date.parse(today) - Date.parse(worst.as_of_date)) / 86_400_000)
      : null;
    return {
      name: a.name,
      date: worst?.as_of_date ?? null,
      source: worst ? classifyHoldingSourceKey(worst.source_key) : null,
      daysOld,
      stalestSymbol: worst?.symbol ?? null,
      latestDate: latestByAccount.get(a.id) ?? null,
      heldCount: heldCountByAccount.get(a.id) ?? 0,
      stalePositions: staleByAccount.get(a.id) ?? [],
    };
  });

  const whyMatters =
    "Old holdings mean positions may not reflect recent trades, corporate actions, or dividends.";

  if (perAccount.length === 0) {
    return {
      score: 100,
      detail: "No accounts",
      detailParts: ["No accounts"],
      whyMatters,
      guidance: "Add an account to get started.",
      guidanceParts: ["Add an account to get started."],
      guidanceActionable: false,
      staleValueShare: null,
      perAccount: [],
    };
  }

  // Score: the VALUE-WEIGHTED average of each position's age bucket (owner
  // ruling 2026-10-08; it used to be the single stalest position's bucket,
  // so one small carried row set the whole score). A large stale position
  // still pulls the score down in proportion to its size.
  //   weight = |market value in USD|            when the row has a price
  //          = |cost basis in USD|              when it has no price
  //          = 1% of the valued total, bucket 0 when it has neither (all such
  //            rows together capped at 10% of the valued total)
  // A stored price of zero or less is treated as no price. An account with
  // no holdings contributes no row, so it does not affect the score.
  let valuedWeight = 0;
  let valuedScoreSum = 0;
  let staleValuedWeight = 0;
  let unvaluedCount = 0;
  let unvaluedStaleCount = 0;
  let oldestRowDays: number | null = null;
  for (const r of holdingRows) {
    const daysOld = Math.round((Date.parse(today) - Date.parse(r.as_of_date)) / 86_400_000);
    if (oldestRowDays === null || daysOld > oldestRowDays) oldestRowDays = daysOld;
    const marketValue =
      r.close_price !== null && r.close_price > 0 && r.market_value_usd !== null
        ? Math.abs(r.market_value_usd)
        : 0;
    const costBasis = r.cost_basis_usd !== null ? Math.abs(r.cost_basis_usd) : 0;
    const weight =
      Number.isFinite(marketValue) && marketValue > 0
        ? marketValue
        : Number.isFinite(costBasis) && costBasis > 0
          ? costBasis
          : 0;
    if (weight > 0) {
      valuedWeight += weight;
      valuedScoreSum += weight * holdingAgeBucketScore(daysOld);
      if (daysOld > 1) staleValuedWeight += weight;
    } else {
      unvaluedCount++;
      if (daysOld > 1) unvaluedStaleCount++;
    }
  }

  // The age the wording and the fallback read: the oldest held row. With no
  // holdings anywhere it keeps the old 999-day sentinel (score 0, "weeks+
  // old" guidance) — the owner kept that case as it was.
  const worstDays = oldestRowDays ?? 999;

  let score: number;
  let staleValueShare: number | null;
  if (valuedWeight > 0) {
    const unvaluedShare = Math.min(
      unvaluedCount * UNVALUED_HOLDING_WEIGHT_SHARE,
      UNVALUED_HOLDINGS_WEIGHT_CAP
    );
    const unvaluedWeight = valuedWeight * unvaluedShare;
    const totalWeight = valuedWeight + unvaluedWeight;
    // Unvalued rows add weight at bucket 0, so they only enlarge the divisor.
    score = Math.round(valuedScoreSum / totalWeight);
    // The share the guidance quotes is by AGE (more than a day old), the same
    // bar as stalePositions; an unvalued row counts at its small fixed weight.
    const staleUnvaluedWeight =
      unvaluedCount > 0 ? unvaluedWeight * (unvaluedStaleCount / unvaluedCount) : 0;
    staleValueShare = (staleValuedWeight + staleUnvaluedWeight) / totalWeight;
  } else {
    // Nothing held can be valued (or nothing is held): there are no weights
    // to average, so the stalest row's bucket stands, as before.
    score = holdingAgeBucketScore(worstDays);
    staleValueShare = null;
  }

  // "<account>: latest: <date> · stalest position: SYM <date>" — both dates
  // named and labeled so this line can never read as contradicting Data
  // Health's own "Last holdings <date>" (which quotes the LATEST date, not
  // the stalest position this line also names).
  const detailParts: CopyPart[] = [];
  for (const a of perAccount.filter(acct => acct.date)) {
    // Always the literal ET date — a relative word ("today") goes stale
    // inside a cached popover.
    const stalestDateLabel = a.date;
    if (detailParts.length > 0) detailParts.push(", ");
    detailParts.push(`${a.name}: latest: ${a.latestDate ?? "—"} · stalest position: `);
    if (a.stalestSymbol) detailParts.push(priv(a.stalestSymbol), ` ${stalestDateLabel}`);
    else detailParts.push(`${stalestDateLabel}`);
  }
  if (detailParts.length === 0) detailParts.push("No holdings imported");
  const detail = copyText(detailParts);

  // Names the specific stalest position so the prescribed action is
  // actionable ("refresh X"), not just a generic "import a statement".
  const worstAccount = perAccount.reduce<(typeof perAccount)[number] | null>(
    (worst, a) => ((a.daysOld ?? -1) > (worst?.daysOld ?? -1) ? a : worst),
    null
  );
  const worstPositionLabel: CopyPart[] = worstAccount?.stalestSymbol
    ? [priv(worstAccount.stalestSymbol), ` in ${worstAccount.name}`]
    : [worstAccount?.name ?? "the affected account"];

  // Guidance is derived from the SAME rows and weights the score averages —
  // never from the score alone
  // (qa:header-dataconfidence--guidance-contradicts-detail-and-actions).
  // "Current across accounts" appears only when EVERY held row is a day old
  // or less. Otherwise the line names the share of book value sitting in
  // positions more than a day old (a private run: it is portfolio-derived)
  // and the stalest position to refresh. A value-weighted score can round to
  // 100 with a small old row still held, so the wording keys on the rows.
  const refreshTail: CopyPart[] =
    score >= 50
      ? ["refresh ", ...worstPositionLabel, " — import the latest monthly statement (Vanguard) or sync TWS (IBKR)."]
      : ["refresh ", ...worstPositionLabel, " now (import latest statements or reconnect TWS)."];
  let guidanceParts: CopyPart[];
  if (worstDays <= 1) {
    guidanceParts =
      valuedWeight > 0 && unvaluedCount > 0
        ? [
            "Holdings are current across accounts; ",
            priv(`${unvaluedCount} ${unvaluedCount === 1 ? "position has" : "positions have"}`),
            " no price or cost basis — counted as stale in this score.",
          ]
        : ["Holdings are current across accounts."];
  } else if (staleValueShare !== null) {
    guidanceParts = [
      priv(formatValueShare(staleValueShare)),
      " of book value is in positions more than a day old — ",
      ...refreshTail,
    ];
  } else {
    // No weights (nothing held can be valued): the wording from before the
    // value-weighted rule, keyed on the stalest row.
    guidanceParts =
      score >= 50
        ? ["Refresh ", ...worstPositionLabel, " — import the latest monthly statement (Vanguard) or sync TWS (IBKR)."]
        : ["Holdings are weeks+ old — refresh ", ...worstPositionLabel, " now (import latest statements or reconnect TWS)."];
  }
  const guidance = copyText(guidanceParts);

  // Same predicate the guidance branches on: actionable whenever any held
  // row is more than a day old (which covers every row older than 7 days,
  // however small its share of the book). deriveActions gates the
  // stale-holdings action row on this, so the two cannot disagree.
  const guidanceActionable = worstDays > 1;

  return {
    score,
    detail,
    detailParts,
    whyMatters,
    guidance,
    guidanceParts,
    guidanceActionable,
    staleValueShare,
    perAccount,
  };
}

// sortWorstFirst is imported from lib/queries/integrity-checks.ts (single
// source of truth, consolidated task 18 — this file and integrity-checks.ts
// each carried an identical copy of the comparator below).

/**
 * Worst (most recent, tie-broken by largest |residual|) unexplained
 * cash-flow candidate across non-IBKR accounts, using the SAME residual
 * computation scripts/repair-missing-external-flows.ts uses — so the
 * confidence score and the repair script's candidate list can never
 * disagree about what counts as "unexplained." Deliberately more sensitive
 * than the repair script's own bar (CONFIDENCE_RESIDUAL_REL_FLOOR=2% vs the
 * script's 5%) — this is an early warning, not a "propose a fix" bar.
 *
 * `source-seam` and `live-anchor-residual` points are excluded from
 * `unexplainedFlow` explicitly at this call site — `isUnexplainedCashFlow`
 * itself stays classification-blind by design (matching
 * partitionCandidates' division of labor). A suppressed `live-anchor-
 * residual` point that would otherwise have crossed the floors is instead
 * surfaced as `timingResidual` (labeled, not capped — see scoreCashAccuracy).
 * `source-seam` points are fully silent in both fields — they're
 * already-understood measurement-basis splices, not data-quality problems.
 */
function findWorstUnexplainedCashFlow(
  db: Database.Database
): {
  unexplainedFlow: { accountName: string; date: string; residual: number; classification: CashFlowClassification } | null;
  timingResidual: TimingResidualNote | null;
} {
  const accounts = db.prepare(`SELECT id, name FROM accounts`).all() as {
    id: number;
    name: string;
  }[];
  const accountIds = accounts.filter(a => !isLikelyIbkrAccountName(a.name)).map(a => a.id);
  if (accountIds.length === 0) return { unexplainedFlow: null, timingResidual: null };

  const seamDatesByAccount = collectSeamDatesByAccount(db, accountIds);
  const liveAnchorDatesByAccount = collectLiveAnchorDatesByAccount(db, accountIds);

  const allPoints = computeCashFlowResiduals(db, {
    accountIds,
    seamDatesByAccount,
    liveAnchorDatesByAccount,
  });

  const floors = {
    absFloor: CONFIDENCE_RESIDUAL_ABS_FLOOR,
    relFloor: CONFIDENCE_RESIDUAL_REL_FLOOR,
  };

  // Both classifications count here — an internal cash/holdings
  // misattribution is still a real data-quality problem, just not one the
  // repair script writes a row for (see cash-flow-audit.ts's
  // classifyCashFlowResidual doc). scoreCashAccuracy names which kind in
  // the detail string.
  const flagged = allPoints.filter(
    p =>
      isUnexplainedCashFlow(p, floors) &&
      p.classification !== "source-seam" &&
      p.classification !== "live-anchor-residual"
  );

  let unexplainedFlow: {
    accountName: string;
    date: string;
    residual: number;
    classification: CashFlowClassification;
  } | null = null;
  if (flagged.length > 0) {
    sortWorstFirst(flagged);
    const worst = flagged[0];
    unexplainedFlow = {
      accountName: worst.accountName,
      date: worst.toDate,
      residual: worst.residual,
      classification: worst.classification,
    };
  }

  const suppressedTimingResiduals = allPoints.filter(
    p => p.classification === "live-anchor-residual" && isUnexplainedCashFlow(p, floors)
  );

  let timingResidual: TimingResidualNote | null = null;
  if (suppressedTimingResiduals.length > 0) {
    sortWorstFirst(suppressedTimingResiduals);
    const worst = suppressedTimingResiduals[0];
    timingResidual = {
      date: worst.toDate,
      accountName: worst.accountName,
      amount: worst.residual,
    };
  }

  return { unexplainedFlow, timingResidual };
}

/**
 * Formats a cash-delta dollar amount for the `detail` prose string using the
 * SAME convention <Money> uses (lib/privacy/components.tsx) when rendered
 * without `signed` — formatUSD's comma grouping, and the "−" (U+2212) glyph
 * for negative values, never an explicit "+" for positive ones. The popover
 * footer renders this same amount through <Money>; a hand-rolled
 * `${sign}$${Math.abs(x).toFixed(0)}` here disagreed with it on BOTH the
 * thousands separator and the sign glyph (2026-09-12).
 */
function formatCashDeltaLikeMoney(value: number): string {
  const formatted = formatUSD(Math.abs(value));
  if (rendersAsZero(formatted)) return formatted;
  return value < 0 ? `−${formatted}` : formatted;
}

function scoreCashAccuracy(db: Database.Database, now: Date = new Date()): CashAccuracyScore {
  const today = todayET(now);

  // Find the most recent monthly snapshot anchor (non-TWS, since TWS snapshots
  // are live NLV and don't contain the breakdown needed for reliable cash inference)
  const row = db.prepare(`
    SELECT
      MAX(month_end_date) AS latest_date,
      CAST(julianday(?) - julianday(MAX(month_end_date)) AS INTEGER) AS days_since
    FROM monthly_snapshots
    WHERE ${excludeLiveSnapshotsSql("source")}
  `).get(today) as { latest_date: string | null; days_since: number | null };

  const whyMatters =
    "Cash is inferred from the latest statement — the older the anchor, the more it can drift from reality.";

  const { unexplainedFlow, timingResidual } = findWorstUnexplainedCashFlow(db);

  if (!row.latest_date) {
    return {
      score: 0,
      detail: "No statement snapshots for cash inference",
      detailParts: ["No statement snapshots for cash inference"],
      whyMatters,
      guidance: "Import a monthly statement to establish a cash anchor.",
      guidanceParts: ["Import a monthly statement to establish a cash anchor."],
      guidanceActionable: true,
      latestAnchorDate: null,
      daysSinceAnchor: null,
      unexplainedFlow,
      timingResidual,
    };
  }

  const days = row.days_since ?? 999;
  let score: number;
  if (days <= 7) score = 100;
  else if (days <= 14) score = 85;
  else if (days <= 30) score = 70;
  else if (days <= 60) score = 40;
  else score = 10;

  // The anchor date and its age are public; only a dollar amount appended
  // below is a private run.
  const detailParts: CopyPart[] = [
    days <= 7
      ? `Cash anchor from ${row.latest_date} (${days}d ago)`
      : `Cash inferred from ${row.latest_date} (${days}d old — may be inaccurate)`,
  ];

  let guidance =
    score >= 85
      ? "Cash anchor is recent."
      : score >= 50
        ? "Consider importing this month's statement to refresh the cash anchor."
        : "Cash may be significantly wrong — import the latest monthly statement.";
  // Same predicate the ternary above branches on: actionable whenever the
  // reassurance ("Cash anchor is recent.") branch isn't the one chosen.
  // Overridden below to true whenever a cash-flow problem replaces this text.
  let guidanceActionable = score < 85;

  // An unexplained cash residual means SOMETHING is off with this account's
  // numbers — cap the score regardless of how fresh the statement anchor
  // otherwise looks, since anchor freshness doesn't fix either kind of
  // problem. The two classifications get different wording (and different
  // guidance) because they're different bugs with different fixes: an
  // external-flow-candidate is a fake return day fixable by
  // scripts/repair-missing-external-flows.ts; an internal-shift is a
  // valuation-source misattribution that script deliberately WON'T touch
  // (see cash-flow-audit.ts's classifyCashFlowResidual doc).
  if (unexplainedFlow) {
    score = Math.min(score, 40);
    guidanceActionable = true;
    const amountStr = formatCashDeltaLikeMoney(unexplainedFlow.residual);

    if (unexplainedFlow.classification === "external-flow-candidate") {
      detailParts.push(
        "; unexplained external-flow-shaped cash delta of ",
        priv(amountStr),
        ` on ${unexplainedFlow.date} in ${unexplainedFlow.accountName} — not matched to any transaction`,
      );
      guidance =
        `${unexplainedFlow.accountName}'s ${unexplainedFlow.date} cash movement isn't explained by any recorded ` +
        `transaction and total_value moved with it — it's likely inflating volatility/drawdown/Sharpe. Review ` +
        `scripts/repair-missing-external-flows.ts (dry-run) to see the proposed fix.`;
    } else {
      detailParts.push(
        "; internal cash/holdings shift (valuation-source misattribution) of ",
        priv(amountStr),
        ` on ${unexplainedFlow.date} in ${unexplainedFlow.accountName}`,
      );
      guidance =
        `${unexplainedFlow.accountName}'s ${unexplainedFlow.date} cash figure jumped but total_value moved smoothly — ` +
        `the cash/holdings split looks misattributed by the valuation source (not a missing external flow, so the ` +
        `repair script won't propose a row for it). Worth checking that day's live source data.`;
    }
  } else if (timingResidual) {
    // Live-snapshot (Plaid/TWS) timing residual: labeled, never capped —
    // it's ambiguous until a statement covers the window, not a confirmed
    // data-quality problem the way unexplainedFlow is. Still flagged as
    // "actionable" text — it names something worth checking, not reassurance.
    guidanceActionable = true;
    const amountStr = formatCashDeltaLikeMoney(timingResidual.amount);
    detailParts.push(
      "; cash delta of ",
      priv(amountStr),
      ` on ${timingResidual.date} in ${timingResidual.accountName} is a live-snapshot timing residual (intraday broker total vs close-priced holdings) — not treated as an external flow`,
    );
    guidance =
      `Live-snapshot (Plaid/TWS) days infer cash as snapshot-total minus holdings value; the residual usually moves ` +
      `with measurement timing, not money. A genuine flow in this window would confirm on the next statement import ` +
      `— verify there if the amount looks like a real deposit or withdrawal.`;
  }

  return {
    score,
    detail: copyText(detailParts),
    detailParts,
    whyMatters,
    guidance,
    // Cash guidance names accounts and dates only — never an amount.
    guidanceParts: [guidance],
    guidanceActionable,
    latestAnchorDate: row.latest_date,
    daysSinceAnchor: days,
    unexplainedFlow,
    timingResidual,
  };
}

function scoreEnrichment(db: Database.Database, now: Date = new Date()): EnrichmentScore {
  const today = todayET(now);
  const rows = db.prepare(`
    SELECT
      s.id, s.symbol, s.ib_con_id,
      LOWER(COALESCE(s.security_type, '')) AS sec_type,
      s.fund_category AS fund_category
    FROM securities s
    JOIN holdings h ON h.security_id = s.id
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
      AND ${liveOptionExpirationSql("s", today)}
    GROUP BY s.id
  `).all() as { id: number; symbol: string; ib_con_id: number | null; sec_type: string; fund_category: string | null }[];

  // Bonds and money market don't need enrichment
  const enrichable = rows.filter(
    r => r.sec_type !== "bond" && !isCashEquivalentSecurity({ security_type: r.sec_type, fund_category: r.fund_category })
  );
  const enriched = enrichable.filter(r => r.ib_con_id !== null);
  const missing = enrichable.filter(r => r.ib_con_id === null).map(r => r.symbol);

  const total = enrichable.length;
  const count = enriched.length;
  const whyMatters =
    "Securities without TWS contract IDs can't fetch live prices, option chains, or historical bars.";

  if (total === 0) {
    return {
      score: 100,
      detail: "No securities need enrichment",
      detailParts: ["No securities need enrichment"],
      whyMatters,
      guidance: "Nothing to enrich.",
      guidanceParts: ["Nothing to enrich."],
      guidanceActionable: false,
      enriched: 0,
      total: 0,
      missing: [],
    };
  }

  const score = Math.round((count / total) * 100);
  const detailParts: CopyPart[] = count === total
    ? ["All ", priv(total), " securities enriched"]
    : [priv(`${count}/${total}`), " enriched — ", priv(missing.length), " missing conId"];
  const detail = copyText(detailParts);

  // Guidance is derived from missing.length — the SAME count the detail line
  // uses — never from the score alone
  // (qa:header-dataconfidence--guidance-contradicts-detail-and-actions). The
  // old `score >= 95` threshold let a single missing conId out of 20+ still
  // read as "all enrichable securities have contract IDs."
  const guidanceParts: CopyPart[] =
    missing.length === 0
      ? ["All enrichable securities have contract IDs."]
      : [
          priv(
            missing.length === 1
              ? "1 security is missing a TWS contract ID"
              : `${missing.length} securities are missing TWS contract IDs`
          ),
          " — click Enrich (requires TWS running).",
        ];
  const guidance = copyText(guidanceParts);

  // Same predicate the guidance ternary above branches on: actionable
  // whenever anything is still missing a conId.
  const guidanceActionable = missing.length > 0;

  return { score, detail, detailParts, whyMatters, guidance, guidanceParts, guidanceActionable, enriched: count, total, missing };
}

function scoreValuationCoverage(db: Database.Database, now: Date = new Date()): ValuationCoverageScore {
  const today = todayET(now);
  // Per-account latest daily_valuations row, summed across every account
  // that currently holds something (latestHoldingsPredicate) — NOT a single
  // global "latest valuation_date across all accounts" row, which silently
  // ignores every account whose valuation happens to be older than the
  // account that last synced. An account with current holdings but NO
  // daily_valuations row at all counts as fully unpriced (held-count,0),
  // not simply omitted from the denominator.
  const rows = db.prepare(`
    WITH current_holdings AS (
      SELECT h.account_id, COUNT(DISTINCT h.security_id) AS held_count
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
        AND ${liveOptionExpirationSql("s", today)}
      GROUP BY h.account_id
    )
    SELECT a.name AS account_name,
           ch.held_count,
           dv.valuation_date,
           dv.holdings_count,
           dv.priced_count
    FROM accounts a
    JOIN current_holdings ch ON ch.account_id = a.id
    LEFT JOIN daily_valuations dv
      ON dv.account_id = a.id
      AND dv.valuation_date = (
        SELECT MAX(v2.valuation_date) FROM daily_valuations v2 WHERE v2.account_id = a.id
      )
    ORDER BY a.name
  `).all() as {
    account_name: string;
    held_count: number;
    valuation_date: string | null;
    holdings_count: number | null;
    priced_count: number | null;
  }[];

  const whyMatters =
    "Missing holdings in the latest daily valuation understate portfolio value and distort change calculations.";

  const perAccountAsOf = rows.map(r => ({
    accountName: r.account_name,
    asOfDate: r.valuation_date,
  }));

  let total = 0;
  let priced = 0;
  for (const r of rows) {
    if (r.valuation_date === null) {
      // No daily_valuations row for this account at all — every currently
      // held security counts as unpriced.
      total += r.held_count;
    } else {
      total += r.holdings_count ?? r.held_count;
      priced += r.priced_count ?? 0;
    }
  }

  if (total === 0) {
    return {
      score: 0,
      detail: "No daily valuations computed",
      detailParts: ["No daily valuations computed"],
      whyMatters,
      guidance: "Run Quick Refresh to compute today's valuation.",
      guidanceParts: ["Run Quick Refresh to compute today's valuation."],
      guidanceActionable: true,
      pricedCount: 0,
      totalCount: 0,
      perAccountAsOf,
    };
  }

  const score = Math.round((priced / total) * 100);
  const detailParts: CopyPart[] = priced === total
    ? ["All ", priv(total), " holdings in latest valuation"]
    : [priv(`${priced}/${total}`), " holdings priced in latest valuation"];
  const detail = copyText(detailParts);

  // Guidance is derived from priced/total — the SAME counts the detail line
  // uses — never from the score alone
  // (qa:header-dataconfidence--guidance-contradicts-detail-and-actions).
  const unpriced = total - priced;
  const unpricedRun = priv(`${unpriced} holding${unpriced === 1 ? "" : "s"}`);
  const guidanceParts: CopyPart[] =
    priced === total
      ? ["Full coverage in the latest valuation."]
      : score >= 50
        ? ["Run Quick Refresh to price the remaining ", unpricedRun, "."]
        : [unpricedRun, " unpriced — Quick Refresh, then enrich any still missing."];
  const guidance = copyText(guidanceParts);

  // Same predicate the guidance ternary above branches on: actionable
  // whenever anything is still unpriced in the latest valuation.
  const guidanceActionable = priced !== total;

  return { score, detail, detailParts, whyMatters, guidance, guidanceParts, guidanceActionable, pricedCount: priced, totalCount: total, perAccountAsOf };
}

// ── Actions ──────────────────────────────────────────────────────────

/** How many lagging tickers the stale-holdings action spells out per account. */
const STALE_POSITIONS_NAMED = 3;

/**
 * One account's clause in the stale-holdings action. The account-level
 * "holdings are N days old" is only true when every position shares that one
 * date. Otherwise the claim is about the lagging positions: it counts them,
 * names the first few, dates the oldest and says the rest are current — the
 * same story the Holdings detail line tells (latest vs stalest position).
 */
function staleHoldingsClaim(a: HoldingsRecencyScore["perAccount"][number]): CopyPart[] {
  const stale = a.stalePositions;
  const oneDate = stale.length > 0 && stale.every(p => p.date === stale[0].date);
  if (stale.length === 0 || (stale.length === a.heldCount && oneDate)) {
    return [`${a.name}${a.source ? ` (${a.source})` : ""} holdings are ${a.daysOld ?? "?"} days old`];
  }
  const named = stale.slice(0, STALE_POSITIONS_NAMED).map(p => p.symbol).join(", ");
  const more = stale.length > STALE_POSITIONS_NAMED ? ` +${stale.length - STALE_POSITIONS_NAMED} more` : "";
  const parts: CopyPart[] = [
    `${a.name}: `,
    priv(`${stale.length} of ${a.heldCount} positions ${stale.length === 1 ? "is" : "are"}`),
    " more than a day old — ",
    priv(`${named}${more}`),
    `, ${stale.length === 1 ? "dated" : "oldest dated"} ${a.date} (${a.daysOld ?? "?"} days${a.source ? `, ${a.source}` : ""})`,
  ];
  if (stale.length < a.heldCount) {
    parts.push(`; the rest are current${a.latestDate ? ` (latest ${a.latestDate})` : ""}`);
  }
  return parts;
}

function deriveActions(
  price: PriceFreshnessScore,
  holdings: HoldingsRecencyScore,
  cash: CashAccuracyScore,
  enrichment: EnrichmentScore,
  valuation: ValuationCoverageScore,
): DataAction[] {
  const actions: DataAction[] = [];
  // Every action is written as runs; the plain strings are their flattening.
  const push = (
    a: Omit<DataAction, "message" | "fix" | "messageParts" | "fixParts"> & {
      messageParts: CopyPart[];
      fixParts: CopyPart[];
    }
  ) => actions.push({ ...a, message: copyText(a.messageParts), fix: copyText(a.fixParts) });

  // Price freshness — fires exactly when the Prices guidance above names a
  // gap (pricedRecent < totalHeld), the SAME count basis, never the score
  // alone (qa:header-dataconfidence--guidance-contradicts-detail-and-
  // actions): a score of 98 (39/40 fresh) used to clear the old `score < 80`
  // gate, so the guidance named "1 of 40 ... has no recent price" while the
  // Actions list stayed empty.
  if (price.totalHeld > 0 && price.pricedRecent < price.totalHeld) {
    push({
      severity: price.score < 30 ? "critical" : "warning",
      // Same basis as the Prices dimension detail/score: totalHeld -
      // pricedRecent, NOT totalHeld - pricedToday (see RECENT_PRICE_WINDOW_DAYS).
      messageParts: [
        priv(`${price.totalHeld - price.pricedRecent} ${price.totalHeld - price.pricedRecent === 1 ? "security has" : "securities have"}`),
        ` no price from the last ${RECENT_PRICE_WINDOW_DAYS} days`,
      ],
      fixParts: ["Run Quick Refresh to update all prices (~2 min)"],
      autoFixable: true,
      apiEndpoint: "/api/tws/auto-refresh",
      apiBody: { level: "quick" },
    });
  }

  // Enrichment
  if (enrichment.missing.length > 0) {
    push({
      severity: enrichment.missing.length > 5 ? "warning" : "info",
      messageParts: [
        priv(`${enrichment.missing.length} ${enrichment.missing.length === 1 ? "security" : "securities"}`),
        " missing TWS contract data",
      ],
      fixParts: [
        "Enrich to enable price fetching: ",
        priv(`${enrichment.missing.slice(0, 3).join(", ")}${enrichment.missing.length > 3 ? "..." : ""}`),
      ],
      autoFixable: true,
      apiEndpoint: "/api/tws/enrich",
    });
  }

  // Cash accuracy — same predicate as the cash guidance text (the popover
  // must not name something to do without an action row for it).
  if (cash.guidanceActionable) {
    push({
      severity: "warning",
      messageParts: [`Cash inferred from ${cash.daysSinceAnchor ?? "?"}d-old snapshot`],
      fixParts: ["Import latest monthly statement to update cash anchor"],
      autoFixable: false,
    });
  }

  // Holdings recency — same predicate as the holdings guidance text (any
  // held row more than a day old), not the old 30-day threshold that let the
  // guidance name a stale account with no matching action row.
  const staleAccounts = holdings.guidanceActionable
    ? holdings.perAccount.filter(a => (a.daysOld ?? 999) > 1)
    : [];
  if (staleAccounts.length > 0) {
    const messageParts: CopyPart[] = [];
    for (const a of staleAccounts) {
      if (messageParts.length > 0) messageParts.push("; ");
      messageParts.push(...staleHoldingsClaim(a));
    }
    push({
      severity: "warning",
      messageParts,
      fixParts: ["Import latest statement or sync IBKR positions"],
      autoFixable: false,
    });
  }

  // Valuation coverage — same count basis as the guidance branches above
  // (pricedCount < totalCount), not the score alone (see Price freshness
  // note above for the class of bug this closes).
  if (valuation.totalCount > 0 && valuation.pricedCount < valuation.totalCount) {
    push({
      severity: "warning",
      messageParts: ["Only ", priv(`${valuation.pricedCount}/${valuation.totalCount}`), " holdings in latest valuation"],
      fixParts: ["Refresh prices to improve valuation coverage"],
      autoFixable: true,
      apiEndpoint: "/api/tws/auto-refresh",
      apiBody: { level: "quick" },
    });
  }

  // No data at all
  if (price.totalHeld === 0) {
    push({
      severity: "critical",
      messageParts: ["No holdings data found"],
      fixParts: ["Import files to get started"],
      autoFixable: false,
    });
  }

  return actions.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
}

// ── Main function ────────────────────────────────────────────────────

export function getDataConfidence(db: Database.Database, now: Date = new Date()): DataConfidence {
  const priceFreshness = scorePriceFreshness(db, now);
  const holdingsRecency = scoreHoldingsRecency(db, now);
  const cashAccuracy = scoreCashAccuracy(db, now);
  const enrichmentCompleteness = scoreEnrichment(db, now);
  const valuationCoverage = scoreValuationCoverage(db, now);

  let overallScore = Math.round(
    priceFreshness.score * WEIGHTS.priceFreshness +
    holdingsRecency.score * WEIGHTS.holdingsRecency +
    cashAccuracy.score * WEIGHTS.cashAccuracy +
    enrichmentCompleteness.score * WEIGHTS.enrichment +
    valuationCoverage.score * WEIGHTS.valuationCoverage,
  );

  let overallLevel: DataConfidence["overallLevel"] =
    overallScore >= 80 ? "high" :
    overallScore >= 50 ? "medium" :
    overallScore >= 20 ? "low" :
    "stale";

  // Integrity gate (spec WS3, task 18): cross-cutting number-trust checks
  // are independent of the 5 weighted dimensions above — a critical hit
  // caps the score/level AFTER the weighted mean, never blends into it.
  // Monotonic only: the cap can lower overallLevel but never promote it, so
  // a "stale" result (already below the cap) stays "stale", not bumped up
  // to "low". Warnings never cap — informational only.
  const integrity = runIntegrityChecks(db);
  let capReason: string | null = null;
  if (integrity.critical.length > 0) {
    capReason = integrity.critical[0].reason;
    overallScore = Math.min(overallScore, 45);
    if (overallLevel === "high" || overallLevel === "medium") overallLevel = "low";
  }

  // Keep freshness arithmetic intact, but do not call a partially checked
  // portfolio high confidence. Existing critical/stale states still win.
  if (!integrity.lotDriftChecked && overallLevel === "high") {
    overallLevel = "unverified";
  }

  const actions = deriveActions(
    priceFreshness,
    holdingsRecency,
    cashAccuracy,
    enrichmentCompleteness,
    valuationCoverage,
  );

  return {
    overallScore,
    overallLevel,
    priceFreshness,
    holdingsRecency,
    cashAccuracy,
    enrichmentCompleteness,
    valuationCoverage,
    actions,
    integrity,
    capReason,
    // Lot-drift hits are keyed `lot-drift:<account>:<security>` by
    // runIntegrityChecks (the hit carries no typed kind for them).
    lotDriftCriticalCount: integrity.critical.filter(h => h.key.startsWith("lot-drift:")).length,
  };
}
