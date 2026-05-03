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
    expect(extractMaturityDate("T-Bill due 10/23")).toBeNull();
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

  // Real Vanguard PDF / IBKR / canonical CSV fixtures from production DB (2026-05-03).
  describe("production fixtures — bare DUE format", () => {
    it("Vanguard T-Bill: 'U S TREASURY BILL DUE 04/14/26 DTD 12/16/25'", () => {
      expect(extractMaturityDate("U S TREASURY BILL DUE 04/14/26 DTD 12/16/25")).toBe(
        "2026-04-14",
      );
    });

    it("Vanguard T-Note with coupon: 'U S TREASURY NOTE CPN 4.125% DUE 11/15/32 DTD 11/15/22 FC 05/15/23'", () => {
      expect(
        extractMaturityDate(
          "U S TREASURY NOTE CPN 4.125% DUE 11/15/32 DTD 11/15/22 FC 05/15/23",
        ),
      ).toBe("2032-11-15");
    });

    it("Vanguard T-Bond with multiple date tokens picks DUE: 'U S TREASURY BOND CPN 3.000% DUE 02/15/48 DTD 02/15/18 FC 08/15/18'", () => {
      expect(
        extractMaturityDate(
          "U S TREASURY BOND CPN 3.000% DUE 02/15/48 DTD 02/15/18 FC 08/15/18 91282CMM -",
        ),
      ).toBe("2048-02-15");
    });

    it("trailing 'U S TREASURY BILL' duplicate suffix doesn't confuse: 'U S TREASURY BILL DUE 11/28/25 DTD 11/29/24 U S TREASURY BILL'", () => {
      expect(
        extractMaturityDate(
          "U S TREASURY BILL DUE 11/28/25 DTD 11/29/24 U S TREASURY BILL",
        ),
      ).toBe("2025-11-28");
    });
  });

  describe("production fixtures — MTD ISO format", () => {
    it("IBKR T-Bill: 'U S TREASURY BILL CPN 0.00000  MTD 2024-08-20 DTD 2024-04-23'", () => {
      // Note the double-space between '0.00000' and 'MTD' — \s+ handles it.
      expect(
        extractMaturityDate(
          "U S TREASURY BILL CPN 0.00000  MTD 2024-08-20 DTD 2024-04-23",
        ),
      ).toBe("2024-08-20");
    });
  });

  describe("production fixtures — two-date treasury fallback", () => {
    it("T-Note no DUE keyword: 'U S TREASURY NOTE 4.625 02/15/35 02/15/25'", () => {
      expect(extractMaturityDate("U S TREASURY NOTE 4.625 02/15/35 02/15/25")).toBe(
        "2035-02-15",
      );
    });

    it("T-Bond no DUE keyword: 'U S TREASURY BOND 4.75 05/15/55 05/15/25'", () => {
      expect(extractMaturityDate("U S TREASURY BOND 4.75 05/15/55 05/15/25")).toBe(
        "2055-05-15",
      );
    });

    it("T-Bond integer coupon: 'U S TREASURY BOND 3 02/15/48 02/15/18'", () => {
      expect(extractMaturityDate("U S TREASURY BOND 3 02/15/48 02/15/18")).toBe(
        "2048-02-15",
      );
    });

    it("requires TREASURY anchor — equity name with two date-like tokens returns null", () => {
      expect(
        extractMaturityDate("Acme Corp ex-div 12/31/25 announce 11/15/25"),
      ).toBeNull();
    });
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
