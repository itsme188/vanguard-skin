import { describe, it, expect } from "vitest";
import { bucketByCompany, renderDigestByCompany } from "@/lib/digest/group-by-company";

interface ArticleLike {
  id: number;
  source_name: string;
  subject: string;
  summary: string | null;
  sentiment: string | null;
  mentioned_symbols: string | null;
  portfolio_relevance: string | null;
  key_themes: string | null;
  source_url: string | null;
  website_url: string | null;
}

function article(
  id: number,
  source: string,
  subject: string,
  symbols: string[] | null,
  extra: Partial<ArticleLike> = {},
): ArticleLike {
  return {
    id,
    source_name: source,
    subject,
    summary: extra.summary ?? null,
    sentiment: extra.sentiment ?? "neutral",
    mentioned_symbols: symbols === null ? null : JSON.stringify(symbols),
    portfolio_relevance: extra.portfolio_relevance ?? null,
    key_themes: extra.key_themes ?? null,
    source_url: extra.source_url ?? null,
    website_url: extra.website_url ?? null,
  };
}

describe("bucketByCompany", () => {
  it("buckets articles by symbol; multi-symbol articles fan out", () => {
    const articles = [
      article(1, "Vital", "NVDA + AMD note", ["NVDA", "AMD"]),
      article(2, "Eliant", "NVDA only", ["NVDA"]),
    ];
    const buckets = bucketByCompany(articles);
    expect(buckets.map((b) => b.symbol)).toEqual(["NVDA", "AMD"]);
    expect(buckets.find((b) => b.symbol === "NVDA")?.articles.length).toBe(2);
    expect(buckets.find((b) => b.symbol === "AMD")?.articles.length).toBe(1);
  });

  it("collects no-symbol articles into a trailing macro bucket", () => {
    const articles = [
      article(1, "Vital", "Macro note", null),
      article(2, "Eliant", "Tape note", []),
      article(3, "Helene", "AAPL", ["AAPL"]),
    ];
    const buckets = bucketByCompany(articles);
    expect(buckets[0].symbol).toBe("AAPL");
    expect(buckets[buckets.length - 1].symbol).toBe("(no symbol)");
    expect(buckets[buckets.length - 1].articles.length).toBe(2);
  });

  it("sorts buckets by article count desc, ties resolved alphabetically", () => {
    const articles = [
      article(1, "Vital", "AMD", ["AMD"]),
      article(2, "Vital", "NVDA 1", ["NVDA"]),
      article(3, "Eliant", "NVDA 2", ["NVDA"]),
      article(4, "Helene", "ZBRA", ["ZBRA"]),
    ];
    const buckets = bucketByCompany(articles);
    expect(buckets.map((b) => b.symbol)).toEqual(["NVDA", "AMD", "ZBRA"]);
  });

  it("normalizes symbols to uppercase + ignores blanks", () => {
    const articles = [
      article(1, "Vital", "mixed case", ["nvda", "  ", "AMD"]),
    ];
    const buckets = bucketByCompany(articles);
    expect(buckets.map((b) => b.symbol).sort()).toEqual(["AMD", "NVDA"]);
  });

  it("survives malformed JSON in mentioned_symbols", () => {
    const a: ArticleLike = {
      id: 99,
      source_name: "Vital",
      subject: "broken",
      summary: null,
      sentiment: "neutral",
      mentioned_symbols: "{not-json",
      portfolio_relevance: null,
      key_themes: null,
      source_url: null,
      website_url: null,
    };
    const buckets = bucketByCompany([a]);
    expect(buckets).toEqual([{ symbol: "(no symbol)", companyName: null, articles: [a] }]);
  });
});

describe("renderDigestByCompany", () => {
  it("renders a per-company markdown view with header + alerts block", () => {
    const articles = [
      article(1, "Vital", "NVDA short", ["NVDA"], {
        summary: "Mention 1",
        sentiment: "bullish",
      }),
      article(2, "Eliant", "NVDA long", ["NVDA"], {
        summary: "Mention 2",
        portfolio_relevance: "Held in IBKR.",
      }),
    ];
    const md = renderDigestByCompany(articles, "## Alerts block\n", "Friday");
    expect(md).toContain("# Morning Research Digest");
    expect(md).toContain("Friday");
    expect(md).toContain("## Alerts block");
    expect(md).toContain("## NVDA · 2 mentions");
    expect(md).toContain("**Vital** · *bullish*");
    expect(md).toContain("**Eliant** · *neutral*");
    expect(md).toContain("Held in IBKR.");
  });

  it("renders the macro bucket heading correctly", () => {
    const articles = [article(1, "Vital", "Macro", null, { summary: "macro note" })];
    const md = renderDigestByCompany(articles, "", "Friday");
    expect(md).toContain("## Macro / no-ticker (1)");
  });
});
