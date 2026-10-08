import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WeekAheadView,
  eventCardClass,
  macroCardExpandable,
  weekAheadRemovable,
  settledActualChipClass,
  actualChipClass,
} from "@/app/dashboard/today/WeekAheadView";
import {
  EnrichmentDetail,
  EnrichmentDisclosure,
  EnrichmentRowSummary,
  PreReleaseActualChips,
  reactionDetailRows,
} from "@/app/dashboard/components/calendar/EnrichmentChips";
import { EarningsConflictMarker } from "@/app/dashboard/components/calendar/EarningsConflictMarker";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";
import type { CalendarEvent } from "@/lib/types";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Units A12 + B47 (week-ahead cards). No DOM harness in this repo: behaviour
// is pinned through the exported pure helpers and renderToStaticMarkup of the
// real components; wiring that needs a browser is source-pinned. Every symbol
// and figure is synthetic.

// A past week, so "released" holds whatever day the suite runs.
const WEEK_OF = "2026-08-24"; // Monday
const TUE = "2026-08-25";
const SAT = "2026-08-29";
const SUN = "2026-08-30";

const SNAP: ReactionSnapshot = {
  t0_utc: "2026-08-25T14:00:00.000Z", // 10:00 ET on TUE
  window_min: 120,
  source: "tws",
  spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
  qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
  tlt: { t_pre: 90, t_post: 90.9, delta_pct: 1 },
};

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: TUE,
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
    source_key: "test:aaa:earnings",
    week_of: WEEK_OF,
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

function macroEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return makeEvent({
    id: 2,
    source: "claude_macro",
    event_type: "cpi",
    symbol: null,
    title: "Consumer Price Index",
    source_key: "fred:test:cpi",
    release_time: "08:30",
    ...overrides,
  });
}

function render(events: CalendarEvent[]): string {
  return renderToStaticMarkup(createElement(WeekAheadView, { weekOf: WEEK_OF, events }));
}

const HOVER = "hover:border-edge-strong";

describe("eventCardClass — the hover cue follows interactivity", () => {
  it("carries the hover cue only for an interactive card", () => {
    expect(eventCardClass(true)).toContain(HOVER);
    expect(eventCardClass(false)).not.toContain(HOVER);
    expect(eventCardClass(false)).toContain("border-edge");
  });

  it("no unconditional hover class is left in the view source", () => {
    const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    const helperAt = anchorIndex(src, "export function eventCardClass");
    const helperEnd = anchorIndex(src, "\n}\n", helperAt);
    const outside = src.slice(0, helperAt) + src.slice(helperEnd);
    expect(outside).not.toContain(HOVER);
  });
});

