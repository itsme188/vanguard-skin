import type Database from "better-sqlite3";

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
