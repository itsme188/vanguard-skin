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
    expect(md).toContain("## NVDA · 2 articles");
    expect(md).toContain("**Vital** · *bullish*");
    expect(md).toContain("**Eliant** · *neutral*");
    expect(md).toContain("Held in IBKR.");
  });

  it("renders the macro bucket heading correctly", () => {
    const articles = [article(1, "Vital", "Macro", null, { summary: "macro note" })];
    const md = renderDigestByCompany(articles, "", "Friday");
    expect(md).toContain("## Macro / no-ticker (1)");
  });

  it("cleans structured-output tag debris from key_themes before rendering", () => {
    const articles = [
      article(1, "Vital", "NVDA note", ["NVDA"], {
        summary: "Mention",
        key_themes: JSON.stringify([
          '<parameter name="key_themes">["real theme"',
          '"second theme"',
        ]),
      }),
    ];
    const md = renderDigestByCompany(articles, "", "Friday");
    expect(md).toContain("*real theme · second theme*");
    expect(md).not.toContain("<parameter");
  });
});

// ---------------------------------------------------------------------------
// Count-line disclosure — by-company view
// (QA: research-digest--silently-caps-at-30-newest-articles-no-disclosure)
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { generateDigestByCompanySince } from "@/lib/digest/group-by-company";

describe("generateDigestByCompanySince — count line discloses the fetch cap", () => {
  function makeDb(articleCount: number): Database.Database {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const source = db
      .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
      .run("Vital Knowledge", "vk@example.com");
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    for (let i = 0; i < articleCount; i++) {
      db.prepare(
        `INSERT INTO research_articles
           (source_id, subject, sender, received_at, raw_text, summary, sentiment,
            processed_at, mentioned_symbols)
         VALUES (?, ?, 'vk@example.com', ?, 'body', ?, 'neutral', datetime('now'), ?)`,
      ).run(
        source.lastInsertRowid as number,
        `Bulk note ${i + 1}`,
        now,
        `Summary ${i + 1}`,
        JSON.stringify(["AAPL"]),
      );
    }
    return db;
  }

  const yesterday = () =>
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it("says 'newest of' when the window exceeds the 30-article cap", () => {
    const md = generateDigestByCompanySince(makeDb(52), yesterday());
    expect(md).toContain("30 newest of 52 articles from 1 source · grouped by company");
  });

  it("keeps the plain wording when nothing was dropped", () => {
    const md = generateDigestByCompanySince(makeDb(6), yesterday());
    expect(md).toContain("6 articles from 1 source · grouped by company");
    expect(md).not.toContain("newest of");
  });
});

// ---------------------------------------------------------------------------
// Each article renders ONCE, homed under its lead company
// (QA: research-digest-by-company--article-reprinted-per-symbol-522kb)
// ---------------------------------------------------------------------------

