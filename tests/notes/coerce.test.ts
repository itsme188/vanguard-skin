/**
 * coerceNoteType / coerceNoteSentiment: the single-sourced exact-match
 * coercion for user-editable, shareable query params (?type=, ?sentiment=).
 * An unknown value — notably the guessable "all" — must fall back to
 * "no filter" (undefined) rather than being cast straight through, which
 * would otherwise match zero rows and render an empty state over a full
 * notebook. Exact match only: no case-folding, no partial match.
 */

import { describe, it, expect } from "vitest";
import { coerceNoteType, coerceNoteSentiment } from "@/lib/notes/coerce";

describe("coerceNoteType", () => {
  it('returns undefined for "all"', () => {
    expect(coerceNoteType("all")).toBeUndefined();
  });

  it('returns "journal" for "journal"', () => {
    expect(coerceNoteType("journal")).toBe("journal");
  });

  it('returns "earnings" for "earnings"', () => {
    expect(coerceNoteType("earnings")).toBe("earnings");
  });

  it('returns "trade_thesis" for "trade_thesis"', () => {
    expect(coerceNoteType("trade_thesis")).toBe("trade_thesis");
  });

  it("returns undefined for an empty string", () => {
    expect(coerceNoteType("")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(coerceNoteType(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(coerceNoteType(undefined)).toBeUndefined();
  });

  it("is an exact match only — wrong case returns undefined", () => {
    expect(coerceNoteType("JOURNAL")).toBeUndefined();
  });
});

describe("coerceNoteSentiment", () => {
  it('returns undefined for "all"', () => {
    expect(coerceNoteSentiment("all")).toBeUndefined();
  });

  it('returns "bullish" for "bullish"', () => {
    expect(coerceNoteSentiment("bullish")).toBe("bullish");
  });

  it('returns "bearish" for "bearish"', () => {
    expect(coerceNoteSentiment("bearish")).toBe("bearish");
  });

  it('returns "neutral" for "neutral"', () => {
    expect(coerceNoteSentiment("neutral")).toBe("neutral");
  });

  it('returns "cautious" for "cautious"', () => {
    expect(coerceNoteSentiment("cautious")).toBe("cautious");
  });

  it('returns "confident" for "confident"', () => {
    expect(coerceNoteSentiment("confident")).toBe("confident");
  });

  it("returns undefined for an empty string", () => {
    expect(coerceNoteSentiment("")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(coerceNoteSentiment(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(coerceNoteSentiment(undefined)).toBeUndefined();
  });

  it("is an exact match only — wrong case returns undefined", () => {
    expect(coerceNoteSentiment("BULLISH")).toBeUndefined();
  });
});
