import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import {
  narrativeRenderState,
  NARRATIVE_COLD_CACHE_COPY,
  NARRATIVE_GENERATE_LABEL,
} from "@/app/dashboard/components/analysis/NarrativeBlock";
import {
  isMacroColdCache,
  topContributorsLabel,
  MACRO_COLD_CACHE_COPY,
  MACRO_GENERATE_LABEL,
} from "@/app/dashboard/components/analysis/MacroOverlayCard";
import {
  MACRO_INPUTS_HEADING,
  MACRO_INPUTS_NOTE,
} from "@/app/dashboard/components/analysis/MacroThemeReceiptDrawer";

// No DOM harness in this repo: pure helpers are tested directly and the wiring
// is pinned by a source scan (see tests/dashboard/narrative-block-refresh.test.ts).

const NARRATIVE = readFileSync("app/dashboard/components/analysis/NarrativeBlock.tsx", "utf8");
const CARD = readFileSync("app/dashboard/components/analysis/MacroOverlayCard.tsx", "utf8");
const DRAWER = readFileSync("app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx", "utf8");

// QA finding analysis-narrative--auto-generates-on-mount-per-scope-surface-cold-cache
describe("NarrativeBlock: a cold cache never spends an AI call without a click", () => {
  const cold = { text: null, error: null, refreshError: null, loading: false, refreshing: false };

  it("an empty cache read renders the cold-empty state, not nothing", () => {
    expect(narrativeRenderState({ ...cold, notGenerated: true })).toBe("cold-empty");
  });

  it("the cold-empty state yields to loading, a load error, a failed generate and real text", () => {
    expect(narrativeRenderState({ ...cold, notGenerated: true, loading: true })).toBe("loading");
    expect(narrativeRenderState({ ...cold, notGenerated: true, refreshing: true })).toBe("loading");
    expect(narrativeRenderState({ ...cold, notGenerated: true, error: "load failed" })).toBe("hidden");
    expect(narrativeRenderState({ ...cold, notGenerated: true, refreshError: "generate failed" })).toBe("cold-failure");
    expect(narrativeRenderState({ ...cold, notGenerated: true, text: "Prose." })).toBe("narrative");
  });

  it("the load effect records the miss and makes no generate call", () => {
    const effect = sliceBetween(NARRATIVE, "  useEffect(() => {", "  const renderState =");
    expect(effect).toContain("fetch(`/api/analysis/narrative?scope=${scope}&surface=${surfaceKey}`)");
    expect(effect).toContain("setNotGenerated(true)");
    expect(effect).not.toContain("handleRefresh");
    expect(effect).not.toContain("apiFetch");
    expect(effect).not.toContain("POST");
    // The effect no longer depends on the generate callback at all.
    expect(effect).toContain("}, [scope, surfaceKey]);");
  });

  it("the only POST in the file lives in the click handler", () => {
    expect(NARRATIVE.match(/method: "POST"/g)).toHaveLength(1);
    const handler = sliceBetween(NARRATIVE, "const handleRefresh = useCallback(", "  useEffect(() => {");
    expect(handler).toContain('method: "POST"');
    // Every call site is an onClick.
    const calls = [...NARRATIVE.matchAll(/handleRefresh\("(?:banner|footer)"\)/g)];
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(NARRATIVE.slice(c.index! - 20, c.index!)).toContain("onClick={() => ");
    }
    expect(NARRATIVE).not.toMatch(/void handleRefresh\(/);
  });

  it("a scope change clears the previous scope's text, so a cold scope shows its own empty state", () => {
    const effect = sliceBetween(NARRATIVE, "  useEffect(() => {", "  const renderState =");
    const beforeFetch = effect.slice(0, anchorIndex(effect, "fetch("));
    expect(beforeFetch).toContain("setText(null)");
    expect(beforeFetch).toContain("setNotGenerated(false)");
  });

  it("the cold-empty state says nothing was generated and offers one Generate button that names its cost", () => {
    const branch = sliceBetween(NARRATIVE, 'if (renderState === "cold-empty") {', 'if (renderState === "cold-failure") {');
    expect(branch).toContain("{NARRATIVE_COLD_CACHE_COPY}");
    expect(branch).toContain("{NARRATIVE_GENERATE_LABEL}");
    expect(branch).toContain('onClick={() => handleRefresh("footer")}');
    expect(branch).toContain("disabled={refreshing}");
    expect(branch).toContain("title={GENERATE_TITLE}");
    expect(branch).toContain("className={`${TOUCH_HIT_AREA} ");
    expect(NARRATIVE_COLD_CACHE_COPY).toMatch(/no ai narrative generated yet/i);
    expect(NARRATIVE_GENERATE_LABEL).toBe("Generate narrative");
    expect(sliceBetween(NARRATIVE, "const GENERATE_TITLE =", ";")).toMatch(/one AI call/);
  });
});

