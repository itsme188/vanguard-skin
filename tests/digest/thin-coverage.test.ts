import { describe, it, expect } from "vitest";
import {
  LISTING_BREADTH_MIN,
  isListingArticle,
  partitionListingOnlyHeldBuckets,
  renderThinCoverageLines,
  insertBeforeAlsoCovered,
} from "@/lib/digest/thin-coverage";
import type { CompanyBucket, ArticleLike } from "@/lib/digest/group-by-company";

function art(symbols: string[] | null, over: Partial<ArticleLike> = {}): ArticleLike {
  return {
    id: 1,
    source_name: "Vital Knowledge",
    subject: "Week ahead",
    summary: "Earnings calendar for the week.",
    sentiment: null,
    mentioned_symbols: symbols ? JSON.stringify(symbols) : null,
    portfolio_relevance: null,
    key_themes: null,
    source_url: "https://example.com/wk",
    website_url: null,
    ...over,
  };
}

const NINE = ["MSFT", "HD", "GS", "JPM", "XOM", "RBRK", "NSC", "TXN", "VZ"];

function bucket(symbol: string, articles: ArticleLike[]): CompanyBucket {
  return { symbol, companyName: null, articles };
}

describe("isListingArticle", () => {
  it("true at breadth >= LISTING_BREADTH_MIN, false below", () => {
    expect(LISTING_BREADTH_MIN).toBe(8);
    expect(isListingArticle(art(NINE))).toBe(true);
    expect(isListingArticle(art(NINE.slice(0, 8)))).toBe(true);
    expect(isListingArticle(art(NINE.slice(0, 7)))).toBe(false);
    expect(isListingArticle(art(["GS", "MS"]))).toBe(false);
  });

  it("null / unparseable mentioned_symbols is NOT a listing (safe default)", () => {
    expect(isListingArticle(art(null))).toBe(false);
    expect(isListingArticle({ mentioned_symbols: "not json" })).toBe(false);
  });
});

describe("partitionListingOnlyHeldBuckets", () => {
  it("held bucket where every article is a listing moves to the roster", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("GS", [art(NINE)]), bucket("AAPL", [art(["AAPL"])])],
      ["GS", "AAPL"],
    );
    expect(rosterSymbols).toEqual(["GS"]);
    expect(active.map((b) => b.symbol)).toEqual(["AAPL"]);
  });

  it("a single real article keeps the bucket active (mixed bucket)", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("GS", [art(NINE), art(["GS", "MS"])])],
      ["GS"],
    );
    expect(rosterSymbols).toEqual([]);
    expect(active.map((b) => b.symbol)).toEqual(["GS"]);
  });

  it("non-held listing-only buckets stay active", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("TXN", [art(NINE)])],
      ["GS"],
    );
    expect(rosterSymbols).toEqual([]);
    expect(active.map((b) => b.symbol)).toEqual(["TXN"]);
  });

  it("is issuer-family aware (GOOGL bucket, GOOG held)", () => {
    const { rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("GOOGL", [art(NINE)])],
      ["GOOG"],
    );
    expect(rosterSymbols).toEqual(["GOOGL"]);
  });

  it("never partitions the macro bucket and sorts the roster alphabetically", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [
        bucket("(no symbol)", [art(null)]),
        bucket("JPM", [art(NINE)]),
        bucket("GS", [art(NINE)]),
      ],
      ["JPM", "GS", "(NO SYMBOL)"],
    );
    expect(active.map((b) => b.symbol)).toEqual(["(no symbol)"]);
    expect(rosterSymbols).toEqual(["GS", "JPM"]);
  });
});

describe("renderThinCoverageLines", () => {
  it("renders both lines, deep-dives first", () => {
    const out = renderThinCoverageLines(
      ["GS", "JPM"],
      [{ symbols: ["NFLX"], source_name: "Stratechery", subject: "Netflix and the Anthology Era" }],
    );
    expect(out).toBe(
      '📄 Deep dives: NFLX (Stratechery — "Netflix and the Anthology Era") — see Research Desk below\n\n' +
        "On this week's calendar: GS · JPM",
    );
  });

  it("omits an empty line; empty-empty renders empty string", () => {
    expect(renderThinCoverageLines([], [])).toBe("");
    expect(renderThinCoverageLines(["GS"], [])).toBe("On this week's calendar: GS");
    expect(
      renderThinCoverageLines([], [{ symbols: ["NFLX"], source_name: "S", subject: "T" }]),
    ).toBe('📄 Deep dives: NFLX (S — "T") — see Research Desk below');
  });

  it("joins multiple essays with ; and multi-symbol essays with /", () => {
    const out = renderThinCoverageLines(
      [],
      [
        { symbols: ["GOOG", "GOOGL"], source_name: "A", subject: "Alpha" },
        { symbols: ["NFLX"], source_name: "B", subject: "Beta" },
      ],
    );
    expect(out).toBe(
      '📄 Deep dives: GOOG/GOOGL (A — "Alpha"); NFLX (B — "Beta") — see Research Desk below',
    );
  });
});

describe("insertBeforeAlsoCovered", () => {
  it("inserts the block immediately before ## Also covered", () => {
    const md = "## The Session\n\nX.\n\n## Also covered\n\nY.";
    const out = insertBeforeAlsoCovered(md, "BLOCK");
    expect(out.indexOf("BLOCK")).toBeLessThan(out.indexOf("## Also covered"));
    expect(out).toContain("BLOCK\n\n## Also covered");
  });

  it("appends at the end when ## Also covered is absent", () => {
    expect(insertBeforeAlsoCovered("## The Session\n\nX.\n", "BLOCK")).toBe(
      "## The Session\n\nX.\n\nBLOCK",
    );
  });
});
