/**
 * Overnight block (spec: docs/superpowers/specs/2026-07-15-overnight-digest-block-design.md).
 *
 * Deterministic Asia/BTC scoreboard + optional VK-Dawn commentary extract at
 * the top of the MORNING digest. Everything here is failure-tolerant by
 * design: a symbol drops its line, a market on holiday says "closed", a
 * missing Dawn or a Claude error degrades to numbers-only, and total failure
 * omits the block without touching the digest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  OVERNIGHT_INSTRUMENTS,
  fetchOvernightMoves,
  renderOvernightBlock,
  extractOvernightCommentary,
  composeOvernightBlock,
  type OvernightMove,
} from "@/lib/digest/overnight";
import type { DailyClose } from "@/lib/quotes/yahoo-daily";

const TODAY = "2026-07-15";

/** Fetcher stub: per-symbol close series. Missing symbol → []. */
function stubFetcher(bySymbol: Record<string, DailyClose[]>) {
  return async (symbol: string): Promise<DailyClose[]> => bySymbol[symbol] ?? [];
}

describe("OVERNIGHT_INSTRUMENTS", () => {
  it("is the user's fixed order: Korea, bitcoin, Japan, China", () => {
    expect(OVERNIGHT_INSTRUMENTS.map((i) => i.label)).toEqual([
      "KOSPI",
      "Bitcoin",
      "Nikkei",
      "Hang Seng",
    ]);
    expect(OVERNIGHT_INSTRUMENTS.map((i) => i.symbol)).toEqual([
      "^KS11",
      "BTC-USD",
      "^N225",
      "^HSI",
    ]);
  });
});

describe("fetchOvernightMoves", () => {
  const fresh = (prior: number, last: number): DailyClose[] => [
    { date: "2026-07-14", close: prior },
    { date: "2026-07-15", close: last },
  ];

  it("computes last-vs-prior percent moves in instrument order", async () => {
    const moves = await fetchOvernightMoves({
      today: TODAY,
      fetcher: stubFetcher({
        "^KS11": fresh(100, 100.8),
        "^N225": fresh(40000, 40480),
        "^HSI": fresh(20000, 19940),
      }),
      fetch24h: async () => -2.1,
    });

    expect(moves).toHaveLength(4);
    expect(moves.map((m) => m.label)).toEqual(["KOSPI", "Bitcoin", "Nikkei", "Hang Seng"]);
    expect((moves[0] as { pct: number }).pct).toBeCloseTo(0.8, 5);
    expect((moves[1] as { pct: number }).pct).toBeCloseTo(-2.1, 5);
    expect((moves[2] as { pct: number }).pct).toBeCloseTo(1.2, 5);
    expect((moves[3] as { pct: number }).pct).toBeCloseTo(-0.3, 5);
  });

  it("Bitcoin uses the rolling-24h fetcher, never the daily-close pair", async () => {
    // The 7/20 digest showed "Bitcoin −0.1%" against VK's "dipped 75bp": the
    // daily pair measures a ~9h partial UTC day at digest time. 24/7 assets
    // get a true rolling-24h window.
    const dailySymbolsAsked: string[] = [];
    const moves = await fetchOvernightMoves({
      today: TODAY,
      fetcher: async (symbol: string) => {
        dailySymbolsAsked.push(symbol);
        // Would produce a misleading partial-day number for BTC:
        return { "^KS11": fresh(100, 101), "BTC-USD": fresh(100, 105), "^N225": fresh(100, 101), "^HSI": fresh(100, 101) }[symbol] ?? [];
      },
      fetch24h: async () => -0.75,
    });

    expect(moves[1]).toEqual({ label: "Bitcoin", pct: -0.75 });
    expect(dailySymbolsAsked).not.toContain("BTC-USD");
  });

  it("drops a symbol whose fetch fails or returns fewer than 2 closes", async () => {
    const moves = await fetchOvernightMoves({
      today: TODAY,
      fetcher: stubFetcher({
        "^KS11": fresh(100, 101),
        "^N225": [{ date: "2026-07-15", close: 40000 }], // only one close
        "^HSI": fresh(20000, 20100),
      }),
      fetch24h: async () => null, // BTC 24h fetch failed → drop the line
    });

    expect(moves.map((m) => m.label)).toEqual(["KOSPI", "Hang Seng"]);
  });

  it("marks a market closed when its latest close is older than 3 calendar days", async () => {
    const moves = await fetchOvernightMoves({
      today: TODAY,
      fetcher: stubFetcher({
        "^KS11": fresh(100, 101),
        "^N225": [
          { date: "2026-07-10", close: 39900 },
          { date: "2026-07-11", close: 40000 }, // 4 days before TODAY — holiday week
        ],
        "^HSI": fresh(100, 101),
      }),
      fetch24h: async () => 1,
    });

    expect(moves[2]).toEqual({ label: "Nikkei", closed: true });
  });

  it("a close exactly 3 calendar days old still counts as fresh (long weekend)", async () => {
    const moves = await fetchOvernightMoves({
      today: TODAY,
      fetcher: stubFetcher({
        "^KS11": [
          { date: "2026-07-11", close: 100 },
          { date: "2026-07-12", close: 102 }, // Sat relative to Wed TODAY = 3 days
        ],
        "^N225": fresh(100, 101),
        "^HSI": fresh(100, 101),
      }),
      fetch24h: async () => 1,
    });

    expect(moves[0]).toEqual({ label: "KOSPI", pct: expect.closeTo(2, 5) });
  });

  it("returns [] when every fetch fails", async () => {
    const moves = await fetchOvernightMoves({
      today: TODAY,
      fetcher: stubFetcher({}),
      fetch24h: async () => null,
    });
    expect(moves).toEqual([]);
  });
});

