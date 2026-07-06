import { describe, it, expect } from "vitest";
import {
  interpretSharpe,
  interpretMaxDrawdown,
  interpretCurrentDrawdown,
  interpretVolatility,
  interpretHHI,
  interpretBeta,
  interpretAlpha,
  interpretR2,
  interpretTrackingError,
  interpretDuration,
  interpretPortfolioRateSensitivity,
  interpretDelta,
  interpretGamma,
  interpretTheta,
  interpretVega,
  interpretTwrVsXirr,
  interpretProtectionRatio,
  toneClass,
} from "@/lib/analysis/interpret";

// ─── Sharpe ──────────────────────────────────────────────────────

describe("interpretSharpe", () => {
  it("negative Sharpe is bad — risk wasn't paid for", () => {
    const r = interpretSharpe(-0.3);
    expect(r.tone).toBe("bad");
    expect(r.text.toLowerCase()).toContain("risk-free");
  });

  it("0 to 0.5 is thin compensation (neutral)", () => {
    expect(interpretSharpe(0).tone).toBe("neutral");
    expect(interpretSharpe(0.49).tone).toBe("neutral");
  });

  it("0.5 boundary flips to good", () => {
    expect(interpretSharpe(0.5).tone).toBe("good");
  });

  it("1.3 is good and references the 1.0 bar", () => {
    const r = interpretSharpe(1.3);
    expect(r.tone).toBe("good");
    expect(r.text).toContain("1.0");
    expect(r.text.toLowerCase()).toContain("volatility");
  });

  it("very high Sharpe (>= 2.5) carries a short-window caution, neutral tone", () => {
    const r = interpretSharpe(3.1);
    expect(r.tone).toBe("neutral");
    expect(r.text.toLowerCase()).toMatch(/window|regime|extrapolat/);
  });
});

// ─── Max drawdown ────────────────────────────────────────────────

describe("interpretMaxDrawdown", () => {
  it("shallow (<10%) is good", () => {
    expect(interpretMaxDrawdown(0.08).tone).toBe("good");
  });

  it("correction-grade (10-20%) is neutral", () => {
    const r = interpretMaxDrawdown(0.15);
    expect(r.tone).toBe("neutral");
    expect(r.text.toLowerCase()).toContain("correction");
  });

  it("bear-market depth (20-35%) is bad", () => {
    expect(interpretMaxDrawdown(0.25).tone).toBe("bad");
  });

  it("severe (>= 35%) is bad and mentions recovery math", () => {
    const r = interpretMaxDrawdown(0.4);
    expect(r.tone).toBe("bad");
    expect(r.text.toLowerCase()).toContain("recover");
  });

  it("boundary: exactly 0.10 is correction-grade, exactly 0.20 is bear depth", () => {
    expect(interpretMaxDrawdown(0.1).tone).toBe("neutral");
    expect(interpretMaxDrawdown(0.2).tone).toBe("bad");
  });

  it("does not echo the displayed number (privacy: value is Pct-masked above)", () => {
    expect(interpretMaxDrawdown(0.15).text).not.toMatch(/\d+(\.\d+)?%/);
  });
});

// ─── Current drawdown ────────────────────────────────────────────

describe("interpretCurrentDrawdown", () => {
  it("null means at all-time high — good", () => {
    const r = interpretCurrentDrawdown(null);
    expect(r.tone).toBe("good");
    expect(r.text.toLowerCase()).toContain("high");
  });

  it("small (<5%) is good", () => {
    expect(interpretCurrentDrawdown(0.03).tone).toBe("good");
  });

  it("mid pullback (5-15%) is neutral", () => {
    expect(interpretCurrentDrawdown(0.1).tone).toBe("neutral");
  });

  it("deep (>= 15%) is bad", () => {
    expect(interpretCurrentDrawdown(0.22).tone).toBe("bad");
  });
});

// ─── Volatility ──────────────────────────────────────────────────

describe("interpretVolatility", () => {
  it("below 10% annualized reads bond-like (neutral)", () => {
    const r = interpretVolatility(0.07);
    expect(r.tone).toBe("neutral");
    expect(r.text.toLowerCase()).toContain("below");
  });

  it("10-18% is in line with broad equities (neutral)", () => {
    const r = interpretVolatility(0.15);
    expect(r.tone).toBe("neutral");
    expect(r.text.toLowerCase()).toMatch(/in line|equit/);
  });

  it("18-25% runs hotter than the index (neutral, cautionary)", () => {
    const r = interpretVolatility(0.21);
    expect(r.tone).toBe("neutral");
  });

  it(">= 25% is bad — single-stock-level volatility", () => {
    expect(interpretVolatility(0.3).tone).toBe("bad");
  });
});

// ─── HHI ─────────────────────────────────────────────────────────

