import { describe, it, expect } from "vitest";
import { extractMaturityDate } from "@/lib/bonds";

/**
 * These tests verify the regex extractor that backs both:
 *   - scripts/backfill-bond-maturity-dates.ts (one-time live-DB backfill)
 *   - lib/mutations/securities.ts upsertSecurity auto-derivation
 *
 * The extractor lives in lib/bonds.ts (shared with vanguard-pdf parser).
 * Tests here mirror the plan's E3 specification cases for traceability.
 */
describe("extractMaturityDate — E3 plan cases", () => {
  it("matches 'DUE MM/DD/YY' with 2-digit year (assumes 20YY)", () => {
    expect(extractMaturityDate("TREAS 4.5% DUE 11/15/29")).toBe("2029-11-15");
  });

  it("matches 'DUE MM/DD/YYYY' with 4-digit year", () => {
    expect(extractMaturityDate("TREAS 4.5% DUE 11/15/2029")).toBe("2029-11-15");
  });

  it("matches 'MTD YYYY-MM-DD' ISO form", () => {
    expect(extractMaturityDate("VANG MTD 2027-08-15")).toBe("2027-08-15");
  });

  it("matches treasury names with two date tokens (first = maturity)", () => {
    // The 'TREASURY' anchor triggers the two-date fallback.
    expect(extractMaturityDate("U S TREASURY BOND 3.25% 08/15/30 08/15/25")).toBe(
      "2030-08-15",
    );
  });

  it("returns null when no date is parseable", () => {
    expect(extractMaturityDate("TREAS 4.5%")).toBeNull();
  });

  it("returns null for invalid month (>12)", () => {
    // Month 13 should fail the date-validity guard.
    expect(extractMaturityDate("DUE 13/15/25")).toBeNull();
  });
});