describe("renderOvernightBlock", () => {
  const MOVES: OvernightMove[] = [
    { label: "KOSPI", pct: 0.8 },
    { label: "Bitcoin", pct: -2.14 },
    { label: "Nikkei", pct: 1.23 },
    { label: "Hang Seng", pct: -0.3 },
  ];

  it("renders the scoreboard line with signed one-decimal percents", () => {
    const block = renderOvernightBlock(MOVES, null);
    expect(block).toContain("## Overnight");
    expect(block).toContain("KOSPI +0.8% · Bitcoin −2.1% · Nikkei +1.2% · Hang Seng −0.3%");
  });

  it("renders a closed market as '<label> closed'", () => {
    const block = renderOvernightBlock(
      [{ label: "KOSPI", pct: 0.8 }, { label: "Nikkei", closed: true }],
      null,
    );
    expect(block).toContain("KOSPI +0.8% · Nikkei closed");
  });

  it("appends the commentary as an attributed blockquote", () => {
    const block = renderOvernightBlock(MOVES, "Asia traded firm; crypto faded overnight.");
    expect(block).toContain(
      "> Asia traded firm; crypto faded overnight. — Vital Knowledge",
    );
  });

  it("omits the blockquote when commentary is null", () => {
    const block = renderOvernightBlock(MOVES, null);
    expect(block).not.toContain(">");
    expect(block).not.toContain("Vital Knowledge");
  });

  it("returns null when there are no moves — even with commentary", () => {
    expect(renderOvernightBlock([], "some text")).toBeNull();
  });
});

describe("extractOvernightCommentary", () => {
  let db: Database.Database;
  let vkSourceId: number;

  const generateStub = vi.fn(async () => ({
    text: "Asia was mixed overnight with Korea leading.",
  }));

  function seedArticle(subject: string, receivedAtIso: string, sourceId = vkSourceId) {
    db.prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
       VALUES (?, ?, 'vk@example.com', ?, 'Overnight: Asia mixed. Korea up on chips.', 'sum', 'neutral', datetime('now'))`,
    ).run(sourceId, subject, receivedAtIso);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vkSourceId = db
      .prepare(
        `INSERT INTO research_sources (name, sender_email, is_active) VALUES ('Vital Knowledge', 'vk@example.com', 1) RETURNING id`,
      )
      .get()!["id" as never] as number;
    generateStub.mockClear();
  });

  it("extracts from today's Dawn edition and passes its text to the model", async () => {
    seedArticle("Vital Dawn — July 15", new Date().toISOString());

    const commentary = await extractOvernightCommentary(db, { generate: generateStub });

    expect(commentary).toBe("Asia was mixed overnight with Korea leading.");
    expect(generateStub).toHaveBeenCalledTimes(1);
    const [feature, opts] = generateStub.mock.calls[0] as unknown as [
      string,
      { prompt: string },
    ];
    expect(feature).toBe("overnightCommentary");
    expect(opts.prompt).toContain("Korea up on chips");
  });

  it("ignores non-dawn VK editions received today", async () => {
    seedArticle("Vital Market Recap — July 14", new Date().toISOString());
    seedArticle("Mid-Day Market Update", new Date().toISOString());

    const commentary = await extractOvernightCommentary(db, { generate: generateStub });

    expect(commentary).toBeNull();
    expect(generateStub).not.toHaveBeenCalled();
  });

  it("ignores yesterday's Dawn — stale overnight commentary is worse than none", async () => {
    seedArticle(
      "Vital Dawn — July 14",
      new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    );

    const commentary = await extractOvernightCommentary(db, { generate: generateStub });

    expect(commentary).toBeNull();
    expect(generateStub).not.toHaveBeenCalled();
  });

  it("returns null when the model call fails", async () => {
    seedArticle("Vital Dawn — July 15", new Date().toISOString());
    generateStub.mockRejectedValueOnce(new Error("529 overloaded"));

    const commentary = await extractOvernightCommentary(db, { generate: generateStub });

    expect(commentary).toBeNull();
  });

  it("returns null when the model returns empty text", async () => {
    seedArticle("Vital Dawn — July 15", new Date().toISOString());
    generateStub.mockResolvedValueOnce({ text: "   " });

    const commentary = await extractOvernightCommentary(db, { generate: generateStub });

    expect(commentary).toBeNull();
  });
});

describe("composeOvernightBlock", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("renders numbers + commentary when both succeed", async () => {
    const block = await composeOvernightBlock(db, {
      fetchMoves: async () => [{ label: "KOSPI", pct: 1.0 }],
      extract: async () => "Korea led overnight.",
    });

    expect(block).toContain("KOSPI +1.0%");
    expect(block).toContain("> Korea led overnight. — Vital Knowledge");
  });

  it("never throws — a total failure returns null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const block = await composeOvernightBlock(db, {
      fetchMoves: async () => {
        throw new Error("yahoo down");
      },
      extract: async () => null,
    });
    expect(block).toBeNull();
    warnSpy.mockRestore();
  });
});