describe("interpretHHI", () => {
  it("0.08 with 12 effective positions reads diversified", () => {
    const r = interpretHHI(0.08, 12.0);
    expect(r.tone).toBe("neutral");
    expect(r.text).toContain("~12 equal positions");
    expect(r.text.toLowerCase()).toContain("diversified");
  });

  it("derives effective positions from 1/HHI when not provided", () => {
    const r = interpretHHI(0.05);
    expect(r.text).toContain("~20 equal positions");
    expect(r.tone).toBe("good");
  });

  it("> 0.25 is highly concentrated — bad", () => {
    const r = interpretHHI(0.3);
    expect(r.tone).toBe("bad");
    expect(r.text.toLowerCase()).toContain("concentrat");
  });

  it("0.15-0.25 is concentrated — neutral caution", () => {
    expect(interpretHHI(0.18).tone).toBe("neutral");
  });

  it("<= 0.06 is well diversified — good", () => {
    expect(interpretHHI(0.04).tone).toBe("good");
  });

  it("non-positive HHI returns a neutral fallback without NaN", () => {
    const r = interpretHHI(0);
    expect(r.tone).toBe("neutral");
    expect(r.text).not.toContain("NaN");
    expect(r.text).not.toContain("Infinity");
  });
});

// ─── Beta ────────────────────────────────────────────────────────

describe("interpretBeta", () => {
  it("1.15 moves ~15% more than the market", () => {
    const r = interpretBeta(1.15);
    expect(r.text).toContain("~15% more");
    expect(r.tone).toBe("neutral");
  });

  it("0.8 moves ~20% less", () => {
    expect(interpretBeta(0.8).text).toContain("~20% less");
  });

  it("near 1.0 reads one-for-one", () => {
    expect(interpretBeta(1.02).text.toLowerCase()).toContain("one-for-one");
    expect(interpretBeta(0.97).text.toLowerCase()).toContain("one-for-one");
  });

  it("negative beta reads as inverse / hedge exposure", () => {
    const r = interpretBeta(-0.4);
    expect(r.text.toLowerCase()).toMatch(/against|inverse|hedge/);
  });

  it("uses the benchmark name when given", () => {
    expect(interpretBeta(1.2, "QQQ").text).toContain("QQQ");
  });
});

// ─── Alpha ───────────────────────────────────────────────────────

describe("interpretAlpha", () => {
  it(">= 2pp annualized is good", () => {
    expect(interpretAlpha(0.04).tone).toBe("good");
  });

  it("small positive (0-2pp) is neutral — within noise", () => {
    expect(interpretAlpha(0.01).tone).toBe("neutral");
  });

  it("small negative (0 to -2pp) is neutral", () => {
    expect(interpretAlpha(-0.01).tone).toBe("neutral");
  });

  it("<= -2pp is bad — lagging market exposure alone", () => {
    const r = interpretAlpha(-0.05);
    expect(r.tone).toBe("bad");
    expect(r.text.toLowerCase()).toMatch(/lag|below|trail/);
  });
});

// ─── R² ──────────────────────────────────────────────────────────

describe("interpretR2", () => {
  it("> 0.8 means beta/alpha readings are reliable", () => {
    const r = interpretR2(0.9);
    expect(r.tone).toBe("neutral");
    expect(r.text.toLowerCase()).toMatch(/reliab|trust/);
  });

  it("< 0.5 warns beta/alpha are indicative only", () => {
    const r = interpretR2(0.3);
    expect(r.text.toLowerCase()).toMatch(/indicative|loose|idiosyncratic/);
  });

  it("0.5-0.8 is a moderate fit", () => {
    expect(interpretR2(0.65).tone).toBe("neutral");
  });
});

// ─── Tracking error ──────────────────────────────────────────────

describe("interpretTrackingError", () => {
  it("< 2% is closet-index territory", () => {
    expect(interpretTrackingError(0.01).text.toLowerCase()).toMatch(/closet|hug/);
  });

  it("2-6% is moderate active risk", () => {
    expect(interpretTrackingError(0.04).tone).toBe("neutral");
  });

  it("> 6% is high active risk — detaches from the index", () => {
    const r = interpretTrackingError(0.09);
    expect(r.text.toLowerCase()).toMatch(/detach|high active|both directions/);
  });
});

// ─── Duration ────────────────────────────────────────────────────

describe("interpretDuration", () => {
  it("5.2 years costs roughly 5.2% of bond value per 100bp", () => {
    const r = interpretDuration(5.2);
    expect(r.text).toContain("5.2%");
    expect(r.text.toLowerCase()).toMatch(/100bp|1% rate|rate rise/);
    expect(r.tone).toBe("neutral");
  });

  it("< 2 years is low rate risk — good", () => {
    expect(interpretDuration(0.9).tone).toBe("good");
  });

  it("> 7 years is long duration — bad", () => {
    expect(interpretDuration(9.5).tone).toBe("bad");
  });
});

