/**
 * Factor-anchored scenario recipes.
 *
 * Each recipe names a SUBJECT — the cohort the scenario is actually about
 * (a sector, an industry, a fund category, foreign-domiciled names, or a
 * factor cohort) — and prices it on the PRIMARY shock path: the headline
 * move, floored at membership and scaled UP by the position's factor
 * buckets. Everything else takes a weaker SPILLOVER leg, an explicit
 * per-recipe fraction of the same headline move. Sector floors are applied
 * worse-of (a floor can deepen a mild result, it never replaces a harsher
 * one).
 *
 * Why (QA finding `analysis-scenarios--generic-factor-bucket-subject-sector-
 * least-impacted`, ruled 2026-09-02, fixed 2026-09-03): the previous engine
 * pushed each scenario through ONE generic factor bucket and used
 * `sectorOverrides` as a REPLACEMENT, so the scenario's own subject was
 * systematically the LEAST affected cohort — healthcare names pinned at the
 * -10% "floor" in a healthcare shock while an unrelated Very-High-regulatory-
 * risk name took -16.8%; the semiconductor pure-play at -10% in "Semi cycle
 * -15%" while a mega-cap internet name took -24%; the foreign ADR at 0.0% in
 * "USD strength +5%".
 *
 * Methodology is exposed alongside the result so the user can audit how a
 * given P&L number was derived — keep those strings TRUE to the math.
 */

import type Database from "better-sqlite3";
import type { FactorColumn } from "@/lib/factors";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import type { ScenarioDefinition, ScenarioResult, PositionImpact } from "./scenarios";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { explodeHoldingBySector } from "./explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { delta } from "./options-greeks";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";

// ─── Per-factor bucket sensitivities ─────────────────────────────────────
//
// Each factor maps a bucket label (No / Low / Moderate / High / Very High,
// plus factor-specific values like "Growth" / "Value") to a multiplier
// applied to the scenario's shock magnitude. 1.0 = full exposure, 0 = no
// exposure, negative = inverse exposure.

type BucketMultipliers = Record<string, number>;

export const FACTOR_SHOCK_SENSITIVITIES: Record<FactorColumn, BucketMultipliers> = {
  interest_rate_sensitive: {
    No: 0, Low: 0.10, Moderate: 0.50, High: 1.00, "Very High": 1.50,
  },
  growth_vs_value: {
    // Value is 0, not negative: on a hawkish surprise value FALLS LESS than
    // growth — it does not rally. A negative multiplier made No-rate-
    // sensitivity Value names spuriously GAIN on rate-shock scenarios.
    Growth: 1.00, Value: 0, Blend: 0.25, Unknown: 0,
  },
  cyclical: {
    No: 0, Low: 0.25, Moderate: 0.50, High: 1.00, "Very High": 1.30,
    Cyclical: 1.00, Defensive: -0.50,
  },
  international_exposure: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.30,
    // The classifier also emits the label "International" for this factor (35
    // live securities on 2026-09-03: TSM, MELI, IDEV, …). It ranks in the same
    // tier as High in FACTOR_SORT_RANK (lib/factors.ts), and leaving it
    // unmapped scored those names 0 — the "foreign ADR takes 0.0% in USD
    // strength +5%" half of the 2026-09-03 QA finding.
    International: 1.00,
  },
  geopolitical_onshoring: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.30,
  },
  tariff_exposure: {
    No: 0, Low: 0.20, Moderate: 0.60, High: 1.00, "Very High": 1.40,
  },
  ai_exposure: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.40,
  },
  crypto_adjacent: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.40,
    // Same vocabulary-gap class as international_exposure's "International":
    // the shared factor vocabulary treats crypto as a binary "Yes" (ranked
    // Very-High-equivalent in FACTOR_SORT_RANK). No live rows carry it today,
    // but an unmapped label scores 0 — silently exempting a miner from the
    // crypto scenario.
    Yes: 1.40,
  },
  regulatory_risk: {
    No: 0, Low: 0.25, Moderate: 0.60, High: 1.00, "Very High": 1.40,
  },
};

// ─── Subject membership ──────────────────────────────────────────────────

/**
 * Multiplier floor for a position that belongs to the subject STRUCTURALLY —
 * its sector / industry / fund category / domicile IS what the scenario is
 * about. 1.0 means "takes the full headline move even with no factor
 * evidence": a healthcare name in a healthcare shock never escapes the
 * headline just because the LLM factor pass called its regulatory risk Low.
 */
