import { describe, it, expect } from "vitest";
import { resolveFilteredCategoryLabel } from "@/app/dashboard/components/ResearchFeedsView";

describe("resolveFilteredCategoryLabel", () => {
  it("maps every known excluded_category enum value to its human phrase", () => {
    expect(resolveFilteredCategoryLabel("receipt")).toBe("Payment receipts");
    expect(resolveFilteredCategoryLabel("welcome")).toBe("Welcome / onboarding");
    expect(resolveFilteredCategoryLabel("gift")).toBe("Gift subscriptions");
    expect(resolveFilteredCategoryLabel("admin")).toBe("Admin mail");
    expect(resolveFilteredCategoryLabel("off_topic")).toBe("Off-topic (Claude judgment)");
    // Regression: this one used to fall through to the raw DB enum
    // ("ENRICHMENT_FAILED · 2" after CSS uppercase) instead of a phrase.
    expect(resolveFilteredCategoryLabel("enrichment_failed")).toBe("Enrichment failed");
  });

  it("humanizes an unmapped snake_case category instead of rendering it raw", () => {
    expect(resolveFilteredCategoryLabel("some_new_category")).toBe("Some new category");
    expect(resolveFilteredCategoryLabel("other")).toBe("Other");
    expect(resolveFilteredCategoryLabel("spam")).toBe("Spam");
  });
});
