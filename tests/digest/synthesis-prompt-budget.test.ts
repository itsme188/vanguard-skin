/**
 * tests/digest/synthesis-prompt-budget.test.ts
 *
 * Regression for the QA finding
 * `research-digest-synthesis--truncated-by-max-tokens-on-every-run-since-jul-31`:
 * buildSynthesisPrompt rendered EVERY article summary once per mentioned
 * symbol, so a real day (88-210 distinct symbols across 15-23 articles with
 * 1-2 KB summaries) reprinted each summary dozens of times and pushed the
 * call past the model's context window. @ai-sdk/anthropic maps BOTH
 * `max_tokens` and `model_context_window_exceeded` to finishReason "length",
 * so every digest since 2026-07-31 threw "output truncated by max tokens"
 * and silently fell back to the per-source layout.
 *
 * The fix is a deterministic priority bound on the buckets that reach the
 * prompt. These tests pin the bound, the priority order, and the overflow
 * line — no model call involved (both functions under test are pure).
 */

import { describe, it, expect } from "vitest";
import {
  boundSynthesisBuckets,
  buildSynthesisPrompt,
  DEFAULT_SYNTHESIS_LIMITS,
} from "@/lib/digest/synthesize";
import type { CompanyBucket, ArticleLike } from "@/lib/digest/group-by-company";

const NO_SYMBOL_BUCKET = "(no symbol)";

function makeArticle(id: number, summaryChars: number, sourceName = "Vital Knowledge"): ArticleLike {
  return {
    id,
    source_name: sourceName,
    subject: `Subject ${id}`,
    // Word-shaped filler so truncateAtWord has word boundaries to cut on.
    summary: "lorem ipsum dolor ".repeat(Math.ceil(summaryChars / 18)).slice(0, summaryChars),
    sentiment: "neutral",
    mentioned_symbols: null,
    portfolio_relevance: null,
    key_themes: null,
    source_url: `https://example.test/a/${id}`,
    website_url: null,
  };
}

function makeBucket(
  symbol: string,
  articleCount: number,
  summaryChars: number,
  startId = 1,
): CompanyBucket {
  return {
    symbol,
    companyName: symbol === NO_SYMBOL_BUCKET ? null : `${symbol} Holdings`,
    articles: Array.from({ length: articleCount }, (_, i) =>
      makeArticle(startId + i, summaryChars),
    ),
  };
}

/** 200 symbol buckets, 5 articles each, 1,500-char summaries — the shape that broke live. */
function heavyDay(): CompanyBucket[] {
  const buckets: CompanyBucket[] = [];
  for (let i = 0; i < 200; i++) {
    const symbol = `SY${String(i).padStart(3, "0")}`;
    buckets.push(makeBucket(symbol, 5, 1500, i * 10 + 1));
  }
  buckets.push(makeBucket(NO_SYMBOL_BUCKET, 4, 1500, 5000));
  return buckets;
}

