/**
 * Tests for Substack admin-mail short-circuit (Tier 5 D2).
 *
 * Calibrated against the 14 real noise rows found in the production DB as
 * of 2026-05-11. Each positive case mirrors an actual subject line; each
 * negative case names a content pattern that shares vocabulary with the
 * noise patterns but is legitimate research.
 */

import { describe, it, expect } from "vitest";
import { checkShortCircuit } from "@/lib/gmail/short-circuit";

describe("checkShortCircuit — positive cases (real DB samples)", () => {
  it.each([
    ["** Payment Receipt", "receipt"],
    ["Your payment receipt from Eliant's Exploits #CIHFW3E7-0006", "receipt"],
    ["Your payment receipt from Purple Drink's Market Musings #1UWJBD9I-0007", "receipt"],
    ["Your payment receipt from The Running Of The Bulltards #ECCB4DC5-0015", "receipt"],
    ["Welcome to Paul Kedrosky", "welcome"],
    ["Welcome to Semi Doped", "welcome"],
    ["Welcome to BEP Research", "welcome"],
    ["Ely S gifted you a subscription!", "gift"],
    ["Ely S would like to give you a subscription to Emerging AI", "gift"],
  ])("flags %s as %s", (subject, expectedCategory) => {
    const result = checkShortCircuit(subject);
    expect(result.excluded).toBe(true);
    if (result.excluded) {
      expect(result.category).toBe(expectedCategory);
      expect(result.reason).toContain(subject.slice(0, 40).replace(/^\*\*\s*/, ""));
    }
  });

  it("strips Substack '** ' emphasis prefix when matching welcome pattern", () => {
    const result = checkShortCircuit("** Welcome to Whatever Newsletter");
    expect(result.excluded).toBe(true);
    if (result.excluded) {
      expect(result.category).toBe("welcome");
    }
  });

  it("flags generic admin patterns (password reset, unsubscribe confirm)", () => {
    expect(checkShortCircuit("Password reset request").excluded).toBe(true);
    expect(checkShortCircuit("Unsubscribe confirmation from The Diff").excluded).toBe(true);
  });
});

describe("checkShortCircuit — negative cases (research content that shares vocabulary)", () => {
  it("does NOT match 'Welcome to ...' when it appears MID-subject (legitimate content)", () => {
    expect(checkShortCircuit("Markets rally: Welcome to the next leg up").excluded).toBe(false);
    expect(checkShortCircuit("Macro view: Welcome to the AI-bubble era").excluded).toBe(false);
  });

  it("does NOT match a real subject that happens to contain 'subscription' (e.g., a company-news article)", () => {
    expect(checkShortCircuit("Netflix subscription growth slows in Q1").excluded).toBe(false);
    expect(checkShortCircuit("How SaaS subscription pricing affects margins").excluded).toBe(false);
  });

  it("does NOT match a real subject containing 'gift' that isn't gift-subscription flow", () => {
    expect(checkShortCircuit("The gift of compound returns").excluded).toBe(false);
    expect(checkShortCircuit("AAPL: Holiday gift demand stronger than expected").excluded).toBe(false);
  });

  it("passes legitimate Vital Knowledge market recaps unchanged", () => {
    expect(checkShortCircuit("Vital Knowledge: Vital Market Recap for Monday May 11, 2026").excluded).toBe(false);
    expect(checkShortCircuit("Vital Knowledge: Company-specific news for Mon 5/11 (BMO)").excluded).toBe(false);
  });

  it("passes legitimate publication-name themed subjects", () => {
    expect(checkShortCircuit("TMTB Morning Wrap").excluded).toBe(false);
    expect(checkShortCircuit("Why does Resource Extraction Produce Such Concentrated Wealth?").excluded).toBe(false);
    expect(checkShortCircuit("5/11/26 Recap").excluded).toBe(false);
  });

  it("'unsubscribe' as a substring in a real headline is OK (only matches at start)", () => {
    expect(checkShortCircuit("Why investors should never unsubscribe from quality research").excluded).toBe(false);
  });
});

describe("checkShortCircuit — defensive edge cases", () => {
  it("handles an empty subject defensively (passes through, not excluded)", () => {
    expect(checkShortCircuit("").excluded).toBe(false);
  });

  it("handles surrounding whitespace by trimming after the ** prefix strip", () => {
    expect(checkShortCircuit("**   Payment Receipt   ").excluded).toBe(true);
  });

  it("is case-insensitive on the 'payment receipt' substring match", () => {
    expect(checkShortCircuit("YOUR PAYMENT RECEIPT FROM X").excluded).toBe(true);
    expect(checkShortCircuit("your Payment Receipt from x").excluded).toBe(true);
  });
});
