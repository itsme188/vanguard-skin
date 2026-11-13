/**
 * Output caps a default-on thinking budget cannot eat (2026-11-12). On the
 * 5.5 generation thinking is on by default and counts against the output
 * cap, so a workhorse or frontier call capped at a few thousand tokens can
 * be cut off before its answer. Each call below asks for 16,000 (under the
 * raw SDK's ~21k non-streaming guard). Source pin: the anchor is the call,
 * the cap is the first one after it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const SITES: Array<[file: string, anchor: string]> = [
  ["lib/alerts/extract-newsletter-levels.ts", 'generateTextForFeature("newsletterLevelExtraction"'],
  ["lib/apis/filing-extract.ts", 'generateTextForFeature("filingSectionExtraction"'],
  ["lib/calendar/verify-earnings-dates.ts", "client.messages.create("],
  ["lib/etf/sector-weights.ts", "messages.create("],
  ["lib/securities/classify-option-sectors.ts", 'generateTextForFeature("securityClassification"'],
  ["lib/trade-review/questions.ts", 'generateObjectForFeature("tradeReviewQA"'],
  ["lib/calendar/macro-events.ts", 'generateTextForFeature("macroEnrichment"'],
  // 2026-11-13: the two callers the 2026-11-12 sweep left at 1,024 and 2,048.
  ["lib/research/verify-mentions.ts", 'generateObjectForFeature("researchMentionVerification"'],
  ["lib/gmail/process.ts", 'generateObjectForFeature("newsletterProcessing"'],
  // Their Worker counterparts (fallbackNewsletterProcessing, workhorse tier).
  ["workers/cron/src/newsletter-fetch.ts", '"fallbackNewsletterProcessing"'],
  ["workers/cron/src/fallback-digest.ts", '"fallbackNewsletterProcessing"'],
];

describe("workhorse/frontier calls leave room for thinking", () => {
  it.each(SITES)("%s", (file, anchor) => {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const at = anchorIndex(src, anchor, 0, file);
    const m = /(?:maxOutputTokens|max_tokens):\s*([\d_]+)/.exec(src.slice(at, at + 1500));
    expect(m, `${file}: no cap after the call`).not.toBeNull();
    const cap = Number(m![1].replace(/_/g, ""));
    expect(cap).toBeGreaterThanOrEqual(16_000);
    expect(cap).toBeLessThanOrEqual(21_000);
  });
});
