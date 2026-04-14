import { describe, it, expect } from "vitest";
import { getPageContext } from "@/lib/chat/page-context";

describe("getPageContext", () => {
  it("returns generic context for overview", () => {
    expect(getPageContext("/dashboard")).toBe("User is on the Overview page.");
  });

  it("returns security context with symbol", () => {
    const ctx = getPageContext("/dashboard/security/42", {
      symbol: "AAPL", name: "Apple Inc.", type: "Stock",
    });
    expect(ctx).toContain("AAPL");
    expect(ctx).toContain("Apple Inc.");
    expect(ctx).toContain("Stock");
  });

  it("returns calendar context with weekOf", () => {
    const ctx = getPageContext("/dashboard/calendar", { weekOf: "2026-04-14" });
    expect(ctx).toContain("Calendar");
    expect(ctx).toContain("2026-04-14");
  });

  it("returns research context", () => {
    expect(getPageContext("/dashboard/research")).toContain("Research");
  });

  it("returns analysis context with scope", () => {
    const ctx = getPageContext("/dashboard/analysis", { accountScope: "IBKR" });
    expect(ctx).toContain("Analysis");
    expect(ctx).toContain("IBKR");
  });

  it("returns generic context for import", () => {
    expect(getPageContext("/dashboard/import")).toBe("User is on the Import page.");
  });

  it("handles unknown paths gracefully", () => {
    expect(getPageContext("/dashboard/something-new")).toBe("User is browsing the dashboard.");
  });
});