describe("interpretPortfolioRateSensitivity", () => {
  it("contribution under 1yr is good and quotes the portfolio-level cost", () => {
    const r = interpretPortfolioRateSensitivity(0.45);
    expect(r.tone).toBe("good");
    expect(r.text).toContain("0.5%");
    expect(r.text.toLowerCase()).toContain("portfolio");
  });

  it("1-3yr contribution is neutral", () => {
    expect(interpretPortfolioRateSensitivity(2.1).tone).toBe("neutral");
  });

  it("> 3yr contribution is bad", () => {
    expect(interpretPortfolioRateSensitivity(4.2).tone).toBe("bad");
  });
});

// ─── Greeks ──────────────────────────────────────────────────────

describe("interpretDelta", () => {
  it("near zero is delta-neutral", () => {
    const r = interpretDelta(2);
    expect(r.tone).toBe("neutral");
    expect(r.text.toLowerCase()).toContain("neutral");
  });

  it("positive delta is long share-equivalents", () => {
    const r = interpretDelta(250);
    expect(r.text).toContain("~250");
    expect(r.text.toLowerCase()).toContain("long");
  });

  it("negative delta is short share-equivalents / hedge", () => {
    const r = interpretDelta(-1500);
    expect(r.text).toContain("~1.5K");
    expect(r.text.toLowerCase()).toMatch(/short|hedge/);
  });
});

describe("interpretGamma", () => {
  it("positive gamma — convexity works for you", () => {
    const r = interpretGamma(12);
    expect(r.text.toLowerCase()).toContain("long gamma");
  });

  it("negative gamma — large moves hurt", () => {
    const r = interpretGamma(-8);
    expect(r.text.toLowerCase()).toContain("short gamma");
  });

  it("negligible gamma is neutral", () => {
    expect(interpretGamma(0.1).tone).toBe("neutral");
  });
});

describe("interpretTheta", () => {
  it("-45 loses ~$45/day to time decay (bad)", () => {
    const r = interpretTheta(-45);
    expect(r.text).toContain("$45/day");
    expect(r.text.toLowerCase()).toContain("decay");
    expect(r.tone).toBe("bad");
  });

  it("positive theta collects decay (good)", () => {
    const r = interpretTheta(120);
    expect(r.text).toContain("$120/day");
    expect(r.tone).toBe("good");
  });

  it("large theta formats in $K", () => {
    expect(interpretTheta(-2400).text).toContain("$2.4K/day");
  });

  it("near-zero theta is a wash", () => {
    expect(interpretTheta(0.5).tone).toBe("neutral");
  });
});

describe("interpretVega", () => {
  it("positive vega — long vol, quotes per-point sensitivity", () => {
    const r = interpretVega(350);
    expect(r.text).toContain("$350");
    expect(r.text.toLowerCase()).toMatch(/implied vol|iv/);
  });

  it("negative vega — short vol", () => {
    const r = interpretVega(-200);
    expect(r.text).toContain("$200");
    expect(r.text.toLowerCase()).toMatch(/short vol|vol rises|spike/);
  });

  it("negligible vega is neutral", () => {
    expect(interpretVega(0.4).tone).toBe("neutral");
  });
});

// ─── TWR vs XIRR ─────────────────────────────────────────────────

describe("interpretTwrVsXirr", () => {
  it("returns null when either input is null", () => {
    expect(interpretTwrVsXirr(null, 0.1)).toBeNull();
    expect(interpretTwrVsXirr(0.1, null)).toBeNull();
  });

  it("spread within ±1pp is neutral — timing roughly a wash", () => {
    const r = interpretTwrVsXirr(0.1, 0.105);
    expect(r?.tone).toBe("neutral");
  });

  it("XIRR leading TWR by >= 1pp — contribution timing added value (good)", () => {
    const r = interpretTwrVsXirr(0.08, 0.11);
    expect(r?.tone).toBe("good");
    expect(r?.text.toLowerCase()).toContain("timing");
  });

  it("XIRR lagging TWR by >= 1pp — timing detracted (bad)", () => {
    const r = interpretTwrVsXirr(0.11, 0.08);
    expect(r?.tone).toBe("bad");
  });
});

// ─── interpretProtectionRatio ────────────────────────────────────

describe("interpretProtectionRatio", () => {
  it("null ratio → neutral no-data text", () => {
    const r = interpretProtectionRatio(null);
    expect(r.tone).toBe("neutral");
  });
  it("under 5% reads as essentially unhedged", () => {
    expect(interpretProtectionRatio(0.03).text).toMatch(/unhedged|unprotected/i);
  });
  it("5-35% reads as partial protection, neutral-to-good tone", () => {
    const r = interpretProtectionRatio(0.18);
    expect(r.text).toMatch(/18%/);
  });
  it("over 60% flags heavy hedging cost drag", () => {
    expect(interpretProtectionRatio(0.65).text).toMatch(/drag|cost/i);
  });
});

// ─── toneClass ───────────────────────────────────────────────────

describe("toneClass", () => {
  it("maps tones to subtle text classes", () => {
    expect(toneClass("good")).toBe("text-up/80");
    expect(toneClass("bad")).toBe("text-down/80");
    expect(toneClass("neutral")).toBe("text-ink-faint");
  });
});