describe("week-ahead cards — who looks clickable", () => {
  it("an earnings card with no resolvable security has no hover cue and no link", () => {
    const html = render([makeEvent({ security_id: null })]);
    expect(html).toContain("AAA");
    expect(html).not.toContain(HOVER);
    expect(html).not.toContain("/dashboard/security/");
  });

  it("a linked earnings card keeps the hover cue", () => {
    const html = render([makeEvent({ security_id: 42 })]);
    expect(html).toContain('href="/dashboard/security/42"');
    expect(html).toContain(HOVER);
  });

  it("an un-enriched macro card reads as static: no hover cue, no button", () => {
    const html = render([macroEvent()]);
    expect(html).toContain("Consumer Price Index");
    expect(html).not.toContain(HOVER);
    expect(html).not.toContain('role="button"');
  });

  it("an enriched macro card is a keyboard-reachable disclosure over the full reaction detail", () => {
    const html = render([
      macroEvent({
        actual_value: "3.1%",
        enriched_at: "2026-08-25 16:05:00",
        reaction_snapshot: JSON.stringify(SNAP),
      }),
    ]);
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/aria-controls="[^"]+"/);
    expect(html).toContain(HOVER);
    // The detail is in the document (hidden until opened) and carries the leg
    // the collapsed line never shows.
    expect(html).toMatch(/<div id="[^"]+" hidden=""/);
    expect(html).toContain("TLT");
    expect(html).toContain("90.00 → 90.90");
  });

  it("a macro card whose snapshot belongs to another day is not expandable", () => {
    const stale = { ...SNAP, t0_utc: "2026-08-18T14:00:00.000Z" };
    const ev = macroEvent({
      actual_value: "3.1%",
      enriched_at: "2026-08-25 16:05:00",
      reaction_snapshot: JSON.stringify(stale),
    });
    expect(macroCardExpandable(ev, "2026-10-07")).toBe(false);
    expect(render([ev])).not.toContain('role="button"');
  });

  it("macroCardExpandable: earnings rows, linked rows, future rows and leg-less snapshots are not expandable", () => {
    const enriched = {
      actual_value: "3.1%",
      enriched_at: "2026-08-25 16:05:00",
      reaction_snapshot: JSON.stringify(SNAP),
    };
    expect(macroCardExpandable(macroEvent(enriched), "2026-10-07")).toBe(true);
    expect(macroCardExpandable(makeEvent(enriched), "2026-10-07")).toBe(false);
    expect(macroCardExpandable(macroEvent({ ...enriched, security_id: 7 }), "2026-10-07")).toBe(false);
    expect(macroCardExpandable(macroEvent(enriched), "2026-08-24")).toBe(false);
    const dead = { ...SNAP, spy: { t_pre: 0, t_post: 0, delta_pct: 0 }, qqq: undefined, tlt: undefined };
    expect(
      macroCardExpandable(
        macroEvent({ ...enriched, reaction_snapshot: JSON.stringify(dead) }),
        "2026-10-07",
      ),
    ).toBe(false);
  });
});

describe("EnrichmentDetail — matches the current snapshot shape", () => {
  it("lists the event's own stock and the sector leg, and drops an unusable leg", () => {
    const snap: ReactionSnapshot = {
      ...SNAP,
      qqq: { t_pre: 400, t_post: 0, delta_pct: 0 }, // dead quote: absent, never +0.00%
      sector: { symbol: "XLK", t_pre: 200, t_post: 202, delta_pct: 1 },
      symbol: { symbol: "AAA", t_pre: 50, t_post: 55, delta_pct: 10 },
    };
    expect(reactionDetailRows(snap).map((r) => r.label)).toEqual(["AAA", "SPY", "TLT", "XLK"]);
    const html = renderToStaticMarkup(
      createElement(EnrichmentDetail, { actual: "3.1%", snapshot: snap, enrichedAt: null }),
    );
    expect(html).toContain("AAA");
    expect(html).toContain("XLK");
    expect(html).not.toContain("QQQ");
  });

  it("labels a prior-close snapshot honestly", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentDetail, {
        actual: null,
        snapshot: { ...SNAP, pre_anchor: "prior_close" },
        enrichedAt: null,
      }),
    );
    expect(html).toContain("vs prior close");
  });

  it("renders no reaction heading when no leg is usable", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentDetail, {
        actual: "3.1%",
        snapshot: { t0_utc: SNAP.t0_utc, window_min: 120, source: "tws" },
        enrichedAt: null,
      }),
    );
    expect(html).toContain("3.1%");
    expect(html).not.toContain("Market reaction");
  });
});

describe("EnrichmentDisclosure", () => {
  it("starts closed with button semantics; the summary stays visible", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentDisclosure, {
        className: "card",
        actual: "3.1%",
        snapshotRaw: JSON.stringify(SNAP),
        enrichedAt: null,
        children: "summary text",
      }),
    );
    expect(html).toContain("summary text");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("answers Enter and Space, not hover (source-pinned)", () => {
    const src = readFileSync("app/dashboard/components/calendar/EnrichmentChips.tsx", "utf8");
    const at = anchorIndex(src, "export function EnrichmentDisclosure");
    const body = src.slice(at, anchorIndex(src, "\n}\n", at));
    expect(body).toContain('e.key === "Enter"');
    expect(body).toContain('e.key === " "');
    expect(body).toContain("onClick");
    expect(body).not.toMatch(/onMouseEnter|onMouseOver/);
  });
});

