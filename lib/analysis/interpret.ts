/**
 * Single-source plain-English interpretation layer for Analysis metrics.
 *
 * Every Analysis card shows a correct number; these helpers say what it
 * MEANS — one line, finance-professional register ("analytical colleague,
 * not coach"). Pure functions: value (+ optional context) in,
 * { text, tone } out. No DB, no React.
 *
 * Privacy rule (CLAUDE.md): texts that embed portfolio-derived dollar
 * amounts or share counts (theta/vega/delta) must be rendered inside
 * <PrivateText> at the call site. Threshold-style texts deliberately do
 * NOT echo the displayed number (the number is already on the card and
 * may be privacy-masked there).
 */

export type InterpretTone = "good" | "bad" | "neutral";

export interface Interpretation {
  text: string;
  tone: InterpretTone;
}

/** Subtle tone → text class mapping (existing muted-tint idiom). */
export function toneClass(tone: InterpretTone): string {
  if (tone === "good") return "text-up/80";
  if (tone === "bad") return "text-down/80";
  return "text-ink-faint";
}

// ─── Dollar / count formatting (local — interpretation strings only) ──

function fmtUsd(abs: number): string {
  if (abs >= 1000) return `$${(abs / 1000).toFixed(1)}K`;
  return `$${Math.round(abs)}`;
}

function fmtShareEquiv(abs: number): string {
  if (abs >= 1000) return `${(abs / 1000).toFixed(1)}K`;
  return `${Math.round(abs)}`;
}

// ─── Risk metrics ────────────────────────────────────────────────

/** Sharpe ratio (already risk-free-adjusted by the compute layer). */
export function interpretSharpe(sharpe: number): Interpretation {
  if (sharpe < 0) {
    return {
      text: "Returns haven't covered the risk-free rate over this window — the volatility wasn't paid for.",
      tone: "bad",
    };
  }
  if (sharpe < 0.5) {
    return {
      text: "Thin compensation per unit of risk — below the ~0.5 long-run equity norm.",
      tone: "neutral",
    };
  }
  if (sharpe >= 2.5) {
    return {
      text: "Exceptionally high — Sharpe this strong over a short window usually reflects a friendly regime; don't extrapolate it.",
      tone: "neutral",
    };
  }
  if (sharpe < 1) {
    return {
      text: "Solid risk-adjusted return — in line with long-run equity risk premia.",
      tone: "good",
    };
  }
  return {
    text: "Good risk-adjusted return — above 1.0 means you're being paid for the volatility you take.",
    tone: "good",
  };
}

/** Max drawdown as a positive fraction (0.15 = −15% peak-to-trough). */
export function interpretMaxDrawdown(fraction: number): Interpretation {
  if (fraction < 0.1) {
    return {
      text: "Shallow for an equity book — well inside normal pullback territory.",
      tone: "good",
    };
  }
  if (fraction < 0.2) {
    return {
      text: "Correction-grade — typical for equity-heavy portfolios, short of bear-market depth.",
      tone: "neutral",
    };
  }
  if (fraction < 0.35) {
    return {
      text: "Bear-market depth — the gain needed to recover is materially larger than the loss itself.",
      tone: "bad",
    };
  }
  return {
    text: "Severe — at this depth the required recovery gain approaches double the drawdown; sizing deserves a look.",
    tone: "bad",
  };
}

/** Current drawdown fraction; null = portfolio at its high-water mark. */
export function interpretCurrentDrawdown(
  fraction: number | null,
): Interpretation {
  if (fraction == null) {
    return { text: "At the high-water mark — no ground to recover.", tone: "good" };
  }
  if (fraction < 0.05) {
    return { text: "Within noise of the high — effectively fully recovered.", tone: "good" };
  }
  if (fraction < 0.15) {
    return {
      text: "Mid-pullback — normal give-back territory, not yet a structural drawdown.",
      tone: "neutral",
    };
  }
  return {
    text: "Deep below the prior peak — recovery now depends on more than market beta.",
    tone: "bad",
  };
}

/** Annualized volatility as a fraction (0.16 = 16%). */
export function interpretVolatility(annualized: number): Interpretation {
  if (annualized < 0.1) {
    return {
      text: "Well below broad-equity volatility (~15-16% long-run) — bond-like swings.",
      tone: "neutral",
    };
  }
  if (annualized < 0.18) {
    return {
      text: "In line with broad equity indices — the portfolio swings about like the market.",
      tone: "neutral",
    };
  }
  if (annualized < 0.25) {
    return {
      text: "Running hotter than the index — concentration or high-beta names are amplifying daily swings.",
      tone: "neutral",
    };
  }
  return {
    text: "Single-stock-level volatility at the portfolio level — position sizing is driving the risk.",
    tone: "bad",
  };
}

/**
 * Herfindahl index. `effectivePositions` defaults to 1/HHI when omitted.
 * Embeds the effective-position count (rendered plain elsewhere in the app).
 */