export const STRUCTURAL_SUBJECT_FLOOR = 1.0;

/**
 * The spillover leg is capped at |shock × spillover|: a non-subject name can
 * never transmit MORE than the headline move. This cap, plus the rule that
 * every recipe's |spillover| is smaller than its weakest membership floor,
 * is what makes "the subject moves furthest" a construction guarantee rather
 * than a per-recipe coincidence.
 */
const SPILLOVER_INTENSITY_CAP = 1.0;

/** Geography labels that mean "US revenue base" (lowercase). */
const DOMESTIC_GEOGRAPHIES = new Set(["us", "usa", "u.s.", "united states", "domestic"]);

/**
 * How a recipe decides which positions ARE the scenario. Selectors are OR-ed;
 * structural hits (sector / industry / fund category / domicile) carry the
 * 1.0 floor, factor hits carry their own `minMultiplier` floor so within-
 * cohort gradation survives.
 */
export interface ScenarioSubject {
  /** Plain-English cohort description — rendered in the methodology string. */
  label: string;
  /** GICS sectors that ARE the subject; ETF sleeves count per look-through weight. */
  sectors?: string[];
  /** Case-insensitive substrings matched against `securities.industry`. */
  industries?: string[];
  /** Case-insensitive substrings matched against `securities.fund_category`. */
  fundCategories?: string[];
  /** Non-US geography or non-USD listing counts as subject (FX scenarios). */
  foreignDomiciled?: boolean;
  /** Factor-bucket membership: bucket multiplier ≥ minMultiplier ⇒ subject. */
  factors?: Array<{ column: FactorColumn; minMultiplier: number }>;
}

// ─── Recipes ─────────────────────────────────────────────────────────────

export interface ScenarioRecipe {
  id: string;
  name: string;
  description: string;
  category: "rate" | "fx" | "tariff" | "ai" | "energy" | "semi" | "healthcare" | "crypto";
  /** The SUBJECT's headline move (signed return). */
  shockMagnitude: number;
  primaryFactor: FactorColumn;
  /**
   * Additional factor weights applied alongside the primary. Default 1.0
   * multiplier for the primary factor.
   */
  factorMultipliers?: Partial<Record<FactorColumn, number>>;
  /** What this scenario is about — the primary shock path. */
  subject: ScenarioSubject;
  /**
   * Signed fraction of `shockMagnitude` transmitted to NON-subject names,
   * scaled by their own (capped) factor blend. Negative = the spillover runs
   * the opposite way to the subject (oil: producers rally, consumers drift).
   * Must be smaller in magnitude than the recipe's weakest membership floor.
   */
  spillover: number;
  /**
   * Per-sector FLOORS, not overrides: applied worse-of for a negative value
   * (`min`) and better-of for a positive one (`max`). A floor can deepen a
   * mild result; it can never cap a harsher one.
   */
  sectorFloors?: Record<string, number>;
  methodology: string;
  /**
   * Set by matchScenariosToThemes when this recipe's primaryFactor matches an
   * active macro theme's factor_label. UI renders a "live now" pill.
   */
  liveNowReason?: string;
}

