/**
 * Source-pin + unit tests for the 2026-10-05 overnight small-UI batch
 * (items 5-8).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { documentMatchesSearch } from "@/app/dashboard/components/research-documents-search";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const read = (p: string) => readFileSync(p, "utf8");

describe("armed-levels '(x% vs level)' contrast", () => {
  const src = read("app/dashboard/alerts/page.tsx");
  it("both guard-distance spans use text-ink-dim, not the 10px ink-faint", () => {
    const marker = "The scanner's guard distance";
    let from = 0;
    let seen = 0;
    for (;;) {
      const i = src.indexOf(marker, from); // loop ends on -1; seen===2 pins the count
      if (i === -1) break;
      const open = src.lastIndexOf("<span", i);
      expect(src.slice(open, i)).toContain("text-ink-dim");
      expect(src.slice(open, i)).not.toContain("text-ink-faint");
      seen++;
      from = i + 1;
    }
    expect(seen).toBe(2);
  });
});

describe("useResearchSync debounce stamp", () => {
  const src = read("lib/hooks/useResearchSync.ts");
  it("stamps only after a completed sync (early return on failure precedes setItem)", () => {
    const a = anchorIndex(src, "if (!(await researchSyncCompleted(res))) return;");
    const b = anchorIndex(src, "localStorage.setItem(SYNC_DEBOUNCE_KEY");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });
});

describe("documentMatchesSearch mentioned_symbols", () => {
  const doc = { title: "Note", mentioned_symbols: JSON.stringify(["NVDA", "AMD"]) };
  it("matches a visible symbol chip, case-insensitively", () => {
    expect(documentMatchesSearch(doc, "nvda")).toBe(true);
    expect(documentMatchesSearch(doc, "AM")).toBe(true);
  });
  it("does not match an absent symbol and tolerates bad JSON", () => {
    expect(documentMatchesSearch(doc, "TSLA")).toBe(false);
    expect(documentMatchesSearch({ title: "x", mentioned_symbols: "{bad" }, "tsla")).toBe(false);
    expect(documentMatchesSearch({ title: "x", mentioned_symbols: null }, "tsla")).toBe(false);
  });
});

describe("ImportFlow importable gate", () => {
  const src = read("app/dashboard/components/ImportFlow.tsx");
  it("ignores the security count when rows were excluded", () => {
    expect(src).toContain("onlySecuritiesLeftIsEmpty ? 0 : p.securityCount");
    expect(src).toContain("(r.skippedRows?.length ?? 0) > 0) > 0");
  });
});

describe("AI cards: unavailable state with manual retry", () => {
  const nb = read("app/dashboard/components/analysis/NarrativeBlock.tsx");
  const macro = read("app/dashboard/components/analysis/MacroOverlayCard.tsx");
  it("narrative shows the plain copy on 5xx / unreachable", () => {
    expect(nb).toContain("AI narrative unavailable right now.");
    expect(nb).toContain("setAiUnavailable(res.status >= 500)");
  });
  it("macro card shows the plain copy and a manual Try again, no auto-retry", () => {
    expect(macro).toContain("AI narrative unavailable right now.");
    expect(macro).toContain("setRetryNonce((n) => n + 1)");
    expect(macro).toContain("[scope, retryNonce]");
    expect((macro.match(/setRetryNonce/g) ?? []).length).toBe(2);
  });
});

describe("Giving ReconciliationStrip zero-amount two-step confirm", () => {
  const src = read("app/dashboard/components/giving/ReconciliationStrip.tsx");
  it("warns and needs a second click; no browser confirm()", () => {
    expect(src).toContain("armedZeroId");
    expect(src).toContain("fair market value");
    expect(src).toContain("zeroAmount && !armed");
    expect(src).not.toMatch(/\bconfirm\(/);
  });
});
