import { describe, it, expect } from "vitest";
import {
  classifyImportError,
  truncateAtWordBoundary,
} from "@/lib/import/error-classify";

// QA: import-pdf--wrong-format-500-truncated-midword-error.
//
// lib/import/parsers/vanguard-pdf.ts is under CLAUDE.md's "What NOT to
// Change" (it throws `Failed to parse Claude response as JSON: ${slice}`
// verbatim) — so the fix lives entirely at the API boundary via this
// classifier. These tests exercise classifyImportError directly against
// realistic messages, including wording actually observed from Claude in
// QA sweeps ("This document is not a Vanguard brokerage statement — …").

describe("classifyImportError", () => {
  it("maps a wrong-document explanation to 400 with a domain-first message", () => {
    const message =
      "Failed to parse Claude response as JSON: This document is not a Vanguard brokerage statement — it appears to be a printer test page with no account or holdings information.";

    const result = classifyImportError(message);

    expect(result.status).toBe(400);
    expect(result.userMessage.startsWith(
      "This file doesn't look like a Vanguard brokerage statement."
    )).toBe(true);
    // The raw implementation-detail prefix must not leak into the user message.
    expect(result.userMessage).not.toContain("Failed to parse Claude response as JSON");
  });

  it("recognizes the 'is not a brokerage statement' phrasing variant", () => {
    const message =
      "Failed to parse Claude response as JSON: I can't extract the requested data. The provided PDF is not a Vanguard brokerage statement — it looks like an unrelated document.";

    const result = classifyImportError(message);
    expect(result.status).toBe(400);
  });

  it("recognizes the 'does not appear to be' phrasing variant", () => {
    const message =
      "Failed to parse Claude response as JSON: The uploaded file does not appear to be a Vanguard account statement, so no data could be extracted.";

    const result = classifyImportError(message);
    expect(result.status).toBe(400);
  });

  it("word-boundary-truncates the embedded explanation with an ellipsis instead of cutting mid-word", () => {
    const longExplanation =
      "This document is not a Vanguard brokerage statement — it appears to be a scanned receipt from an unrelated retail purchase with no account number, holdings, or transaction history of any kind, so nothing could be extracted from it at all.";
    const message = `Failed to parse Claude response as JSON: ${longExplanation}`;

    const result = classifyImportError(message);

    expect(result.status).toBe(400);
    expect(result.userMessage).toContain("…");
    // No truncation mid-word: the text immediately before the ellipsis must
    // not be cut inside a word (i.e. the char before the ellipsis is not
    // immediately preceded by a partial word fragment — check via the
    // truncateAtWordBoundary helper directly for a tight guarantee below).
    expect(result.userMessage.length).toBeLessThan(longExplanation.length + 60);
  });

  it("truncateAtWordBoundary never cuts a word in half", () => {
    const text =
      "supercalifragilisticexpialidocious is not a real truncation boundary word by itself but the sentence around it is long enough to force a cut";
    const truncated = truncateAtWordBoundary(text, 40);

    expect(truncated.endsWith("…")).toBe(true);
    const withoutEllipsis = truncated.slice(0, -1);
    // Whatever we kept must be a prefix of full words from the original text.
    expect(text.startsWith(withoutEllipsis.trimEnd())).toBe(true);
    // The char right after the kept text in the original must be a space
    // (i.e. we stopped at a word boundary, not mid-word).
    const nextChar = text[withoutEllipsis.trimEnd().length];
    expect(nextChar === " " || nextChar === undefined).toBe(true);
  });

  it("truncateAtWordBoundary returns the text unchanged when already short enough", () => {
    expect(truncateAtWordBoundary("short text", 160)).toBe("short text");
  });

  it("keeps genuinely malformed AI JSON as a 500, still word-boundary-truncated", () => {
    const garbage =
      "{\"account_type\": \"Individual\", \"holdings\": [truncated mid object with no closing brace and a bunch of trailing garbage that just keeps going and going without any sign of the wrong-document explanation phrasing at all";
    const message = `Failed to parse Claude response as JSON: ${garbage}`;

    const result = classifyImportError(message);

    expect(result.status).toBe(500);
    expect(result.userMessage.startsWith("Failed to parse Claude response as JSON: ")).toBe(true);
    expect(result.userMessage).toContain("…");
  });

  it("passes an unrelated error message straight through unchanged, as a 500", () => {
    const message = "ECONNREFUSED: could not reach Claude API";
    const result = classifyImportError(message);

    expect(result).toEqual({ status: 500, userMessage: message });
  });

  it("passes through a short genuinely-malformed message without adding an ellipsis", () => {
    const message = "Failed to parse Claude response as JSON: {}";
    const result = classifyImportError(message);

    expect(result).toEqual({ status: 500, userMessage: message });
  });
});
