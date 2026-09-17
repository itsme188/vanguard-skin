import { describe, it, expect } from "vitest";
import { formatGeneratedAt } from "@/lib/calendar/date-utils";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — confirmed by grep before writing
// this file). Following the notesListIsFiltered precedent in
// tests/dashboard/notes-filtered-state.test.ts, we test the extracted pure
// helper directly rather than inventing a rendering harness. The fetch-wiring
// (GET populates the caption, POST refresh replaces text, refresh failure
// surfaces the server error) is covered by browser verification instead.
//
// formatGeneratedAt lives in lib/calendar/date-utils.ts (moved out of
// NarrativeBlock.tsx — it's a generic ET date formatter, not UI logic).
describe("formatGeneratedAt (as-of caption date, ET-anchored)", () => {
  it("formats an ISO timestamp as a short month + day in Eastern time", () => {
    // Midday UTC is unambiguous in ET regardless of DST.
    expect(formatGeneratedAt("2026-08-10T15:00:00.000Z")).toBe("Aug 10");
  });

  it("anchors to ET, not UTC — a late-UTC-evening timestamp is still the same ET day", () => {
    // 2026-08-11T02:00Z is 2026-08-10 22:00 ET (EDT, UTC-4) — previous day in ET.
    expect(formatGeneratedAt("2026-08-11T02:00:00.000Z")).toBe("Aug 10");
  });

  it("never renders a raw ISO string", () => {
    const out = formatGeneratedAt("2026-08-10T15:00:00.000Z");
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
    expect(out).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("parses the SQLite datetime('now') shape — space-separated UTC, no 'Z' — as UTC, not local time", () => {
    // 2026-08-13 01:00:00 UTC is 2026-08-12 21:00 ET (EDT, UTC-4) — a naive
    // `new Date("2026-08-13 01:00:00")` would parse this as LOCAL time
    // instead, silently shifting the instant (and on some Safari versions,
    // rejecting the string outright as Invalid Date).
    expect(formatGeneratedAt("2026-08-13 01:00:00")).toBe("Aug 12");
  });

  it("returns null for an unparseable string, so the caller hides the caption instead of rendering Invalid Date", () => {
    expect(formatGeneratedAt("not-a-date")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// QA 2026-09-07 — analysis-factor-narrative--refresh-regenerate-429-silent-
// no-feedback. "Refresh to regenerate" sits INSIDE the drift banner, but the
// only place the component rendered a refresh status was the footer line
// below the whole prose block (~128px away — the same distance problem the
// banner button itself was added to solve). A rate-limited click therefore
// read as "the button does nothing", and the copy it did render named
// neither the limit nor a retry in words a reader would recognise.
//
// The failure copy is now a pure exported helper so it can be tested here
// (this repo has no jsdom/RTL harness), and the status renders under the
// button that was actually pressed.
// Landing 2026-09-11: the helper moved out of NarrativeBlock into the module
// the Macro card also uses, so there is exactly one of it; the `subject`
// parameter is what keeps the narrative copy below byte-identical.
import {
  describeRefreshFailure,
  NARRATIVE_SUBJECT,
} from "@/app/dashboard/components/analysis/refresh-failure-message";
import { readFileSync } from "node:fs";

describe("describeRefreshFailure (Refresh to regenerate — domain-language status)", () => {
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  it("explains a 429 as a refresh limit and says when to try again, in hours", () => {
    const msg = describeRefreshFailure(NARRATIVE_SUBJECT, 429, { error: "rate-limited", retryAfter: 23 * HOUR });
    expect(msg).toMatch(/once a day/i);
    expect(msg).toMatch(/try again/i);
    expect(msg).toContain("23h");
    // Never the raw server token.
    expect(msg).not.toContain("rate-limited");
  });

  it("rounds a sub-hour wait up into minutes rather than saying 0h", () => {
    const msg = describeRefreshFailure(NARRATIVE_SUBJECT, 429, { error: "rate-limited", retryAfter: 90 * MINUTE });
    expect(msg).toContain("2h");
    const mins = describeRefreshFailure(NARRATIVE_SUBJECT, 429, { error: "rate-limited", retryAfter: 5 * MINUTE });
    expect(mins).toMatch(/5 minutes/);
    expect(mins).not.toMatch(/\b0h\b/);
  });

  it("still gives a usable sentence when the body carries no retryAfter", () => {
    const msg = describeRefreshFailure(NARRATIVE_SUBJECT, 429, {});
    expect(msg).toMatch(/once a day/i);
    expect(msg).toMatch(/try again/i);
    expect(msg).not.toMatch(/undefined|NaN|Invalid/);
  });

  it("maps any other non-OK response to a plain failure sentence with a retry", () => {
    for (const status of [404, 500, 502]) {
      const msg = describeRefreshFailure(NARRATIVE_SUBJECT, status, { error: "Anthropic 529 overloaded" });
      expect(msg).toMatch(/couldn't regenerate/i);
      expect(msg).toMatch(/try again/i);
      // Raw server/model text never reaches the card.
      expect(msg).not.toContain("Anthropic");
    }
  });

  it("maps a network-level failure to domain copy, never the browser's raw message", () => {
    const msg = describeRefreshFailure(NARRATIVE_SUBJECT, 0, null);
    expect(msg).toMatch(/couldn't regenerate/i);
    expect(msg).not.toMatch(/Failed to fetch|TypeError|NetworkError/);
  });
});

describe("NarrativeBlock renders the refresh status under the button that was pressed", () => {
  const src = readFileSync("app/dashboard/components/analysis/NarrativeBlock.tsx", "utf8");

  it("routes every non-OK response and the network catch through describeRefreshFailure", () => {
    expect(src).toMatch(
      /setRefreshError\(describeRefreshFailure\(NARRATIVE_SUBJECT, res\.status, data\)\)/,
    );
    // The catch no longer prints e.message.
    expect(src).not.toMatch(/setRefreshError\(\s*e instanceof Error/);
    expect(src).toMatch(/catch\s*\{[^}]*describeRefreshFailure\(NARRATIVE_SUBJECT, 0, null\)/);
    // res.ok AND data.success is still the success predicate.
    expect(src).toContain("if (res.ok && data.success)");
  });

  it("tracks which button started the refresh and renders the status beside it", () => {
    expect(src).toMatch(/refreshOrigin/);
    expect(src).toMatch(/handleRefresh\("banner"\)/);
    expect(src).toMatch(/handleRefresh\("footer"\)/);
    // Two render sites, one per button, each gated on its own origin.
    expect(src.match(/refreshError && refreshOrigin === "(banner|footer)"/g)).toHaveLength(2);
  });

  it("puts the banner status inside the drift banner, after the button", () => {
    const banner = src.slice(src.indexOf("{drifted && ("), src.indexOf("<PrivateText>"));
    const button = banner.indexOf("Refresh to regenerate");
    const status = banner.indexOf('refreshError && refreshOrigin === "banner"');
    expect(button).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(button);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// QA 2026-09-17 —
// analysis-defense-narrative--auto-generation-500-card-vanishes-no-error-no-retry.
//
// On a cold cache, the GET returns {notGenerated:true} and the effect
// auto-fires handleRefresh() (the generate POST) to fill it. When that POST
// fails, handleRefresh sets refreshError to a domain-language message — but
// the OLD render guard `if (error || !text) return null` ran first. `text`
// is still null on a cold cache, so the whole card vanished: no message, no
// Refresh/Try-again button, nothing to say a paid AI generation was
// attempted. A reload just auto-fires (and pays for) another attempt.
//
// The fix extracts a pure `narrativeRenderState` helper (exported from
// NarrativeBlock.tsx) so this can be pinned without a DOM harness — this
// repo has no jsdom/RTL (see file header above).
import { narrativeRenderState } from "@/app/dashboard/components/analysis/NarrativeBlock";

describe("narrativeRenderState (cold-cache auto-generation failure must not vanish the card)", () => {
  it("is 'loading' while the initial GET is in flight", () => {
    expect(
      narrativeRenderState({ text: null, error: null, refreshError: null, loading: true, refreshing: false }),
    ).toBe("loading");
  });

  it("is 'loading' while the cold-cache auto-fill POST is in flight (no text yet)", () => {
    expect(
      narrativeRenderState({ text: null, error: null, refreshError: null, loading: false, refreshing: true }),
    ).toBe("loading");
  });

  it("is 'narrative' once text is present, even if a stale refreshError lingers from a prior click", () => {
    expect(
      narrativeRenderState({
        text: "Some cached prose.",
        error: null,
        refreshError: "stale failure text",
        loading: false,
        refreshing: false,
      }),
    ).toBe("narrative");
  });

  it("is 'hidden' for the genuine no-narrative case — no text, no error, nothing attempted", () => {
    expect(
      narrativeRenderState({ text: null, error: null, refreshError: null, loading: false, refreshing: false }),
    ).toBe("hidden");
  });

  it("is 'hidden' when the initial GET failed outright — unchanged existing behavior", () => {
    expect(
      narrativeRenderState({
        text: null,
        error: "Failed to load narrative",
        refreshError: null,
        loading: false,
        refreshing: false,
      }),
    ).toBe("hidden");
  });

  it("hides prior-scope text when loading the new scope fails", () => {
    expect(narrativeRenderState({
      text: "Narrative for the previous account scope.",
      error: "The newly selected scope failed to load",
      refreshError: null,
      loading: false,
      refreshing: false,
    })).toBe("hidden");
  });

  it("is 'cold-failure' when the cold-cache auto-generation POST failed — the bug this pins", () => {
    // text stays null (nothing ever generated), error (GET-failure) stays null
    // (the GET itself succeeded with {notGenerated:true}), but refreshError is
    // now set by handleRefresh's failure branch. The old guard hid this case;
    // it must now render a status instead of nothing.
    expect(
      narrativeRenderState({
        text: null,
        error: null,
        refreshError: "Couldn't regenerate — the request failed. Try again in a few minutes.",
        loading: false,
        refreshing: false,
      }),
    ).toBe("cold-failure");
  });
});

describe("NarrativeBlock wires the cold-failure state to a visible retry, never a silent null", () => {
  const src = readFileSync("app/dashboard/components/analysis/NarrativeBlock.tsx", "utf8");

  it("no longer has the old unconditional guard that hid a cold-cache generation failure", () => {
    // The old bug line: `if (error || !text) return null` ran before refreshError
    // was ever consulted, so `!text` alone (with error still null) hid the card.
    expect(src).not.toMatch(/if\s*\(\s*error\s*\|\|\s*!text\s*\)\s*return null/);
  });

  it("computes what to render through the pure narrativeRenderState helper", () => {
    expect(src).toMatch(/const renderState = narrativeRenderState\(/);
  });

  it("renders a role=alert status with a Try again button, wired to the footer refresh, on cold-failure", () => {
    const branchStart = src.indexOf('renderState === "cold-failure"');
    expect(branchStart).toBeGreaterThan(-1);
    const branch = src.slice(branchStart, branchStart + 1200);
    expect(branch).toMatch(/role="alert"/);
    expect(branch).toContain("{refreshError}");
    expect(branch).toMatch(/Try again/);
    expect(branch).toMatch(/handleRefresh\("footer"\)/);
    expect(branch).toMatch(/disabled=\{refreshing\}/);
  });

  it("still returns null for the genuine no-narrative case (hidden state)", () => {
    expect(src).toMatch(/renderState === "hidden"[^)]*\)\s*return null/);
  });
});
