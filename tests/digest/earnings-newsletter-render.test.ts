import { describe, it, expect } from "vitest";
import { renderNewslettersBlock } from "@/lib/digest/send-earnings-email";

type Ctx = Parameters<typeof renderNewslettersBlock>[0];

function mkEntry(over: Partial<Ctx["recentArticles"][number]> = {}) {
  return {
    source_name: "TMT Breakout",
    subject: "Morning Wrap",
    received_at: "2026-07-16T10:12:00.000Z",
    body: "Body text.",
    sentiment: "neutral" as string | null,
    sentiment_score: null as number | null,
    source_id: 8,
    earnings_rank: 2 as number | null,
    earnings_note: "Bogies tables — quote exact numbers." as string | null,
    ...over,
  };
}

function mkCtx(articles: ReturnType<typeof mkEntry>[]): Ctx {
  return { symbol: "AAPL", recentArticles: articles } as Ctx;
}

describe("renderNewslettersBlock — hierarchy rendering", () => {
  it("renders a source's note once, on its first article only", () => {
    const block = renderNewslettersBlock(
      mkCtx([
        mkEntry({ subject: "Morning Wrap" }),
        mkEntry({ subject: "EOD Wrap", received_at: "2026-07-16T21:00:00.000Z" }),
      ]),
      "preview"
    );
    const occurrences = block.split("How to read this source").length - 1;
    expect(occurrences).toBe(1);
    expect(block).toContain("Bogies tables — quote exact numbers.");
  });

  it("omits the note line for sources without one", () => {
    const block = renderNewslettersBlock(
      mkCtx([mkEntry({ earnings_note: null })]),
      "preview"
    );
    expect(block).not.toContain("How to read this source");
  });

  it("pins the trust-order framing and dedup instruction (preview)", () => {
    const block = renderNewslettersBlock(mkCtx([mkEntry()]), "preview");
    expect(block).toContain("trust order");
    expect(block).toContain("multi-source attribution");
  });

  it("pins the trust-order framing and dedup instruction (recap)", () => {
    const block = renderNewslettersBlock(mkCtx([mkEntry()]), "recap");
    expect(block).toContain("trust order");
    expect(block).toContain("multi-source attribution");
  });

  it("keeps the empty-state web_search fallback", () => {
    const block = renderNewslettersBlock(mkCtx([]), "preview");
    expect(block).toContain("No recent newsletter articles");
    expect(block).toContain("web_search");
  });
});