describe("weekend events — counted and listed off the Mon-Fri grid", () => {
  it("counts a Saturday event in the header and lists it under the grid", () => {
    const html = render([
      makeEvent({ id: 1, security_id: 42 }),
      makeEvent({
        id: 3,
        symbol: "ZZZ",
        title: "ZZZ Q3 Earnings",
        event_date: SAT,
        security_id: 77,
        source_key: "test:zzz",
      }),
    ]);
    expect(html).toContain("2 events");
    expect(html).toContain("Outside the Mon–Fri grid");
    expect(html).toContain("Sat Aug 29");
    expect(html).toContain('href="/dashboard/security/77"');
    expect(html).toContain("ZZZ");
  });

  it("a week holding only a Sunday event is not reported as empty", () => {
    const html = render([macroEvent({ event_date: SUN })]);
    expect(html).toContain("1 event");
    expect(html).not.toContain("No events recorded for the week");
    expect(html).toContain("Sun Aug 30");
    expect(html).toContain("Consumer Price Index");
  });

  it("renders no weekend note when the week has no weekend event", () => {
    expect(render([makeEvent()])).not.toContain("Outside the Mon–Fri grid");
  });

  it("an unlinkable weekend event is plain text, never a link", () => {
    const html = render([
      makeEvent({ id: 3, symbol: "ZZZ", event_date: SAT, security_id: null }),
    ]);
    expect(html).toContain("ZZZ");
    expect(html).not.toContain("/dashboard/security/");
  });

  it("prints the display-only earnings time when the page attached one", () => {
    const ev = {
      ...makeEvent({ id: 3, symbol: "ZZZ", event_date: SAT }),
      display_time: { label: "time unknown" },
    } as CalendarEvent;
    expect(render([ev])).toContain("time unknown");
  });
});

describe("hand-entered rows can be removed from the week view", () => {
  it("only a hand-entered earnings row gets the remove control", () => {
    expect(weekAheadRemovable(makeEvent({ source: "manual" }))).toBe(true);
    expect(weekAheadRemovable(makeEvent({ source: "finnhub" }))).toBe(false);
    expect(weekAheadRemovable(macroEvent({ source: "manual" }))).toBe(false);
  });

  it("the control sits outside the card link and is wired to the shared delete button", () => {
    const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    expect(src).toContain('import { EarningsDeleteButton } from "./EarningsDeleteButton"');
    const rowAt = anchorIndex(src, "function EventRow(");
    const row = src.slice(rowAt);
    // Inside the linked branch the control comes after the link closes,
    // never between <Link> and </Link> (a button inside a link is invalid).
    const linkStart = anchorIndex(row, "<Link");
    const linkEnd = anchorIndex(row, "</Link>", linkStart);
    expect(row.slice(linkStart, linkEnd)).not.toMatch(/removeRow|RemoveRow|EarningsDeleteButton/);
    expect(anchorIndex(row, "{removeRow}", linkEnd)).toBeGreaterThan(linkEnd);
    const helper = src.slice(anchorIndex(src, "function RemoveRow("));
    expect(helper).toContain("<EarningsDeleteButton");
    expect(helper).toContain("weekAheadRemovable(event)");
  });
});

describe("narrow-column overflow", () => {
  it("the reaction line wraps inside its card", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, { actual: null, snapshot: SNAP }),
    );
    expect(html).toContain("flex-wrap");
    expect(html).toContain("min-w-0");
    expect(html).not.toContain("whitespace-nowrap");
  });

  it("the conflict chip wraps when asked to, and the week view asks", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsConflictMarker, {
        dateStatus: "conflict",
        dateConflictWith: "finnhub:2026-09-28",
        wrap: true,
      }),
    );
    expect(html).not.toContain("whitespace-nowrap");
    expect(html).toContain("max-w-full");
    expect(html).toContain("break-words");
    const viewHtml = render([
      makeEvent({ date_status: "conflict", date_conflict_with: "finnhub:2026-09-28" }),
    ]);
    expect(viewHtml).toContain("⚠");
    expect(viewHtml).not.toContain("whitespace-nowrap");
  });
});

