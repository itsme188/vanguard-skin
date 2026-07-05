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
