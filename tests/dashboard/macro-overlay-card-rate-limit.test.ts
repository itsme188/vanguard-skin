import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  describeRefreshFailure,
  isExpectedRefreshState,
  MACRO_THEMES_SUBJECT,
  NARRATIVE_SUBJECT,
} from "@/app/dashboard/components/analysis/refresh-failure-message";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). So the shared pure helper is
// tested directly and the component wiring is pinned by a source scan, following
// tests/dashboard/quick-action-chips-scrollfade.test.ts.
//
// QA finding `analysis-macro-themes--auto-generates-on-mount-then-bare-rate-limited-token`:
// MacroOverlayCard threw away `res.status`, so a 429 from POST
// /api/analysis/macro-themes rendered its raw API token — the card body became
// the single word "rate-limited".
//
// Landing 2026-09-11: PR #69 gave NarrativeBlock describeRefreshFailure(status,
// data) and PR #74 extracted an older 429-only formatter for the Macro card,
// leaving TWO helpers in the tree. There is now exactly ONE, parameterised by a
// RefreshSubject, in ./refresh-failure-message.

const CARD_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/analysis/MacroOverlayCard.tsx",
);
const NARRATIVE_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/analysis/NarrativeBlock.tsx",
);
const HELPER_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/analysis/refresh-failure-message.ts",
);

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

describe("describeRefreshFailure — the macro card's subject", () => {
  it("explains the once-a-day limit with the wait, never the bare API token", () => {
    const msg = describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, {
      error: "rate-limited",
      reason: "daily",
      retryAfter: 20 * MS_PER_HOUR,
    });
    expect(msg).toBe(
      "Can't regenerate yet — macro themes refresh once a day. Try again in about 20h.",
    );
    expect(msg).not.toContain("rate-limited");
  });

  it("rounds partial hours UP so 'about Nh' never understates the wait", () => {
    expect(
      describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, {
        reason: "daily",
        retryAfter: MS_PER_HOUR + 1,
      }),
    ).toContain("about 2h");
  });

  it("names the FAILURE cooldown as its own cause, in minutes — not 'once a day'", () => {
    // The route's 10-minute cooldown after a failed generation used to be
    // answered with the daily-limit sentence, which said both the wrong reason
    // ("refreshes once a day") and the wrong wait ("less than 1h").
    const msg = describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, {
      error: "rate-limited",
      reason: "last_attempt_failed",
      retryAfter: 9 * MS_PER_MINUTE + 1,
    });
    expect(msg).toBe(
      "The last macro-themes generation failed; the next attempt opens in about 10 minutes.",
    );
    expect(msg).not.toMatch(/once a day/i);
    expect(msg).not.toMatch(/less than 1h/);
  });

  it("says a single minute in the singular", () => {
    expect(
      describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, {
        reason: "last_attempt_failed",
        retryAfter: MS_PER_MINUTE,
      }),
    ).toContain("about 1 minute.");
  });

  it("still gives a usable sentence when the 429 body carries no retryAfter", () => {
    const daily = describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, { reason: "daily" });
    expect(daily).toBe(
      "Can't regenerate yet — macro themes refresh once a day. Try again later.",
    );
    const failed = describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, {
      reason: "last_attempt_failed",
      retryAfter: "soon",
    });
    expect(failed).toBe(
      "The last macro-themes generation failed; the next attempt opens shortly.",
    );
    for (const msg of [daily, failed]) {
      expect(msg).not.toMatch(/undefined|NaN|Invalid|\b0h\b/);
    }
  });

  it("treats a 429 with no reason as the daily limit", () => {
    expect(describeRefreshFailure(MACRO_THEMES_SUBJECT, 429, {})).toMatch(/once a day/);
  });

  it("maps a network failure and any other status to macro-card domain copy", () => {
    expect(describeRefreshFailure(MACRO_THEMES_SUBJECT, 0, null)).toBe(
      "Couldn't refresh macro themes — could not reach the server. Try again.",
    );
    for (const status of [404, 500, 502]) {
      const msg = describeRefreshFailure(MACRO_THEMES_SUBJECT, status, {
        error: "Anthropic 529 overloaded",
      });
      expect(msg).toBe(
        "Couldn't refresh macro themes — the request failed. Try again in a few minutes.",
      );
      // Raw server/model text never reaches the card through the helper.
      expect(msg).not.toContain("Anthropic");
    }
  });
});