export function interpretHHI(
  hhi: number,
  effectivePositions?: number,
): Interpretation {
  if (!(hhi > 0)) {
    return { text: "No position weights to measure concentration on.", tone: "neutral" };
  }
  const eff = Math.round(effectivePositions ?? 1 / hhi);
  if (hhi > 0.25) {
    return {
      text: `Behaves like ~${eff} equal positions — highly concentrated; single-name risk dominates outcomes.`,
      tone: "bad",
    };
  }
  if (hhi > 0.15) {
    return {
      text: `Behaves like ~${eff} equal positions — concentrated; a handful of names drive the P&L.`,
      tone: "neutral",
    };
  }
  if (hhi > 0.06) {
    return {
      text: `Behaves like ~${eff} equal positions — reasonably diversified.`,
      tone: "neutral",
    };
  }
  return {
    text: `Behaves like ~${eff} equal positions — well diversified; no single name moves the book much.`,
    tone: "good",
  };
}

// ─── Market regression ───────────────────────────────────────────

/** Regression beta vs a benchmark (default phrasing: "the market"). */
export function interpretBeta(
  beta: number,
  benchmark = "the market",
): Interpretation {
  if (beta <= 0) {
    return {
      text: `Moves against ${benchmark} — net inverse/hedge exposure on a typical day.`,
      tone: "neutral",
    };
  }
  if (Math.abs(beta - 1) <= 0.05) {
    return {
      text: `Moves with ${benchmark} essentially one-for-one.`,
      tone: "neutral",
    };
  }
  const pct = Math.round(Math.abs(beta - 1) * 100);
  if (beta > 1) {
    return {
      text: `Moves ~${pct}% more than ${benchmark} on a typical day — amplified in both directions.`,
      tone: "neutral",
    };
  }
  return {
    text: `Moves ~${pct}% less than ${benchmark} on a typical day — dampened market exposure.`,
    tone: "neutral",
  };
}

/** Annualized alpha as a fraction (0.02 = +2pp/yr). */
export function interpretAlpha(alphaAnnual: number): Interpretation {
  if (alphaAnnual >= 0.02) {
    return {
      text: "Earning meaningfully more than your market exposure alone explains — selection is adding value.",
      tone: "good",
    };
  }
  if (alphaAnnual > -0.02) {
    return {
      text: "Within noise of zero — returns are roughly what your beta alone would have delivered.",
      tone: "neutral",
    };
  }
  return {
    text: "Lagging what your market exposure alone would have delivered — selection is detracting.",
    tone: "bad",
  };
}

/** Regression R² (0-1). */
export function interpretR2(r2: number): Interpretation {
  if (r2 > 0.8) {
    return {
      text: "Tight fit — the benchmark explains most of the variance, so the beta and alpha readings are reliable.",
      tone: "neutral",
    };
  }
  if (r2 >= 0.5) {
    return {
      text: "Moderate fit — benchmark explains roughly half the variance; beta and alpha are usable but imprecise.",
      tone: "neutral",
    };
  }
  return {
    text: "Loose fit — idiosyncratic positions dominate; treat beta and alpha as indicative only.",
    tone: "neutral",
  };
}

/** Annualized tracking error as a fraction (0.04 = 4%). */
export function interpretTrackingError(teAnnual: number): Interpretation {
  if (teAnnual < 0.02) {
    return {
      text: "Hugs the benchmark — closet-index territory; active bets are too small to matter much.",
      tone: "neutral",
    };
  }
  if (teAnnual <= 0.06) {
    return {
      text: "Moderate active risk — enough deviation for selection to matter without detaching from the index.",
      tone: "neutral",
    };
  }
  return {
    text: "High active risk — performance will detach from the index in both directions.",
    tone: "neutral",
  };
}

// ─── Fixed income ────────────────────────────────────────────────

/** Weighted-average bond duration in years. */
export function interpretDuration(years: number): Interpretation {
  const pct = years.toFixed(1);
  const base = `A 100bp rate rise would cost roughly ${pct}% of bond value (and add the same on a fall).`;
  if (years < 2) return { text: `${base} Minimal rate sensitivity.`, tone: "good" };
  if (years <= 7) return { text: base, tone: "neutral" };
  return { text: `${base} Long duration — rates are a first-order risk here.`, tone: "bad" };
}

/** Portfolio-level duration contribution (duration × bond weight), years. */
export function interpretPortfolioRateSensitivity(
  years: number,
): Interpretation {
  const pct = years.toFixed(1);
  const base = `A 100bp rate rise would cost roughly ${pct}% of the total portfolio via the bond sleeve.`;
  if (years < 1) return { text: `${base} Minimal portfolio-level rate risk.`, tone: "good" };
  if (years <= 3) return { text: base, tone: "neutral" };
  return { text: `${base} Rates rival equities as a portfolio risk at this level.`, tone: "bad" };
}

