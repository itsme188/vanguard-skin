/**
 * The chat evaluation can price every model the app can now resolve to
 * (owner ruling 2026-11-12: always the latest version of a class). Figures
 * are the first-party rates on platform.claude.com/docs/en/about-claude/pricing,
 * checked 2026-11-12: input, output, cache read; 5-minute write = 1.25x input.
 */
import { describe, it, expect } from "vitest";
import { priceFor } from "../../scripts/chat-eval/pricing";

describe("chat-eval prices for the current generation", () => {
  it.each([
    ["claude-fable-5-2", 8, 10, 0.2, 40],
    ["claude-opus-5-5", 4, 5, 0.2, 20],
    ["claude-sonnet-5-5", 2, 2.5, 0.1, 10],
    ["claude-haiku-5-5", 0.1, 0.125, 0.01, 0.5],
  ])("%s", (id, input, cacheWrite, cacheRead, output) => {
    expect(priceFor(id)).toEqual({ input, cacheWrite, cacheRead, output });
  });

});
