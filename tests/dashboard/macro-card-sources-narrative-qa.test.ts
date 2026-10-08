import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import {
  exposurePillClass,
  exposureRankLabel,
  hasExposureFigure,
} from "@/app/dashboard/components/analysis/MacroOverlayCard";
import { macroEventLabel } from "@/app/dashboard/components/analysis/MacroThemeReceiptDrawer";

// No DOM harness in this repo: pure helpers are tested directly and the JSX
// wiring is pinned by a source scan (see tests/dashboard/narrative-block-refresh.test.ts).

const CARD = readFileSync("app/dashboard/components/analysis/MacroOverlayCard.tsx", "utf8");
const DRAWER = readFileSync("app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx", "utf8");
const NARRATIVE = readFileSync("app/dashboard/components/analysis/NarrativeBlock.tsx", "utf8");

// QA finding analysis-macro-themes--exposure-badge-always-very-high-regression-1
describe("Macro card exposure pill", () => {
  it("labels only the ends of the week's range", () => {
    expect(exposureRankLabel("highest")).toBe("highest this week");
    expect(exposureRankLabel("lowest")).toBe("lowest this week");
    expect(exposureRankLabel(null)).toBeNull();
    expect(exposureRankLabel(undefined)).toBeNull();
  });

  it("colours by the relative marker, three distinct treatments", () => {
    const classes = new Set([exposurePillClass("highest"), exposurePillClass("lowest"), exposurePillClass(null)]);
    expect(classes.size).toBe(3);
    expect(exposurePillClass(undefined)).toBe(exposurePillClass(null));
  });

  it("a theme cached without the figure has nothing to show", () => {
    expect(hasExposureFigure({})).toBe(false);
    expect(hasExposureFigure({ exposure_pct: Number.NaN })).toBe(false);
    expect(hasExposureFigure({ exposure_pct: 0 })).toBe(true);
    expect(hasExposureFigure({ exposure_pct: 31 })).toBe(true);
  });

  it("prints the percentage through the privacy component and never the bucket word", () => {
    const pill = sliceBetween(CARD, "{hasExposureFigure(t) && (", '<p className="text-xs text-ink-dim mt-1 ml-4">');
    expect(pill).toContain("<Pct value={t.exposure_pct} digits={0} />");
    expect(pill).toContain("exposureRankLabel(t.exposure_rank)");
    expect(pill).toContain("exposurePillClass(t.exposure_rank)");
    expect(pill).not.toContain("exposure_bucket");
    // Nowhere in the rendered card.
    const jsx = CARD.slice(anchorIndex(CARD, "export function MacroOverlayCard("));
    expect(jsx).not.toContain("exposure_bucket");
  });
});

// QA finding analysis-macro-sources--generic-links-unlabeled-events-regression-3 (event-name half)
describe("Macro sources drawer event label", () => {
  it("names a symbol-less macro release by its title", () => {
    expect(macroEventLabel({ id: 1, symbol: null, event_date: "2026-05-02", title: "CPI Release", event_type: "macro" })).toBe("CPI Release");
  });

  it("prefixes the ticker only when the title does not already carry it", () => {
    expect(macroEventLabel({ id: 1, symbol: "AAA", event_date: "2026-05-02", title: "AAA Earnings" })).toBe("AAA Earnings");
    expect(macroEventLabel({ id: 1, symbol: "AAA", event_date: "2026-05-02", title: "Q3 Earnings" })).toBe("AAA · Q3 Earnings");
  });

  it("falls back for an older cached summary: symbol, then event type, then a plain placeholder", () => {
    expect(macroEventLabel({ id: 1, symbol: "AAA", event_date: "2026-05-02" })).toBe("AAA");
    expect(macroEventLabel({ id: 1, symbol: null, event_date: "2026-05-02", title: "  ", event_type: "other_macro" })).toBe("other macro");
    expect(macroEventLabel({ id: 1, symbol: null, event_date: "2026-05-02" })).toBe("Unnamed event");
  });

  it("the drawer renders the label, not the bare word 'macro'", () => {
    expect(DRAWER).toContain("{macroEventLabel(e)} · {e.event_date}");
    expect(DRAWER).not.toContain('e.symbol ?? "macro"');
  });
});

// QA finding mobile-analysis-narratives--refresh-buttons-16px-paid-ai-tap-targets-no-touch-extension
describe("NarrativeBlock paid-AI buttons carry a touch hit area", () => {
  it("the extension reaches about 44px on a 16px control, on touch only", () => {
    const def = sliceBetween(NARRATIVE, "const TOUCH_HIT_AREA =", ";");
    expect(def).toContain("relative");
    expect(def).toContain("pointer-coarse:after:absolute");
    expect(def).toContain("pointer-coarse:after:content-['']");
    expect(def).toContain("pointer-coarse:after:-inset-3.5");
    // Never an unconditional overlay: that would enlarge the mouse target too.
    expect(def).not.toMatch(/(^|[\s"])after:/);
  });

  it.each([
    ['aria-label="Refresh narrative now"', "Refresh to regenerate"],
    ['aria-label="Refresh narrative"\n', '"Refresh"}'],
    ['aria-label="Try generating the narrative again"', "Try again"],
  ])("%s button uses it and says what a press costs", (label, text) => {
    const start = anchorIndex(NARRATIVE, label);
    const button = NARRATIVE.slice(start, anchorIndex(NARRATIVE, "</button>", start));
    expect(button).toContain(text);
    expect(button).toContain("className={`${TOUCH_HIT_AREA} ");
    expect(button).toContain("title={REGENERATE_TITLE}");
  });

  it("the title names the one AI call", () => {
    expect(sliceBetween(NARRATIVE, "const REGENERATE_TITLE =", ";")).toMatch(/one AI call/);
  });
});
