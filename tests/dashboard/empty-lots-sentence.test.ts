/**
 * QA finding: a short position with no tax lots said its shares came from a
 * snapshot "with no matching purchase". A short is opened by a short sale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { emptyLotsCounterpartNoun } from "@/lib/ui/empty-lots-sentence";

describe("emptyLotsCounterpartNoun", () => {
  it("says short sale when every gap is short", () => {
    expect(emptyLotsCounterpartNoun([-100])).toBe("short sale");
    expect(emptyLotsCounterpartNoun([-100, -50])).toBe("short sale");
  });
  it("says purchase when every gap is long", () => {
    expect(emptyLotsCounterpartNoun([100, 50])).toBe("purchase");
  });
  it("says purchase for a mix", () => {
    expect(emptyLotsCounterpartNoun([-100, 100])).toBe("purchase");
  });
  it("says purchase for no gap information", () => {
    expect(emptyLotsCounterpartNoun([])).toBe("purchase");
  });
  it("does not treat zero as short", () => {
    expect(emptyLotsCounterpartNoun([0])).toBe("purchase");
    expect(emptyLotsCounterpartNoun([-100, 0])).toBe("purchase");
  });
});

describe("security hub empty-lots sentence (source pin)", () => {
  const SRC = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
  it("uses the helper and no longer hardcodes the purchase wording", () => {
    const at = anchorIndex(SRC, "No open tax lots on record for this security");
    const region = SRC.slice(at, anchorIndex(SRC, ") : (", at));
    expect(region).toContain("emptyLotsCounterpartNoun(");
    expect(region).toContain("no matching {");
    expect(region).not.toContain("no matching purchase");
    expect(SRC).toContain('from "@/lib/ui/empty-lots-sentence"');
  });
});