export const SCENARIO_RECIPES: ScenarioRecipe[] = [
  {
    id: "rate_shock_up_25bp",
    name: "Rate shock +25bp",
    description: "Fed surprise hike 25bp — bonds drop by duration × Δy, growth stocks lag.",
    category: "rate",
    shockMagnitude: -0.025, // approximate equity-side impact per 25bp surprise
    primaryFactor: "interest_rate_sensitive",
    factorMultipliers: { growth_vs_value: 0.50 },
    subject: {
      label: "Rate-sensitive assets — bonds, long-duration growth equity, REITs and utilities",
      sectors: ["Real Estate", "Utilities"],
      factors: [
        { column: "interest_rate_sensitive", minMultiplier: 0.50 }, // Moderate+
        { column: "growth_vs_value", minMultiplier: 0.50 }, // Growth (long-duration cash flows)
      ],
    },
    // A hawkish 25bp surprise is worth roughly -0.6% to the broad tape vs
    // -2.5% for the rate-sensitive cohort.
    spillover: 0.25,
    methodology:
      "Subject = rate-sensitive assets: bonds (priced off duration, not buckets), " +
      "long-duration growth equity, REITs and utilities. Subject P&L = position_value × -2.5% × " +
      "max(membership floor, blend), blend = interest_rate_sensitive bucket + 0.5 × growth tilt " +
      "(Value adds nothing — it falls less than growth on a hike, it doesn't rally). " +
      "Everything else takes the spillover leg: 25% of the shock scaled by its own capped blend " +
      "(≈ -0.6% at most). Bonds: duration × 25bp / 100. Options: inherit the underlying's rate " +
      "exposure, levered by delta elasticity (Ω = Δ·S/V, |Ω| ≤ 8, fallback 2.5× when unpriceable). " +
      "Calibrated to typical 25bp surprise-day historical reaction.",
  },
  {
    id: "usd_strength_5pct",
    name: "USD strength +5%",
    description: "Dollar rallies 5% — international revenue stocks underperform; small caps benefit.",
    category: "fx",
    shockMagnitude: -0.05,
    primaryFactor: "international_exposure",
    subject: {
      label: "Foreign-revenue and non-US-domiciled names",
      foreignDomiciled: true,
      factors: [{ column: "international_exposure", minMultiplier: 0.50 }], // Moderate+
    },
    // Translation drag is subject-specific; domestic-only names are close to
    // flat (relative winners), so the spillover leg is deliberately small.
    spillover: 0.10,
    methodology:
      "Subject = foreign-revenue and non-US-domiciled names: international_exposure Moderate or " +
      "higher, OR a non-US geography / non-USD listing — the structural test catches the ADRs the " +
      "factor pass missed. Subject P&L = position_value × -5% × max(1.0, international bucket). " +
      "Domestic names take the spillover leg — 10% of the shock scaled by their own international " +
      "bucket — so a domestic-only name is close to flat.",
  },
  {
    id: "tariff_escalation_10pt",
    name: "Tariff escalation +10pt",
    description: "Avg tariff rate up 10 percentage points — supply-chain-exposed names hit.",
    category: "tariff",
    shockMagnitude: -0.08,
    primaryFactor: "tariff_exposure",
    factorMultipliers: { geopolitical_onshoring: -0.40 },
    subject: {
      label: "Tariff-exposed supply chains",
      factors: [{ column: "tariff_exposure", minMultiplier: 0.50 }], // Moderate+
    },
    // A tariff escalation is a broad risk-off event: ≈ -2% for names with no
    // direct supply-chain exposure but some second-order sensitivity.
    spillover: 0.25,
    methodology:
      "Subject = tariff-exposed supply chains (tariff_exposure Moderate or higher). Subject P&L = " +
      "position_value × -8% × max(0.5, tariff bucket - 0.4 × onshoring bucket), so reshoring " +
      "beneficiaries keep their offset inside the subject cohort. Non-subject names take the " +
      "spillover leg — 25% of the shock scaled by that same capped blend — which leaves a pure " +
      "onshoring beneficiary with a small lift.",
  },
  {
    id: "ai_capex_pause",
    name: "AI capex pause",
    description: "Big tech announces AI capex deceleration — semis and infrastructure names sell off.",
    category: "ai",
    shockMagnitude: -0.15,
    primaryFactor: "ai_exposure",
    subject: {
      label: "AI-levered names — semis, AI infrastructure, data-center adjacencies",
      industries: ["semiconductor"],
      fundCategories: ["semiconductor"],
      factors: [{ column: "ai_exposure", minMultiplier: 0.50 }], // Moderate+
    },
    // The AI complex is a large share of index cap: a -15% drawdown there
    // drags a name with partial AI sensitivity by roughly -3%.
    spillover: 0.20,
    methodology:
      "Subject = AI-levered names: ai_exposure Moderate or higher, plus semiconductor industry / " +
      "fund-category members. Subject P&L = position_value × -15% × max(membership floor, ai bucket) " +
      "— Very-High names take ≈ -21%. Everything else takes the spillover leg: 20% of the shock " +
      "scaled by its own AI bucket, so a book with no AI story barely moves. Calibrated to an " +
      "NDX-95 analog: AI-pure names dropped ~20% over 2 weeks.",
  },
  {
    id: "oil_shock_10dollar",
    name: "Oil shock +$10/bbl",
    description: "Brent +$10 — cyclical-sensitive names drift; energy producers rally.",
    category: "energy",
    shockMagnitude: 0.12, // the SUBJECT here benefits: energy producers rally
    primaryFactor: "cyclical",
    subject: {
      label: "Energy producers",
      sectors: ["Energy"],
      industries: ["oil", "pipeline", "energy"],
      fundCategories: ["energy", "oil"],
    },
    // Oil consumers move the OTHER way: -1/3 of the +12% producer move ≈ -4%
    // for a fully cyclical name, scaled by its cyclicality bucket.
    spillover: -1 / 3,
    sectorFloors: {
      Utilities: -0.04,
      Industrials: -0.05,
      "Consumer Discretionary": -0.06,
    },
    methodology:
      "Subject = energy producers (Energy sector, oil / pipeline industries, energy fund " +
      "categories) — the beneficiaries: position_value × +12% × max(1.0, cyclicality bucket). " +
      "Everything else takes the spillover leg in the OPPOSITE direction (-1/3 of the subject " +
      "move, ≈ -4%) scaled by its cyclicality bucket, so defensives drift up slightly while " +
      "Very-High cyclicals take the full drag. Sector floors apply worse-of: Utilities -4%, " +
      "Industrials -5%, Consumer Discretionary -6%. Calibrated to $10 Brent shock historical " +
      "analogs (2018, 2022).",
  },
  {
    id: "semi_cycle_minus_15pct",
    name: "Semi cycle -15%",
    description: "Memory pricing rolls over + China overcapacity — semis index -15%.",
    category: "semi",
    shockMagnitude: -0.15,
    primaryFactor: "tariff_exposure",
    factorMultipliers: { ai_exposure: 0.60 },
    subject: {
      label: "Semiconductors and semi-cap equipment",
      industries: ["semiconductor"],
      fundCategories: ["semiconductor"],
    },
    spillover: 0.25,
    sectorFloors: { Technology: -0.10 },
    methodology:
      "Subject = semiconductors and semi-cap equipment (industry / fund-category membership — NOT " +
      "the whole Technology sector). Subject P&L = position_value × -15% × max(1.0, tariff bucket + " +
      "0.6 × AI bucket). Non-semi names take the spillover leg (25% of the shock scaled by that " +
      "capped blend); the across-Tech floor of -10% then applies worse-of, deepening a mild result " +
      "but never capping a semi's. Mid-cycle semi correction analog.",
  },
  {
    id: "healthcare_reg_shock",
    name: "Healthcare regulatory shock",
    description: "Drug pricing reform or MA cuts — managed care + pharma sell off.",
    category: "healthcare",
    shockMagnitude: -0.12,
    primaryFactor: "regulatory_risk",
    subject: {
      label: "Healthcare — managed care, pharma, biotech, providers",
      sectors: ["Healthcare"],
      industries: ["pharmaceutic", "biotech", "healthcare", "health care", "medical"],
      fundCategories: ["health care", "healthcare", "biotech"],
    },
    // Drug-pricing headlines are sector news: the read-through to an
    // unrelated book is small.
    spillover: 0.15,
    methodology:
      "Subject = healthcare — managed care, pharma, biotech, providers (sector, industry or " +
      "fund-category membership; ETF sleeves count per look-through weight). Subject P&L = " +
      "position_value × -12% × max(1.0, regulatory_risk bucket), so a Very-High-regulatory " +
      "healthcare name takes ≈ -16.8% while an unclassified healthcare name still takes the full " +
      "-12%. Everything else takes the spillover leg: 15% of the shock scaled by its own regulatory " +
      "bucket. Calibrated to a drug-pricing-headline day-of-news analog.",
  },
  {
    id: "crypto_minus_30pct",
    name: "Crypto -30%",
    description: "BTC drawdown 30% — crypto-adjacent equities + miners hit hard.",
    category: "crypto",
    shockMagnitude: -0.30,
    primaryFactor: "crypto_adjacent",
    subject: {
      label: "Crypto-adjacent equities — miners, exchanges, crypto-treasury names",
      fundCategories: ["crypto"],
      factors: [{ column: "crypto_adjacent", minMultiplier: 0.50 }], // Moderate+
    },
    // A BTC drawdown in isolation has little direct read-through to unrelated
    // equities, so the spillover leg is the smallest in the catalog.
    spillover: 0.10,
    methodology:
      "Subject = crypto-adjacent equities — miners, exchanges, crypto-treasury names " +
      "(crypto_adjacent Moderate or higher, or a crypto fund category). Subject P&L = " +
      "position_value × -30% × max(0.5, crypto bucket): Very-High names (miners, pure exchanges) " +
      "take ≈ -42%, Moderate exposure ≈ -15%. Everything else takes the spillover leg — 10% of the " +
      "shock scaled by its own crypto bucket — so a book with no crypto exposure is untouched.",
  },
];

