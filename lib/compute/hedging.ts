import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { computePortfolioGreeks, type GreeksDiagnostic } from "@/lib/compute/options-greeks";
import { optionExposureFallback } from "@/lib/compute/exposure";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { explodeHoldingBySector } from "@/lib/compute/explode-sector";

/**
 * Defense/Hedging engine — classifies the book into hedged pairs (Tier 1),
 * proxy protection (Tier 2), amplifiers, and standalone bets, then scores
 * every hedge. Spec: docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md
 *
 * All classification runs on SIGNED delta-notional exposure (stocks at MV,
 * options at Δ·S·mult·qty). Sign rules generalize: any negative-exposure
 * instrument on an ETF with no long core is portfolio protection; on a
 * non-held single name it is a directional bet.
 */

// ─── Badge thresholds (Task 4 consumes; single tunable home) ────────
export const HEDGE_BADGE_THRESHOLDS = {
  EXPIRING_DAYS: 30,
  DECAYED_OTM_PCT: 0.2,
  DECAYED_RUNWAY_DAYS: 45,
  EXPENSIVE_MONTHLY_BLEED_PCT: 0.03,
  DEEP_ITM_ABS_DELTA: 0.8,
} as const;

export interface DefenseInstrument {
  securityId: number;
  symbol: string;
  /** issuerSiblings-canonical underlying (self for stock/ETF). */
  underlying: string;
  isOption: boolean;
  optionType: "CALL" | "PUT" | null;
  quantity: number; // signed
  /** Signed delta-notional USD. */
  exposure: number;
  /** Signed USD market value. */
  marketValue: number;
  underlyingIsEtf: boolean;
  sector: string | null;
  geography: string | null;
  greeksAvailable: boolean;
  // Option detail for scoring (Task 4); absent on shares.
  strike?: number;
  expiration?: string;
  daysToExpiry?: number;
  /** Daily theta in dollars for the whole position (negative = decay). */
  thetaPerDay?: number | null;
  delta?: number | null;
  underlyingPrice?: number;
}

export interface UnderlyingGroup {
  underlying: string;
  underlyingIsEtf: boolean;
  instruments: DefenseInstrument[];
}

export type PairClassification =
  | "hedged_long"
  | "hedged_short"
  | "amplified"
  | "unhedged"
  | "speculative";

export interface UnderlyingPair {
  underlying: string;
  classification: PairClassification;
  coreExposure: number;
  /** Σ opposing-option exposure magnitude, uncapped. */
  offsetExposure: number;
  /** min(offsetExposure, |core|) — what actually counts as hedged. */
  offsetCredited: number;
  amplifierExposure: number;
  hasAmplifiers: boolean;
  netExposure: number;
  /** offsetCredited / |core|; null when core === 0. */
  coveragePct: number | null;
  sector: string | null;
  instruments: DefenseInstrument[];
}

export interface ProxyCandidate {
  underlying: string;
  protectiveNotional: number; // positive magnitude
  source: "no_core_etf" | "etf_negative_stack" | "tier1_spill";
  instruments: DefenseInstrument[];
}

export interface StandaloneBet {
  underlying: string;
  exposure: number; // signed (negative)
  kind: "single_name_put" | "naked_short";
  instruments: DefenseInstrument[];
}

