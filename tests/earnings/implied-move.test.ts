import { describe, it, expect } from "vitest";
import {
  straddleImpliedMovePct, ivApproxMovePct, pickPostPrintExpiry,
  pickAtmStrike, computeMid, defaultExpiryFriday, IMPLIED_MOVE_CORRUPT_CEILING_PCT,
} from "@/lib/earnings/implied-move";

describe("straddleImpliedMovePct", () => {
  it("computes (call+put)/spot as percent", () => {
    expect(straddleImpliedMovePct(3.2, 3.0, 129.1)).toBeCloseTo(4.802, 2);
  });
  it("nulls on missing/non-positive inputs", () => {
    expect(straddleImpliedMovePct(null, 3.0, 129.1)).toBeNull();
    expect(straddleImpliedMovePct(3.2, 3.0, 0)).toBeNull();
    expect(straddleImpliedMovePct(3.2, 3.0, null)).toBeNull();
  });
});

describe("ivApproxMovePct", () => {
  it("iv × sqrt(dte/365) as percent", () => {
    expect(ivApproxMovePct(0.43, 4)).toBeCloseTo(0.43 * Math.sqrt(4 / 365) * 100, 3);
  });
  it("nulls on missing iv or dte", () => {
    expect(ivApproxMovePct(null, 4)).toBeNull();
    expect(ivApproxMovePct(0.43, null)).toBeNull();
    expect(ivApproxMovePct(0.43, 0)).toBeNull();
  });
});

describe("pickPostPrintExpiry", () => {
  const exps = ["2026-07-11", "2026-07-14", "2026-07-18", "2026-07-25", "2026-08-15"];
  it("AMC: strictly after event date", () => {
    expect(pickPostPrintExpiry(exps, "2026-07-14", "AMC")).toBe("2026-07-18");
  });
  it("BMO: same-day expiry allowed", () => {
    expect(pickPostPrintExpiry(exps, "2026-07-14", "BMO")).toBe("2026-07-14");
  });
  it("null eventTime treated like AMC", () => {
    expect(pickPostPrintExpiry(exps, "2026-07-14", null)).toBe("2026-07-18");
  });
  it("21-day ceiling: far-month-only chain → null", () => {
    expect(pickPostPrintExpiry(["2026-08-15"], "2026-07-14", "AMC")).toBeNull();
  });
});

describe("pickAtmStrike / computeMid", () => {
  it("nearest strike to spot", () => {
    expect(pickAtmStrike([120, 125, 130, 135], 128.9)).toBe(130);
    expect(pickAtmStrike([], 128.9)).toBeNull();
  });
  it("mid from bid/ask when sane", () => {
    expect(computeMid(3.0, 3.4, 2.0)).toBeCloseTo(3.2);
  });
  it("wide spread (>50% of mid) falls to last", () => {
    expect(computeMid(1.0, 3.0, 2.1)).toBe(2.1); // spread 2.0 > 0.5×2.0
  });
  it("no bid → last; no last → null", () => {
    expect(computeMid(0, 3.4, 2.0)).toBe(2.0);
    expect(computeMid(null, null, null)).toBeNull();
  });
});

describe("defaultExpiryFriday", () => {
  it("first Friday on/after the event date", () => {
    expect(defaultExpiryFriday("2026-07-14")).toBe("2026-07-17"); // Tue → Fri
    expect(defaultExpiryFriday("2026-07-17")).toBe("2026-07-17"); // Fri → same day
  });
});

it("exports the 60% corrupt ceiling", () => {
  expect(IMPLIED_MOVE_CORRUPT_CEILING_PCT).toBe(60);
});
