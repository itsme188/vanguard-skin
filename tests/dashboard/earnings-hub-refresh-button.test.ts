/**
 * EarningsHubRefreshButton — nightly QA ledger findings
 * `today-earningshub-finnhub-refresh--54s-silent-no-feedback` [MEDIUM] and
 * its twin `today-earningshub-refresh--silent-partial-failure-no-outcome-report-regression-2`
 * [MEDIUM]: the "↻ Refresh from Finnhub" button ran a 30-75s mutating sync
 * and ended in total silence — the label froze at "syncing…" the whole run,
 * then just went idle, even when the run swallowed dozens of Finnhub 429s.
 *
 * Root cause: the client parsed every `data:` frame looking for a top-level
 * `evt.message`, but the route (app/api/calendar/sync/route.ts) never sends
 * one — it sends `{ progress: { phase, message } }`, `{ complete: true, data }`,
 * or `{ error }`. Nothing matched, so `progress` never updated past its
 * initial placeholder and the `complete`/`error` frames were dropped on the
 * floor.
 *
 * This repo has no DOM test harness (no jsdom/RTL — see
 * memory/reference_no_dom_test_harness_source_pin.md), so the fix is proven
 * two ways: the pure outcome-line composer (`buildSyncOutcome`) is
 * unit-tested directly, and the frame-parsing/state-lifecycle wiring is
 * proven with source pins (following tests/dashboard/earnings-hub-live.test.ts
 * and tests/dashboard/narrative-block-refresh.test.ts precedent).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSyncOutcome } from "@/app/dashboard/today/EarningsHubRefreshButton";

describe("buildSyncOutcome — the outcome line the button keeps visible after a run", () => {
  it("reports new + updated counts", () => {
    expect(buildSyncOutcome({ newEvents: 3, refreshedEvents: 2, errors: [] })).toEqual({
      text: "Refreshed — 3 new, 2 updated",
    });
  });

  it("reports only new when nothing was updated, and vice versa", () => {
    expect(buildSyncOutcome({ newEvents: 4, refreshedEvents: 0, errors: [] })).toEqual({
      text: "Refreshed — 4 new",
    });
    expect(buildSyncOutcome({ newEvents: 0, refreshedEvents: 1, errors: [] })).toEqual({
      text: "Refreshed — 1 updated",
    });
  });

  it('says "no changes" when both counts are zero and there are no errors', () => {
    expect(buildSyncOutcome({ newEvents: 0, refreshedEvents: 0, errors: [] })).toEqual({
      text: "Refreshed — no changes",
    });
  });

  // Regression 3 (2026-09-13): "· 2 steps had problems" was true but
  // useless — it never said WHAT went wrong, and the only place that said so
  // was the expandable detail. A run that silently skipped 3 of 12 symbols
  // (synthetic counts) has to say that on the visible line.
  it("carries the error summary INLINE, keeping the full joined list in title", () => {
    const partial =
      "finnhub: 3 of 12 symbols not scanned — rate-limited by Finnhub (429); retry in a few minutes";
    expect(buildSyncOutcome({ newEvents: 2, refreshedEvents: 0, errors: [partial] })).toEqual({
      text: `Refreshed — 2 new · ${partial}`,
      title: partial,
    });
  });

  // Regression 4 (2026-09-13): `errors` is pushed in phase order (wsh, macro,
  // then the finnhub "not scanned" summary last), so a WSH/macro failure used
  // to bump the not-scanned warning behind "(+1 more)" — exactly the failure
  // this line exists to surface. The not-scanned entry must show inline
  // regardless of its position in the array; the count and the full joined
  // list in `title` are unaffected.
  it("prefers a not-scanned entry inline even when it isn't errors[0]", () => {
    const wshError = "wsh: timeout after 10s";
    const notScanned =
      "finnhub: 3 of 12 symbols not scanned — rate-limited by Finnhub (429); retry in a few minutes";
    expect(
      buildSyncOutcome({ newEvents: 0, refreshedEvents: 0, errors: [wshError, notScanned] }),
    ).toEqual({
      text: `Refreshed — no changes · ${notScanned} (+1 more)`,
      title: `${wshError}; ${notScanned}`,
    });
  });

  it("shows the first problem inline and counts the rest, for several failed phases", () => {
    expect(
      buildSyncOutcome({
        newEvents: 1,
        refreshedEvents: 0,
        errors: ["finnhub: 429 Too Many Requests", "wsh: timeout after 10s"],
      }),
    ).toEqual({
      text: "Refreshed — 1 new · finnhub: 429 Too Many Requests (+1 more)",
      title: "finnhub: 429 Too Many Requests; wsh: timeout after 10s",
    });
  });

  it("shows a single problem inline, even with no changes otherwise", () => {
    expect(
      buildSyncOutcome({ newEvents: 0, refreshedEvents: 0, errors: ["macro: Claude request failed"] }),
    ).toEqual({
      text: "Refreshed — no changes · macro: Claude request failed",
      title: "macro: Claude request failed",
    });
  });

  it("never lets a raw JSON body into the visible line (the detail keeps the original)", () => {
    const raw =
      'finnhub: Finnhub 429: {"error":"API limit reached. Please try again later.","code":429}';
    const outcome = buildSyncOutcome({ newEvents: 0, refreshedEvents: 0, errors: [raw] });
    expect(outcome.text).not.toContain("{");
    expect(outcome.text).toBe("Refreshed — no changes · finnhub: Finnhub 429");
    expect(outcome.title).toBe(raw);
  });

  it("truncates a very long upstream string rather than flooding the line", () => {
    const long = `finnhub: ${"x".repeat(400)}`;
    const outcome = buildSyncOutcome({ newEvents: 0, refreshedEvents: 0, errors: [long] });
    expect(outcome.text.length).toBeLessThanOrEqual(160);
    expect(outcome.text.endsWith("…")).toBe(true);
    expect(outcome.title).toBe(long);
  });

  it("defaults missing counts/errors to zero/empty rather than throwing (defensive against a stale server)", () => {
    expect(buildSyncOutcome({} as never)).toEqual({ text: "Refreshed — no changes" });
  });
});

describe("EarningsHubRefreshButton source — frame parsing and outcome lifecycle", () => {
  const src = readFileSync("app/dashboard/today/EarningsHubRefreshButton.tsx", "utf8");

  it("no longer keys on a top-level evt.message — that field never exists on any frame", () => {
    expect(src).not.toMatch(/evt\.message/);
  });

  it("reads evt.progress.message for the live progress line", () => {
    expect(src).toMatch(/evt\.progress\?\.message/);
    expect(src).toMatch(/setProgress\(evt\.progress\.message\)/);
  });

  it("reads the complete frame and builds the outcome via buildSyncOutcome", () => {
    expect(src).toMatch(/evt\.complete && evt\.data/);
    expect(src).toMatch(/setOutcome\(buildSyncOutcome\(evt\.data\)\)/);
  });

  it("reads the error frame and frames it in domain language", () => {
    expect(src).toMatch(/typeof evt\.error === "string"/);
    expect(src).toMatch(/setError\(`Refresh failed: \$\{evt\.error\}`\)/);
  });

  it("reports when the stream ends with neither a complete nor an error frame", () => {
    expect(src).toMatch(/if \(!gotResult\)/);
    expect(src).toContain("Refresh ended without a result — reload to check.");
  });

  it("keeps the outcome line visible after the run — only cleared when the NEXT refresh starts", () => {
    // setOutcome(null) must appear exactly once: at the top of refresh(),
    // before the fetch. If it appeared again after the drain loop, the
    // outcome would be wiped the instant syncing finishes.
    expect(src.match(/setOutcome\(null\)/g)).toHaveLength(1);
    const clearIdx = src.indexOf("setOutcome(null)");
    const fetchIdx = src.indexOf("apiFetch(");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(fetchIdx);
  });

  it("still refreshes the server component after the stream ends, so rows update", () => {
    expect(src).toMatch(/router\.refresh\(\)/);
  });

  it("keeps the disabled/Syncing… state while a run is in flight", () => {
    expect(src).toMatch(/disabled=\{syncing\}/);
    expect(src).toMatch(/syncing \? "Syncing…" : "↻ Refresh from Finnhub"/);
  });

  it("renders the outcome without the privacy wrapper — these are public calendar-event counts", () => {
    expect(src).not.toMatch(/<Money|<Pct|<Shares|<Count|<PrivateText/);
  });

  // 2026-09 follow-up (CLAUDE.md: hover-only affordances are touch
  // tap-traps) — the joined error strings used to live only in a `title`
  // attribute on the outcome span, unreachable on a phone. A <details> makes
  // the same content reachable by tap while keeping the one-line outcome as
  // the always-visible summary.
  it("no longer hides the joined error strings behind a hover-only title", () => {
    expect(src).not.toMatch(/title=\{outcome\.title\}/);
  });

  it("renders the errors as a click-to-expand <details>, keyed on outcome.title", () => {
    const block = src.slice(
      src.indexOf("{!progress && outcome && ("),
      src.indexOf("{error && "),
    );
    expect(block).toMatch(/outcome\.title\s*\?/);
    expect(block).toContain("<details");
    expect(block).toContain("<summary");
    expect(block).toContain("{outcome.text}");
    expect(block).toContain("{outcome.title}");
  });

  it("falls back to a plain one-line span when there is nothing to expand", () => {
    const block = src.slice(
      src.indexOf("{!progress && outcome && ("),
      src.indexOf("{error && "),
    );
    // The ternary's else branch: a bare span with no <details>/<summary>.
    const elseBranch = block.slice(block.indexOf(") : ("));
    expect(elseBranch).not.toContain("<details");
    expect(elseBranch).toContain("{outcome.text}");
  });
});
