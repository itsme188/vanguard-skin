/**
 * QA finding (medium): the Analysis AI controls answered an Anthropic
 * account outage (out of credit, spend cap, rejected key...) with "try again
 * in a few minutes", a retry that cannot succeed.
 *
 * The generate routes now answer an account-level failure with HTTP 503,
 * `reason: "ai_account"` and the shared `aiUnavailableReason(kind)` sentence.
 * The one translator (`describeRefreshFailure`) names it and ends with a
 * non-retry clause; `isExpectedRefreshState` treats it like the rate limit
 * (an expected state, neutral colour). The client-safe reader
 * (`lib/ui/ai-account-failure.ts`) must agree with the server's prefix and
 * kind list. No DOM harness here, so the card wiring is pinned by source scan.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  describeRefreshFailure,
  isExpectedRefreshState,
  MACRO_THEMES_SUBJECT,
  NARRATIVE_SUBJECT,
} from "@/app/dashboard/components/analysis/refresh-failure-message";
import {
  AI_UNAVAILABLE_REASON_PREFIX,
  aiUnavailableReason,
  type AccountFailureKind,
} from "@/lib/earnings/ai-unavailable";
import {
  AI_ACCOUNT_FAILURE_REASON,
  AI_ACCOUNT_KINDS,
  AI_UNAVAILABLE_PREFIX,
  readAiAccountFailure,
} from "@/lib/ui/ai-account-failure";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const ALL_KINDS: AccountFailureKind[] = ["billing", "auth", "rate_limit", "outage", "network", "config"];

function body(kind: AccountFailureKind) {
  return { success: false, error: aiUnavailableReason(kind), reason: "ai_account" };
}

describe("the client-safe reader agrees with the server module", () => {
  it("uses the same sentence prefix", () => {
    expect(AI_UNAVAILABLE_PREFIX).toBe(AI_UNAVAILABLE_REASON_PREFIX);
    expect(AI_ACCOUNT_FAILURE_REASON).toBe("ai_account");
  });

  it("knows every account kind and reads each server sentence back to its kind", () => {
    expect([...AI_ACCOUNT_KINDS].sort()).toEqual([...ALL_KINDS].sort());
    for (const kind of ALL_KINDS) {
      expect(readAiAccountFailure(body(kind))?.kind).toBe(kind);
    }
  });

  it("is null for an ordinary failure body", () => {
    expect(readAiAccountFailure({ error: "Couldn't refresh macro themes — try again in a few minutes." })).toBeNull();
    expect(readAiAccountFailure(null)).toBeNull();
    expect(readAiAccountFailure({ error: "rate-limited", reason: "daily" })).toBeNull();
  });
});

describe("describeRefreshFailure — 503 account failure", () => {
  it("names the out-of-credit outage and never invites a retry in minutes", () => {
    const msg = describeRefreshFailure(NARRATIVE_SUBJECT, 503, body("billing"));
    expect(msg).toBe(
      "Couldn't regenerate the narrative — AI unavailable (billing). Retry once the account is restored.",
    );
    expect(msg).not.toMatch(/few minutes|in a minute|Try again/i);
    // The server sentence's tail is for the earnings prepare steps, not a card.
    expect(msg).not.toMatch(/no attempt counted|waiting/);
  });

  it("uses the macro card's subject", () => {
    expect(describeRefreshFailure(MACRO_THEMES_SUBJECT, 503, body("auth"))).toBe(
      "Couldn't refresh macro themes — AI unavailable (auth). Retry once the account is restored.",
    );
  });

  it("says the service must recover for the kinds that pass by themselves", () => {
    for (const kind of ["rate_limit", "outage", "network"] as const) {
      const msg = describeRefreshFailure(MACRO_THEMES_SUBJECT, 503, body(kind));
      expect(msg).toBe(
        `Couldn't refresh macro themes — AI unavailable (${kind}). Retry once the AI service recovers.`,
      );
    }
  });

  it("reads the sentence prefix even without the reason flag", () => {
    const msg = describeRefreshFailure(NARRATIVE_SUBJECT, 503, { error: aiUnavailableReason("config") });
    expect(msg).toContain("AI unavailable (config)");
  });

  it("leaves a plain 503 and every other status on the generic sentence", () => {
    for (const status of [500, 502, 503]) {
      expect(describeRefreshFailure(NARRATIVE_SUBJECT, status, { error: "Anthropic 529 overloaded" })).toBe(
        "Couldn't regenerate the narrative — the request failed. Try again in a few minutes.",
      );
    }
    // An account body on a 500 is not the route's contract; keep the old copy.
    expect(describeRefreshFailure(NARRATIVE_SUBJECT, 500, body("billing"))).toMatch(/few minutes/);
  });
});

describe("isExpectedRefreshState", () => {
  it("treats an account failure like the rate limit", () => {
    expect(isExpectedRefreshState(503, body("billing"))).toBe(true);
    expect(isExpectedRefreshState(429)).toBe(true);
  });

  it("keeps every other failure in the loss colour", () => {
    expect(isExpectedRefreshState(503, { error: "boom" })).toBe(false);
    expect(isExpectedRefreshState(503)).toBe(false);
    expect(isExpectedRefreshState(500, body("billing"))).toBe(false);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("the cards show the translated sentence for an account failure", () => {
  it("MacroOverlayCard: the expected-state check reads the body and the fixed 'unavailable' line is skipped", () => {
    const src = read("app/dashboard/components/analysis/MacroOverlayCard.tsx");
    const at = anchorIndex(src, "describeRefreshFailure(MACRO_THEMES_SUBJECT, res.status, json)");
    const region = src.slice(at, at + 1400);
    expect(region).toContain("isExpectedRefreshState(res.status, json)");
    expect(region).toMatch(/unavailable:\s*res\.status >= 500 && !accountFailure/);
    // A route message is preferred over the fallback only when it is NOT the
    // account sentence (whose tail is for the earnings prepare steps).
    expect(region).toMatch(/!accountFailure/);
  });

  it("NarrativeBlock: the cold-failure state shows the sentence and hides 'Try again'", () => {
    const src = read("app/dashboard/components/analysis/NarrativeBlock.tsx");
    const at = anchorIndex(src, "describeRefreshFailure(NARRATIVE_SUBJECT, res.status, data)");
    const region = src.slice(at, at + 600);
    expect(region).toMatch(/setAiUnavailable\(res\.status >= 500 && !accountFailure\)/);
    expect(region).toContain("setAccountFailure(accountFailure)");
    const cold = src.slice(anchorIndex(src, 'renderState === "cold-failure"'));
    const coldRegion = cold.slice(0, 1600);
    expect(coldRegion).toMatch(/!accountFailure && \(/);
  });
});