describe("pre-release chip clears on a timer", () => {
  const base = {
    actualDisplay: "EPS 1.00",
    preReleaseClass: "pre-cls",
    settledClass: "settled-cls",
    chipText: "pre-release",
    chipTitle: "why",
  };

  it("shows the muted figure and the chip while pre-release", () => {
    const html = renderToStaticMarkup(
      createElement(PreReleaseActualChips, { ...base, initiallyPreRelease: true, clearsAtMs: null }),
    );
    expect(html).toContain("actual EPS 1.00");
    expect(html).toContain("pre-cls");
    expect(html).toContain("pre-release");
    expect(html).not.toContain("settled-cls");
  });

  it("shows the settled figure and no chip otherwise", () => {
    const html = renderToStaticMarkup(
      createElement(PreReleaseActualChips, { ...base, initiallyPreRelease: false, clearsAtMs: null }),
    );
    expect(html).toContain("settled-cls");
    expect(html).not.toContain("pre-release");
    expect(html).not.toContain("pre-cls");
  });

  it("settledActualChipClass ignores the pre-release window; actualChipClass does not", () => {
    const ev = makeEvent({
      event_date: "2026-08-25",
      event_time: "AMC",
      consensus_estimate: "EPS 0.41",
      actual_value: "EPS 0.45",
    });
    const before = new Date("2026-08-25T14:00:00.000Z"); // 10:00 ET, before the 16:00 floor
    expect(actualChipClass(ev, before)).toContain("italic");
    expect(settledActualChipClass(ev)).toContain("text-up");
    expect(settledActualChipClass(ev)).not.toContain("italic");
  });

  it("the client chip gets the same layout classes as the server-rendered figure", () => {
    const view = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    const layout = view.match(/const ACTUAL_CHIP_LAYOUT = "([^"]+)";/)?.[1];
    expect(layout).toBeTruthy();
    expect(view).toContain(`className={\`${layout} \${actualChipClass(event)}\`}`);
  });

  it("the view hands the server-computed deadline to the shared hook", () => {
    const view = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    expect(view).toContain('import { preReleaseClearsAtMs } from "./pre-release-clear"');
    expect(view).toMatch(/clearsAtMs=\{[^}]*preReleaseClearsAtMs\(event/);
    const chips = readFileSync("app/dashboard/components/calendar/EnrichmentChips.tsx", "utf8");
    const at = anchorIndex(chips, "export function PreReleaseActualChips");
    expect(chips.slice(at)).toContain("usePreReleaseActive(initiallyPreRelease, clearsAtMs)");
  });
});

describe("Today page (B47)", () => {
  const page = readFileSync("app/dashboard/today/page.tsx", "utf8");

  it("masks the account count under privacy; the date stays public", () => {
    expect(page).toContain("<Count value={portfolio.accountCount} />");
    expect(page).not.toMatch(/[^=]\{portfolio\.accountCount\}/);
  });

  it("the price-freshness chip names what it measures", () => {
    const at = anchorIndex(page, "{overallQuality && (");
    const chip = page.slice(at, anchorIndex(page, "</span>", at));
    expect(chip).toMatch(/title=\{[^}]*price/i);
    expect(chip).toContain("IBKR prices");
  });

  it("the week view reads the deduped week query", () => {
    const at = anchorIndex(page, 'view === "week-ahead"');
    const branch = page.slice(at, anchorIndex(page, "<WeekAheadView", at));
    expect(branch).toMatch(/dedupeWeekEarnings\(\s*db,\s*weekOf,\s*withDisplayTimes\(db, getEventsByWeek\(db, weekOf\)\),?\s*\)/);
  });
});
