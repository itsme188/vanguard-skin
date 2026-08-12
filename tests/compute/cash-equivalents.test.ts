import { describe, it, expect } from "vitest";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";

describe("isCashEquivalentSecurity", () => {
  // ─── Signal 1: security_type ────────────────────────────────────
  // Set by the static lookup's `fix_security_type` (VMFXX/VFFXX/VFMXX,
  // lib/data/security-classifications.ts) and by broker/import mapping.

  it("recognizes the money_market security_type", () => {
    expect(isCashEquivalentSecurity({ security_type: "money_market", fund_category: null })).toBe(true);
  });

  it("recognizes the space-separated 'money market' spelling", () => {
    expect(isCashEquivalentSecurity({ security_type: "money market", fund_category: null })).toBe(true);
  });

  it("compares security_type case-insensitively", () => {
    expect(isCashEquivalentSecurity({ security_type: "Money_Market", fund_category: null })).toBe(true);
    expect(isCashEquivalentSecurity({ security_type: "MONEY MARKET", fund_category: null })).toBe(true);
  });

  // ─── Signal 2: fund_category ────────────────────────────────────
  // Set by the auto rule in lib/compute/classify-securities.ts and by the
  // static lookup. Catches rows whose security_type was never repaired.

  it("recognizes the Cash Equivalent fund_category", () => {
    expect(isCashEquivalentSecurity({ security_type: "stock", fund_category: "Cash Equivalent" })).toBe(true);
  });

  it("compares fund_category case-insensitively", () => {
    expect(isCashEquivalentSecurity({ security_type: null, fund_category: "cash equivalent" })).toBe(true);
    expect(isCashEquivalentSecurity({ security_type: null, fund_category: "CASH EQUIVALENT" })).toBe(true);
  });

  // ─── Negatives ──────────────────────────────────────────────────

  it("returns false for ordinary securities", () => {
    expect(isCashEquivalentSecurity({ security_type: "stock", fund_category: "US Large Cap Equity" })).toBe(false);
    expect(isCashEquivalentSecurity({ security_type: "etf", fund_category: "US Total Market Equity" })).toBe(false);
  });

  it("does not treat bonds or ultra-short bond funds as cash equivalents", () => {
    // Treasuries are HOLDINGS, not cash — the whole point of the split.
    expect(isCashEquivalentSecurity({ security_type: "bond", fund_category: "US Treasury" })).toBe(false);
    expect(isCashEquivalentSecurity({ security_type: "mutual_fund", fund_category: "US Ultra-Short Bond" })).toBe(false);
  });

  it("handles nulls on both fields", () => {
    expect(isCashEquivalentSecurity({ security_type: null, fund_category: null })).toBe(false);
  });

  it("does not match on a substring of another category", () => {
    expect(isCashEquivalentSecurity({ security_type: null, fund_category: "Cash Equivalent Alternatives" })).toBe(false);
    expect(isCashEquivalentSecurity({ security_type: "money_market_adjacent", fund_category: null })).toBe(false);
  });
});
