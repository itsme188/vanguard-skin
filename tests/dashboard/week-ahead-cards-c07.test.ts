/**
 * Unit C07 (week-ahead cards) plus the manual-row title swap:
 *   - today-week-ahead--past-event-without-actual-indistinguishable-from-upcoming
 *   - today-week-ahead--reaction-line-spy-in-stock-slot-regression-1
 *   - today-week-ahead-conflict-marker--confirm-instruction-points-at-hub-that-cannot-reach-row
 *   - today-releases-week-ahead--manual-row-prints-manual-entry-instead-of-bmo-slot
 *
 * No DOM harness in this repo: behaviour is proved through the exported pure
 * helpers and renderToStaticMarkup of the real components. Every symbol and
 * figure is invented.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WeekAheadView,
  NO_ACTUAL_RECORDED_LABEL,
  conflictResolvableHere,
  showsNoActualRecorded,
  weekAheadTitle,
} from "@/app/dashboard/today/WeekAheadView";
import {
  EnrichmentRowSummary,
  reactionSummaryPairs,
} from "@/app/dashboard/components/calendar/EnrichmentChips";
import {
  EarningsConflictActions,
  EarningsConflictMarker,
  confirmConflictDate,
  conflictResolveOptions,
} from "@/app/dashboard/components/calendar/EarningsConflictMarker";
import { slotAwareTitle } from "@/app/dashboard/components/TodayReleases";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";
import type { CalendarEvent } from "@/lib/types";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// A hand-entered earnings row renders its remove control, which needs the app
// router and the toast provider; a static render has neither, and the control
// is not under test here.
vi.mock("@/app/dashboard/today/EarningsDeleteButton", () => ({
  EarningsDeleteButton: () => null,
}));

const PAST_WEEK = "2026-08-24"; // Monday, long past
const PAST_TUE = "2026-08-25";
const TODAY = "2026-10-07";

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: PAST_TUE,
    event_time: null,
    title: "AAA Q3 Earnings",
    description: null,
    security_id: null,
    symbol: "AAA",
    ib_con_id: null,
    expected_impact: null,
    consensus_estimate: null,
    previous_value: null,
    raw_json: null,
    source_key: "finnhub:AAA:2026-08-25",
    week_of: PAST_WEEK,
    fetched_at: "2026-08-20 00:00:00",
    created_at: "2026-08-20 00:00:00",
    release_time: "16:00",
    actual_value: null,
    consensus_value: null,
    reaction_snapshot: null,
    enriched_at: null,
    date_status: null,
    date_conflict_with: null,
    superseded: 0,
    manual_actuals_at: null,
    ...overrides,
  } as CalendarEvent;
}

const macro = (overrides: Partial<CalendarEvent> = {}) =>
  makeEvent({
    id: 2,
    source: "claude_macro",
    event_type: "economic_release" as CalendarEvent["event_type"],
    symbol: null,
    title: "August Widget Orders",
    source_key: "nonfred:Widget_Orders:2026-08-25",
    release_time: "10:00",
    ...overrides,
  });

const render = (events: CalendarEvent[], weekOf = PAST_WEEK) =>
  renderToStaticMarkup(createElement(WeekAheadView, { events, weekOf }));

afterEach(() => {
  vi.useRealTimers();
});

describe("past event with no actual says so", () => {
  it("tags a past row from a source that normally records an actual", () => {
    expect(showsNoActualRecorded(macro(), TODAY)).toBe(true);
    expect(showsNoActualRecorded(macro({ source_key: "fred:10:2026-08-25" }), TODAY)).toBe(true);
    expect(showsNoActualRecorded(makeEvent(), TODAY)).toBe(true);
    expect(showsNoActualRecorded(makeEvent({ source: "nasdaq" }), TODAY)).toBe(true);
  });

  it("never tags a hand-entered row, whatever it is", () => {
    expect(showsNoActualRecorded(makeEvent({ source: "manual" }), TODAY)).toBe(false);
    expect(showsNoActualRecorded(macro({ source: "manual" }), TODAY)).toBe(false);
  });

  it("does not tag today's rows, future rows, or a row that has an actual", () => {
    expect(showsNoActualRecorded(macro({ event_date: TODAY }), TODAY)).toBe(false);
    expect(showsNoActualRecorded(macro({ event_date: "2026-10-09" }), TODAY)).toBe(false);
    expect(showsNoActualRecorded(macro({ actual_value: "3.2%" }), TODAY)).toBe(false);
    // On file but withheld as implausible is not "not recorded".
    expect(
      showsNoActualRecorded(
        makeEvent({ consensus_estimate: "EPS 1.00", actual_value: "EPS 9.00" }),
        TODAY,
      ),
    ).toBe(false);
  });

  it("does not tag a macro row from a source with no actual feed", () => {
    expect(showsNoActualRecorded(macro({ source_key: "holiday:2026-08-25" }), TODAY)).toBe(false);
  });

  it("the card prints the tag for the past macro row and not for the manual one", () => {
    const html = render([
      macro(),
      makeEvent({ id: 3, source: "manual", symbol: "BBB", title: "BBB earnings (Manual entry)" }),
    ]);
    expect(html.split(NO_ACTUAL_RECORDED_LABEL).length - 1).toBe(1);
    expect(render([macro({ actual_value: "3.2%" })])).not.toContain(NO_ACTUAL_RECORDED_LABEL);
  });
});

describe("reaction line: the stock's own slot is never filled by SPY", () => {
  const noSymbolLeg: ReactionSnapshot = {
    t0_utc: "2026-08-25T20:05:00.000Z",
    window_min: 120,
    source: "tws",
    spy: { t_pre: 500, t_post: 501, delta_pct: 0.2 },
    qqq: { t_pre: 400, t_post: 402, delta_pct: 0.5 },
  };

  it("leads with the ticker as not captured, then SPY", () => {
    expect(
      reactionSummaryPairs(noSymbolLeg, { preferEventSymbol: true, eventSymbol: "AAA" }),
    ).toEqual([
      { label: "AAA", pct: null, notCaptured: true },
      { label: "SPY", pct: 0.2 },
    ]);
  });

  it("a captured stock leg is unchanged, and a row with no ticker still degrades to SPY / QQQ", () => {
    const withLeg: ReactionSnapshot = {
      ...noSymbolLeg,
      symbol: { symbol: "AAA", t_pre: 10, t_post: 11, delta_pct: 10 },
    };
    expect(
      reactionSummaryPairs(withLeg, { preferEventSymbol: true, eventSymbol: "AAA" }),
    ).toEqual([
      { label: "AAA", pct: 10 },
      { label: "SPY", pct: 0.2 },
    ]);
    expect(reactionSummaryPairs(noSymbolLeg, { preferEventSymbol: true, eventSymbol: null })).toEqual([
      { label: "SPY", pct: 0.2 },
      { label: "QQQ", pct: 0.5 },
    ]);
    // Not asked to lead with the stock: the Calendar-row treatment stands.
    expect(reactionSummaryPairs(noSymbolLeg, { eventSymbol: "AAA" })[0].label).toBe("SPY");
  });

  it("renders the dash with a title saying the move was not captured", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, {
        actual: null,
        snapshot: noSymbolLeg,
        preferEventSymbol: true,
        eventSymbol: "AAA",
      }),
    );
    expect(html).toContain("AAA —");
    expect(html).toMatch(/title="AAA&#x27;s own move was not captured"/);
    expect(html).not.toContain("QQQ");
  });

  it("the week card passes the ticker for an earnings row only", () => {
    const earnings = render([
      makeEvent({ enriched_at: "2026-08-25 22:30:00", reaction_snapshot: JSON.stringify(noSymbolLeg) }),
    ]);
    expect(earnings).toContain("AAA —");
    const macroHtml = render([
      macro({
        enriched_at: "2026-08-25 16:30:00",
        reaction_snapshot: JSON.stringify({ ...noSymbolLeg, t0_utc: "2026-08-25T14:00:00.000Z" }),
      }),
    ]);
    expect(macroHtml).toContain("SPY");
    expect(macroHtml).toContain("QQQ");
    expect(macroHtml).not.toContain(" —<");
  });
});

describe("date-conflict marker offers the confirm itself", () => {
  it("offers the row's own date and the competing vendor's, future dates only", () => {
    expect(
      conflictResolveOptions(
        { eventDate: "2026-10-15", dateConflictWith: "finnhub:2026-10-12" },
        TODAY,
      ),
    ).toEqual([
      { kind: "shown", date: "2026-10-15", label: "Confirm Oct 15" },
      { kind: "other", date: "2026-10-12", label: "Use Finnhub date · Oct 12" },
    ]);
    // A stale competing date is not a live option.
    expect(
      conflictResolveOptions(
        { eventDate: "2026-10-15", dateConflictWith: "nasdaq:2026-07-15" },
        TODAY,
      ).map((o) => o.kind),
    ).toEqual(["shown"]);
    // Both behind us: nothing to pick.
    expect(
      conflictResolveOptions({ eventDate: "2026-08-25", dateConflictWith: "finnhub:2026-08-26" }, TODAY),
    ).toEqual([]);
    // Malformed or same-day competing date: only the row's own.
    expect(
      conflictResolveOptions({ eventDate: "2026-10-15", dateConflictWith: "finnhub:soon" }, TODAY),
    ).toHaveLength(1);
    expect(
      conflictResolveOptions({ eventDate: "2026-10-15", dateConflictWith: "finnhub:2026-10-15" }, TODAY),
    ).toHaveLength(1);
    expect(conflictResolveOptions({ eventDate: "2026-10-15", dateConflictWith: null }, TODAY)).toHaveLength(1);
  });

  it("posts the picked date to the confirm-date route and reads the envelope", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const ok = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, data: { eventId: 7 } }), { status: 200 });
    };
    expect(await confirmConflictDate({ symbol: "AAA", date: "2026-10-12", slot: "bmo" }, ok)).toEqual({
      kind: "confirmed",
    });
    expect(calls).toEqual([
      {
        url: "/api/earnings/confirm-date",
        body: { symbol: "AAA", confirmedDate: "2026-10-12", confirmedTime: "bmo" },
      },
    ]);

    const refused = async () =>
      new Response(JSON.stringify({ success: false, error: "that date is in the past" }), { status: 409 });
    expect(await confirmConflictDate({ symbol: "AAA", date: "2026-10-12", slot: "amc" }, refused)).toEqual({
      kind: "failed",
      message: "that date is in the past",
    });
    // A 2xx without success: true is still a failure.
    const hollow = async () => new Response(JSON.stringify({}), { status: 200 });
    expect((await confirmConflictDate({ symbol: "AAA", date: "2026-10-12", slot: "amc" }, hollow)).kind).toBe(
      "failed",
    );
    const down = async () => {
      throw new Error("offline");
    };
    expect(await confirmConflictDate({ symbol: "AAA", date: "2026-10-12", slot: "amc" }, down)).toEqual({
      kind: "unreachable",
    });
  });

  it("renders both buttons with the touch extension for a live conflict, nothing otherwise", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
    const props = {
      dateStatus: "conflict" as const,
      dateConflictWith: "finnhub:2026-10-12",
      symbol: "AAA",
      eventDate: "2026-10-15",
      eventTime: null,
      rawJson: null,
      releaseTime: "16:05",
    };
    const html = renderToStaticMarkup(createElement(EarningsConflictActions, props));
    expect(html).toContain("Confirm Oct 15");
    expect(html).toContain("Use Finnhub date · Oct 12");
    expect(html.split("<button").length - 1).toBe(2);
    expect(html).toContain("pointer-coarse:after:absolute");
    expect(renderToStaticMarkup(createElement(EarningsConflictActions, { ...props, dateStatus: "confirmed" }))).toBe("");
    expect(renderToStaticMarkup(createElement(EarningsConflictActions, { ...props, symbol: null }))).toBe("");
  });

  it("the chip stops pointing at the Hub when the row carries the buttons", () => {
    const base = { dateStatus: "conflict" as const, dateConflictWith: "finnhub:2026-10-12" };
    const here = renderToStaticMarkup(createElement(EarningsConflictMarker, { ...base, resolveHere: true }));
    expect(here).not.toContain("Earnings Hub");
    expect(here).toContain("buttons on this row");
    // A surface that renders no buttons keeps the old pointer.
    expect(renderToStaticMarkup(createElement(EarningsConflictMarker, base))).toContain("Earnings Hub");
  });

  it("the week view offers the buttons outside the card link, on a conflict that can still be settled", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
    const weekOf = "2026-10-12";
    const conflicted = makeEvent({
      event_date: "2026-10-15",
      week_of: weekOf,
      security_id: 42,
      date_status: "conflict",
      date_conflict_with: "finnhub:2026-10-12",
    });
    expect(conflictResolvableHere(conflicted, TODAY)).toBe(true);
    const html = render([conflicted], weekOf);
    expect(html).toContain("Confirm Oct 15");
    expect(html).toContain("Use Finnhub date · Oct 12");
    // No button may sit inside the card's link.
    for (const anchor of html.match(/<a [\s\S]*?<\/a>/g) ?? []) {
      expect(anchor).not.toContain("<button");
    }
    expect(html).not.toContain("Confirm on Today");
  });

  it("offers nothing on a settled row, a macro row, or a conflict wholly in the past", () => {
    expect(conflictResolvableHere(makeEvent({ date_status: "confirmed" }), TODAY)).toBe(false);
    expect(conflictResolvableHere(macro({ date_status: "conflict" }), TODAY)).toBe(false);
    const stale = makeEvent({ date_status: "conflict", date_conflict_with: "finnhub:2026-08-26" });
    expect(conflictResolvableHere(stale, TODAY)).toBe(false);
    const html = render([stale]);
    expect(html).toContain("⚠");
    expect(html).not.toContain("<button");
    // With no buttons the chip must not promise any.
    expect(html).not.toContain("buttons on this row");
  });

  it("the server view never calls a function of the client marker module", () => {
    const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    expect(anchorIndex(src, "<EarningsConflictActions")).toBeGreaterThan(-1);
    expect(src).not.toMatch(/conflictResolveOptions\(|confirmConflictDate\(/);
    expect(src).not.toMatch(/from "\.\.\/components\/TodayReleases"/);
  });
});

describe("a hand-entered earnings row prints its market slot", () => {
  const rows: Array<Pick<CalendarEvent, "title" | "event_time" | "raw_json" | "event_type">> = [
    { event_type: "earnings", title: "AAA earnings (Manual entry)", event_time: "BMO", raw_json: null },
    { event_type: "earnings", title: "AAA earnings (Manual entry)", event_time: "amc", raw_json: null },
    { event_type: "earnings", title: "AAA earnings (Manual entry)", event_time: "07:00", raw_json: null },
    { event_type: "earnings", title: "AAA earnings (Manual entry)", event_time: null, raw_json: null },
    { event_type: "earnings", title: "AAA earnings (Manual entry)", event_time: "TAS", raw_json: null },
    {
      event_type: "earnings",
      title: "AAA earnings (Manual entry)",
      event_time: null,
      raw_json: JSON.stringify({ entry: { hour: "amc" } }),
    },
    { event_type: "earnings", title: "AAA earnings (After Market Close)", event_time: "BMO", raw_json: null },
    { event_type: "earnings", title: "AAA earnings", event_time: "BMO", raw_json: null },
    {
      event_type: "economic_release" as CalendarEvent["event_type"],
      title: "Widget Orders (Manual entry)",
      event_time: "BMO",
      raw_json: null,
    },
  ];

  it("gives the same answer as Today's releases for every row", () => {
    for (const row of rows) expect(weekAheadTitle(row)).toBe(slotAwareTitle(row));
  });

  it("swaps the source token for the slot only when the slot is known", () => {
    expect(weekAheadTitle(rows[0])).toBe("AAA earnings (Before Market Open)");
    expect(weekAheadTitle(rows[1])).toBe("AAA earnings (After Market Close)");
    expect(weekAheadTitle(rows[3])).toBe("AAA earnings (Manual entry)");
  });

  it("the card shows the slot and never the stored source token", () => {
    const html = render([
      makeEvent({ source: "manual", title: "AAA earnings (Manual entry)", event_time: "BMO" }),
    ]);
    expect(html).toContain("AAA earnings (Before Market Open)");
    expect(html).not.toContain("(Manual entry)");
  });
});
