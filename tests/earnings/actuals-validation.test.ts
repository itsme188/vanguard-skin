/**
 * parseActualsInput — BogeysEditModal "Save actuals" validation.
 *
 * Regression coverage for finding
 * today-bogeys-actuals--nonnumeric-eps-wrong-error-message (2026-08-19):
 * typing a non-numeric EPS with revenue left blank showed the identical
 * "Provide at least one actual value" message used for two blank fields,
 * even though the EPS field visibly held text. The resolver must
 * distinguish "both fields empty" from "a field holds an unparseable value".
 */

import { describe, it, expect } from "vitest";
import { parseActualsInput } from "@/lib/earnings/actuals-validation";

describe("parseActualsInput", () => {
  it("errors with the specific EPS message when EPS is non-numeric and revenue is blank", () => {
    const out = parseActualsInput("not-a-number", "");
    expect(out.error).toBe("EPS must be a number.");
    expect(out.error).not.toBe("Provide at least one actual value (EPS or revenue).");
  });

  it("errors with the specific revenue message when revenue is non-numeric and EPS is blank", () => {
    const out = parseActualsInput("", "not-a-number");
    expect(out.error).toBe("Revenue must be a number (e.g. 1.3B or 1300000000).");
  });

  it("errors with the provide-at-least-one message when both fields are blank", () => {
    const out = parseActualsInput("", "");
    expect(out.error).toBe("Provide at least one actual value (EPS or revenue).");
    expect(out.eps_actual).toBeNull();
    expect(out.revenue_actual_usd).toBeNull();
  });

  it("errors with the provide-at-least-one message when both fields are whitespace-only", () => {
    const out = parseActualsInput("   ", "  ");
    expect(out.error).toBe("Provide at least one actual value (EPS or revenue).");
  });

  it("parses a valid EPS with revenue blank and returns no error", () => {
    const out = parseActualsInput("0.91", "");
    expect(out.error).toBeNull();
    expect(out.eps_actual).toBe(0.91);
    expect(out.revenue_actual_usd).toBeNull();
  });

  it("parses a suffixed revenue value ($1.30B) accepted by parseLargeUSD and returns no error", () => {
    const out = parseActualsInput("", "$1.30B");
    expect(out.error).toBeNull();
    expect(out.eps_actual).toBeNull();
    expect(out.revenue_actual_usd).toBe(1_300_000_000);
  });

  it("parses both fields valid and returns no error", () => {
    const out = parseActualsInput("0.91", "4.34B");
    expect(out.error).toBeNull();
    expect(out.eps_actual).toBe(0.91);
    expect(out.revenue_actual_usd).toBe(4_340_000_000);
  });

  it("prefers the EPS error when both fields are non-numeric", () => {
    const out = parseActualsInput("garbage", "also-garbage");
    expect(out.error).toBe("EPS must be a number.");
  });
});
