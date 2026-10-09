import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";
import { normalizeOptionExpiration } from "@/lib/compute/option-expiry";

// Legacy option rows store the expiration compact (YYYYMMDD). The security
// page printed the stored string, so one contract read "20261016 (7d)" while
// the next read "2026-10-16". Display only: every place the page prints an
// expiration goes through the shared normaliser.
const src = readFileSync(
  join(process.cwd(), "app/dashboard/security/[id]/page.tsx"),
  "utf8",
);

describe("security page prints an option expiration in the dashed form", () => {
  it("the normaliser rebuilds a compact date and leaves anything else alone", () => {
    expect(normalizeOptionExpiration("20261016")).toBe("2026-10-16");
    expect(normalizeOptionExpiration("2026-10-16")).toBe("2026-10-16");
    expect(normalizeOptionExpiration("not a date")).toBe("not a date");
  });

  it("the Expiration cell prints the normalised date", () => {
    const start = anchorIndex(src, '<OptionCell label="Expiration">');
    const cell = src.slice(start, anchorIndex(src, "</OptionCell>", start));
    expect(cell).toContain("{expirationShown}");
    expect(src).toMatch(
      /const expirationShown = security\.expiration_date\s*\? normalizeOptionExpiration\(security\.expiration_date\)\s*: null;/,
    );
    expect(cell).not.toMatch(/\{security\.expiration_date\}/);
    // The day count still reads the stored value (daysToExpiry normalises itself).
    expect(cell).toContain("daysToExpiry(security.expiration_date)");
  });

  it("no JSX on the page prints a stored expiration as-is", () => {
    expect(src).not.toMatch(/\{(security|o)\.expiration_date\}/);
    expect(src).not.toMatch(/\$\{security\.expiration_date\}/);
  });
});
