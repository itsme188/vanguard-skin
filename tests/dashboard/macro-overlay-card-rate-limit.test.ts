import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatRateLimitMessage } from "@/app/dashboard/components/analysis/rate-limit-message";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). So the shared pure helper is
// tested directly and the component wiring is pinned by a source scan, following
// tests/dashboard/quick-action-chips-scrollfade.test.ts.
//
// QA finding `analysis-macro-themes--auto-generates-on-mount-then-bare-rate-limited-token`:
// MacroOverlayCard threw away `res.status`, so a 429 from POST
// /api/analysis/macro-themes rendered its raw API token — the card body became
// the single word "rate-limited". NarrativeBlock already had the domain-language
// formatter; it is now shared instead of duplicated.

const CARD_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/analysis/MacroOverlayCard.tsx",
);
const NARRATIVE_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/analysis/NarrativeBlock.tsx",
);

const MS_PER_HOUR = 60 * 60 * 1000;

describe("formatRateLimitMessage (shared 429 wording)", () => {
  it("keeps NarrativeBlock's rendered strings byte-identical", () => {
    expect(formatRateLimitMessage("Narrative refreshes", 3 * MS_PER_HOUR)).toBe(
      "Narrative refreshes once per day — available again in about 3h.",
    );
    expect(formatRateLimitMessage("Narrative refreshes", 5 * 60 * 1000)).toBe(
      "Narrative refreshes once per day — available again in less than 1h.",
    );
  });

  it("renders the macro-card subject with the same sentence shape", () => {
    expect(formatRateLimitMessage("Macro themes refresh", 20 * MS_PER_HOUR)).toBe(
      "Macro themes refresh once per day — available again in about 20h.",
    );
  });

  it("rounds partial hours UP so 'about Nh' never understates the wait", () => {
    expect(formatRateLimitMessage("Macro themes refresh", MS_PER_HOUR + 1)).toBe(
      "Macro themes refresh once per day — available again in about 2h.",
    );
  });

  it("falls back to the 'less than 1h' branch for a missing or non-numeric retryAfter", () => {
    // The 10-minute failure cooldown lands here too.
    expect(formatRateLimitMessage("Macro themes refresh", undefined)).toBe(
      "Macro themes refresh once per day — available again in less than 1h.",
    );
    expect(formatRateLimitMessage("Macro themes refresh", "soon")).toBe(
      "Macro themes refresh once per day — available again in less than 1h.",
    );
    expect(formatRateLimitMessage("Macro themes refresh", 10 * 60 * 1000)).toBe(
      "Macro themes refresh once per day — available again in less than 1h.",
    );
  });
});

describe("MacroOverlayCard renders a 429 in domain language, never the API token", () => {
  const source = fs.readFileSync(CARD_PATH, "utf8");

  it("imports the shared formatter", () => {
    expect(source).toMatch(
      /import\s*\{\s*formatRateLimitMessage\s*\}\s*from\s*["']\.\/rate-limit-message["']/,
    );
  });

  it("branches on the 429 status instead of discarding it", () => {
    expect(source).toMatch(/res\.status\s*===\s*429/);
    expect(source).toContain("formatRateLimitMessage(");
  });

  it("carries retryAfter on the response type so the wait time can be rendered", () => {
    expect(source).toMatch(/retryAfter\?\s*:\s*number/);
  });

  it("never renders the bare rate-limited token", () => {
    expect(source).not.toContain("rate-limited");
  });
});

describe("NarrativeBlock uses the same shared formatter", () => {
  const source = fs.readFileSync(NARRATIVE_PATH, "utf8");

  it("imports it rather than declaring a local copy", () => {
    expect(source).toMatch(
      /import\s*\{\s*formatRateLimitMessage\s*\}\s*from\s*["']\.\/rate-limit-message["']/,
    );
    expect(source).not.toMatch(/function\s+formatRateLimitMessage/);
  });

  it("passes its own subject clause", () => {
    expect(source).toMatch(/formatRateLimitMessage\(\s*["']Narrative refreshes["']/);
  });
});