// Same spend policy on the Macro card (the sibling row
// analysis-macro-themes--auto-generates-on-mount-then-bare-rate-limited-token
// left this half as a decision; its recommendation is the same explicit button).
describe("MacroOverlayCard: a cold cache never spends an AI call without a click", () => {
  it("recognises the empty cache read", () => {
    expect(isMacroColdCache({ success: true, notGenerated: true })).toBe(true);
    expect(isMacroColdCache({ success: true })).toBe(false);
    expect(isMacroColdCache({ success: false, notGenerated: true })).toBe(false);
    expect(isMacroColdCache(null)).toBe(false);
  });

  it("the load effect reads the cache and stops", () => {
    const effect = sliceBetween(CARD, "  useEffect(() => {\n    let cancelled = false;", "  }, [scope, retryNonce]);");
    expect(effect).toContain("/api/analysis/macro-themes?scope=");
    expect(effect).toContain("if (!cancelled) setData(j);");
    expect(effect).not.toContain("generate(");
    expect(effect).not.toContain("handleGenerate");
    expect(effect).not.toContain("apiFetch");
    expect(effect).not.toContain("POST");
  });

  it("the only POST lives in the click handler, and every call of it is an onClick", () => {
    expect(CARD.match(/method: "POST"/g)).toHaveLength(1);
    const handler = sliceBetween(CARD, "const handleGenerate = async () => {", "  useEffect(() => {\n    let cancelled = false;");
    expect(handler).toContain('method: "POST"');
    const uses = [...CARD.matchAll(/handleGenerate(?! = )/g)];
    expect(uses).toHaveLength(2);
    for (const u of uses) {
      const lineStart = CARD.lastIndexOf("\n", u.index!);
      expect(CARD.slice(lineStart, u.index!)).toContain("onClick={");
    }
  });

  it("the cold state names what is missing and offers one Generate button that names its cost", () => {
    const box = sliceBetween(CARD, "{!loading && isMacroColdCache(data) && (", "{!loading && data?.underThreshold && (");
    expect(box).toContain("{MACRO_COLD_CACHE_COPY}");
    expect(box).toContain("MACRO_GENERATE_LABEL");
    expect(box).toContain("onClick={handleGenerate}");
    expect(box).toContain("disabled={generating}");
    expect(box).toContain("title={MACRO_GENERATE_TITLE}");
    expect(MACRO_COLD_CACHE_COPY).toMatch(/no themes generated yet/i);
    expect(MACRO_GENERATE_LABEL).toBe("Generate this week's themes");
    expect(sliceBetween(CARD, "export const MACRO_GENERATE_TITLE =", ";")).toMatch(/one AI call/);
  });

  it("Try again repeats a failed generate and re-reads the cache after a failed load", () => {
    const box = CARD.slice(anchorIndex(CARD, "!data.success && !data.underThreshold"));
    expect(box).toContain("data.generateFailed ? handleGenerate() : setRetryNonce((n) => n + 1)");
  });
});

// QA finding analysis-macro-themes--identical-top-exposure-across-themes-money-market-leads-regression-1 (label half)
describe("Macro card names whose list the top holdings are", () => {
  it("labels the list with the theme's factor", () => {
    expect(topContributorsLabel("interest_rate_sensitive")).toBe("top Rate-sensitive holdings");
    expect(topContributorsLabel("ai_exposure")).toBe("top AI holdings");
    expect(topContributorsLabel("not_a_known_factor")).toBe("top not_a_known_factor holdings");
  });

  it("the card prints that label, not a bare 'top:'", () => {
    expect(CARD).toContain("{topContributorsLabel(t.factor_label)}: {t.top_contributors.map((c) => c.symbol).join(\", \")}");
    expect(CARD).not.toMatch(/>\s*top: \{/);
  });
});

// QA finding analysis-macro-sources--receipt-drawer-same-10-articles-for-every-theme
describe("Macro sources drawer is the week's inputs, not one theme's receipt", () => {
  it("is headed as the week's inputs and says the list is shared by every theme", () => {
    expect(MACRO_INPUTS_HEADING).toBe("Inputs to this week's macro read");
    expect(MACRO_INPUTS_NOTE).toMatch(/same list sits behind every theme/);
    expect(MACRO_INPUTS_NOTE).toMatch(/up to 10 of each/);
    expect(DRAWER).toContain("<h2 className=\"text-base font-medium text-ink\">{MACRO_INPUTS_HEADING}</h2>");
    expect(DRAWER).toContain("aria-label={MACRO_INPUTS_HEADING}");
  });

  it("no longer takes or prints a theme", () => {
    expect(DRAWER).not.toMatch(/theme\.(name|summary)/);
    expect(DRAWER).not.toMatch(/^\s*theme,$/m);
    expect(DRAWER).not.toContain("theme: Theme");
    const mount = sliceBetween(CARD, "<MacroThemeReceiptDrawer", "/>");
    expect(mount).not.toContain("theme=");
    expect(mount).toContain("sourceSummary={data.sourceSummary}");
  });

  it("the button on each theme does not promise that theme's sources", () => {
    expect(CARD).toContain("This week's inputs →");
    expect(CARD).not.toContain("View sources →");
  });
});
