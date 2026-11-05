import { describe, it, expect } from "vitest";
import { validateDocForEvent } from "@/lib/print-watch/gate";

const DOC = "Zebra Corporation reports third quarter 2026 results. Revenue was $1.0 billion.";
const OTHER = "Quokka Corporation reports third quarter 2026 results. Revenue was $1.0 billion.";
const ctx = (issuerName: string | null) => ({ symbol: "ZZZ", issuerName, eventDate: "2026-10-20" });

describe("issuer needle ignores a vendor share-class suffix", () => {
  it("passes a document naming the company when the stored name carries a dashed suffix", () => {
    expect(validateDocForEvent(DOC, ctx("Zebra Corp - Ordinary Shares - Class A")).ok).toBe(true);
  });

  it("still fails a document naming neither the ticker nor the company", () => {
    expect(validateDocForEvent(OTHER, ctx("Zebra Corp - Ordinary Shares - Class A"))).toEqual({
      ok: false,
      reason: "issuer not named (ZZZ)",
    });
  });

  it("yields no needle for a name that is only suffix words; the ticker alone can match", () => {
    const name = "Holdings Inc - Class B";
    expect(validateDocForEvent("Holdings reports third quarter 2026 results.", ctx(name)).ok).toBe(false);
    expect(validateDocForEvent("ZZZ reports third quarter 2026 results.", ctx(name)).ok).toBe(true);
  });

  it("handles ADR and Class B variants, with or without the dash", () => {
    for (const name of [
      "Zebra Corp - ADR",
      "Zebra Corp - Class B",
      "Zebra Corp Class B",
      "Zebra Corp Ordinary Shares",
      "Zebra Corp ADS",
      "Zebra Corp Common Stock",
    ]) {
      expect(validateDocForEvent(DOC, ctx(name)).ok, name).toBe(true);
    }
  });
});
