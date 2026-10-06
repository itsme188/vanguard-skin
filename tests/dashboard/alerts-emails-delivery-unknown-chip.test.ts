/**
 * The Alerts "Emails" tab must flag a sent email whose delivery the provider
 * never confirmed (getSentEarningsEmails -> delivery_unknown = 1), matching
 * the chip on Security Detail. Source-pin test (no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Alerts Emails tab — delivery_unknown chip", () => {
  const src = readFileSync("app/dashboard/alerts/page.tsx", "utf8");
  const sec = readFileSync("app/dashboard/components/SecurityEarningsEmails.tsx", "utf8");

  it("renders the delivery-unconfirmed chip off the query flag", () => {
    expect(src).toMatch(/e\.delivery_unknown === 1/);
    expect(src).toContain("delivery unconfirmed");
  });

  it("uses the same wording as Security Detail and no state literal", () => {
    expect(sec).toContain("delivery unconfirmed");
    expect(src).not.toMatch(/["']delivery_unknown["']/);
  });
});
