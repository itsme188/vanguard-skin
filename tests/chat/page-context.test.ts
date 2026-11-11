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

  it("names the Today page (the default landing)", () => {
    expect(getPageContext("/dashboard/today")).toBe("User is on the Today page.");
  });

  it("names the Tax Lots, Levels, Alerts and Notes pages", () => {
    expect(getPageContext("/dashboard/tax-lots")).toBe("User is on the Tax Lots page.");
    expect(getPageContext("/dashboard/levels/review")).toBe("User is on the Levels review page.");
    expect(getPageContext("/dashboard/levels/performance")).toBe("User is on the Levels performance page.");
    expect(getPageContext("/dashboard/alerts")).toBe("User is on the Alerts page.");
    expect(getPageContext("/dashboard/notes")).toBe("User is on the Notes page.");
  });

  it("names the earnings print page with its symbol and event date when given", () => {
    expect(
      getPageContext("/dashboard/print/77", { symbol: "ZZZT", eventDate: "2026-01-02" }),
    ).toBe("User is on the earnings print page for ZZZT (event date 2026-01-02).");
    expect(getPageContext("/dashboard/print/77/filings", { symbol: "ZZZT" })).toBe(
      "User is on the earnings print page for ZZZT.",
    );
    expect(getPageContext("/dashboard/print/77")).toBe("User is on an earnings print page.");
  });

  it("a security page with no server data gives the generic sentence", () => {
    expect(getPageContext("/dashboard/security/42")).toBe("User is viewing a Security Detail page.");
  });

  it("names the Charts, Chat, Reconciliation and account-linking pages", () => {
    expect(getPageContext("/dashboard/charts")).toBe("User is on the Charts page.");
    expect(getPageContext("/dashboard/chat")).toBe("User is on the full-page Chat.");
    expect(getPageContext("/dashboard/reconciliation")).toBe("User is on the Reconciliation page.");
    expect(getPageContext("/dashboard/plaid-link")).toBe("User is on the account-linking page.");
  });

  it("every page under app/dashboard has its own sentence (R4-5)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(process.cwd(), "app/dashboard");
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "components") walk(p);
        } else if (name === "page.tsx") {
          pages.push(relative(root, dir));
        }
      }
    };
    walk(root);
    expect(pages.length).toBeGreaterThan(15);
    const generic = pages
      .map((rel) => "/dashboard" + (rel ? "/" + rel.replace(/\[[^\]]+\]/g, "42") : ""))
      .filter((path) => getPageContext(path) === "User is browsing the dashboard.");
    expect(generic).toEqual([]);
  });
});
