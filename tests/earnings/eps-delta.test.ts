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
});

describe("deltaToneClass", () => {
  it("colors a beat up, a miss down, and null/in-line neutral", () => {
    expect(deltaToneClass({ sign: 1 })).toBe("text-up");
    expect(deltaToneClass({ sign: -1 })).toBe("text-down");
    expect(deltaToneClass({ sign: 0 })).toBe("text-ink-dim");
    expect(deltaToneClass(null)).toBe("text-ink-faint");
  });
});