export interface ClassifyResult {
  pairs: UnderlyingPair[];
  proxyCandidates: ProxyCandidate[];
  standaloneBets: StandaloneBet[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function classifyBook(groups: Map<string, UnderlyingGroup>): ClassifyResult {
  const pairs: UnderlyingPair[] = [];
  const proxyCandidates: ProxyCandidate[] = [];
  const standaloneBets: StandaloneBet[] = [];

  for (const g of groups.values()) {
    const core = sum(g.instruments.filter((i) => !i.isOption).map((i) => i.exposure));
    const options = g.instruments.filter((i) => i.isOption);
    const netExposure = sum(g.instruments.map((i) => i.exposure));
    const sector = g.instruments.find((i) => i.sector)?.sector ?? null;

    if (core > 0) {
      const opposing = options.filter((o) => o.exposure < 0);
      const amplifying = options.filter((o) => o.exposure > 0);
      const offsetExposure = Math.abs(sum(opposing.map((o) => o.exposure)));
      const offsetCredited = Math.min(offsetExposure, core);
      const excess = offsetExposure - offsetCredited;
      if (excess > 0 && g.underlyingIsEtf) {
        proxyCandidates.push({
          underlying: g.underlying,
          protectiveNotional: excess,
          source: "tier1_spill",
          instruments: opposing,
        });
      }
      pairs.push({
        underlying: g.underlying,
        classification:
          opposing.length > 0 ? "hedged_long" : amplifying.length > 0 ? "amplified" : "unhedged",
        coreExposure: core,
        offsetExposure,
        offsetCredited,
        amplifierExposure: sum(amplifying.map((o) => o.exposure)),
        hasAmplifiers: amplifying.length > 0,
        netExposure,
        coveragePct: offsetCredited / core,
        sector,
        instruments: g.instruments,
      });
      continue;
    }

    if (core < 0) {
      const opposing = options.filter((o) => o.exposure > 0); // calls hedging the short
      const sameSign = options.filter((o) => o.exposure < 0);
      if (g.underlyingIsEtf) {
        // Negative ETF stack = portfolio protection: core remainder after
        // opposing calls offset, plus all same-sign puts (MAGS case).
        const offsetExposure = sum(opposing.map((o) => o.exposure));
        const coreRemainder = Math.max(0, Math.abs(core) - offsetExposure);
        const notional = coreRemainder + Math.abs(sum(sameSign.map((o) => o.exposure)));
        if (notional > 0) {
          proxyCandidates.push({
            underlying: g.underlying,
            protectiveNotional: notional,
            source: "etf_negative_stack",
            instruments: g.instruments,
          });
        }
        continue;
      }
      if (opposing.length > 0) {
        const offsetExposure = sum(opposing.map((o) => o.exposure));
        const offsetCredited = Math.min(offsetExposure, Math.abs(core));
        pairs.push({
          underlying: g.underlying,
          classification: "hedged_short",
          coreExposure: core,
          offsetExposure,
          offsetCredited,
          amplifierExposure: sum(sameSign.map((o) => o.exposure)),
          hasAmplifiers: sameSign.length > 0,
          netExposure,
          coveragePct: offsetCredited / Math.abs(core),
          sector,
          instruments: g.instruments,
        });
      } else {
        standaloneBets.push({
          underlying: g.underlying,
          exposure: netExposure,
          kind: "naked_short",
          instruments: g.instruments,
        });
      }
      continue;
    }

    // core === 0 — options only.
    const protective = options.filter((o) => o.exposure < 0);
    const bullish = options.filter((o) => o.exposure > 0);
    if (protective.length > 0) {
      if (g.underlyingIsEtf) {
        proxyCandidates.push({
          underlying: g.underlying,
          protectiveNotional: Math.abs(sum(protective.map((o) => o.exposure))),
          source: "no_core_etf",
          instruments: protective,
        });
      } else {
        standaloneBets.push({
          underlying: g.underlying,
          exposure: sum(protective.map((o) => o.exposure)),
          kind: "single_name_put",
          instruments: protective,
        });
      }
    }
    if (bullish.length > 0) {
      pairs.push({
        underlying: g.underlying,
        classification: "speculative",
        coreExposure: 0,
        offsetExposure: 0,
        offsetCredited: 0,
        amplifierExposure: sum(bullish.map((o) => o.exposure)),
        hasAmplifiers: true,
        netExposure: sum(bullish.map((o) => o.exposure)),
        coveragePct: null,
        sector,
        instruments: bullish,
      });
    }
  }

  return { pairs, proxyCandidates, standaloneBets };
}

// ─── Beta Resolver (Task 2) ────────────────────────────────────────

const MAX_RETURN_PAIR_GAP_DAYS = 7; // prices-table hole guard (see CLAUDE.md)
const MIN_BETA_RETURN_PAIRS = 6;

function calendarDaysBetween(a: string, b: string): number {
  return Math.abs(new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000;
}

/** Log-return pairs aligned by date, dropping pairs spanning > MAX_RETURN_PAIR_GAP_DAYS. */
function gapGuardedReturns(series: Array<{ date: string; close: number }>): Map<string, number> {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.close <= 0 || cur.close <= 0) continue;
    if (calendarDaysBetween(prev.date, cur.date) > MAX_RETURN_PAIR_GAP_DAYS) continue;
    out.set(cur.date, Math.log(cur.close / prev.close));
  }
  return out;
}

export function computeGapGuardedBeta(
  series: Array<{ date: string; close: number }>,
  bench: Array<{ date: string; close: number }>
): number | null {
  const secR = gapGuardedReturns(series);
  const benchR = gapGuardedReturns(bench);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [date, r] of secR) {
    const br = benchR.get(date);
    if (br !== undefined) {
      ys.push(r);
      xs.push(br);
    }
  }
  if (xs.length < MIN_BETA_RETURN_PAIRS) return null;
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  if (varx === 0) return null;
  return cov / varx;
}

export interface ResolvedBeta {
  beta: number;
  source: "cached" | "computed" | "assumed";
}

/**
 * β for a proxy-hedge underlying: security_betas cache → gap-guarded compute
 * from cached closes (prices + benchmark_prices vs SPY) → assumed 1.0.
 */
