import { describe, it, expect } from "vitest";
import { issuerSiblings, sameIssuer } from "@/lib/securities/issuer-family";

describe("issuerSiblings", () => {
  it("returns the Alphabet family for GOOG (the user's reported bug)", () => {
    const siblings = issuerSiblings("GOOG");
    expect(siblings).toEqual(["GOOG", "GOOGL"]);
  });

  it("returns the same family for GOOGL — direction-agnostic", () => {
    const siblings = issuerSiblings("GOOGL");
    expect(siblings).toEqual(["GOOG", "GOOGL"]);
  });

  it("returns the Berkshire family including the user's actual 'BRK B' (space) variant", () => {
    const siblings = issuerSiblings("BRK B");
    expect(siblings).toContain("BRK B");
    expect(siblings).toContain("BRK.B");
    expect(siblings).toContain("BRK/B");
    expect(siblings).toContain("BRK A");
  });

  it("returns a singleton for symbols with no known family", () => {
    expect(issuerSiblings("AAPL")).toEqual(["AAPL"]);
    expect(issuerSiblings("TER")).toEqual(["TER"]);
  });

  it("is case-insensitive on lookup but preserves canonical case in output", () => {
    expect(issuerSiblings("goog")).toEqual(["GOOG", "GOOGL"]);
    expect(issuerSiblings("Googl")).toEqual(["GOOG", "GOOGL"]);
  });

  it("returns empty array for empty input", () => {
    expect(issuerSiblings("")).toEqual([]);
  });
});

describe("sameIssuer", () => {
  it("matches GOOG and GOOGL as same issuer (Alphabet)", () => {
    expect(sameIssuer("GOOG", "GOOGL")).toBe(true);
    expect(sameIssuer("GOOGL", "GOOG")).toBe(true);
  });

  it("matches BRK B and BRK/B variants", () => {
    expect(sameIssuer("BRK B", "BRK/B")).toBe(true);
    expect(sameIssuer("BRK.B", "BRK B")).toBe(true);
  });

  it("returns true for identical symbols even if not in any family", () => {
    expect(sameIssuer("AAPL", "AAPL")).toBe(true);
  });

  it("returns false for unrelated symbols", () => {
    expect(sameIssuer("AAPL", "MSFT")).toBe(false);
    expect(sameIssuer("GOOG", "MSFT")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(sameIssuer("", "GOOG")).toBe(false);
    expect(sameIssuer("GOOG", "")).toBe(false);
    expect(sameIssuer("", "")).toBe(false);
  });
});