describe("boundSynthesisBuckets", () => {
  it("keeps the macro bucket, caps the bucket count, and overflows the rest", () => {
    const { priority, overflowSymbols } = boundSynthesisBuckets(heavyDay(), {
      heldSymbols: [],
      watchlist: [],
      anomalySymbols: [],
    });

    expect(priority.length).toBeLessThanOrEqual(DEFAULT_SYNTHESIS_LIMITS.maxBuckets);
    expect(priority.some((b) => b.symbol === NO_SYMBOL_BUCKET)).toBe(true);
    // Everything not rendered is disclosed by symbol.
    expect(overflowSymbols.length).toBe(200 - (priority.length - 1));
    expect(overflowSymbols).not.toContain(NO_SYMBOL_BUCKET);
  });

  it("returns overflow symbols in deterministic sorted order", () => {
    const a = boundSynthesisBuckets(heavyDay(), {
      heldSymbols: [],
      watchlist: [],
      anomalySymbols: [],
    });
    const b = boundSynthesisBuckets(heavyDay(), {
      heldSymbols: [],
      watchlist: [],
      anomalySymbols: [],
    });
    expect(a.overflowSymbols).toEqual(b.overflowSymbols);
    expect(a.overflowSymbols).toEqual([...a.overflowSymbols].sort());
  });

  it("prioritizes anomaly, then held, then watchlist over plain article count", () => {
    // Give the low-priority names MORE articles so a pure count sort would win.
    const buckets: CompanyBucket[] = [];
    for (let i = 0; i < 60; i++) {
      buckets.push(makeBucket(`NOISE${i}`, 9, 400, i * 20 + 1));
    }
    // The three names that matter carry a single thin article each.
    buckets.push(makeBucket("ANOM", 1, 400, 9001));
    buckets.push(makeBucket("HELD", 1, 400, 9101));
    buckets.push(makeBucket("WATCH", 1, 400, 9201));

    const { priority } = boundSynthesisBuckets(
      buckets,
      { heldSymbols: ["HELD"], watchlist: ["WATCH"], anomalySymbols: ["ANOM"] },
      { maxBuckets: 5 },
    );

    const symbols = priority.map((b) => b.symbol);
    expect(symbols.slice(0, 3)).toEqual(["ANOM", "HELD", "WATCH"]);
    expect(symbols).toHaveLength(5);
  });

  it("matches held names through issuerSiblings (held GOOG keeps the GOOGL bucket)", () => {
    const buckets: CompanyBucket[] = [];
    for (let i = 0; i < 40; i++) buckets.push(makeBucket(`NOISE${i}`, 9, 400, i * 20 + 1));
    buckets.push(makeBucket("GOOGL", 1, 400, 9001));

    const { priority, overflowSymbols } = boundSynthesisBuckets(
      buckets,
      { heldSymbols: ["GOOG"], watchlist: [], anomalySymbols: [] },
      { maxBuckets: 3 },
    );

    expect(priority[0].symbol).toBe("GOOGL");
    expect(overflowSymbols).not.toContain("GOOGL");
  });

  it("caps articles per bucket and truncates each summary line", () => {
    const { priority } = boundSynthesisBuckets(
      [makeBucket("AAA", 20, 4000)],
      { heldSymbols: ["AAA"], watchlist: [], anomalySymbols: [] },
    );

    const kept = priority.find((b) => b.symbol === "AAA");
    expect(kept).toBeDefined();
    expect(kept!.articles.length).toBe(DEFAULT_SYNTHESIS_LIMITS.maxArticlesPerBucket);
    for (const article of kept!.articles) {
      expect((article.summary ?? "").length).toBeLessThanOrEqual(
        DEFAULT_SYNTHESIS_LIMITS.maxSummaryChars + 1, // +1 for the ellipsis
      );
    }
    // The bucket order the caller supplied is preserved (latest-first upstream).
    expect(kept!.articles[0].id).toBe(1);
  });

  it("does not mutate the input buckets", () => {
    const input = [makeBucket("AAA", 20, 4000)];
    const before = input[0].articles.length;
    const beforeSummary = input[0].articles[0].summary;
    boundSynthesisBuckets(input, { heldSymbols: [], watchlist: [], anomalySymbols: [] });
    expect(input[0].articles.length).toBe(before);
    expect(input[0].articles[0].summary).toBe(beforeSummary);
  });

  it("keeps every bucket on a small day and leads with Macro", () => {
    // bucketByCompany pins the macro bucket LAST; the bound moves it first
    // because it feeds the lead `## <sessionHeading>` section the system
    // prompt's OUTPUT SECTION ORDER block demands.
    const buckets = [makeBucket("AAA", 2, 300), makeBucket(NO_SYMBOL_BUCKET, 1, 300, 50)];
    const { priority, overflowSymbols } = boundSynthesisBuckets(buckets, {
      heldSymbols: ["AAA"],
      watchlist: [],
      anomalySymbols: [],
    });
    expect(priority.map((b) => b.symbol)).toEqual([NO_SYMBOL_BUCKET, "AAA"]);
    expect(overflowSymbols).toEqual([]);
  });
});

describe("buildSynthesisPrompt", () => {
  it("stays far under the context window on a 200-bucket day", () => {
    const buckets = heavyDay();
    const bounded = boundSynthesisBuckets(buckets, {
      heldSymbols: ["SY007"],
      watchlist: ["SY042"],
      anomalySymbols: ["SY100"],
    });
    const prompt = buildSynthesisPrompt(
      {
        buckets,
        heldSymbols: ["SY007"],
        watchlist: ["SY042"],
        anomalies: [{ symbol: "SY100", companyName: null }],
      },
      bounded,
    );

    expect(prompt.length).toBeLessThan(80_000);
    // The names that matter are the ones that got rendered.
    expect(prompt).toContain("## SY100");
    expect(prompt).toContain("## SY007");
    expect(prompt).toContain("## SY042");
  });

  it("renders one compact 'Also mentioned today' line for the overflow", () => {
    const buckets = heavyDay();
    const bounded = boundSynthesisBuckets(buckets, {
      heldSymbols: [],
      watchlist: [],
      anomalySymbols: [],
    });
    const prompt = buildSynthesisPrompt(
      { buckets, heldSymbols: [], watchlist: [], anomalies: [] },
      bounded,
    );

    expect(prompt).toContain("Also mentioned today");
    const alsoLines = prompt
      .split("\n")
      .filter((l) => l.startsWith("Also mentioned today"));
    expect(alsoLines).toHaveLength(1);
    // Overflow names appear as bare symbols, not as rendered buckets.
    const overflowSym = bounded.overflowSymbols[0];
    expect(alsoLines[0]).toContain(overflowSym);
    expect(prompt).not.toContain(`## ${overflowSym} `);
  });

  it("omits the overflow line entirely when nothing overflowed", () => {
    const buckets = [makeBucket("AAA", 2, 300)];
    const bounded = boundSynthesisBuckets(buckets, {
      heldSymbols: [],
      watchlist: [],
      anomalySymbols: [],
    });
    const prompt = buildSynthesisPrompt(
      { buckets, heldSymbols: [], watchlist: [], anomalies: [] },
      bounded,
    );
    expect(prompt).not.toContain("Also mentioned today");
  });
});
