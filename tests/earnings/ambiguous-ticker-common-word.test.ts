import { describe, it, expect } from "vitest";
import {
  AMBIGUOUS_TICKER_WORDS,
  articleNamesSymbol,
  isSymbolMentioned,
} from "@/lib/earnings/extract-newsletter-bogeys";

// A ticker that is also an everyday word must not match that word in prose:
// the text is upper-cased before the test, so "land" would read as the ticker.
describe("a ticker that is an ordinary word (LAND)", () => {
  it("is on the curated stoplist", () => {
    expect(AMBIGUOUS_TICKER_WORDS.has("LAND")).toBe(true);
  });

  it("does not match the word in ordinary prose", () => {
    expect(isSymbolMentioned("Shares could land near the top of the range.", "LAND")).toBe(false);
    expect(isSymbolMentioned("A soft landing; the land grab in AI continues.", "LAND")).toBe(false);
    expect(
      articleNamesSymbol(
        { subject: "Morning wrap: where rates land", raw_text: "Nothing about the company here." },
        "LAND",
      ),
    ).toBe(false);
  });

  it("still matches a cashtag or a finance cue", () => {
    expect(isSymbolMentioned("Watching $LAND into the print.", "LAND")).toBe(true);
    expect(isSymbolMentioned("LAND Q3 preview: farmland rents", "LAND")).toBe(true);
    expect(
      articleNamesSymbol({ subject: "Preview | LAND earnings", raw_text: "Body text." }, "LAND"),
    ).toBe(true);
  });
});