export function resolveProxyBeta(db: Database.Database, symbol: string): ResolvedBeta {
  const cached = db
    .prepare(
      `SELECT sb.beta FROM security_betas sb
       JOIN securities s ON s.id = sb.security_id
       WHERE s.symbol = ? AND sb.beta IS NOT NULL ORDER BY sb.computed_at DESC LIMIT 1`
    )
    .get(symbol) as { beta: number } | undefined;
  if (cached) return { beta: cached.beta, source: "cached" };

  // Deterministic one-source-per-date: prefer `prices` (broker-sourced closes)
  // over `benchmark_prices` (fallback) when both tables have a row for the
  // same date — a same-date collision otherwise corrupts gapGuardedReturns'
  // date-keyed Map (identical dupes collapse variance to ~0; near-identical
  // dupes inject a few-bp noise return that can send beta wildly off).
  const closesFor = (sym: string): Array<{ date: string; close: number }> =>
    db
      .prepare(
        `SELECT date, close FROM (
           SELECT date, close_price AS close,
                  ROW_NUMBER() OVER (PARTITION BY date ORDER BY pri) AS rn
           FROM (
             SELECT p.date AS date, p.close_price, 1 AS pri
             FROM prices p JOIN securities s ON s.id = p.security_id
             WHERE s.symbol = ? AND p.close_price > 0
             UNION ALL
             SELECT bp.date, bp.close_price, 2 AS pri
             FROM benchmark_prices bp WHERE bp.symbol = ? AND bp.close_price > 0
           )
         ) WHERE rn = 1 ORDER BY date`
      )
      .all(sym, sym) as Array<{ date: string; close: number }>;

  const sec = closesFor(symbol);
  const spy = closesFor("SPY");
  const computed = computeGapGuardedBeta(sec, spy);
  if (computed !== null) return { beta: computed, source: "computed" };
  return { beta: 1.0, source: "assumed" };
}

// ─── Proxy Attribution (Task 3) ────────────────────────────────────────

export interface ProxyHedge {
  underlying: string;
  protectiveNotional: number;
  route: "sector" | "geography" | "beta";
  creditedTo: Array<{ bucket: string; credited: number }>;
  betaSource?: ResolvedBeta["source"];
  instruments: DefenseInstrument[];
}

export interface SectorCoverage {
  sector: string;
  longExposure: number;
  protected: number;
  coveragePct: number | null;
}

export interface AttributionContext {
  /** getEtfSectorWeights(db) shape: symbol → [{sector, weight_pct}] */
  sectorWeights: Map<string, Array<{ sector: string; weight_pct: number }>>;
  /** ETF symbol → geography (from securities.geography of the ETF row). */
  etfGeography: Map<string, string>;
  longExposureBySector: Map<string, number>;
  longExposureByGeography: Map<string, number>;
  /** Tier-1 offsetCredited bucketed by the pair's sector (for the bars). */
  tier1CreditedBySector: Map<string, number>;
  /** Carried for interface completeness / future consumers — attributeProxies
   * itself never reads this field; the orchestrator computes and uses its
   * own totalLongExposure (for pctOfBook, etc.). Do not remove. */
  totalLongExposure: number;
  resolveBeta: (symbol: string) => ResolvedBeta;
}

export function attributeProxies(
  candidates: ProxyCandidate[],
  ctx: AttributionContext
): { proxies: ProxyHedge[]; sectorCoverage: SectorCoverage[] } {
  const proxies: ProxyHedge[] = [];
  const protectedBySector = new Map<string, number>(ctx.tier1CreditedBySector);

  for (const c of candidates) {
    const weights = ctx.sectorWeights.get(c.underlying);
    if (weights && weights.length > 0) {
      const creditedTo = weights.map((w) => ({
        bucket: w.sector,
        credited: c.protectiveNotional * (w.weight_pct / 100),
      }));
      for (const ct of creditedTo) {
        protectedBySector.set(ct.bucket, (protectedBySector.get(ct.bucket) ?? 0) + ct.credited);
      }
      proxies.push({ underlying: c.underlying, protectiveNotional: c.protectiveNotional, route: "sector", creditedTo, instruments: c.instruments });
      continue;
    }
    const geo = ctx.etfGeography.get(c.underlying);
    if (geo && ctx.longExposureByGeography.has(geo)) {
      proxies.push({
        underlying: c.underlying,
        protectiveNotional: c.protectiveNotional,
        route: "geography",
        creditedTo: [{ bucket: geo, credited: c.protectiveNotional }],
        instruments: c.instruments,
      });
      continue;
    }
    const { beta, source } = ctx.resolveBeta(c.underlying);
    proxies.push({
      underlying: c.underlying,
      protectiveNotional: c.protectiveNotional,
      route: "beta",
      creditedTo: [{ bucket: "book", credited: c.protectiveNotional * beta }],
      betaSource: source,
      instruments: c.instruments,
    });
  }

  const sectors = new Set([...ctx.longExposureBySector.keys(), ...protectedBySector.keys()]);
  const sectorCoverage: SectorCoverage[] = [...sectors]
    .map((sector) => {
      const longExposure = ctx.longExposureBySector.get(sector) ?? 0;
      const prot = protectedBySector.get(sector) ?? 0;
      return {
        sector,
        longExposure,
        protected: prot,
        coveragePct: longExposure > 0 ? prot / longExposure : null,
      };
    })
    .sort((a, b) => b.longExposure - a.longExposure);

  return { proxies, sectorCoverage };
}