// ─── Options Greeks (portfolio-level) ────────────────────────────
// NOTE: these embed portfolio-derived $ / share-equivalent figures —
// render inside <PrivateText> (same masking as the value above them).

/** Net delta in share-equivalents. */
export function interpretDelta(totalDelta: number): Interpretation {
  if (Math.abs(totalDelta) < 5) {
    return {
      text: "Delta-neutral — the option book carries little net directional exposure.",
      tone: "neutral",
    };
  }
  const n = fmtShareEquiv(Math.abs(totalDelta));
  if (totalDelta > 0) {
    return {
      text: `Net long ~${n} share-equivalents — the option book adds to market direction.`,
      tone: "neutral",
    };
  }
  return {
    text: `Net short ~${n} share-equivalents — the option book hedges (or bets against) the long book.`,
    tone: "neutral",
  };
}

/** Net gamma in share-equivalents per $1 underlying move. */
export function interpretGamma(totalGamma: number): Interpretation {
  if (Math.abs(totalGamma) < 0.5) {
    return { text: "Negligible convexity — delta barely shifts as underlyings move.", tone: "neutral" };
  }
  if (totalGamma > 0) {
    return {
      text: "Long gamma — delta tilts further in your favor as markets move; theta is the rent you pay for it.",
      tone: "neutral",
    };
  }
  return {
    text: "Short gamma — large moves in either direction hurt; calm markets are what pays.",
    tone: "neutral",
  };
}

/** Daily theta in dollars (negative = paying decay). */
export function interpretTheta(totalTheta: number): Interpretation {
  if (Math.abs(totalTheta) < 1) {
    return { text: "Time decay is roughly a wash across the book.", tone: "neutral" };
  }
  const usd = fmtUsd(Math.abs(totalTheta));
  if (totalTheta < 0) {
    return {
      text: `The option book loses ~${usd}/day to time decay at current prices — the bleed accelerates into expiry.`,
      tone: "bad",
    };
  }
  return {
    text: `Collecting ~${usd}/day of time decay while underlyings sit still.`,
    tone: "good",
  };
}

/** Net vega: $ P&L per 1-point IV move. */
export function interpretVega(totalVega: number): Interpretation {
  if (Math.abs(totalVega) < 1) {
    return { text: "Vol exposure is negligible — IV swings barely mark the book.", tone: "neutral" };
  }
  const usd = fmtUsd(Math.abs(totalVega));
  if (totalVega > 0) {
    return {
      text: `Long vol — a 1-point rise in implied vol marks the book up ~${usd}; a vol crush costs the same.`,
      tone: "neutral",
    };
  }
  return {
    text: `Short vol — the book gives up ~${usd} per 1-point rise in implied vol; a vol spike is the risk.`,
    tone: "neutral",
  };
}

// ─── Performance ─────────────────────────────────────────────────

// ─── Defense / Hedging ───────────────────────────────────────────

/** Protection ratio: protective notional / long exposure (fraction, 0-1+). */
export function interpretProtectionRatio(ratio: number | null): Interpretation {
  if (ratio === null) return { text: "No long exposure to protect in this scope.", tone: "neutral" };
  const pct = Math.round(ratio * 100);
  if (ratio < 0.05)
    return { text: `Only ${pct}% of the long book carries any hedge delta — effectively unhedged; a broad decline lands at full weight.`, tone: "bad" };
  if (ratio <= 0.35)
    return { text: `${pct}% of the long book is covered by hedge delta — partial protection; the uncovered majority still drives drawdowns.`, tone: "neutral" };
  if (ratio <= 0.6)
    return { text: `${pct}% of the long book is hedged — substantial cushion in a selloff at a meaningful carry cost.`, tone: "good" };
  return { text: `${pct}% hedge coverage — the book is defensively positioned, but the theta cost drag will bite in flat or rising markets.`, tone: "neutral" };
}

/**
 * TWR vs XIRR spread (both annualized fractions). XIRR above TWR means
 * cash-flow timing helped; below means it hurt. Returns null when either
 * leg is unavailable.
 */
export function interpretTwrVsXirr(
  twr: number | null,
  xirr: number | null,
): Interpretation | null {
  if (twr == null || xirr == null) return null;
  const spread = xirr - twr;
  if (Math.abs(spread) < 0.01) {
    return {
      text: "Money-weighted ≈ time-weighted — cash-flow timing has been roughly a wash.",
      tone: "neutral",
    };
  }
  if (spread > 0) {
    return {
      text: "Money-weighted leads time-weighted — contribution timing added value on top of the strategy.",
      tone: "good",
    };
  }
  return {
    text: "Money-weighted lags time-weighted — cash tended to arrive ahead of weak stretches; timing detracted.",
    tone: "bad",
  };
}
