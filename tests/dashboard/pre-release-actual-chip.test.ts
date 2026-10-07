import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";
import { stageChips } from "@/app/dashboard/today/hub-live/send-state-chips";
import type { CockpitRowWire } from "@/app/dashboard/today/hub-live/types";
import { actualChipClass } from "@/app/dashboard/today/WeekAheadView";

// QA finding (HIGH, owner ruling 2026-10-06, Option 1 display-only): a manual
// actual saved before its print window opened rendered as plain fact on
// Today's releases, the Hub row ("act ✓") and the week-ahead card. Every
// surface now routes through isPreReleaseActual and shows a "pre-release"
// chip with muted figures. No DOM harness in this repo — source-pin, browser
// proof separately.

const HELPER_IMPORT = 'from "@/lib/calendar/pre-release-actual"';

describe("Today's releases marks a pre-release actual", () => {
  const src = readFileSync("app/dashboard/components/TodayReleases.tsx", "utf8");

  it("imports the shared helper and gates on it", () => {
    expect(src).toContain(HELPER_IMPORT);
    expect(src).toMatch(/const preRelease = enriched && isPreReleaseActual\(event\)/);
  });

  it("renders the pre-release chip with the figure muted, ahead of the normal summary", () => {
    const at = anchorIndex(src, "{preRelease ? (");
    const branch = src.slice(at, anchorIndex(src, "<EnrichmentRowSummary", at));
    expect(branch).toContain("preReleaseActualChipText(event.manual_actuals_at)");
    expect(branch).toContain('<Chip tone="warn"');
    expect(branch).toContain('className="text-ink-faint italic">{preReleaseFigure}');
    expect(branch).not.toContain("text-gold-ink");
  });
});

describe("Earnings Hub row marks a pre-release actual", () => {
  const hub = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");
  const chips = readFileSync("app/dashboard/today/EarningsRowChips.tsx", "utf8");

  it("both row shapes compute preRelease with the helper and pass it to the chips", () => {
    expect(hub).toContain(HELPER_IMPORT);
    expect(hub.match(/const preRelease = isPostRelease && !implausible && isPreReleaseActual\(event\)/g)).toHaveLength(2);
    expect(hub.match(/preReleaseActualTitle=\{preRelease \? PRE_RELEASE_ACTUAL_TITLE : null\}/g)).toHaveLength(2);
    expect(hub.match(/<PreReleaseChip manualActualsAt=/g)).toHaveLength(2);
    expect(hub).toContain("preReleaseActualChipText(manualActualsAt)");
  });

  it("mutes the actual figures and the delta", () => {
    expect(hub.match(/muted=\{preRelease\}/g)).toHaveLength(2);
    expect(hub.match(/preRelease \? "text-ink-faint" : deltaToneClass\(delta\)/g)).toHaveLength(2);
  });

  it("EarningsRowChips threads the flag into the stage strip", () => {
    expect(chips).toMatch(/<StageChipStrip[^>]*preReleaseActualTitle=\{preReleaseActualTitle\}/);
    // A client file: it must not value-import the lib/calendar helper.
    expect(chips).not.toContain(HELPER_IMPORT);
  });
});

describe("stage strip 'act' chip", () => {
  const row = (actual: CockpitRowWire["stages"]["actual"]) =>
    ({
      releaseTime: "16:05",
      eventTime: "AMC",
      stages: {
        released: { state: "upcoming", releaseInstant: null },
        preview: "pending",
        actual,
        reaction: { state: "pending", source: null },
        recap: "waiting",
      },
    }) as unknown as CockpitRowWire;

  it("reads 'act pre-release' in the warn tone for a captured pre-release actual", () => {
    const act = stageChips(row("captured"), null, "saved early").find((c) => c.key === "actual")!;
    expect(act.text).toBe("act pre-release");
    expect(act.tone).toBe("warn");
    expect(act.title).toBe("saved early");
  });

  it("is unchanged once the window has opened, or when the stage is not captured", () => {
    expect(stageChips(row("captured")).find((c) => c.key === "actual")!.text).toBe("act ✓");
    expect(stageChips(row("blocked"), null, "saved early").find((c) => c.key === "actual")!.text).toBe("act ✗");
  });
});

describe("week-ahead card marks a pre-release actual", () => {
  const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");

  it("adds the pre-release chip beside the actual", () => {
    expect(src).toContain(HELPER_IMPORT);
    expect(src).toMatch(/const preRelease = !!actualDisplay && isPreReleaseActual\(event\)/);
    expect(src).toContain("preReleaseActualChipText(event.manual_actuals_at)");
  });

  it("actualChipClass never colors a pre-release actual as a beat, and reverts once the window opens", () => {
    // 2026-10-07 is EDT: 16:00 ET = 20:00Z.
    const ev = {
      event_type: "earnings" as const,
      consensus_estimate: "EPS 0.41",
      actual_value: "EPS 0.45",
      event_date: "2026-10-07",
      event_time: "AMC",
      release_time: "16:05",
      raw_json: null,
      manual_actuals_at: "2026-10-07 13:00:00",
    };
    const before = actualChipClass(ev, new Date("2026-10-07T19:59:00Z"));
    expect(before).toContain("text-ink-faint");
    expect(before).not.toContain("text-up");
    expect(actualChipClass(ev, new Date("2026-10-07T20:00:00Z"))).toContain("text-up");
  });
});
