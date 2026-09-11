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

describe("NarrativeBlock after the 2026-09-07 refresh-failure fix (landing resolution 2026-09-11)", () => {
  // PR #69 (2026-09-07) replaced NarrativeBlock's 429-only formatter with
  // describeRefreshFailure(status, data), which covers 429 (minutes/hours),
  // network failure and every other status in one place; PR #74 (2026-09-10)
  // was cut from an older base and re-pointed NarrativeBlock at the shared
  // formatter it extracted for the Macro card. At landing the richer #69
  // helper wins for NarrativeBlock; the shared formatter stays the Macro
  // card's. Pin that neither card declares a private copy, and that the
  // narrative 429 path still never leaks the bare "rate-limited" token.
  const source = fs.readFileSync(NARRATIVE_PATH, "utf8");

  it("declares no local formatRateLimitMessage", () => {
    expect(source).not.toMatch(/function\s+formatRateLimitMessage/);
  });

  it("routes every failed refresh, 429 included, through describeRefreshFailure", () => {
    expect(source).toMatch(/setRefreshError\(describeRefreshFailure\(res\.status, data\)\)/);
    expect(source).toMatch(/setRefreshError\(describeRefreshFailure\(0, null\)\)/);
    // The token may appear in comments; it must never be what the card renders.
    expect(source).not.toMatch(/setRefreshError\(\s*(data\.error|["']rate-limited)/);
  });
});
