import { describe, it, expect } from "vitest";
import { getQuickActions } from "@/lib/chat/quick-actions";

describe("getQuickActions", () => {
  it("returns global actions for overview", () => {
    const actions = getQuickActions("/dashboard");
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions.some((a) => a.label.toLowerCase().includes("portfolio"))).toBe(true);
  });

  it("returns security-page actions without needing the symbol (B18)", () => {
    const actions = getQuickActions("/dashboard/security/42");
    expect(actions.slice(0, 3)).toEqual([
      { label: "Outlook", prompt: "What's the outlook for the security on this page?" },
      { label: "My position", prompt: "Show my position in the security on this page." },
      { label: "News and earnings", prompt: "Any recent news or earnings for the security on this page?" },
    ]);
  });

  it("the movers chip asks for today's moves in dollars", () => {
    const movers = getQuickActions("/dashboard").find((a) => a.label === "Biggest movers");
    expect(movers?.prompt).toBe("What moved my portfolio today, in dollars?");
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
    const actions = getQuickActions("/dashboard/security/42");
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions.some((a) => a.label === "Portfolio today")).toBe(true);
  });
});