// ─── Per-hedge Scoring (Task 4) ────────────────────────────────────────

export type HedgeBadge = "expiring" | "decayed" | "expensive" | "deep_itm";

export interface HedgeScore {
  securityId: number;
  symbol: string;
  underlying: string;
  /** What it protects: a name, "sector: Technology (90%) + …", or "book". */
  protects: string;
  protectedNotional: number;
  thetaPerDay: number | null;
  /** Monthly theta as a fraction of protected notional; negative = the hedge
   *  COLLECTS theta (short-option premium income), not a cost. */
  monthlyBleedPct: number | null;
  runwayDays: number | null;
  /** (strike − spot) / spot; negative = OTM for puts. */
  moneynessPct: number | null;
  /** Dollars protected per dollar of monthly decay; null when no carry data. */
  efficiency: number | null;
  badges: HedgeBadge[];
}

export function scoreHedges(
  inputs: Array<{ instrument: DefenseInstrument; protects: string; protectedNotional: number }>
): HedgeScore[] {
  const T = HEDGE_BADGE_THRESHOLDS;
  const scores = inputs.map(({ instrument: i, protects, protectedNotional }) => {
    const hasGreeks = i.greeksAvailable && i.isOption;
    const thetaPerDay = hasGreeks && typeof i.thetaPerDay === "number" ? i.thetaPerDay : null;
    // Signed carry: theta < 0 (long options) decays — positive bleed = cost.
    // theta > 0 (a short-option hedge collecting premium) — negative bleed =
    // income; "expensive" then never fires and efficiency stays null via the
    // existing monthlyBleed > 0 guard. Identical output for all long hedges.
    const monthlyBleed = thetaPerDay !== null && protectedNotional > 0 ? -thetaPerDay * 30 : null;
    const monthlyBleedPct = monthlyBleed !== null ? monthlyBleed / protectedNotional : null;
    const runwayDays = i.isOption && typeof i.daysToExpiry === "number" ? i.daysToExpiry : null;
    const moneynessPct =
      i.isOption && typeof i.strike === "number" && typeof i.underlyingPrice === "number" && i.underlyingPrice > 0
        ? (i.strike - i.underlyingPrice) / i.underlyingPrice
        : null;
    const efficiency = monthlyBleed !== null && monthlyBleed > 0 ? protectedNotional / monthlyBleed : null;

    const badges: HedgeBadge[] = [];
    if (runwayDays !== null && runwayDays < T.EXPIRING_DAYS) badges.push("expiring");
    const otmPct = i.optionType === "PUT" ? (moneynessPct !== null ? -moneynessPct : null) : moneynessPct;
    if (otmPct !== null && runwayDays !== null && otmPct > T.DECAYED_OTM_PCT && runwayDays < T.DECAYED_RUNWAY_DAYS) badges.push("decayed");
    if (monthlyBleedPct !== null && monthlyBleedPct > T.EXPENSIVE_MONTHLY_BLEED_PCT) badges.push("expensive");
    if (typeof i.delta === "number" && Math.abs(i.delta) >= T.DEEP_ITM_ABS_DELTA) badges.push("deep_itm");

    return {
      securityId: i.securityId,
      symbol: i.symbol,
      underlying: i.underlying,
      protects,
      protectedNotional,
      thetaPerDay,
      monthlyBleedPct,
      runwayDays,
      moneynessPct,
      efficiency,
      badges,
    };
  });

  return scores.sort((a, b) => {
    if (a.efficiency === null && b.efficiency === null) return 0;
    if (a.efficiency === null) return 1;
    if (b.efficiency === null) return -1;
    return a.efficiency - b.efficiency;
  });
}

// ─── Orchestrator (Task 5) ──────────────────────────────────────────────

interface DefenseHoldingRow {
  security_id: number;
  symbol: string;
  security_type: string | null;
  option_type: string | null;
  underlying_symbol: string | null;
  sector: string | null;
  geography: string | null;
  currency: string | null;
  quantity: number;
  mv: number;
}

interface UnderlyingMeta {
  isEtf: boolean;
  geography: string | null;
  sector: string | null;
  securityId: number | null;
}

interface GreeksAgg {
  exposure: number;
  thetaPerDay: number;
  delta: number | null;
  daysToExpiry: number | null;
  strike: number | null;
  underlyingPrice: number | null;
  greeksAvailable: boolean;
}

/** issuerSiblings-canonical key for a raw underlying symbol. */
function canonicalUnderlying(symbol: string): string {
  return issuerSiblings(symbol).slice().sort()[0];
}

/** Options → underlying_symbol (fallback: OCC symbol prefix before the first space). Shares → own symbol. */
function rawUnderlyingOf(
  row: Pick<DefenseHoldingRow, "symbol" | "security_type" | "underlying_symbol">
): string {
  if ((row.security_type ?? "").toLowerCase() === "option") {
    return row.underlying_symbol ?? row.symbol.split(" ")[0];
  }
  return row.symbol;
}