describe("describeRefreshFailure — NarrativeBlock's strings stay byte-identical", () => {
  // These are the exact strings PR #69 shipped. The subject parameter exists so
  // that unifying the two helpers changed no rendered narrative copy.
  it("renders the 429 sentences unchanged", () => {
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 429, { retryAfter: 3 * MS_PER_HOUR })).toBe(
      "Can't regenerate yet — this narrative refreshes once a day. Try again in about 3h.",
    );
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 429, { retryAfter: 5 * MS_PER_MINUTE })).toBe(
      "Can't regenerate yet — this narrative refreshes once a day. Try again in about 5 minutes.",
    );
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 429, { retryAfter: 30 * 1000 })).toBe(
      "Can't regenerate yet — this narrative refreshes once a day. Try again in under a minute.",
    );
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 429, {})).toBe(
      "Can't regenerate yet — this narrative refreshes once a day. Try again later.",
    );
  });

  it("renders the network and generic-failure sentences unchanged", () => {
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 0, null)).toBe(
      "Couldn't regenerate the narrative — could not reach the server. Try again.",
    );
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 500, { error: "boom" })).toBe(
      "Couldn't regenerate the narrative — the request failed. Try again in a few minutes.",
    );
  });
});

describe("isExpectedRefreshState", () => {
  it("calls a rate limit expected and everything else a breakage", () => {
    expect(isExpectedRefreshState(429)).toBe(true);
    expect(isExpectedRefreshState(500)).toBe(false);
    expect(isExpectedRefreshState(0)).toBe(false);
  });
});

describe("one shared helper, no per-card copies", () => {
  const helper = fs.readFileSync(HELPER_PATH, "utf8");
  const card = fs.readFileSync(CARD_PATH, "utf8");
  const narrative = fs.readFileSync(NARRATIVE_PATH, "utf8");

  it("is the only module that declares the formatter", () => {
    expect(helper).toMatch(/export function describeRefreshFailure/);
    expect(card).not.toMatch(/function\s+describeRefreshFailure/);
    expect(narrative).not.toMatch(/function\s+describeRefreshFailure/);
    // The superseded 429-only formatter is gone from the tree.
    expect(card).not.toContain("formatRateLimitMessage");
    expect(narrative).not.toContain("formatRateLimitMessage");
    expect(
      fs.existsSync(
        path.join(process.cwd(), "app/dashboard/components/analysis/rate-limit-message.ts"),
      ),
    ).toBe(false);
  });

  it("both cards import it from the shared module", () => {
    expect(card).toMatch(/from\s*["']\.\/refresh-failure-message["']/);
    expect(narrative).toMatch(/from\s*["']\.\/refresh-failure-message["']/);
  });
});

describe("MacroOverlayCard wiring", () => {
  const source = fs.readFileSync(CARD_PATH, "utf8");

  it("branches on the response status instead of discarding it", () => {
    expect(source).toMatch(/describeRefreshFailure\(MACRO_THEMES_SUBJECT, res\.status, json\)/);
  });

  it("carries retryAfter and reason on the response type so both 429s can be told apart", () => {
    expect(source).toMatch(/retryAfter\?\s*:\s*number/);
    expect(source).toMatch(/reason\?\s*:\s*"daily"\s*\|\s*"last_attempt_failed"/);
  });

  it("never renders the bare rate-limited token or a raw network word", () => {
    expect(source).not.toContain("rate-limited");
    expect(source).not.toMatch(/error:\s*["']network error["']/);
    expect(source).toMatch(/describeRefreshFailure\(MACRO_THEMES_SUBJECT, 0, null\)/);
  });

  it("renders an expected state (the rate limit) neutrally, not in the loss colour", () => {
    // The failure box is shared by both cases; only a real breakage may reach
    // the down/loss treatment.
    const box = source.slice(source.indexOf("!data.success && !data.underThreshold"));
    expect(box).toMatch(/data\.expected\s*\?\s*["']status["']\s*:\s*["']alert["']/);
    expect(box).toMatch(/data\.expected\s*\?\s*["']border-edge\/40["']\s*:\s*["']border-down\/40["']/);
    expect(box).toMatch(/data\.expected\s*\?\s*["']text-ink-faint["']\s*:\s*["']text-down["']/);
  });
});
