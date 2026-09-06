import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnrichmentRowSummary,
  EnrichmentDetail,
} from "@/app/dashboard/components/calendar/EnrichmentChips";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";

// Gap #2 of the PR #68 landing review: an `actual` value whose only
// recognizable token parses to nothing usable (Finnhub's literal "Rev 0"
// placeholder) must never leak the raw token, never leave a dangling
// separator with nothing in front of it, and never render an empty chip.
// This repo has no DOM test harness — pin behavior via renderToStaticMarkup
// (the today-page-blocks.test.ts idiom), not render-and-fire-events.

const SNAP: ReactionSnapshot = {
  t0_utc: "2026-08-16T14:55:00.000Z",
  window_min: 120,
  source: "tws",
  spy: { t_pre: 741.4, t_post: 742.23, delta_pct: 0.11 },
  qqq: { t_pre: 683.53, t_post: 687.28, delta_pct: 0.55 },
  tlt: { t_pre: 82.83, t_post: 82.72, delta_pct: -0.13 },
};

describe("EnrichmentRowSummary — placeholder-only actual", () => {
  it("renders nothing (not an empty chip) for a placeholder actual with no reaction data", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, { actual: "Rev 0", snapshot: null }),
    );
    expect(html).toBe("");
  });

  it("renders only the reaction pairs, with no dangling separator or raw token, when a placeholder actual is paired with real reaction data", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, { actual: "Rev 0", snapshot: SNAP }),
    );
    expect(html).toContain("SPY");
    expect(html).not.toContain("actual");
    expect(html).not.toContain("Rev 0");
    // The "·" separator only ever sits between the actual figure and the
    // reaction pairs — with no actual figure, it must not appear at all.
    expect(html).not.toContain("·");
  });

  it("still renders the actual figure + separator normally for a real actual", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, { actual: "EPS 1.20 · Rev 190000", snapshot: SNAP }),
    );
    expect(html).toContain("actual");
    expect(html).toContain("$1.20");
    expect(html).toContain("·");
    expect(html).toContain("SPY");
  });
});

describe("EnrichmentDetail — placeholder-only actual", () => {
  it("renders the em-dash, never an empty line, for a placeholder actual", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentDetail, { actual: "Rev 0", snapshot: null, enrichedAt: null }),
    );
    const match = /text-gold-ink mt-0\.5">([^<]*)</.exec(html);
    expect(match?.[1]).toBe("—");
    expect(html).not.toContain("Rev 0");
  });

  it("still renders a real actual figure", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentDetail, {
        actual: "EPS 1.20 · Rev 190000",
        snapshot: null,
        enrichedAt: null,
      }),
    );
    const match = /text-gold-ink mt-0\.5">([^<]*)</.exec(html);
    expect(match?.[1]).toBe("$1.20 · $190,000");
  });
});
