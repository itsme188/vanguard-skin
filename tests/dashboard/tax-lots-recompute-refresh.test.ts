import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("tax lots recompute refresh wiring", () => {
  const button = readFileSync("app/dashboard/components/RecomputeButton.tsx", "utf8");
  const card = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");
  const page = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");

  it("emits a completion signal after a confirmed recompute", () => {
    expect(button).toContain("completionEventName");
    expect(button).toContain("window.dispatchEvent(new CustomEvent(completionEventName))");
  });

  it("renders recompute preview figures through privacy components", () => {
    expect(button).toMatch(/import \{[^}]*Count[^}]*Money[^}]*\} from "@\/lib\/privacy\/components"/);
    expect(button).toContain("<Money value={year.realizedGainBefore}");
    // Year rows are on the sale-year basis; open lots sit outside any year.
    expect(button).toContain("<Count value={year.lotSalesAdded}");
    expect(button).toContain("<Count value={year.lotSalesRemoved}");
    expect(button).toContain("<Count value={summary.openLots.before}");
    expect(button).toContain("<Count value={summary.openLots.after}");
    expect(button).not.toContain("year.lotsOpened");
    expect(button).not.toContain("year.lotsClosed");
  });

  it("passes the signal to TaxReportCard and refetches when it fires", () => {
    expect(page).toContain('completionEventName="tax-lots:recomputed"');
    expect(page).toContain('refreshEventName="tax-lots:recomputed"');
    expect(card).toContain("window.addEventListener(refreshEventName");
    expect(card).toContain("setRefreshKey((key) => key + 1)");
    expect(card).toContain("[year, accountParam, refreshKey]");
  });
});