/** "sector: Technology 90% / Communication Services 10%" | "geography: Europe" | "book (β=1.2)" */
function describeProxyRoute(hedge: ProxyHedge): string {
  if (hedge.route === "sector") {
    return (
      "sector: " +
      hedge.creditedTo
        .map((c) => `${c.bucket} ${Math.round((c.credited / hedge.protectiveNotional) * 100)}%`)
        .join(" / ")
    );
  }
  if (hedge.route === "geography") {
    return `geography: ${hedge.creditedTo[0]?.bucket ?? "Unknown"}`;
  }
  const beta =
    hedge.protectiveNotional !== 0 ? (hedge.creditedTo[0]?.credited ?? 0) / hedge.protectiveNotional : 1;
  return `book (β=${beta.toFixed(1)})`;
}

export interface RankedExposure {
  underlying: string;
  netExposure: number;
  pctOfBook: number | null; // |net| / totalLongExposure
  tier1CoveragePct: number | null;
  sectorProxyCoveragePct: number | null; // the sector's coverage, context column
  classification: PairClassification;
  hasAmplifiers: boolean;
  sector: string | null;
  securityId: number | null; // for SymbolLink; null if underlying row absent
}

export interface DefenseDiagnostic {
  kind: "assumed_beta" | "no_sector_weights" | "greeks_fallback" | "unknown_underlying";
  symbol: string;
  detail: string;
}

export interface DefenseSummary {
  longExposure: number;
  shortExposure: number;
  protectiveNotional: number;
  protectionRatio: number | null;
  netExposure: number;
  grossExposure: number;
  hedgeCount: number;
}

export interface DefenseAnalysis {
  summary: DefenseSummary;
  pairs: UnderlyingPair[];
  proxies: ProxyHedge[];
  sectorCoverage: SectorCoverage[];
  standaloneBets: StandaloneBet[];
  rankedExposures: RankedExposure[];
  hedgeScores: HedgeScore[];
  diagnostics: DefenseDiagnostic[];
}

/**
 * Defense/Hedging orchestrator — pulls the holdings universe (shares + options,
 * shorts included, FX-adjusted), wires Greeks-derived exposure, classifies the
 * book (Task 1), attributes proxy hedges (Task 3), and scores every hedge
 * (Task 4). See docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md.
 */