import { homeArticlesByCompany } from "@/lib/digest/group-by-company";

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe("homeArticlesByCompany", () => {
  it("homes each article under exactly one bucket — its highest-ranked symbol", () => {
    const wide = article(1, "Vital", "Three names", ["BBB", "AAA", "CCC"]);
    const narrow = article(2, "Eliant", "AAA only", ["AAA"]);
    const homed = homeArticlesByCompany([wide, narrow]);

    // AAA leads (2 mentions); BBB/CCC have 1 each and keep no homed article.
    expect(homed.map((b) => b.symbol)).toEqual(["AAA"]);
    expect(homed[0].articles.map((a) => a.id)).toEqual([1, 2]);
    expect(homed[0].mentionCount).toBe(2);
  });

  it("keeps a bucket whose lead article lands elsewhere only when it homes one of its own", () => {
    const shared = article(1, "Vital", "Both names", ["AAA", "BBB"]);
    const aOnly = article(2, "Eliant", "AAA note", ["AAA"]);
    const bOnly = article(3, "Helene", "BBB note", ["BBB"]);
    const homed = homeArticlesByCompany([shared, aOnly, bOnly]);

    expect(homed.map((b) => b.symbol)).toEqual(["AAA", "BBB"]);
    expect(homed[0].articles.map((a) => a.id)).toEqual([1, 2]);
    expect(homed[0].mentionCount).toBe(2);
    expect(homed[1].articles.map((a) => a.id)).toEqual([3]);
    expect(homed[1].mentionCount).toBe(2); // shared still counts as a mention
  });

  it("sends no-ticker articles to the trailing macro bucket", () => {
    const homed = homeArticlesByCompany([
      article(1, "Vital", "Macro", null),
      article(2, "Eliant", "AAA", ["AAA"]),
    ]);
    expect(homed.map((b) => b.symbol)).toEqual(["AAA", "(no symbol)"]);
    expect(homed[1].articles.map((a) => a.id)).toEqual([1]);
  });

  it("returns every article exactly once across all buckets", () => {
    const articles = [
      article(1, "Vital", "One", ["AAA", "BBB", "CCC"]),
      article(2, "Eliant", "Two", ["BBB"]),
      article(3, "Helene", "Three", null),
      article(4, "Vital", "Four", ["CCC", "AAA"]),
    ];
    const homed = homeArticlesByCompany(articles);
    const ids = homed.flatMap((b) => b.articles.map((a) => a.id)).sort();
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});

describe("renderDigestByCompany — one copy per article", () => {
  it("prints a three-symbol article once and chips all three symbols", () => {
    const articles = [
      article(1, "Vital", "Three-name note", ["AAA", "BBB", "CCC"], {
        summary: "A single unmistakable sentence about three fictional tickers.",
      }),
      article(2, "Eliant", "AAA follow-up", ["AAA"], { summary: "Second note." }),
    ];
    const md = renderDigestByCompany(articles, "", "Friday");

    expect(
      occurrences(md, "A single unmistakable sentence about three fictional tickers."),
    ).toBe(1);
    expect(occurrences(md, "Three-name note")).toBe(1);
    expect(md).toContain("Mentions: AAA · BBB · CCC");
  });

  it("puts the chips line under the headline, above the summary", () => {
    const articles = [
      article(1, "Vital", "Three-name note", ["AAA", "BBB", "CCC"], {
        summary: "A single unmistakable sentence about three fictional tickers.",
        source_url: "https://example.test/note",
      }),
    ];
    const md = renderDigestByCompany(articles, "", "Friday");

    const sourceLine = md.indexOf("**Vital** · *neutral*");
    const headline = md.indexOf("### [Three-name note](https://example.test/note)");
    const chips = md.indexOf("Mentions: AAA · BBB · CCC");
    const summary = md.indexOf("A single unmistakable sentence");

    expect(sourceLine).toBeGreaterThan(-1);
    expect(headline).toBeGreaterThan(sourceLine);
    expect(chips).toBeGreaterThan(headline);
    expect(summary).toBeGreaterThan(chips);
  });

  it("headings count homed articles and disclose mentions filed elsewhere", () => {
    const articles = [
      article(1, "Vital", "Shared", ["AAA", "BBB"], { summary: "Shared note." }),
      article(2, "Eliant", "AAA solo", ["AAA"], { summary: "AAA note." }),
      article(3, "Helene", "BBB solo", ["BBB"], { summary: "BBB note." }),
    ];
    const md = renderDigestByCompany(articles, "", "Friday");

    expect(md).toContain("## AAA · 2 articles");
    expect(md).toContain("## BBB · 1 article");
    expect(md).toContain("also mentioned in 1 article filed under other companies");
    // AAA homes everything it is mentioned in, so it carries no such note.
    const aaaSection = md.slice(md.indexOf("## AAA"), md.indexOf("## BBB"));
    expect(aaaSection).not.toContain("also mentioned in");
  });

  it("drops a company heading when every article mentioning it is filed elsewhere", () => {
    const articles = [
      article(1, "Vital", "Lead", ["AAA", "ZZZ"], { summary: "Lead note." }),
      article(2, "Eliant", "Second", ["AAA"], { summary: "Second note." }),
    ];
    const md = renderDigestByCompany(articles, "", "Friday");
    expect(md).toContain("## AAA · 2 articles");
    expect(md).not.toContain("## ZZZ");
    expect(md).toContain("Mentions: AAA · ZZZ");
  });

  it("stays O(articles): breadth of mentions does not multiply the body", () => {
    const longSummary =
      "A deliberately wordy fake summary sentence so the size comparison is " +
      "driven by article bodies rather than by heading text alone, which is " +
      "what the per-symbol reprint regression used to blow up.";
    const wide = ["AAA", "BBB", "CCC"].map((prefix, i) =>
      article(i + 1, "Vital", `${prefix} wide note`, Array.from({ length: 40 }, (_, n) => `${prefix}${n}`), {
        summary: longSummary,
      }),
    );
    const narrow = ["AAA", "BBB", "CCC"].map((prefix, i) =>
      article(i + 1, "Vital", `${prefix} wide note`, [`${prefix}0`], {
        summary: longSummary,
      }),
    );

    const wideMd = renderDigestByCompany(wide, "", "Friday");
    const narrowMd = renderDigestByCompany(narrow, "", "Friday");

    expect(occurrences(wideMd, longSummary)).toBe(3);
    expect(wideMd.length).toBeLessThan(narrowMd.length * 3);
  });
});
