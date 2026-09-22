/**
 * QA 2026-09-22 —
 * analysis-trade-reviews--generate-review-dies-raw-anthropic-tool-choice-error.
 *
 * "Generate Review" printed the vendor's own sentence, verbatim, in the banner:
 *   Error: tool_choice: type "tool" and "any" are not supported for this model.
 * Nothing was saved, nothing explained that, and the banner survived an account
 * switch — so a failure from one account/month described a different period.
 *
 * Three pins here:
 *   1. the copy helper words a failure in domain language (honest-button rule:
 *      what failed, what state the data is in, what to do next);
 *   2. the component no longer interpolates a raw error into the banner, and
 *      the banner's error styling hangs off an explicit flag rather than the
 *      text starting with the word "Error" (which pinned copy to CSS);
 *   3. both selection-change handlers clear the banner.
 *
 * Source-scanned rather than rendered: this repo has no jsdom/RTL harness
 * (see tests/dashboard/notes-composer-save-failure-copy.test.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tradeReviewFailureMessage } from "@/app/dashboard/components/TradeReviewView";

const src = readFileSync("app/dashboard/components/TradeReviewView.tsx", "utf8");

describe("tradeReviewFailureMessage", () => {
  it("says what failed, that nothing was saved, and what to do next", () => {
    const msg = tradeReviewFailureMessage("The AI service is temporarily overloaded.");
    expect(msg).toMatch(/couldn't generate the review/i);
    expect(msg).toContain("The AI service is temporarily overloaded.");
    expect(msg).toMatch(/nothing was saved/i);
    expect(msg).toMatch(/period is unchanged/i);
    expect(msg).toMatch(/try again, or pick a different month/i);
  });

  it("never renders the vendor's tool_choice sentence", () => {
    // The route classifies before sending; this is the belt-and-braces check
    // that the copy itself introduces no vendor vocabulary.
    const msg = tradeReviewFailureMessage(
      "The AI model this feature is set to use can't handle this kind of request.",
    );
    expect(msg).not.toMatch(/tool_choice|anthropic|claude-|400/i);
  });

  it("does not repeat the lead-in when the server sent the generic fallback", () => {
    const msg = tradeReviewFailureMessage("Couldn't generate the review.");
    expect(msg.match(/couldn't generate the review/gi)).toHaveLength(1);
    expect(msg).toMatch(/nothing was saved/i);
  });

  it("still reads as a sentence with no reason at all", () => {
    for (const empty of [undefined, null, "", "   "]) {
      const msg = tradeReviewFailureMessage(empty);
      expect(msg).toMatch(/^Couldn't generate the review\. /);
      expect(msg).toMatch(/nothing was saved/i);
      expect(msg).not.toMatch(/undefined|null|NaN|—\s*\./);
    }
  });
});

describe("TradeReviewView banner wiring", () => {
  it("no longer interpolates a raw error into the banner text", () => {
    // `Error: ${data.error}` / `Error: ${errorBody?.error ...}` / `Error: ${err...}`
    expect(src).not.toMatch(/`Error:\s*\$\{/);
    expect(src).not.toContain("Error: ${");
  });

  it("routes every generate failure through the copy helper", () => {
    const doGenerate = src.slice(
      src.indexOf("const doGenerate = async ("),
      src.indexOf("// ── Regenerate"),
    );
    expect(doGenerate.length).toBeGreaterThan(0);
    // HTTP-level failure, SSE `error` event, and the network catch.
    expect(
      (doGenerate.match(/tradeReviewFailureMessage\(/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    // Every one of them also raises the explicit error flag.
    expect(
      (doGenerate.match(/setGenerateFailed\(true\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    // ...and the flag is cleared when a fresh run starts.
    expect(doGenerate).toMatch(/setGenerateFailed\(false\)/);
  });

  it("styles the banner off the error flag, not off the copy starting with 'Error'", () => {
    expect(src).not.toMatch(/generateMsg\.startsWith\(\s*"Error"\s*\)/);
    expect(src).toMatch(/generateFailed\s*\n?\s*\?\s*"border-down/);
  });

  it("clears a stale banner when the account changes", () => {
    const handler = src.slice(
      src.indexOf("const handleAccountChange = async ("),
      src.indexOf("// ── Month change"),
    );
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/setGenerateMsg\(null\)/);
    expect(handler).toMatch(/setGenerateFailed\(false\)/);
  });

  it("clears a stale banner when the month changes", () => {
    const handler = src.slice(
      src.indexOf("const handlePeriodChange = ("),
      src.indexOf("// ── Find unreviewed periods"),
    );
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/setSelectedPeriod\(periodStart\)/);
    expect(handler).toMatch(/setGenerateMsg\(null\)/);
    expect(handler).toMatch(/setGenerateFailed\(false\)/);
    // The month <select> must actually go through the handler.
    expect(src).toMatch(/onChange=\{\(e\) => handlePeriodChange\(e\.target\.value\)\}/);
  });
});
