/**
 * A pending level's Review link on the security page opens the alerts inbox.
 * The inbox takes a `?symbol=` scope (app/dashboard/alerts/page.tsx,
 * parseSymbolScope), but the link never passed one, so a reader landed on the
 * whole review queue and had to find the symbol by hand
 * (qa:dashboard-security-1737-intc-levelspanel-pending-review-row-review-link-a-pending-level-s-review-link-opens-the-whole-316-item-queue).
 * Both row variants now link to the review view scoped to this security's
 * symbol. Source-pin test (no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");
const panel = src.slice(anchorIndex(src, "export function LevelsPanel("));

describe("LevelsPanel pending-review Review link", () => {
  it("every review link carries the symbol scope", () => {
    const scoped =
      panel.split("href={`/dashboard/alerts?view=review&symbol=${encodeURIComponent(symbol)}`}").length - 1;
    expect(scoped).toBe(2);
  });

  it("no review link opens the unscoped queue", () => {
    expect(panel).not.toContain('href="/dashboard/alerts?view=review"');
  });
});
