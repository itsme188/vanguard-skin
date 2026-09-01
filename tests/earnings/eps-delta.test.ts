import { describe, it, expect } from "vitest";
import { epsDelta, deltaToneClass } from "@/lib/earnings/eps-delta";

describe("epsDelta", () => {
  it("returns a positive sign on an EPS beat", () => {
    const d = epsDelta("EPS 0.41", "EPS 0.45");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(1);
  });

  it("returns a negative sign on an EPS miss", () => {
    const d = epsDelta("EPS 0.41", "EPS 0.30");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(-1);
  });

  it("returns sign 0 (in-line) when the delta is within 0.05%", () => {
    const d = epsDelta("EPS 1.00", "EPS 1.0001");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(0);
    expect(d?.label).toBe("in-line");
  });

  it("returns null when either side has no parseable EPS", () => {
    expect(epsDelta(null, "EPS 0.45")).toBeNull();
    expect(epsDelta("EPS 0.41", null)).toBeNull();
    expect(epsDelta("Rev 4305870107", "EPS 0.45")).toBeNull();
  });

  it("BEATs when both EPS are negative and the actual loss is smaller than the estimated loss", () => {
    // A narrower loss than expected (-0.30 vs -0.50 estimated) is a beat —
    // the naive (a - c) sign flip without dividing by |c| would get this
    // backwards for negative consensus.
    const d = epsDelta("EPS -0.50", "EPS -0.30");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(1);
    expect(d?.label).toBe("+40.0%");
  });

  it("MISSes when both EPS are negative and the actual loss is larger than the estimated loss", () => {
    // A wider loss than expected (-0.50 vs -0.30 estimated) is a miss.
    const d = epsDelta("EPS -0.30", "EPS -0.50");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(-1);
    expect(d?.label).toBe("-66.7%");
  });

  it("keeps the beat/miss SIGN when the estimate is exactly 0, labeling in absolute dollars (percent is undefined)", () => {
    // Returning null here used to render a real miss on a neutral chip
    // (QA finding week-ahead-chips--zero-consensus-eps-miss-renders-neutral-not-red:
    // MP printed -$0.01 against a $0.00 consensus and looked in-line).
    const beat = epsDelta("EPS 0.00", "EPS 0.45");
    expect(beat).not.toBeNull();
    expect(beat?.sign).toBe(1);
    expect(beat?.label).toBe("+$0.45");

    const miss = epsDelta("EPS 0.00", "EPS -0.01");
    expect(miss).not.toBeNull();
    expect(miss?.sign).toBe(-1);
    expect(miss?.label).toBe("-$0.01");
  });

  it("stays in-line when both the estimate and the actual are exactly 0", () => {
    const d = epsDelta("EPS 0.00", "EPS 0.00");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(0);
    expect(d?.label).toBe("in-line");
  });

  it("does not swallow a genuine $0.00 actual as missing when the estimate is non-zero", () => {
    // formatFinnhubFigure renders a real zero EPS as the string "$0.00" —
    // truthy, not null/undefined — so the `!act.eps` presence check must
    // not misread it as "no actual reported". A collapse to exactly zero
    // EPS against a positive estimate is a genuine, steep miss.
    const d = epsDelta("EPS 0.45", "EPS 0.00");
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(-1);
    expect(d?.label).toBe("-100.0%");
  });
});

describe("deltaToneClass", () => {
  it("colors a beat up, a miss down, and null/in-line neutral", () => {
    expect(deltaToneClass({ sign: 1 })).toBe("text-up");
    expect(deltaToneClass({ sign: -1 })).toBe("text-down");
    expect(deltaToneClass({ sign: 0 })).toBe("text-ink-dim");
    expect(deltaToneClass(null)).toBe("text-ink-faint");
  });
});
