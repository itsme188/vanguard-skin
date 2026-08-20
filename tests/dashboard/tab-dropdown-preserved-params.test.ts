import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withPreservedParams } from "@/app/dashboard/components/TabDropdown";
import { tabs } from "@/app/dashboard/components/nav-tabs";

// Regression covered (2026-08-20 code review of b687a6e): the original
// withCurrentScope hardcoded 'scope' as a param every tab's dropdown should
// carry, which leaked Analysis's ?scope= onto OTHER tabs' sub-view links
// whenever their TabDropdown happened to render off the same current-page
// URL (all tab dropdowns in the nav bar share one useSearchParams() call).
// The fix moves the decision into nav-tabs.ts (Tab.preserveParams, declared
// per tab) and withPreservedParams just consults whatever list it's handed.

describe("withPreservedParams", () => {
  it("appends a declared param that's present on the current URL", () => {
    const sp = new URLSearchParams("scope=ibkr");
    expect(withPreservedParams("/dashboard/analysis?view=diagnostics", sp, ["scope"])).toBe(
      "/dashboard/analysis?view=diagnostics&scope=ibkr",
    );
  });

  it("uses '?' as the separator when the href has no query string yet", () => {
    const sp = new URLSearchParams("scope=ibkr");
    expect(withPreservedParams("/dashboard/analysis", sp, ["scope"])).toBe(
      "/dashboard/analysis?scope=ibkr",
    );
  });

  it("leaves the href untouched when no preserveParams are declared for this tab", () => {
    const sp = new URLSearchParams("scope=ibkr");
    expect(withPreservedParams("/dashboard/research?view=feeds", sp, undefined)).toBe(
      "/dashboard/research?view=feeds",
    );
    expect(withPreservedParams("/dashboard/research?view=feeds", sp, [])).toBe(
      "/dashboard/research?view=feeds",
    );
  });

  it("leaves the href untouched when the declared param isn't present on the current URL", () => {
    const sp = new URLSearchParams("view=diagnostics");
    expect(withPreservedParams("/dashboard/analysis?view=workspace", sp, ["scope"])).toBe(
      "/dashboard/analysis?view=workspace",
    );
  });

  it("only forwards the declared params, not every param on the current URL", () => {
    const sp = new URLSearchParams("scope=ibkr&period=1y&dimension=sector");
    expect(withPreservedParams("/dashboard/analysis?view=diagnostics", sp, ["scope"])).toBe(
      "/dashboard/analysis?view=diagnostics&scope=ibkr",
    );
  });
});

describe("nav-tabs.ts preserveParams declarations", () => {
  it("only Analysis declares ?scope= as preserved — no other tab's sub-view links should inherit it", () => {
    const analysis = tabs.find((t) => t.name === "Analysis");
    expect(analysis?.preserveParams).toEqual(["scope"]);

    for (const tab of tabs) {
      if (tab.name === "Analysis") continue;
      expect(tab.preserveParams ?? []).not.toContain("scope");
    }
  });

  it("simulates the cross-tab leak this fixes: Research's dropdown never gains ?scope= while viewing Analysis?scope=ibkr", () => {
    const currentUrlParams = new URLSearchParams("scope=ibkr");
    const research = tabs.find((t) => t.name === "Research")!;
    for (const sv of research.subviews ?? []) {
      const href = withPreservedParams(sv.href, currentUrlParams, research.preserveParams);
      expect(href).not.toContain("scope=");
    }
  });

  it("Analysis's own sub-view links DO carry the current scope", () => {
    const currentUrlParams = new URLSearchParams("scope=ibkr");
    const analysis = tabs.find((t) => t.name === "Analysis")!;
    for (const sv of analysis.subviews ?? []) {
      const href = withPreservedParams(sv.href, currentUrlParams, analysis.preserveParams);
      expect(href).toContain("scope=ibkr");
    }
  });
});

// analysis/page.tsx is an async server component that hits the db module at
// import time, so it can't be imported directly under vitest (no db
// fixture wired here). Following the static-scan precedent in
// tests/dashboard/data-confidence-indicator-privacy.test.ts, scan the
// Workspace scope-pill block's source instead of rendering it.
describe("Analysis Workspace scope-pill hrefs (analysis/page.tsx)", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/analysis/page.tsx"),
    "utf-8",
  );

  function scopePillBlock(src: string): string {
    const start = src.indexOf("SCOPE_PILLS.map((s) =>");
    expect(start, "SCOPE_PILLS.map(...) block not found in analysis/page.tsx").toBeGreaterThan(-1);
    const end = src.indexOf("</div>", start);
    return src.slice(start, end);
  }

  it("pill hrefs omit ?view= — Workspace's canonical nav identity is view-absent", () => {
    const block = scopePillBlock(source);
    expect(block).toContain("href={`/dashboard/analysis?scope=${s.key}`}");
    // The regression this guards against: hardcoding the buggy
    // `?view=workspace&scope=...` shape directly in the href template
    // literal (a bare substring check for "view=workspace" would also
    // trip on this file's explanatory comments, so match the href pattern).
    expect(block).not.toContain("?view=workspace&scope=");
  });
});