// ─── Computation ─────────────────────────────────────────────────────────

interface RecipePositionRow {
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string;
  sector: string | null;
  industry: string | null;
  fund_category: string | null;
  geography: string | null;
  currency: string | null;
  market_value: number;
  duration_years: number | null;
  interest_rate_sensitive: string | null;
  growth_vs_value: string | null;
  cyclical: string | null;
  international_exposure: string | null;
  geopolitical_onshoring: string | null;
  tariff_exposure: string | null;
  ai_exposure: string | null;
  crypto_adjacent: string | null;
  regulatory_risk: string | null;
  // Option fields (null for non-options) — used for elasticity
  strike_price: number | null;
  expiration_date: string | null;
  option_type: string | null;
  own_price: number | null;
  underlying_price: number | null;
  underlying_iv: number | null;
}

function bucketMultiplier(factor: FactorColumn, bucket: string | null): number {
  if (!bucket) return 0;
  return FACTOR_SHOCK_SENSITIVITIES[factor][bucket] ?? 0;
}

/** Case-insensitive GICS-aware sector comparison (never string-equal raw). */
function sectorEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = (normalizeSector(a) ?? a).trim().toLowerCase();
  const nb = (normalizeSector(b) ?? b).trim().toLowerCase();
  return na !== "" && na === nb;
}

