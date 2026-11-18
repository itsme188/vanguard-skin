import { describe, it, expect } from "vitest";
import { extractGuidanceMetrics, verifyCallout } from "@/lib/print-watch/callouts";

const guidance = extractGuidanceMetrics(["Revenue guide commentary.", "Gross margin commentary.", "Operating margin commentary.", "Subscription growth commentary."]);

function run(label: string, value_text: string, snippet: string) {
  return verifyCallout({
    proposal: { label, value_text, snippet, doc_id: 1 },
    text: `Zeta Corp outlook. ${snippet} Thank you.`,
    guidanceMetrics: guidance,
    sheetLineKeys: [],
  });
}

describe("verifyCallout refuses a percent that is only a tolerance band", () => {
  const BAND = /tolerance band/;
  const snip = (lead: string) => `Revenue is expected to be $130.0 billion, ${lead} 3% for the quarter`;
  for (const lead of ["plus or minus", "plus/minus", "+/-", "+/- ", "±", "± ", "give or take"]) {
    it(`refuses 3% after "${lead}"`, () => {
      const r = run("Revenue guide", "3%", snip(lead));
      expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(BAND) });
    });
  }
  it("refuses a percent written with the sign glued on (+/-3%)", () => {
    expect(run("Revenue guide", "3%", "Revenue is expected to be $130.0 billion, +/-3% for the quarter").ok).toBe(false);
  });
  it("passes the real guided figure when a band follows it", () => {
    expect(run("Gross margin", "72.0%", "Gross margin is expected to be 72.0%, plus or minus 50 basis points").ok).toBe(true);
    expect(run("Operating margin", "35%", "Operating margin of 35%, plus or minus 2% for the quarter").ok).toBe(true);
  });
  it("refuses the band figure when a real figure sits beside it", () => {
    expect(run("Operating margin", "2%", "Operating margin of 35%, plus or minus 2% for the quarter")).toMatchObject({ ok: false, reason: expect.stringMatching(BAND) });
  });
  it("passes when the same number is both standalone and a band", () => {
    expect(run("Subscription growth", "3%", "Subscription growth of 3%, plus or minus 3% for the quarter").ok).toBe(true);
  });
  it("leaves a plain percent alone", () => {
    expect(run("Subscription growth", "3%", "Subscription growth of 3% for the quarter").ok).toBe(true);
  });
});
