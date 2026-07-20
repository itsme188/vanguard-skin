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
    const { markdown } = insertCrossFilePointers(ai, [essay()], ["NVDA"]);
    const lines = markdown.split("\n");
    const i = lines.indexOf("## NVDA (NVIDIA Corp)");
    expect(lines[i + 1]).toBe(
      '📄 *Deep dive today: **MBI Deep Dives** — "NVDA\'s networking moat" (see Research Desk below)*',
    );
  });

  it("matches across issuer families (GOOGL essay → GOOG section)", () => {
    const md = "## GOOG (Alphabet)\nText.";
    const { markdown } = insertCrossFilePointers(
      md,
      [essay({ mentioned_symbols: '["GOOGL"]', subject: "Alphabet piece" })],
      ["GOOG"],
    );
    expect(markdown).toContain("Deep dive today");
  });

  it("no-ops when the essay's symbol is not held/watchlisted or has no section", () => {
    expect(insertCrossFilePointers(ai, [essay({ mentioned_symbols: '["XYZ"]' })], ["NVDA"]).markdown).toBe(ai);
    expect(insertCrossFilePointers(ai, [essay({ mentioned_symbols: '["AMD"]' })], ["AMD"]).markdown).toBe(ai);
  });

  it("returns unfiled essays when no matching ## section exists", () => {
    const md = "## The Session\n\nX.\n\n## Also covered\n\nY.";
    const essay = {
      source_name: "Stratechery",
      subject: "Netflix and the Anthology Era",
      summary: null,
      mentioned_symbols: JSON.stringify(["NFLX"]),
      key_themes: null,
      source_url: null,
      website_url: null,
    };
    const { markdown, unfiled } = insertCrossFilePointers(md, [essay], ["NFLX"]);
    expect(markdown).toBe(md); // nothing filed, markdown untouched
    expect(unfiled).toEqual([
      { source_name: "Stratechery", subject: "Netflix and the Anthology Era", symbols: ["NFLX"] },
    ]);
  });

  it("a filed essay is NOT in unfiled; an irrelevant essay is neither filed nor unfiled", () => {
    const md = "## NFLX (Netflix)\n\nCovered.\n\n## Also covered\n\nY.";
    const filed = {
      source_name: "Stratechery", subject: "T1", summary: null,
      mentioned_symbols: JSON.stringify(["NFLX"]), key_themes: null,
      source_url: null, website_url: null,
    };
    const irrelevant = {
      source_name: "Odd Lots", subject: "T2", summary: null,
      mentioned_symbols: JSON.stringify(["ZZZZ"]), key_themes: null,
      source_url: null, website_url: null,
    };
    const { markdown, unfiled } = insertCrossFilePointers(md, [filed, irrelevant], ["NFLX"]);
    expect(markdown).toContain("Deep dive today");
    expect(unfiled).toEqual([]);
  });
});
