import { describe, it, expect } from "vitest";
import { getQuickActions } from "@/lib/chat/quick-actions";

describe("getQuickActions", () => {
  it("returns global actions for overview", () => {
    const actions = getQuickActions("/dashboard");
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions.some((a) => a.label.toLowerCase().includes("portfolio"))).toBe(true);
  });

  it("returns security-specific actions", () => {
    const actions = getQuickActions("/dashboard/security/42", { symbol: "AAPL" });
    expect(actions.some((a) => a.label.includes("AAPL"))).toBe(true);
  });

  it("returns calendar-specific actions", () => {
    const actions = getQuickActions("/dashboard/calendar");
    expect(actions.some((a) => a.prompt.toLowerCase().includes("week"))).toBe(true);
  });

  it("returns analysis-specific actions", () => {
    const actions = getQuickActions("/dashboard/analysis");
    expect(actions.some((a) => a.prompt.toLowerCase().includes("risk"))).toBe(true);
  });

  it("always includes some global actions", () => {
    const actions = getQuickActions("/dashboard/security/42", { symbol: "AAPL" });
    expect(actions.length).toBeGreaterThanOrEqual(3);
  });
});
