import { describe, it, expect } from "vitest";
import {
  resolveAnalysisView,
  type ResolvedAnalysisView,
} from "@/lib/analysis/view-param";

describe("resolveAnalysisView", () => {
  // ── Canonical ?view= values ─────────────────────────────────────
  it("defaults to workspace when no params present", () => {
    expect(resolveAnalysisView({})).toEqual<ResolvedAnalysisView>({
      view: "workspace",
      mode: "classification",
    });
  });

  it("resolves explicit view=workspace", () => {
    expect(resolveAnalysisView({ view: "workspace" }).view).toBe("workspace");
  });

  it("resolves view=diagnostics with default classification mode", () => {
    expect(resolveAnalysisView({ view: "diagnostics" })).toEqual({
      view: "diagnostics",
      mode: "classification",
    });
  });

  it("resolves view=diagnostics with mode=factors", () => {
    expect(resolveAnalysisView({ view: "diagnostics", mode: "factors" })).toEqual({
      view: "diagnostics",
      mode: "factors",
    });
  });

  it("resolves view=performance", () => {
    expect(resolveAnalysisView({ view: "performance" }).view).toBe("performance");
  });

  it("resolves view=trade-reviews", () => {
    expect(resolveAnalysisView({ view: "trade-reviews" }).view).toBe("trade-reviews");
  });

  it("resolves the defense sub-view", () => {
    expect(resolveAnalysisView({ view: "defense" })).toEqual({ view: "defense", mode: "classification" });
  });

  // ── Legacy aliases (CLAUDE.md documents ?mode=factors as kept) ──
  it("aliases legacy ?mode=factors (no view) to diagnostics/factors", () => {
    expect(resolveAnalysisView({ mode: "factors" })).toEqual({
      view: "diagnostics",
      mode: "factors",
    });
  });

  it("aliases legacy ?mode=classification (no view) to diagnostics/classification", () => {
    expect(resolveAnalysisView({ mode: "classification" })).toEqual({
      view: "diagnostics",
      mode: "classification",
    });
  });

  it("aliases legacy ?view=reviews (old Research param) to trade-reviews", () => {
    expect(resolveAnalysisView({ view: "reviews" }).view).toBe("trade-reviews");
  });

  // ── Precedence + garbage handling ───────────────────────────────
  it("explicit view=workspace wins over a stray mode param", () => {
    expect(resolveAnalysisView({ view: "workspace", mode: "factors" }).view).toBe(
      "workspace"
    );
  });

  it("explicit view=performance ignores a stray mode param", () => {
    expect(resolveAnalysisView({ view: "performance", mode: "factors" }).view).toBe(
      "performance"
    );
  });

  it("unknown view falls back to the mode alias when mode is valid", () => {
    expect(resolveAnalysisView({ view: "bogus", mode: "factors" })).toEqual({
      view: "diagnostics",
      mode: "factors",
    });
  });

  it("unknown view with no mode falls back to workspace", () => {
    expect(resolveAnalysisView({ view: "bogus" }).view).toBe("workspace");
  });

  it("unknown mode inside diagnostics falls back to classification", () => {
    expect(resolveAnalysisView({ view: "diagnostics", mode: "bogus" }).mode).toBe(
      "classification"
    );
  });
});