export function computeDefenseAnalysis(db: Database.Database, accountIds?: number[]): DefenseAnalysis {
  const diagnostics: DefenseDiagnostic[] = [];
  const scopedAccountIds = accountIds && accountIds.length > 0 ? accountIds : undefined;
  const accountFilter = scopedAccountIds
    ? `AND h.account_id IN (${scopedAccountIds.map(() => "?").join(",")})`
    : "";

  // ─── Note 1: SQL pull — holdings universe (shares + options, shorts
  // included), FX-adjusted, maturity/expiry filtered. ─────────────────
  const sql = `
    WITH latest_holdings AS (
      SELECT h.* FROM holdings h
      WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true, accountFilter })}
    ),
    latest_prices AS (
      SELECT p.security_id, p.close_price
      FROM prices p
      INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
      ON p.security_id = lp.security_id AND p.date = lp.max_date
    )
    SELECT
      s.id AS security_id, s.symbol, s.security_type, s.option_type, s.underlying_symbol,
      s.sector, s.geography, s.currency, h.quantity,
      CASE
        WHEN lp.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
        WHEN h.cost_basis IS NOT NULL AND h.cost_basis != 0
          THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
        ELSE 0
      END AS mv
    FROM latest_holdings h
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    WHERE (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
      AND (s.expiration_date IS NULL OR s.expiration_date >= date('now', '-1 day'))
      AND LOWER(s.security_type) IN ('stock', 'etf', 'common stock', 'option', 'mutual fund')
  `;
  const rawRows = db.prepare(sql).all(...(scopedAccountIds ?? [])) as DefenseHoldingRow[];

  // Sum quantity/mv across accounts per security_id.
  const aggregated = new Map<number, DefenseHoldingRow>();
  for (const r of rawRows) {
    const existing = aggregated.get(r.security_id);
    if (existing) {
      existing.quantity += r.quantity;
      existing.mv += r.mv;
    } else {
      aggregated.set(r.security_id, { ...r });
    }
  }
  const rows = [...aggregated.values()];
  const securityTypeById = new Map<number, string | null>();
  for (const row of rows) securityTypeById.set(row.security_id, row.security_type);

  // ─── Note 2: Greeks — signed delta-notional exposure + theta, summed
  // across scoped accounts; ±2.5×MV fallback when Greeks unavailable. ──
  const greeksMap = new Map<number, GreeksAgg>();
  const greeksDiagBySymbol = new Map<string, GreeksDiagnostic>();
  const scopes: Array<number | undefined> = scopedAccountIds ?? [undefined];
  for (const accountId of scopes) {
    const greeks = computePortfolioGreeks(db, accountId !== undefined ? { accountId } : undefined);
    for (const d of greeks.diagnostics) greeksDiagBySymbol.set(d.symbol, d);
    for (const pos of greeks.positions) {
      const cur: GreeksAgg =
        greeksMap.get(pos.securityId) ?? {
          exposure: 0,
          thetaPerDay: 0,
          delta: null,
          daysToExpiry: pos.daysToExpiry,
          strike: pos.strike,
          underlyingPrice: pos.underlyingPrice,
          greeksAvailable: false,
        };
      if (pos.greeks) {
        cur.exposure += pos.greeks.delta * pos.underlyingPrice * pos.multiplier * pos.quantity;
        cur.thetaPerDay += pos.greeks.theta * pos.multiplier * pos.quantity;
        cur.delta = pos.greeks.delta;
        cur.greeksAvailable = true;
      }
      cur.daysToExpiry = pos.daysToExpiry;
      cur.strike = pos.strike;
      cur.underlyingPrice = pos.underlyingPrice;
      greeksMap.set(pos.securityId, cur);
    }
  }

  // ─── Note 4: underlying isEtf / geography / sector / securityId — one
  // query over the distinct raw underlyings referenced by this universe. ──
  const rawUnderlyings = new Set<string>();
  for (const row of rows) rawUnderlyings.add(rawUnderlyingOf(row));
  const rawList = [...rawUnderlyings];
  const underlyingRows =
    rawList.length > 0
      ? (db
          .prepare(
            `SELECT id, symbol, security_type, geography, sector FROM securities WHERE symbol IN (${rawList
              .map(() => "?")
              .join(",")})`
          )
          .all(...rawList) as Array<{
            id: number;
            symbol: string;
            security_type: string | null;
            geography: string | null;
            sector: string | null;
          }>)
      : [];
  const rawInfoBySymbol = new Map(underlyingRows.map((r) => [r.symbol, r]));

  const underlyingInfo = new Map<string, UnderlyingMeta>();
  for (const raw of rawList) {
    const canonical = canonicalUnderlying(raw);
    const found = rawInfoBySymbol.get(raw);
    if (!found) {
      diagnostics.push({
        kind: "unknown_underlying",
        symbol: raw,
        detail: `No securities row found for underlying ${raw} — treated as non-ETF with unknown sector/geography`,
      });
    }
    const isEtf = found ? ["etf", "mutual fund"].includes((found.security_type ?? "").toLowerCase()) : false;
    const existing = underlyingInfo.get(canonical);
    underlyingInfo.set(canonical, {
      isEtf: (existing?.isEtf ?? false) || isEtf,
      geography: existing?.geography ?? found?.geography ?? null,
      sector: existing?.sector ?? found?.sector ?? null,
      securityId: existing?.securityId ?? found?.id ?? null,
    });
  }

  const etfGeography = new Map<string, string>();
  for (const [canonical, meta] of underlyingInfo) {
    if (meta.isEtf && meta.geography) etfGeography.set(canonical, meta.geography);
  }

  // ─── Note 3 + instrument assembly ──────────────────────────────────
  const instruments: DefenseInstrument[] = [];
  for (const row of rows) {
    const isOption = (row.security_type ?? "").toLowerCase() === "option";
    const raw = rawUnderlyingOf(row);
    const canonical = canonicalUnderlying(raw);
    const meta = underlyingInfo.get(canonical);

    let exposure: number;
    let thetaPerDay: number | null | undefined;
    let delta: number | null | undefined;
    let daysToExpiry: number | undefined;
    let strike: number | undefined;
    let underlyingPrice: number | undefined;
    let greeksAvailable = false;

    if (isOption) {
      const g = greeksMap.get(row.security_id);
      if (g && g.greeksAvailable) {
        exposure = g.exposure;
        thetaPerDay = g.thetaPerDay;
        delta = g.delta;
        daysToExpiry = g.daysToExpiry ?? undefined;
        strike = g.strike ?? undefined;
        underlyingPrice = g.underlyingPrice ?? undefined;
        greeksAvailable = true;
      } else {
        exposure = optionExposureFallback(row.option_type, row.mv);
        thetaPerDay = null;
        delta = null;
        daysToExpiry = g?.daysToExpiry ?? undefined;
        strike = g?.strike ?? undefined;
        underlyingPrice = g?.underlyingPrice ?? undefined;
        greeksAvailable = false;
        const reasonDiag = greeksDiagBySymbol.get(row.symbol);
        diagnostics.push({
          kind: "greeks_fallback",
          symbol: row.symbol,
          detail: reasonDiag
            ? `Greeks unavailable (${reasonDiag.reason}) — using the ±2.5× market-value fallback`
            : `Greeks unavailable — using the ±2.5× market-value fallback`,
        });
      }
    } else {
      exposure = row.mv;
    }

    instruments.push({
      securityId: row.security_id,
      symbol: row.symbol,
      underlying: canonical,
      isOption,
      // Case-insensitive normalize — house rule (see options-greeks.ts:399).
      optionType: isOption ? ((row.option_type?.toUpperCase() ?? null) as "CALL" | "PUT" | null) : null,
      quantity: row.quantity,
      exposure,
      marketValue: row.mv,
      underlyingIsEtf: meta?.isEtf ?? false,
      sector: row.sector,
      geography: row.geography,
      greeksAvailable,
      ...(isOption ? { strike, daysToExpiry, thetaPerDay, delta, underlyingPrice } : {}),
    });
  }

  // ─── Group + classify ───────────────────────────────────────────────
  const groups = new Map<string, UnderlyingGroup>();
  for (const inst of instruments) {
    const g = groups.get(inst.underlying) ?? {
      underlying: inst.underlying,
      underlyingIsEtf: inst.underlyingIsEtf,
      instruments: [],
    };
    g.instruments.push(inst);
    groups.set(inst.underlying, g);
  }
  const classifyResult = classifyBook(groups);

  // ─── Note 5: attribution context ────────────────────────────────────
  const sectorWeights = getEtfSectorWeights(db);
  let totalLongExposure = 0;
  const longExposureBySector = new Map<string, number>();
  const longExposureByGeography = new Map<string, number>();

  for (const inst of instruments) {
    if (inst.exposure <= 0) continue;
    totalLongExposure += inst.exposure;

    if (!inst.isOption) {
      const parts = explodeHoldingBySector(
        inst.symbol,
        securityTypeById.get(inst.securityId) ?? null,
        inst.exposure,
        sectorWeights,
        inst.sector
      );
      for (const p of parts) {
        longExposureBySector.set(p.sector, (longExposureBySector.get(p.sector) ?? 0) + p.value);
      }
    } else {
      const meta = underlyingInfo.get(inst.underlying);
      const sector = meta?.sector ?? inst.sector ?? "Unknown";
      longExposureBySector.set(sector, (longExposureBySector.get(sector) ?? 0) + inst.exposure);
    }

    const meta = underlyingInfo.get(inst.underlying);
    const geo = meta?.geography ?? inst.geography ?? "Unknown";
    longExposureByGeography.set(geo, (longExposureByGeography.get(geo) ?? 0) + inst.exposure);
  }

  const tier1CreditedBySector = new Map<string, number>();
  for (const pair of classifyResult.pairs) {
    if (pair.offsetCredited > 0) {
      const key = pair.sector ?? "Unknown";
      tier1CreditedBySector.set(key, (tier1CreditedBySector.get(key) ?? 0) + pair.offsetCredited);
    }
  }

  // Wrap resolveProxyBeta: attributeProxies only calls this once sector AND
  // geography routing have both failed, so every call here IS "landed on the
  // beta route" — push no_sector_weights unconditionally, assumed_beta only
  // when the resolved source is "assumed".
  const resolveBeta = (symbol: string): ResolvedBeta => {
    diagnostics.push({
      kind: "no_sector_weights",
      symbol,
      detail: `No cached sector weights or geography match for ${symbol} — routed to beta-weighted broad-book credit`,
    });
    const result = resolveProxyBeta(db, symbol);
    if (result.source === "assumed") {
      diagnostics.push({
        kind: "assumed_beta",
        symbol,
        detail: `No cached or computable beta for ${symbol} — assumed β=1.0`,
      });
    }
    return result;
  };

  const attributionCtx: AttributionContext = {
    sectorWeights,
    etfGeography,
    longExposureBySector,
    longExposureByGeography,
    tier1CreditedBySector,
    totalLongExposure,
    resolveBeta,
  };

  const { proxies, sectorCoverage } = attributeProxies(classifyResult.proxyCandidates, attributionCtx);

  // ─── Note 6: hedge score inputs ──────────────────────────────────────
  const pairsByUnderlying = new Map(classifyResult.pairs.map((p) => [p.underlying, p]));
  const scoreInputs: Array<{ instrument: DefenseInstrument; protects: string; protectedNotional: number }> = [];

  for (const pair of classifyResult.pairs) {
    if (pair.offsetExposure <= 0) continue;
    const coreSign = Math.sign(pair.coreExposure);
    const opposing = pair.instruments.filter((i) => i.isOption && Math.sign(i.exposure) === -coreSign);
    const creditRatio = pair.offsetCredited / pair.offsetExposure;
    for (const inst of opposing) {
      scoreInputs.push({
        instrument: inst,
        protects: pair.underlying,
        protectedNotional: Math.abs(inst.exposure) * creditRatio,
      });
    }
  }

  // Spill double-attribution guard: a tier1_spill proxy candidate shares its
  // `instruments` array with the pair it spilled from. Score the pair-side
  // fraction above (credited/offset) and the spill-side fraction here
  // (spill/offset) — the two fractions sum to 1, so the same dollar is never
  // scored twice.
  //
  // Index coupling: attributeProxies() emits exactly one ProxyHedge per
  // ProxyCandidate, IN ORDER — proxies[i] always describes
  // classifyResult.proxyCandidates[i]. Don't reorder either array independently.
  classifyResult.proxyCandidates.forEach((candidate, i) => {
    const hedge = proxies[i];
    const routeDescription = describeProxyRoute(hedge);
    // Only protective (negative-exposure) instruments earn a hedge-book row.
    // no_core_etf/tier1_spill candidates already carry all-protective
    // instruments (filter is a no-op there); etf_negative_stack's
    // `instruments` is the WHOLE underlying group — including opposing calls
    // that offset the short — which must never surface as a "hedge".
    const protective = candidate.instruments.filter((inst) => inst.exposure < 0);
    if (candidate.source === "tier1_spill") {
      const pair = pairsByUnderlying.get(candidate.underlying);
      const ratio = pair && pair.offsetExposure > 0 ? candidate.protectiveNotional / pair.offsetExposure : 0;
      for (const inst of protective) {
        scoreInputs.push({
          instrument: inst,
          protects: routeDescription,
          protectedNotional: Math.abs(inst.exposure) * ratio,
        });
      }
    } else {
      // Scale to the credited notional so an etf_negative_stack core's full
      // (pre-offset) exposure never overstates what's actually protecting the
      // book — mirrors the tier1_spill ratio above. No-op (ratio 1) for
      // no_core_etf, whose protectiveNotional already equals the sum of its
      // (already all-protective) instruments' exposure.
      const protectiveSum = sum(protective.map((inst) => Math.abs(inst.exposure)));
      const ratio = protectiveSum > 0 ? candidate.protectiveNotional / protectiveSum : 0;
      for (const inst of protective) {
        scoreInputs.push({
          instrument: inst,
          protects: routeDescription,
          protectedNotional: Math.abs(inst.exposure) * ratio,
        });
      }
    }
  });

  const hedgeScores = scoreHedges(scoreInputs);

  // ─── Note 7: summary ─────────────────────────────────────────────────
  let shortExposure = 0;
  let netExposure = 0;
  let grossExposure = 0;
  for (const inst of instruments) {
    netExposure += inst.exposure;
    grossExposure += Math.abs(inst.exposure);
    if (inst.exposure < 0) shortExposure += inst.exposure;
  }

  let protectiveNotional = 0;
  for (const pair of classifyResult.pairs) protectiveNotional += pair.offsetCredited;
  for (const proxy of proxies) {
    for (const c of proxy.creditedTo) protectiveNotional += c.credited;
  }

  const summary: DefenseSummary = {
    longExposure: totalLongExposure,
    shortExposure,
    protectiveNotional,
    protectionRatio: totalLongExposure > 0 ? protectiveNotional / totalLongExposure : null,
    netExposure,
    grossExposure,
    hedgeCount: hedgeScores.length,
  };

  // ─── Note 8: ranked exposures ────────────────────────────────────────
  function coreSecurityId(insts: DefenseInstrument[], canonical: string): number | null {
    const core = insts.find((i) => !i.isOption);
    if (core) return core.securityId;
    return underlyingInfo.get(canonical)?.securityId ?? null;
  }

  const rankedExposures: RankedExposure[] = [];
  for (const pair of classifyResult.pairs) {
    rankedExposures.push({
      underlying: pair.underlying,
      netExposure: pair.netExposure,
      pctOfBook: totalLongExposure > 0 ? Math.abs(pair.netExposure) / totalLongExposure : null,
      tier1CoveragePct: pair.coveragePct,
      sectorProxyCoveragePct: pair.sector
        ? sectorCoverage.find((s) => s.sector === pair.sector)?.coveragePct ?? null
        : null,
      classification: pair.classification,
      hasAmplifiers: pair.hasAmplifiers,
      sector: pair.sector,
      securityId: coreSecurityId(pair.instruments, pair.underlying),
    });
  }
  for (const bet of classifyResult.standaloneBets) {
    const sector = bet.instruments.find((i) => i.sector)?.sector ?? null;
    rankedExposures.push({
      underlying: bet.underlying,
      netExposure: bet.exposure,
      pctOfBook: totalLongExposure > 0 ? Math.abs(bet.exposure) / totalLongExposure : null,
      tier1CoveragePct: null,
      sectorProxyCoveragePct: sector ? sectorCoverage.find((s) => s.sector === sector)?.coveragePct ?? null : null,
      // Standalone bets are, by definition, never paired with an offsetting
      // instrument — "unhedged" is the PairClassification value that matches.
      classification: "unhedged",
      hasAmplifiers: false,
      sector,
      securityId: coreSecurityId(bet.instruments, bet.underlying),
    });
  }
  rankedExposures.sort((a, b) => Math.abs(b.netExposure) - Math.abs(a.netExposure));

  return {
    summary,
    pairs: classifyResult.pairs,
    proxies,
    sectorCoverage,
    standaloneBets: classifyResult.standaloneBets,
    rankedExposures,
    hedgeScores,
    diagnostics,
  };
}
