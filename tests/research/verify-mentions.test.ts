import { describe, it, expect } from "vitest";
import {
  hasWordBoundaryMatch,
  applyWordBoundaryGate,
} from "@/lib/research/verify-mentions";

describe("hasWordBoundaryMatch", () => {
  it("drops HOOD inside likelihood", () => {
    expect(hasWordBoundaryMatch("the likelihood of a rate cut", "HOOD")).toBe(false);
  });

  it("keeps HOOD when used as the ticker", () => {
    expect(hasWordBoundaryMatch("Robinhood (HOOD) reported", "HOOD")).toBe(true);
  });

  it("keeps NET when used as the ticker", () => {
    expect(hasWordBoundaryMatch("Cloudflare NET jumped 5%", "NET")).toBe(true);
  });

  it("keeps NET in 'net income' at the word-boundary layer (Haiku drops it)", () => {
    // "net" is a standalone word, so word-boundary passes. The Haiku layer is
    // responsible for catching the semantic distinction (accounting term vs ticker).
    expect(hasWordBoundaryMatch("record net income", "NET")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasWordBoundaryMatch("aapl earnings", "AAPL")).toBe(true);
    expect(hasWordBoundaryMatch("Aapl earnings", "aapl")).toBe(true);
  });

  it("respects boundaries with punctuation", () => {
    expect(hasWordBoundaryMatch("see: TSLA,", "TSLA")).toBe(true);
    expect(hasWordBoundaryMatch("(AAPL)", "AAPL")).toBe(true);
  });

  it("returns false for empty inputs", () => {
    expect(hasWordBoundaryMatch("", "AAPL")).toBe(false);
    expect(hasWordBoundaryMatch("AAPL moved", "")).toBe(false);
  });

  it("escapes regex metacharacters in the symbol", () => {
    // Symbols with dots like BRK.B should literal-match, not regex-match.
    expect(hasWordBoundaryMatch("BRK.B closed up", "BRK.B")).toBe(true);
    // "BRK-B" shouldn't match "BRK.B" because it's not a substring.
    expect(hasWordBoundaryMatch("BRK-B closed up", "BRK.B")).toBe(false);
  });
});

describe("applyWordBoundaryGate", () => {
  it("drops symbols that only appear as substrings", () => {
    const body = "There is a likelihood of rate action. The market app report.";
    const subject = "Daily digest";
    const out = applyWordBoundaryGate(["HOOD", "APP"], subject, body);
    // HOOD is inside "likelihood", dropped. APP is inside "app" word-boundary, kept.
    // Actually "app" = "APP" via word-boundary case-insensitive, so APP survives.
    expect(out.map((o) => o.symbol)).toContain("APP");
    expect(out.map((o) => o.symbol)).not.toContain("HOOD");
  });

  it("keeps symbols that appear only in the subject line", () => {
    const subject = "AAPL and TSLA preview";
    const body = "Market notes follow below.";
    const out = applyWordBoundaryGate(["AAPL", "TSLA"], subject, body);
    expect(out.map((o) => o.symbol).sort()).toEqual(["AAPL", "TSLA"]);
  });

  it("normalizes symbol casing and trims whitespace", () => {
    const body = "aapl rally continues";
    const out = applyWordBoundaryGate([" aapl ", "Aapl"], "x", body);
    expect(out.length).toBe(2);
    expect(out[0].symbol).toBe("AAPL");
  });

  it("surfaces a context snippet around the match", () => {
    const body =
      "Markets opened flat. Robinhood (HOOD) reported Q4 earnings beats. Shares rallied 12% in after-hours trading.";
    const out = applyWordBoundaryGate(["HOOD"], "HOOD earnings", body);
    expect(out.length).toBe(1);
    expect(out[0].context).toMatch(/Robinhood/i);
    expect(out[0].context).toMatch(/HOOD/);
  });

  it("skips empty/whitespace-only symbols", () => {
    const out = applyWordBoundaryGate(["", "   ", "AAPL"], "AAPL news", "AAPL up");
    expect(out.length).toBe(1);
    expect(out[0].symbol).toBe("AAPL");
  });
});
