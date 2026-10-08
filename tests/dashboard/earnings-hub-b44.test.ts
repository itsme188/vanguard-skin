/**
 * Earnings Hub rows and chips (unit B44). No DOM harness: pure helpers are
 * tested directly, wiring is pinned against source with loud anchors.
 * Symbols and times are synthetic.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// EarningsHub.tsx imports the db singleton; the helpers under test never touch it.
vi.mock("@/lib/db", () => ({ db: null }));

import { whenCell, earningsHubHeading } from "@/app/dashboard/today/EarningsHub";
import {
  reportsAtTime,
  releaseTimeInputValue,
  type ReleaseTimeState,
} from "@/app/dashboard/today/EarningsDateChip";
import { stageChips, stageTitle, StageChipStrip } from "@/app/dashboard/today/hub-live/send-state-chips";
import type { CockpitRowWire } from "@/app/dashboard/today/hub-live/types";

const read = (p: string) => readFileSync(p, "utf8");
const HUB = read("app/dashboard/today/EarningsHub.tsx");
const CHIPS = read("app/dashboard/today/EarningsRowChips.tsx");
const DATE_CHIP = read("app/dashboard/today/EarningsDateChip.tsx");
const ADD_FORM = read("app/dashboard/today/EarningsHubAddForm.tsx");

const STORED = { label: "4:05 PM", kind: "stored" as const };

// qa:today-earningshub-when--slot-dash-on-vendor-rows-despite-known-amc-regression-1
describe("whenCell — the WHEN cell", () => {
  const cell = (
    event_time: string | null,
    release_time: string | null,
    raw_json: string | null,
    display_time: { label: string | null; kind: "stored" | "usual" | "unknown" } = STORED,
  ) => whenCell({ event_time, release_time, raw_json, display_time });

  it("a vendor row (no event_time) takes its slot from the vendor hour, not a dash", () => {
    expect(cell(null, "16:05", JSON.stringify({ entry: { hour: "amc" } }))).toBe("AMC · 16:05");
    expect(cell(null, "07:00", JSON.stringify({ entry: { hour: "bmo" } }))).toBe("BMO · 07:00");
  });

  it("a manual row keeps its own marker", () => {
    expect(cell("AMC", "16:15", null)).toBe("AMC · 16:15");
    expect(cell("bmo", null, null)).toBe("BMO");
    // The vendor hour never overrides a marker the row already carries.
    expect(cell("BMO", "07:00", JSON.stringify({ entry: { hour: "amc" } }))).toBe("BMO · 07:00");
  });

  it("a time with no slot evidence shows the time alone, never a dash", () => {
    expect(cell(null, "16:05", "{}")).toBe("16:05");
    expect(cell(null, null, null)).toBe("TBD");
  });

  it("an estimate or unknown label still wins over the stored time", () => {
    expect(cell(null, "16:15", null, { label: "time unknown", kind: "unknown" })).toBe("time unknown");
  });
});

// qa:today-earningshub--weekend-heading-this-week-disagrees-with-week-ahead-navigator
describe("earningsHubHeading", () => {
  it("says 'this week' only for the week that contains today", () => {
    expect(earningsHubHeading("2026-09-07", "2026-09-09")).toBe("Earnings This Week"); // Wednesday
    expect(earningsHubHeading("2026-09-07", "2026-09-07")).toBe("Earnings This Week"); // Monday
  });

  it("on Saturday and Sunday the rolled-forward week is the week ahead", () => {
    expect(earningsHubHeading("2026-09-14", "2026-09-12")).toBe("Earnings Week Ahead");
    expect(earningsHubHeading("2026-09-14", "2026-09-13")).toBe("Earnings Week Ahead");
  });

  it("the header renders the helper, not a fixed string", () => {
    anchorIndex(HUB, "{earningsHubHeading(weekOf, todayET())}");
    expect(HUB).not.toContain("\n            Earnings This Week\n");
  });
});

// qa:mobile-earningshub--week-range-wraps-mid-date
describe("hub week range", () => {
  it("each date is its own no-wrap run", () => {
    anchorIndex(HUB, '<span className="whitespace-nowrap">{weekOf}</span>');
    anchorIndex(HUB, '<span className="whitespace-nowrap">{weekEnd}</span>');
  });
});

// qa:today-earningshub-release-time--clear-leaves-stale-input-value-regression-1
describe("release-time override input", () => {
  const withOverride: ReleaseTimeState = {
    resolved: { time: "16:20", source: "user" },
    override: { source: "user", release_time: "16:20" },
  };
  const cleared: ReleaseTimeState = { resolved: null, override: null };

  it("untouched, the input shows the standing override", () => {
    expect(releaseTimeInputValue(null, withOverride, "16:20")).toBe("16:20");
  });

  it("after a Clear it follows the Reports-at line, including once the row refreshes", () => {
    // Just after the clear the row prop is still the old value...
    expect(releaseTimeInputValue(null, cleared, "16:20")).toBe(reportsAtTime(cleared, "16:20"));
    // ...and when the refreshed row arrives, input and line move together.
    expect(reportsAtTime(cleared, "16:15")).toBe("16:15");
    expect(releaseTimeInputValue(null, cleared, "16:15")).toBe("16:15");
  });

  it("what the user typed wins until the next load or save, an emptied field included", () => {
    expect(releaseTimeInputValue("09:30", cleared, "16:15")).toBe("09:30");
    expect(releaseTimeInputValue("", withOverride, "16:20")).toBe("");
  });

  it("a load resets the typed value instead of copying a time into state", () => {
    const load = sliceBetween(DATE_CHIP, "async function loadReleaseTime()", "async function saveReleaseTime(");
    expect(load).toContain("setRtEdited(null);");
    expect(load).not.toContain("?? releaseTime");
    anchorIndex(DATE_CHIP, "const rtEdit = releaseTimeInputValue(rtEdited, rt, releaseTime);");
  });
});

// qa:mobile-alerts-conflicts--popover-ok-and-save-are-19px-targets-no-touch-extension
describe("conflict popover touch targets", () => {
  it("'ok' and 'Save' carry the pointer-coarse hit extension; 'ok' stands off the slot select", () => {
    const ok = DATE_CHIP.slice(0, anchorIndex(DATE_CHIP, "\n                ok\n"));
    expect(ok.slice(ok.lastIndexOf("<button"))).toContain("${TOUCH_EXTENSION} ml-1 ");
    const save = DATE_CHIP.slice(0, anchorIndex(DATE_CHIP, "\n          Save\n"));
    expect(save.slice(save.lastIndexOf("<button"))).toContain("${TOUCH_EXTENSION} ");
    const ext = sliceBetween(DATE_CHIP, "const TOUCH_EXTENSION =", ";");
    expect(ext).toContain("pointer-coarse:after:absolute");
    expect(ext).toContain("pointer-coarse:after:-inset-y-2");
  });
});

// qa:today-earningshub-add-ticker--slot-select-keeps-last-value-while-ticker-and-date-reset
// qa:mobile-earningshub-footer--add-ticker-refresh-upload-21px-no-touch-extension
describe("+ Add ticker", () => {
  const opener = sliceBetween(ADD_FORM, "if (!open) {", "+ Add ticker");

  it("opening the form resets the slot with the date", () => {
    expect(opener).toContain("setDate(defaultDateWithinWeek(weekOf));");
    expect(opener).toContain("setSlot(DEFAULT_SLOT);");
    expect(ADD_FORM).toContain('export const DEFAULT_SLOT: Slot = "AMC";');
  });

  it("the opener carries the pointer-coarse hit extension", () => {
    expect(opener).toContain("pointer-coarse:after:absolute");
    expect(opener).toContain("pointer-coarse:after:-inset-y-3");
  });
});

// qa:today-cockpit--stage-chips-no-tooltips-no-legend-regression-2
describe("stage chips name themselves", () => {
  const row = {
    eventId: 1, symbol: "ZZA", securityId: null, title: "ZZA Q3", eventDate: "2026-09-10",
    eventTime: "AMC", releaseTime: "16:05", symbolStatus: "held", consensus: null, actual: null,
    stages: {
      preview: "pending",
      released: { state: "upcoming", releaseInstant: "2026-09-10T20:05:00.000Z" },
      actual: "pending",
      reaction: { state: "pending", source: null, readyAt: null },
      recap: "waiting",
    },
    netExposure: 0, isTopExposure: false, hasCallNote: false, carryover: false, intel: null,
  } as unknown as CockpitRowWire;

  it("every chip has a title that names the stage and its state", () => {
    const titles = Object.fromEntries(stageChips(row).map((c) => [c.key, c.title]));
    expect(titles).toEqual({
      released: "Release time (ET): not released yet",
      preview: "Preview email: not sent yet",
      actual: "Reported figures: not captured yet",
      reaction: "Price reaction: not captured yet",
      recap: "Recap email: waiting for the reported figures",
    });
  });

  it("an unmapped state still gets the stage name", () => {
    expect(stageTitle("recap", "brand-new")).toBe("Recap email: brand-new");
  });

  it("the rendered strip puts the sentence in both title and aria-label of each chip", () => {
    const html = renderToStaticMarkup(createElement(StageChipStrip, { row, onOpen: () => undefined }));
    for (const c of stageChips(row)) {
      expect(html).toContain(`aria-label="${c.title}"`);
      expect(html).toContain(`title="${c.title}"`);
    }
  });
});

// qa:today-earningshub-email-chips--preview-pending-sends-automatically-after-print
describe("preview chip after the print", () => {
  it("a missed preview is plain text: no automatic-send promise, no skip control", () => {
    const missed = sliceBetween(CHIPS, "if (missed) {", "return (\n    <span className=\"inline-flex items-center gap-0.5\">");
    expect(missed).toContain("was not sent before the print");
    expect(missed).not.toContain("sends automatically");
    expect(missed).not.toContain("<button");
    expect(missed).not.toContain("toggleSkip");
  });

  it("missed means printed (or the cockpit's own missed stage) with nothing sent or skipped", () => {
    const rule = sliceBetween(CHIPS, "const previewMissed =", ";");
    expect(rule).toContain("!previewSent && !previewSkipped");
    expect(rule).toContain('cockpitRow?.stages.preview === "missed"');
    expect(rule).toContain("printed");
    // Only the preview chip is told; the recap chip is unchanged.
    expect(CHIPS.split("missed={previewMissed}").length).toBe(2);
  });

  it("the hub passes printed only for an actual whose print window has opened", () => {
    expect(HUB.split("printed={isPostRelease && !isPreReleaseActual(event)}").length).toBe(3);
  });
});

// qa:mobile-today-live-print--unarming-leaves-stale-panel-claiming-wire-armed-until-reload
// qa:today-earningshub-gen--recap-enriches-but-hub-row-stays-stale-regression-1
describe("live layer follows a row mutation", () => {
  it("a disarm asks the watcher to reconcile, then re-reads status before the row re-renders", () => {
    const toggle = sliceBetween(CHIPS, "async function toggleWorksheet()", "const [inlineData");
    const ensure = anchorIndex(toggle, '"/api/print-watch/ensure"');
    const guard = toggle.lastIndexOf("if (worksheetArmed) {", ensure);
    expect(guard).toBeGreaterThan(-1);
    const changed = anchorIndex(toggle, "await live?.onChanged();", ensure);
    const refresh = anchorIndex(toggle, "router.refresh();", changed);
    expect(ensure).toBeLessThan(changed);
    expect(changed).toBeLessThan(refresh);
  });

  it("a finished gen recap re-reads the client-polled chips as well as the server row", () => {
    const gen = sliceBetween(CHIPS, "async function generateRecap()", "function cancelRecap()");
    const open = anchorIndex(gen, 'setOpenPhase("recap");');
    const changed = anchorIndex(gen, "void live?.onChanged();", open);
    anchorIndex(gen, "router.refresh();", changed);
  });
});

// The hub's pre-release chip clears on time (rides with B44).
describe("pre-release clear timer", () => {
  it("both hub layouts pass the clear instant to the row chips", () => {
    expect(
      HUB.split("preReleaseClearsAtMs={preRelease ? preReleaseClearsAtMs(event) : null}").length,
    ).toBe(3);
  });
});
