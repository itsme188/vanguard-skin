import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boundSynthesisBuckets, renderBucket, synthesisCoverageNotice } from "@/lib/digest/synthesis-budget";
import { boundSynthesisBuckets as workerBound } from "../../workers/cron/src/synthesis-budget";

const article = { id: 1, source_id: 1, source_name: "Source", subject: "Subject", summary: "A source observation. ".repeat(100), sentiment: null, mentioned_symbols: null, portfolio_relevance: null, key_themes: null, source_url: "https://example.test", website_url: null, gmail_message_id: "test", received_at: "2026-09-17", sender: "source@example.test", processed_at: null, ai_model: null, sentiment_score: null };
const context = { heldSymbols: ["GOOG"], watchlist: ["WATCH"], anomalySymbols: ["ANOM"] };

describe("Mac / Worker synthesis budget", () => {
  it("pins the mirrored algorithm and disclosure byte for byte", () => {
    const body = (path: string) => readFileSync(path, "utf8").split("// Budget implementation mirrored")[1];
    expect(body("lib/digest/synthesis-budget.ts")).toBe(body("workers/cron/src/synthesis-budget.ts"));
  });
  it("selects and trims identical buckets, including issuer families", () => {
    const buckets = ["NOISE", "GOOGL", "WATCH", "ANOM", "(no symbol)"].map(symbol => ({ symbol, companyName: null, articles: [article] }));
    const result = boundSynthesisBuckets(buckets, context, { maxBuckets: 4 });
    expect(result).toEqual(workerBound(buckets, context, { maxBuckets: 4 }));
    expect(result.priority.map(b => b.symbol)).toEqual(["(no symbol)", "ANOM", "GOOGL", "WATCH"]);
    expect(synthesisCoverageNotice(result)).toContain("1 additional company/topic buckets");
  });
  it("discloses shortened summaries even without bucket overflow", () => {
    const result = boundSynthesisBuckets([{ symbol: "GOOG", companyName: null, articles: [article] }], context);
    expect(result.overflowSymbols).toEqual([]);
    expect(synthesisCoverageNotice(result)).toContain("shortened summaries");
  });
  it("bounds subject fallback and oversized macro metadata without mutating sources", () => {
    const subjectOnly = { ...article, summary: null, subject: "Subject ".repeat(10000) };
    const bucket = { symbol: "(no symbol)", companyName: null, articles: [subjectOnly] };
    const result = boundSynthesisBuckets([bucket], context);
    expect(result.priority.map(renderBucket).join("\n\n").length).toBeLessThan(60000);
    expect(subjectOnly.summary).toBeNull();
    const oversized = boundSynthesisBuckets([{ ...bucket, articles: [{ ...subjectOnly, source_url: "x".repeat(100000) }] }], context);
    expect(oversized.priority).toEqual([]);
    expect(synthesisCoverageNotice(oversized)).toContain("1 additional company/topic buckets");
  });
});
