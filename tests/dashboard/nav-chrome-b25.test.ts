/**
 * Unit B25 (nav chrome): five header/nav QA findings.
 * No DOM harness, so pure functions are called directly and component
 * behaviour is pinned by source anchors.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { subviewMatches } from "@/app/dashboard/components/TabDropdown";
import { tabs } from "@/app/dashboard/components/nav-tabs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const read = (f: string) => readFileSync(`app/dashboard/components/${f}`, "utf8");
const analysis = tabs.find((t) => t.name === "Analysis")!;
const research = tabs.find((t) => t.name === "Research")!;
const workspace = analysis.subviews![0];
const diagnostics = analysis.subviews![1];

describe("subviewMatches only ticks on the tab's own route", () => {
  it("does not tick the default item off-route", () => {
    expect(subviewMatches(workspace, new URLSearchParams(), "/dashboard/today", analysis.href)).toBe(false);
    expect(subviewMatches(research.subviews![0], new URLSearchParams(), "/dashboard/analysis", research.href)).toBe(false);
    expect(subviewMatches(workspace, new URLSearchParams(), "/dashboard/security/12", analysis.href)).toBe(false);
  });
  it("ticks the default item on the tab route with no view param", () => {
    expect(subviewMatches(workspace, new URLSearchParams(), "/dashboard/analysis", analysis.href)).toBe(true);
    expect(subviewMatches(workspace, new URLSearchParams("scope=ibkr"), "/dashboard/analysis", analysis.href)).toBe(true);
  });
  it("ticks the named view only on the tab route", () => {
    const sp = new URLSearchParams("view=diagnostics");
    expect(subviewMatches(diagnostics, sp, "/dashboard/analysis", analysis.href)).toBe(true);
    expect(subviewMatches(workspace, sp, "/dashboard/analysis", analysis.href)).toBe(false);
    expect(subviewMatches(diagnostics, sp, "/dashboard/research", analysis.href)).toBe(false);
  });
  it("does not match a sibling route sharing a prefix", () => {
    expect(subviewMatches(workspace, new URLSearchParams(), "/dashboard/analysisx", analysis.href)).toBe(false);
  });
});

describe("TabDropdown returns focus to the trigger", () => {
  const src = read("TabDropdown.tsx");
  it("keeps a ref on the ••• button and focuses it on Escape", () => {
    anchorIndex(src, "const triggerRef = useRef<HTMLButtonElement>(null)");
    const esc = anchorIndex(src, 'if (e.key === "Escape")');
    expect(src.slice(esc, esc + 400)).toContain("triggerRef.current?.focus()");
    anchorIndex(src, "ref={triggerRef}");
  });
});

describe("TwsStatus popover dismissal", () => {
  const src = read("TwsStatus.tsx");
  it("closes on Escape and on an outside pointerdown", () => {
    const i = anchorIndex(src, "wrapperRef.current?.contains");
    const block = src.slice(i - 600, i + 800);
    expect(block).toContain('"pointerdown"');
    expect(block).toContain('"Escape"');
    anchorIndex(src, "ref={wrapperRef}");
  });
});

describe("MobileNavDrawer", () => {
  const src = read("MobileNavDrawer.tsx");
  it("extends both small controls for touch", () => {
    const close = anchorIndex(src, 'aria-label="Close navigation"');
    expect(src.slice(close - 400, close)).toContain("pointer-coarse:after:-inset-3");
    const burger = anchorIndex(src, 'aria-label="Open navigation menu"');
    expect(src.slice(burger - 400, burger)).toContain("pointer-coarse:after:-inset-2");
  });
  it("moves focus out of the drawer before it hides, and makes it inert", () => {
    anchorIndex(src, "hamburgerRef.current?.focus()");
    anchorIndex(src, "inert={!open}");
  });
});

describe("AnalysisViewToggle", () => {
  const src = read("AnalysisViewToggle.tsx");
  it("scrolls the active tab into view and wraps the strip in ScrollFade", () => {
    anchorIndex(src, '"use client"');
    anchorIndex(src, "scrollIntoView");
    anchorIndex(src, "<ScrollFade");
  });
});

describe("NotificationBell touch target", () => {
  it("extends the 18px bell to at least 44px", () => {
    const src = read("NotificationBell.tsx");
    expect(src).toContain("pointer-coarse:after:-inset-3.5");
    expect(src).not.toContain("pointer-coarse:after:-inset-2 ");
  });
});
