import { describe, it, expect } from "vitest";
import { extractMaturityDate, isBondMatured } from "@/lib/bonds";

describe("extractMaturityDate", () => {
  it("extracts 2-digit year from T-Bill name", () => {
    expect(extractMaturityDate("T-Bill (due 10/23/25)")).toBe("2025-10-23");
  });

  it("extracts 2-digit year from T-Note name", () => {
    expect(extractMaturityDate("T-Note 4.375% (due 05/15/34)")).toBe("2034-05-15");
  });

  it("extracts 4-digit year", () => {
    expect(extractMaturityDate("T-Bond 3.5% (due 02/15/2053)")).toBe("2053-02-15");
  });

  it("handles case insensitivity", () => {
    expect(extractMaturityDate("T-BILL (DUE 10/23/25)")).toBe("2025-10-23");
    expect(extractMaturityDate("t-bill (Due 10/23/25)")).toBe("2025-10-23");
  });

  it("handles 20th century years (80-99)", () => {
    expect(extractMaturityDate("Bond (due 01/15/99)")).toBe("1999-01-15");
    expect(extractMaturityDate("Bond (due 06/30/80)")).toBe("1980-06-30");
  });

  it("handles 21st century years (00-79)", () => {
    expect(extractMaturityDate("Bond (due 01/15/00)")).toBe("2000-01-15");
    expect(extractMaturityDate("Bond (due 12/31/79)")).toBe("2079-12-31");
  });

  it("returns null for non-bond names", () => {
    expect(extractMaturityDate("Apple Inc.")).toBeNull();
    expect(extractMaturityDate("Vanguard Total Stock Market")).toBeNull();
  });

  it("returns null for incomplete patterns", () => {
    expect(extractMaturityDate("T-Bill (due 10/23)")).toBeNull();
    expect(extractMaturityDate("T-Bill due 10/23/25")).toBeNull();
  });

  it("returns null for invalid dates", () => {
    expect(extractMaturityDate("Bond (due 13/23/25)")).toBeNull(); // month > 12
    expect(extractMaturityDate("Bond (due 00/23/25)")).toBeNull(); // month 0
    expect(extractMaturityDate("Bond (due 10/00/25)")).toBeNull(); // day 0
    expect(extractMaturityDate("Bond (due 10/32/25)")).toBeNull(); // day > 31
  });

  it("extracts from CUSIP-style names", () => {
    expect(extractMaturityDate("912797QG5 T-Bill (due 10/23/25)")).toBe("2025-10-23");
  });
});

describe("isBondMatured", () => {
  it("returns true when maturity date is before as-of date", () => {
    expect(isBondMatured("2025-10-23", "2026-03-09")).toBe(true);
  });

  it("returns false when maturity date is after as-of date", () => {
    expect(isBondMatured("2026-05-15", "2026-03-09")).toBe(false);
  });

  it("returns false when maturity date equals as-of date", () => {
    // Same day — not matured yet (matures at end of day)
    expect(isBondMatured("2026-03-09", "2026-03-09")).toBe(false);
  });

  it("returns false when maturity date is null", () => {
    expect(isBondMatured(null, "2026-03-09")).toBe(false);
  });
});
