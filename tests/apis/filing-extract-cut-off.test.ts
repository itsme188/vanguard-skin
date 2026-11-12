/**
 * A filing-section summary cut off at the output cap is never cached
 * (2026-11-12): the reply is plain text, so a truncated one would parse and
 * be stored as if it were complete. EDGAR and the model are stubbed; the
 * figures are synthetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
}));
vi.mock("@/lib/apis/edgar", async (orig) => ({
  ...(await orig<typeof import("@/lib/apis/edgar")>()),
  getLatestAnnualOrQuarterlyFiling: vi.fn(async () => ({
    cik: "0000000001",
    accessionNumber: "0000000001-26-000001",
    filingDate: "2026-02-01",
    filingUrl: "https://www.sec.gov/example",
  })),
  fetchFilingPrimaryDoc: vi.fn(async () => "<html>doc</html>"),
  extractItemSection: vi.fn(() => "Item 1A. Risk Factors. Demand may soften."),
}));

import { getFilingSection } from "@/lib/apis/filing-extract";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  generateTextMock.mockReset();
});

const PARAMS = { symbol: "XMPL", filing_type: "10-K" as const, section: "risk_factors" as const };

describe("getFilingSection and a cut-off reply", () => {
  it("returns an error and caches nothing when the reply stopped at the cap", async () => {
    generateTextMock.mockResolvedValue({ text: "SUMMARY\nDemand may", finishReason: "length" });
    const out = await getFilingSection(db, PARAMS);
    expect(out).toMatchObject({ error: expect.stringMatching(/cut off/) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM filing_sections").get()).toEqual({ n: 0 });
  });

  it("a complete reply is stored as before", async () => {
    generateTextMock.mockResolvedValue({ text: "SUMMARY\nDemand may soften.\nKEY POINTS\n- demand", finishReason: "stop" });
    const out = await getFilingSection(db, PARAMS);
    expect(out).not.toHaveProperty("error");
    expect(db.prepare("SELECT COUNT(*) AS n FROM filing_sections").get()).toEqual({ n: 1 });
  });
});
