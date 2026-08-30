/**
 * QA: import-pdf--wrong-format-500-truncated-midword-error.
 *
 * lib/import/parsers/vanguard-pdf.ts (a file under CLAUDE.md's "What NOT to
 * Change" — do not edit it) throws
 *   `Failed to parse Claude response as JSON: ${jsonText.slice(0, 200)}`
 * whenever Claude answers in prose instead of the requested JSON schema.
 * That happens for two very different reasons:
 *
 *   1. The uploaded PDF isn't a Vanguard statement at all (a CUPS test page,
 *      a random PDF, etc.) — Claude politely explains that in prose. This is
 *      a user mistake, not a server failure: it should be a 4xx with a
 *      domain-first message, not a 500 with an implementation-detail prefix.
 *   2. Claude's response is genuinely malformed/truncated for an unrelated
 *      reason. This really is a server-side failure and should stay a 500 —
 *      but the embedded fragment is still a raw 200-char slice that can cut
 *      off mid-word, so it's cleaned up to a word-boundary + ellipsis too.
 *
 * This module is the API-boundary classifier: it inspects the *message* of
 * a caught error (never the parser internals) and decides which case applies.
 * Kept separate from the parser and from app/api/import/route.ts so it's
 * independently unit-testable.
 *
 * A THIRD case lives here too: the Claude call itself can fail before the
 * parser ever runs (billing, rotated/invalid API key, rate-limit, overload —
 * see lib/ai/classify-anthropic-error.ts). When that happens, the message
 * that reaches this module IS the raw Anthropic error envelope
 * (`'400 {"type":"error","error":{...},"request_id":"req_..."}'`), not the
 * parser's "Failed to parse..." shape — so it's checked first, via
 * `classifyAnthropicErrorMessage`, before the wrong-document logic below.
 */

import { classifyAnthropicErrorMessage } from "@/lib/ai/classify-anthropic-error";

const PARSE_JSON_PREFIX = "Failed to parse Claude response as JSON: ";

// Phrases Claude actually uses (observed in QA sweeps, e.g.
// "This document is not a Vanguard brokerage statement — …",
// "The provided PDF is not a Vanguard brokerage statement — …") when it's
// explaining that the uploaded document isn't a Vanguard statement, rather
// than emitting the requested JSON.
const WRONG_DOCUMENT_PATTERNS: RegExp[] = [
  /not a vanguard/i,
  /not a brokerage statement/i,
  /does not appear to be/i,
];

const MAX_EMBEDDED_LENGTH = 160;

export interface ImportErrorClassification {
  status: 400 | 500;
  userMessage: string;
}

/**
 * Truncate `text` to at most `maxLength` characters, cutting on a word
 * boundary (never mid-word) and appending an ellipsis when truncated.
 */
export function truncateAtWordBoundary(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;

  const slice = trimmed.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Classify a caught import error's message into an HTTP status + a
 * user-facing message.
 *
 * - Not the parser's JSON-parse-failure shape at all → passthrough as-is
 *   (still a 500; some other failure entirely, message untouched).
 * - The parser's JSON-parse-failure shape, and the embedded text reads like
 *   Claude explaining the document isn't a Vanguard statement → 400 with a
 *   domain-first message, embedded explanation word-boundary-truncated.
 * - The parser's JSON-parse-failure shape, but no such explanation (genuinely
 *   malformed AI JSON) → stays 500, same prefix, word-boundary-truncated.
 * - The message IS a raw Anthropic API error envelope (the Claude call
 *   failed before parsing ever started) → the classifier's plain-English
 *   message. "content" (Claude rejected the document/image itself) keeps a
 *   400 like the wrong-document case above; every other kind (billing,
 *   auth, rate-limit, overloaded, unknown) is a service-side condition, not
 *   the user's document, so it's a 500 — same as an unrelated passthrough
 *   error.
 */
export function classifyImportError(message: string): ImportErrorClassification {
  const anthropicClassification = classifyAnthropicErrorMessage(message);
  if (anthropicClassification) {
    return {
      status: anthropicClassification.kind === "content" ? 400 : 500,
      userMessage: anthropicClassification.userMessage,
    };
  }

  if (!message.startsWith(PARSE_JSON_PREFIX)) {
    return { status: 500, userMessage: message };
  }

  const embedded = message.slice(PARSE_JSON_PREFIX.length);
  const truncated = truncateAtWordBoundary(embedded, MAX_EMBEDDED_LENGTH);
  const looksLikeWrongDocument = WRONG_DOCUMENT_PATTERNS.some((pattern) =>
    pattern.test(embedded)
  );

  if (looksLikeWrongDocument) {
    return {
      status: 400,
      userMessage: `This file doesn't look like a Vanguard brokerage statement. ${truncated}`,
    };
  }

  return {
    status: 500,
    userMessage: `${PARSE_JSON_PREFIX}${truncated}`,
  };
}
