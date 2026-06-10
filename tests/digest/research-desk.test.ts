import { describe, it, expect } from "vitest";
import {
  splitEssays,
  renderResearchDesk,
  insertCrossFilePointers,
} from "@/lib/digest/research-desk";

const essay = (over: Partial<Record<string, string | null>> = {}) => ({
  source_name: "MBI Deep Dives",
  subject: "NVDA's networking moat",
  summary: "Long-form argument about NVLink.",
  mentioned_symbols: '["NVDA"]',
  key_themes: '["networking","moats"]',
  source_url: "https://example.com/nvda",
  website_url: null,
  ...over,
});

describe("splitEssays", () => {
  it("routes by SOURCE_KINDS with unknown→essay default", () => {
    const articles = [
      { source_name: "Vital Knowledge" },
      { source_name: "MBI Deep Dives" },
      { source_name: "Brand New Source" },
    ];
    const { essays, commentary } = splitEssays(articles);
    expect(commentary.map((a) => a.source_name)).toEqual(["Vital Knowledge"]);
    expect(essays.map((a) => a.source_name)).toEqual(["MBI Deep Dives", "Brand New Source"]);
  });
});

describe("renderResearchDesk", () => {
  it("renders one entry per essay with link, summary, themes", () => {
    const md = renderResearchDesk([essay()]);
    expect(md).toContain("## Research Desk");
    expect(md).toContain("**MBI Deep Dives** — [NVDA's networking moat](https://example.com/nvda)");
    expect(md).toContain("Long-form argument about NVLink.");
    expect(md).toContain("*networking · moats*");
  });
  it("returns empty string for no essays", () => {
    expect(renderResearchDesk([])).toBe("");
  });
});

describe("insertCrossFilePointers", () => {
  const ai = [
    "## Overnight & Setup",
    "Macro text.",
    "## NVDA (NVIDIA Corp)",
    "Coverage text.",
    "## Also covered",
    "Tail.",
  ].join("\n");

  it("inserts a pointer line under the matching held-symbol section", () => {
    const out = insertCrossFilePointers(ai, [essay()], ["NVDA"]);
    const lines = out.split("\n");
    const i = lines.indexOf("## NVDA (NVIDIA Corp)");
    expect(lines[i + 1]).toBe(
      '📄 *Deep dive today: **MBI Deep Dives** — "NVDA\'s networking moat" (see Research Desk below)*',
    );
  });

  it("matches across issuer families (GOOGL essay → GOOG section)", () => {
    const md = "## GOOG (Alphabet)\nText.";
    const out = insertCrossFilePointers(
      md,
      [essay({ mentioned_symbols: '["GOOGL"]', subject: "Alphabet piece" })],
      ["GOOG"],
    );
    expect(out).toContain("Deep dive today");
  });

  it("no-ops when the essay's symbol is not held/watchlisted or has no section", () => {
    expect(insertCrossFilePointers(ai, [essay({ mentioned_symbols: '["XYZ"]' })], ["NVDA"])).toBe(ai);
    expect(insertCrossFilePointers(ai, [essay({ mentioned_symbols: '["AMD"]' })], ["AMD"])).toBe(ai);
  });
});