function matchesAnySubstring(value: string | null, needles: string[] | undefined): boolean {
  if (!value || !needles?.length) return false;
  const haystack = value.toLowerCase();
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

function isForeignDomiciled(pos: RecipePositionRow): boolean {
  const currency = pos.currency?.trim().toUpperCase();
  if (currency && currency !== "USD") return true;
  const geography = pos.geography?.trim().toLowerCase();
  return Boolean(geography && !DOMESTIC_GEOGRAPHIES.has(geography));
}

/**
 * The multiplier FLOOR this position earns from position-level subject
 * selectors (industry / fund category / domicile / factor buckets), or null
 * when it is not a subject by any of them. Sector membership is decided per
 * look-through slice in computeRecipeScenario, not here.
 */
function positionSubjectFloor(subject: ScenarioSubject, pos: RecipePositionRow): number | null {
  if (matchesAnySubstring(pos.industry, subject.industries)) return STRUCTURAL_SUBJECT_FLOOR;
  if (matchesAnySubstring(pos.fund_category, subject.fundCategories)) return STRUCTURAL_SUBJECT_FLOOR;
  if (subject.foreignDomiciled && isForeignDomiciled(pos)) return STRUCTURAL_SUBJECT_FLOOR;

  let floor: number | null = null;
  for (const selector of subject.factors ?? []) {
    const mult = bucketMultiplier(selector.column, pos[selector.column]);
    if (mult >= selector.minMultiplier) floor = Math.max(floor ?? 0, selector.minMultiplier);
  }
  return floor;
}

/**
 * Fixed income and cash sit OUT of the equity spillover channel: a Treasury
 * bill does not drift because semiconductors rolled over, whatever Low factor
 * buckets the classifier hung on it. They still take the SUBJECT path when a
 * scenario is about them — the rate shock prices bonds off duration — this
 * only silences the second-order leg. Cash identity is single-sourced through
 * isCashEquivalentSecurity (never a hand-rolled money_market list).
 */
function transmitsEquitySpillover(pos: RecipePositionRow): boolean {
  if (pos.security_type.toLowerCase() === "bond") return false;
  return !isCashEquivalentSecurity(pos);
}

/** Primary bucket + weighted secondary buckets — the position's factor blend. */
function factorBlend(recipe: ScenarioRecipe, pos: RecipePositionRow): number {
  let total = bucketMultiplier(recipe.primaryFactor, pos[recipe.primaryFactor]);
  for (const [factor, weight] of Object.entries(recipe.factorMultipliers ?? {})) {
    if (!weight) continue;
    total += bucketMultiplier(factor as FactorColumn, pos[factor as FactorColumn]) * weight;
  }
  return total;
}

/**
 * Sector floors are a FLOOR, not a replacement: a negative floor takes the
 * worse of (the position is at least this bad), a positive floor the better
 * of. Pre-2026-09-03 this was `override ?? fallback`, which made every
 * scenario's own subject sector its least-affected cohort.
 */
export function applySectorFloor(change: number, floor: number | undefined): number {
  if (floor == null || !Number.isFinite(floor) || floor === 0) return change;
  return floor < 0 ? Math.min(change, floor) : Math.max(change, floor);
}

function sectorFloorFor(
  floors: Record<string, number> | undefined,
  sector: string | null
): number | undefined {
  if (!floors) return undefined;
  for (const [key, value] of Object.entries(floors)) {
    if (sectorEquals(key, sector)) return value;
  }
  return undefined;
}

/** Fallback when elasticity inputs are missing (no underlying price / IV /
 *  option price). Sign carries the option's direction. Exported so the
 *  delta-exposure column (lib/compute/exposure.ts) shares the convention. */
export const DEFAULT_OPTION_ELASTICITY = 2.5;

/** |Ω| clamp — deep-OTM short-dated options have huge theoretical elasticity
 *  but gamma/vol effects dominate there; a linear-delta model shouldn't
 *  extrapolate past this. */
const MAX_OPTION_ELASTICITY = 8;

/**
 * Option elasticity Ω = Δ·S/V: the % move in the option per 1% move in the
 * underlying (linear-delta approximation). Signed — puts carry negative Ω so
 * a down-shock on the underlying produces a positive option move. Falls back
 * to ±2.5 when pricing inputs are unavailable.
 */
function optionElasticity(pos: RecipePositionRow, riskFreeRate: number): number {
  const isPut = (pos.option_type ?? "").toUpperCase().startsWith("P");
  const fallback = (isPut ? -1 : 1) * DEFAULT_OPTION_ELASTICITY;

  const S = pos.underlying_price;
  const V = pos.own_price;
  const K = pos.strike_price;
  if (S == null || S <= 0 || V == null || V <= 0 || K == null || K <= 0 || !pos.expiration_date) {
    return fallback;
  }
  const T = (new Date(pos.expiration_date).getTime() - Date.now()) / (365 * 24 * 3600 * 1000);
  if (!Number.isFinite(T) || T <= 0) return fallback;

  const sigma = pos.underlying_iv ?? 0.30;
  const d = delta(S, K, T, riskFreeRate, sigma, isPut ? "PUT" : "CALL");
  const omega = (d * S) / V;
  if (!Number.isFinite(omega) || omega === 0) return fallback;
  return Math.max(-MAX_OPTION_ELASTICITY, Math.min(MAX_OPTION_ELASTICITY, omega));
}

/**
 * Compute the per-position P&L impact for a factor-anchored recipe.
 *
 * Subject positions take `shock × max(membership floor, factor blend)`;
 * everything else takes `shock × spillover × clamp(blend, ±1)`. Bonds use
 * duration-based pricing for rate scenarios (they ARE the subject there),
 * and options lever whatever their underlying's path produced.
 */
export function computeRecipeScenario(
  db: Database.Database,
  recipe: ScenarioRecipe,
  options?: { accountId?: number; accountIds?: number[] }
): ScenarioResult {
  const accountIds = options?.accountIds ?? (options?.accountId ? [options.accountId] : undefined);
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

  const positions = db
    .prepare(
      `
      WITH latest_holdings AS (
        SELECT h.security_id, SUM(h.quantity) AS total_qty
        FROM holdings h
        WHERE ${latestHoldingsPredicate({ accountFilter })}
        GROUP BY h.security_id
      ),
      latest_prices AS (
        SELECT security_id, close_price
        FROM prices
        WHERE (security_id, date) IN (
          SELECT security_id, MAX(date) FROM prices GROUP BY security_id
        )
      )
      SELECT
        lh.security_id,
        s.symbol,
        s.name AS security_name,
        s.security_type,
        COALESCE(s.sector, s_u.sector) AS sector,
        COALESCE(s.industry, s_u.industry) AS industry,
        COALESCE(s.fund_category, s_u.fund_category) AS fund_category,
        COALESCE(s.geography, s_u.geography) AS geography,
        COALESCE(s.currency, s_u.currency) AS currency,
        s.duration_years,
        s.strike_price,
        s.expiration_date,
        s.option_type,
        lp.close_price AS own_price,
        lp_u.close_price AS underlying_price,
        q_u.iv_underlying AS underlying_iv,
        COALESCE(sf.interest_rate_sensitive, sf_u.interest_rate_sensitive) AS interest_rate_sensitive,
        COALESCE(sf.growth_vs_value, sf_u.growth_vs_value) AS growth_vs_value,
        COALESCE(sf.cyclical, sf_u.cyclical) AS cyclical,
        COALESCE(sf.international_exposure, sf_u.international_exposure) AS international_exposure,
        COALESCE(sf.geopolitical_onshoring, sf_u.geopolitical_onshoring) AS geopolitical_onshoring,
        COALESCE(sf.tariff_exposure, sf_u.tariff_exposure) AS tariff_exposure,
        COALESCE(sf.ai_exposure, sf_u.ai_exposure) AS ai_exposure,
        COALESCE(sf.crypto_adjacent, sf_u.crypto_adjacent) AS crypto_adjacent,
        COALESCE(sf.regulatory_risk, sf_u.regulatory_risk) AS regulatory_risk,
        ${adjustedMarketValueSQL("lh.total_qty", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS market_value
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      -- Option → underlying inheritance (the same COALESCE rule every
      -- factor-coverage surface applies — options have no factor rows of
      -- their own by design and contributed exactly $0 to scenarios before).
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
      LEFT JOIN latest_prices lp_u ON lp_u.security_id = s_u.id
      LEFT JOIN security_quotes q_u ON q_u.security_id = s_u.id
      WHERE COALESCE(lp.close_price, 0) > 0
        AND ${liveOptionExpirationSql("s")}
      ORDER BY market_value DESC
    `
    )
    .all(...params) as RecipePositionRow[];

  const currentPortfolioValue = positions.reduce((s, p) => s + p.market_value, 0);

  // ETF look-through weights — needed whenever sector membership or a sector
  // floor can split a fund across buckets (single source: the same map
  // cash-deploy and the allocation breakdown use).
  const needsSectorLookThrough = Boolean(recipe.sectorFloors || recipe.subject.sectors?.length);
  const etfWeights = needsSectorLookThrough
    ? getEtfSectorWeights(db)
    : new Map<string, Array<{ sector: string; weight_pct: number }>>();

  const riskFreeRate = getRiskFreeRate(db);

  const impacts: PositionImpact[] = positions.map((pos) => {
    const blend = factorBlend(recipe, pos);
    const positionFloor = positionSubjectFloor(recipe.subject, pos);

    let changePercent: number;
    let subjectShare: number;

    if (recipe.category === "rate" && pos.security_type.toLowerCase() === "bond") {
      // Bonds ARE the subject of a rate shock, and duration prices them
      // better than any factor bucket could.
      const duration = pos.duration_years ?? 5;
      // Recipe shock is the equity-side impact for a 25bp move (~-0.025).
      // Convert to bps: -0.025 = -25bp on equities; the corresponding bond
      // hit is duration × Δy/100.
      const rateBpsMove = -recipe.shockMagnitude * 1000; // recipe.shockMagnitude in [-0.5, 0.5] → bps
      changePercent = -duration * rateBpsMove / 10000;
      subjectShare = 1;
    } else {
      // Per sector slice: a fund with cached weights can be part subject
      // (its healthcare sleeve) and part spillover (everything else).
      const parts = explodeHoldingBySector(
        pos.symbol,
        pos.security_type,
        pos.market_value,
        etfWeights,
        pos.sector
      );
      const mv = pos.market_value || 1;
      let weighted = 0;
      let share = 0;
      for (const part of parts) {
        const weight = part.value / mv;
        const sliceFloor = (recipe.subject.sectors ?? []).some((s) => sectorEquals(s, part.sector))
          ? STRUCTURAL_SUBJECT_FLOOR
          : positionFloor;
        const raw =
          sliceFloor != null
            ? // SUBJECT path — the headline move, floored at membership and
              // scaled up by the position's own factor buckets.
              recipe.shockMagnitude * Math.max(sliceFloor, blend)
            : // SPILLOVER path — an explicit fraction of the same move,
              // scaled by the (capped) blend so unrelated names barely move,
              // and silenced entirely for bonds / cash.
              (transmitsEquitySpillover(pos)
                ? recipe.shockMagnitude *
                  recipe.spillover *
                  Math.max(-SPILLOVER_INTENSITY_CAP, Math.min(SPILLOVER_INTENSITY_CAP, blend))
                : 0);
        weighted += weight * applySectorFloor(raw, sectorFloorFor(recipe.sectorFloors, part.sector));
        if (sliceFloor != null) share += weight;
      }
      changePercent = weighted;
      subjectShare = share;
    }

    // Options: the factor/sector math above describes the UNDERLYING's move
    // (factors are inherited via the COALESCE join). Lever it by elasticity
    // Ω = Δ·S/V — signed, so a held put GAINS on a down-shock — and clamp at
    // -100% (an option's price can't go below zero).
    if (pos.security_type.toLowerCase() === "option") {
      const omega = optionElasticity(pos, riskFreeRate);
      changePercent = Math.max(-1, changePercent * omega);
    }

    const estimatedChange = pos.market_value * changePercent;

    return {
      securityId: pos.security_id,
      symbol: pos.symbol,
      securityName: pos.security_name,
      securityType: pos.security_type,
      sector: pos.sector,
      currentValue: pos.market_value,
      estimatedChange,
      estimatedNewValue: pos.market_value + estimatedChange,
      changePercent,
      beta: 1.0, // factor-based math doesn't use beta; default for type compat
      subjectShare,
    };
  });

  const estimatedChange = impacts.reduce((s, p) => s + p.estimatedChange, 0);
  const estimatedPortfolioValue = currentPortfolioValue + estimatedChange;
  const estimatedChangePercent =
    currentPortfolioValue > 0 ? estimatedChange / currentPortfolioValue : 0;

  const sorted = [...impacts].sort((a, b) => a.estimatedChange - b.estimatedChange);
  const biggestLosers = sorted.filter((p) => p.estimatedChange < 0).slice(0, 5);
  const biggestWinners = sorted
    .filter((p) => p.estimatedChange > 0)
    .reverse()
    .slice(0, 5);

  return {
    scenario: recipeToScenarioDefinition(recipe),
    currentPortfolioValue,
    estimatedPortfolioValue,
    estimatedChange,
    estimatedChangePercent,
    positionImpacts: impacts,
    biggestLosers,
    biggestWinners,
  };
}

/**
 * Convert a recipe to the legacy ScenarioDefinition shape so UI code that
 * already iterates `PRESET_SCENARIOS` keeps working unchanged.
 */
export function recipeToScenarioDefinition(recipe: ScenarioRecipe): ScenarioDefinition {
  // Map recipe category → legacy category (legacy only has crash/rate/sector/custom)
  let legacyCategory: "crash" | "rate" | "sector" | "custom";
  switch (recipe.category) {
    case "rate":
      legacyCategory = "rate";
      break;
    case "fx":
    case "tariff":
    case "ai":
    case "energy":
    case "semi":
    case "healthcare":
    case "crypto":
      legacyCategory = "sector";
      break;
    default:
      legacyCategory = "custom";
  }
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    category: legacyCategory,
    marketMove: recipe.shockMagnitude,
    sectorMoves: recipe.sectorFloors,
    primaryFactor: recipe.primaryFactor,
  };
}

export function findRecipe(id: string): ScenarioRecipe | undefined {
  return SCENARIO_RECIPES.find((r) => r.id === id);
}

/**
 * Decorate each recipe with a `liveNowReason` string when its `primaryFactor`
 * matches an active macro theme's `factor_label`.
 *
 * - Returns a NEW array (never mutates input).
 * - When themes is empty every recipe gets `liveNowReason: undefined`.
 * - Direction is not filtered: any active theme whose factor_label matches
 *   makes the scenario "live" regardless of risk-on / risk-off direction.
 */
export function matchScenariosToThemes(
  recipes: ScenarioRecipe[],
  themes: Array<{ name: string; factor_label: string; direction: string; [key: string]: unknown }>
): ScenarioRecipe[] {
  if (themes.length === 0) {
    return recipes.map((r) => ({ ...r, liveNowReason: undefined }));
  }
  return recipes.map((r) => {
    const match = themes.find((t) => t.factor_label === r.primaryFactor);
    if (!match) return { ...r, liveNowReason: undefined };
    return { ...r, liveNowReason: match.name };
  });
}
