import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ANALYSIS_SCOPE_KEY,
  ANALYSIS_SCOPE_TOKENS,
  isKnownAnalysisScope,
  readRememberedScope,
  rememberScope,
  isAnalysisPath,
  rememberedScopeHref,
  type StorageLike,
} from "@/lib/ui/analysis-scope-memory";
import { tabs } from "@/app/dashboard/components/nav-tabs";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}
const throwing: StorageLike = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("scope tokens", () => {
  it("accepts only the four pill tokens", () => {
    expect([...ANALYSIS_SCOPE_TOKENS].sort()).toEqual(["all", "ibkr", "roth", "vanguard"]);
    expect(isKnownAnalysisScope("ibkr")).toBe(true);
    expect(isKnownAnalysisScope("bogus")).toBe(false);
    expect(isKnownAnalysisScope(null)).toBe(false);
  });
});

describe("remember and read", () => {
  it("round-trips a valid scope", () => {
    const s = fakeStorage();
    rememberScope(s, "roth");
    expect(s.data[ANALYSIS_SCOPE_KEY]).toBe("roth");
    expect(readRememberedScope(s)).toBe("roth");
  });
  it("does not store an invalid scope", () => {
    const s = fakeStorage();
    rememberScope(s, "<script>");
    expect(s.data[ANALYSIS_SCOPE_KEY]).toBeUndefined();
  });
  it("ignores a stale or hand-edited stored value", () => {
    expect(readRememberedScope(fakeStorage({ [ANALYSIS_SCOPE_KEY]: "hacked" }))).toBeNull();
  });
  it("returns null with nothing stored", () => {
    expect(readRememberedScope(fakeStorage())).toBeNull();
  });
  it("survives storage that throws", () => {
    expect(readRememberedScope(throwing)).toBeNull();
    expect(() => rememberScope(throwing, "ibkr")).not.toThrow();
    expect(readRememberedScope(null)).toBeNull();
    expect(() => rememberScope(null, "ibkr")).not.toThrow();
  });
});

describe("isAnalysisPath", () => {
  it("matches the Analysis route only", () => {
    expect(isAnalysisPath("/dashboard/analysis")).toBe(true);
    expect(isAnalysisPath("/dashboard/analysis/x")).toBe(true);
    expect(isAnalysisPath("/dashboard/analysisx")).toBe(false);
    expect(isAnalysisPath("/dashboard/today")).toBe(false);
  });
});

describe("rememberedScopeHref", () => {
  const analysis = tabs.find((t) => t.name === "Analysis")!;
  it("appends the remembered scope off the Analysis tab", () => {
    expect(rememberedScopeHref("/dashboard/analysis", "ibkr", "/dashboard/today")).toBe(
      "/dashboard/analysis?scope=ibkr",
    );
    expect(rememberedScopeHref("/dashboard/analysis?view=defense", "roth", "/dashboard/today")).toBe(
      "/dashboard/analysis?view=defense&scope=roth",
    );
  });
  it("leaves the href alone with no remembered scope or an invalid one", () => {
    expect(rememberedScopeHref("/dashboard/analysis", null, "/dashboard/today")).toBe("/dashboard/analysis");
    expect(rememberedScopeHref("/dashboard/analysis", "nope", "/dashboard/today")).toBe("/dashboard/analysis");
  });
  it("leaves the href alone while on an Analysis page (live scope owns it)", () => {
    expect(rememberedScopeHref("/dashboard/analysis", "ibkr", "/dashboard/analysis")).toBe("/dashboard/analysis");
  });
  it("never adds a scope to a non-Analysis link", () => {
    for (const tab of tabs) {
      if (tab.name === "Analysis") continue;
      expect(rememberedScopeHref(tab.href, "ibkr", "/dashboard/today")).toBe(tab.href);
      for (const sv of tab.subviews ?? []) {
        expect(rememberedScopeHref(sv.href, "ibkr", "/dashboard/today")).toBe(sv.href);
      }
    }
    expect(analysis.subviews!.length).toBeGreaterThan(0);
  });
  it("does not duplicate a scope already in the href", () => {
    expect(rememberedScopeHref("/dashboard/analysis?scope=all", "ibkr", "/dashboard/today")).toBe(
      "/dashboard/analysis?scope=all",
    );
  });
});

describe("source pins: read happens in an effect, not during render", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");
  const hook = read("app/dashboard/components/use-remembered-analysis-scope.ts");
  it("hook reads storage only inside useEffect", () => {
    const eff = hook.indexOf("useEffect(");
    expect(eff).toBeGreaterThan(-1);
    const firstRead = hook.indexOf("readRememberedScope(");
    expect(firstRead).toBeGreaterThan(eff);
    expect(hook).toContain("useState<string | null>(null)");
  });
  it("TabDropdown and MobileBottomNav use the hook and the href builder", () => {
    for (const f of ["TabDropdown.tsx", "MobileBottomNav.tsx"]) {
      const src = read(`app/dashboard/components/${f}`);
      expect(src).toContain("useRememberedAnalysisScope");
      expect(src).toContain("rememberedScopeHref");
      expect(src).not.toMatch(/sessionStorage/);
    }
  });
});
