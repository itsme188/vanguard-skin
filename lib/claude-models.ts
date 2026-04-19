/**
 * Central source of truth for Claude model IDs used throughout the app.
 *
 * Anthropic's API doesn't support "latest" aliases — every call must pass
 * a specific model ID. Historically these were scattered across a dozen
 * files, which meant a model rename (e.g. a typo like `claude-sonnet-4-7`
 * for a version that doesn't exist) silently broke every feature that
 * called Claude.
 *
 * Rule: do NOT inline a model string anywhere else. Import from here.
 *
 * To bump a model family: edit this file, run the full test suite, and
 * manually smoke-test each feature that uses Claude (chat, calendar sync,
 * trade review, briefing, Gmail processing, PDF extraction).
 */

/** Top-tier reasoning. Used for chat, trade reviews, briefings. */
export const OPUS_MODEL = "claude-opus-4-7";

/** Fast/cheap. Used for enrichment, Gmail processing, high-volume tasks. */
export const SONNET_MODEL = "claude-sonnet-4-6";
