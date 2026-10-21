/**
 * The newsletter bogey scan reads content images (2026-10-21).
 *
 * A Substack post that sends every figure as a screenshot was read as text
 * only and booked `no_numbers`. Pinned here:
 *   - the images reach the model call as image blocks beside the text, with
 *     the instruction to read only the listed reporter's block of a shared image;
 *   - a figure for a company that is not the event's never lands on the sheet;
 *   - image-bearing articles are read at NEWSLETTER_IMAGE_EXTRACTOR_VERSION, so a
 *     version-2 `no_numbers` no longer short-circuits them, while text-only
 *     articles keep version 2 and cost no new call;
 *   - an image fetch failure degrades to text, never fails the scan, and never
 *     books a final `no_numbers`.
 * Synthetic tickers, hosts and figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { APICallError } from "ai";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import {
  extractBogeysFromArticle,
  extractBogeysFromArticleForEvent,
  newsletterExtractorVersionForArticle,
  NEWSLETTER_EXTRACTOR_VERSION,
  NEWSLETTER_IMAGE_EXTRACTOR_VERSION,
  type ArticleInput,
} from "@/lib/earnings/extract-newsletter-bogeys";
import { makeNewsletterRescanStep, SCAN_MAX_ATTEMPTS } from "@/lib/earnings/prepare-steps/newsletter-rescan";
import type { FetchNewsletterImagesFn, NewsletterImageFetchResult } from "@/lib/earnings/newsletter-images";
import { normalizeNewsletterHtml, sanitizeNewsletterHtml } from "@/lib/gmail/sanitize";
import {
  CDN_DAY1,
  CDN_DAY2,
  PNG_BYTES,
  SUBSTACK_IMAGE_ONLY_TEXT,
  substackImageOnlyEmail,
} from "../helpers/substack-email-fixture";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Letter')`).run();
});
afterEach(() => generateTextMock.mockReset());

const ctx = { now: () => Date.now(), signal: new AbortController().signal };

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const STORED_HTML = normalizeNewsletterHtml(sanitizeNewsletterHtml(substackImageOnlyEmail()));
const TEXT_ONLY_HTML = "<p>ACME into the print: nothing but words here.</p>";

function seedEvent(symbol = "ACME"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual','earnings',?,?,?,?)`,
      )
      .run(daysAhead(2), symbol, `manual:${symbol}`, symbol).lastInsertRowid,
  );
}

function seedArticle(rawHtml: string | null, scanned: string | null = null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, raw_html, bogeys_scanned_at)
         VALUES (9001, 'Desk Bogeys: ACME, ZETA', 'desk@example.test', ?, ?, ?, ?)`,
      )
      .run(daysAgo(1), SUBSTACK_IMAGE_ONLY_TEXT, rawHtml, scanned).lastInsertRowid,
  );
}

const loadArticle = (id: number): ArticleInput =>
  db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text, a.raw_html
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`,
    )
    .get(id) as ArticleInput;

const fetchAll: FetchNewsletterImagesFn = vi.fn(async (urls: string[]): Promise<NewsletterImageFetchResult> => ({
  images: urls.map((url) => ({ url, mediaType: "image/png" as const, data: new Uint8Array(PNG_BYTES) })),
  expected: urls.length,
  failures: [],
}));
const fetchNone: FetchNewsletterImagesFn = vi.fn(async (urls: string[]): Promise<NewsletterImageFetchResult> => ({
  images: [],
  expected: urls.length,
  failures: urls.map(() => "newsletter image: HTTP 503"),
}));

/** The shared image holds two companies; the model reads both. */
const BOTH_COMPANIES = JSON.stringify([
  { symbol: "ACME", eps_consensus: 1.11, revenue_whisper: 2.22e9, notes: "read from the screenshot" },
  { symbol: "ZETA", eps_consensus: 9.99, revenue_consensus: 8.88e9 },
]);

const ledger = (eventId: number) =>
  db
    .prepare(
      `SELECT article_id, extractor_version, status, attempts FROM earnings_bogey_scans WHERE event_id = ? ORDER BY article_id, extractor_version`,
    )
    .all(eventId);

describe("newsletterExtractorVersionForArticle", () => {
  it("image-bearing articles move to the image version; text-only ones stay put", () => {
    expect(NEWSLETTER_IMAGE_EXTRACTOR_VERSION).toBeGreaterThan(NEWSLETTER_EXTRACTOR_VERSION);
    expect(newsletterExtractorVersionForArticle({ raw_html: STORED_HTML })).toBe(NEWSLETTER_IMAGE_EXTRACTOR_VERSION);
    expect(newsletterExtractorVersionForArticle({ raw_html: TEXT_ONLY_HTML })).toBe(NEWSLETTER_EXTRACTOR_VERSION);
    expect(newsletterExtractorVersionForArticle({ raw_html: null })).toBe(NEWSLETTER_EXTRACTOR_VERSION);
    // An image on a host the scan may not fetch does not move the article.
    expect(
      newsletterExtractorVersionForArticle({ raw_html: `<figure><img src="https://cdn.example.test/a.png"></figure>` }),
    ).toBe(NEWSLETTER_EXTRACTOR_VERSION);
  });
});

describe("global scan with images", () => {
  it("sends the images as image blocks and stores only the listed reporter's figures", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(STORED_HTML);
    generateTextMock.mockResolvedValue({ text: BOTH_COMPANIES });

    await extractBogeysFromArticle(db, loadArticle(art), [{ symbol: "ACME", event_id: ev, event_date: daysAhead(2) }], {
      fetchImages: fetchAll,
    });

    expect(fetchAll).toHaveBeenCalledWith([CDN_DAY1, CDN_DAY2], expect.anything());
    const opts = generateTextMock.mock.calls[0][1];
    expect(opts.prompt).toBeUndefined();
    const content = opts.messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("IMAGES: 2 image(s)");
    expect(content[0].text).toMatch(/SEVERAL companies/);
    expect(content[0].text).toMatch(/Never take a number from another company's block/);
    // Only the event's company is listed for extraction.
    const reporters = content[0].text.split("UPCOMING REPORTERS (only extract for these):")[1].split("NEWSLETTER:")[0];
    expect(reporters).toContain("ACME");
    expect(reporters).not.toContain("ZETA");
    expect(content.slice(1)).toEqual([
      { type: "image", image: new Uint8Array(PNG_BYTES), mediaType: "image/png" },
      { type: "image", image: new Uint8Array(PNG_BYTES), mediaType: "image/png" },
    ]);

    const rows = db.prepare(`SELECT event_id, eps_consensus, revenue_whisper_usd FROM earnings_bogeys`).all();
    expect(rows).toEqual([{ event_id: ev, eps_consensus: 1.11, revenue_whisper_usd: 2.22e9 }]);
    expect(ledger(ev)).toEqual([
      { article_id: art, extractor_version: NEWSLETTER_IMAGE_EXTRACTOR_VERSION, status: "hit", attempts: 0 },
    ]);
  });

  it("a text-only article is sent as a plain prompt and banked at the text version", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(TEXT_ONLY_HTML);
    generateTextMock.mockResolvedValue({ text: "[]" });
    const fetchSpy = vi.fn(async (urls: string[]): Promise<NewsletterImageFetchResult> => ({
      images: [],
      expected: urls.length,
      failures: [],
    }));

    await extractBogeysFromArticle(db, loadArticle(art), [{ symbol: "ACME", event_id: ev, event_date: daysAhead(2) }], {
      fetchImages: fetchSpy,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(typeof generateTextMock.mock.calls[0][1].prompt).toBe("string");
    expect(generateTextMock.mock.calls[0][1].prompt).not.toContain("IMAGES:");
    expect(ledger(ev)).toEqual([
      { article_id: art, extractor_version: NEWSLETTER_EXTRACTOR_VERSION, status: "no_numbers", attempts: 0 },
    ]);
  });

  it("unreadable images degrade to text: the scan completes but banks no final no_numbers", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(STORED_HTML);
    generateTextMock.mockResolvedValue({ text: "[]" });

    const r = await extractBogeysFromArticle(
      db,
      loadArticle(art),
      [{ symbol: "ACME", event_id: ev, event_date: daysAhead(2) }],
      { fetchImages: fetchNone },
    );

    expect(r).toEqual({ bogeysStored: 0, eventsMatched: 0 });
    const opts = generateTextMock.mock.calls[0][1];
    expect(typeof opts.prompt).toBe("string"); // text only
    expect(opts.prompt).not.toContain("IMAGES:");
    expect(ledger(ev)).toEqual([]); // the armed rescan may still read it with its pictures
    const scanned = db.prepare(`SELECT bogeys_scanned_at FROM research_articles WHERE id = ?`).get(art) as {
      bogeys_scanned_at: string | null;
    };
    expect(scanned.bogeys_scanned_at).not.toBeNull();
  });

  it("a fetcher that throws is also a text-only read, never a failed scan", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(STORED_HTML);
    generateTextMock.mockResolvedValue({ text: "[]" });
    const r = await extractBogeysFromArticleForEvent(
      db,
      loadArticle(art),
      { event_id: ev, symbol: "ACME", event_date: daysAhead(2) },
      { fetchImages: vi.fn(async () => Promise.reject(new Error("boom"))) },
    );
    expect(r).toMatchObject({ called: true, bogeysStored: 0, imagesIncomplete: true });
  });
});

describe("the model refuses the images", () => {
  const rejected = (statusCode: number) =>
    new APICallError({
      message: "image exceeds 8000 pixels",
      url: "https://api.example.test/v1/messages",
      requestBodyValues: {},
      statusCode,
      isRetryable: false,
    });

  it("a 400 with images attached is retried ONCE as text, and the article is consumed (no endless retry)", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(STORED_HTML);
    generateTextMock
      .mockRejectedValueOnce(rejected(400))
      .mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "ACME", eps_consensus: 1.11 }]) });

    const r = await extractBogeysFromArticle(
      db,
      loadArticle(art),
      [{ symbol: "ACME", event_id: ev, event_date: daysAhead(2) }],
      { fetchImages: fetchAll },
    );

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(generateTextMock.mock.calls[0][1].messages).toBeDefined();
    expect(typeof generateTextMock.mock.calls[1][1].prompt).toBe("string");
    expect(generateTextMock.mock.calls[1][1].prompt).not.toContain("IMAGES:");
    expect(r).toEqual({ bogeysStored: 1, eventsMatched: 1 });
    const row = db.prepare(`SELECT bogeys_scanned_at FROM research_articles WHERE id = ?`).get(art) as {
      bogeys_scanned_at: string | null;
    };
    expect(row.bogeys_scanned_at).not.toBeNull();
  });

  it("the text-only retry finding nothing banks no final no_numbers (images were not read)", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(STORED_HTML);
    generateTextMock.mockRejectedValueOnce(rejected(413)).mockResolvedValueOnce({ text: "[]" });
    const out = await extractBogeysFromArticleForEvent(
      db,
      loadArticle(art),
      { event_id: ev, symbol: "ACME", event_date: daysAhead(2) },
      { fetchImages: fetchAll },
    );
    expect(out).toMatchObject({ called: true, bogeysStored: 0, imagesIncomplete: true });
    expect(ledger(ev)).toEqual([]);
  });

  it("a server-side failure (5xx) is not an image problem: no text retry, the scan retries later", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(STORED_HTML);
    generateTextMock.mockRejectedValueOnce(rejected(529));
    const r = await extractBogeysFromArticle(
      db,
      loadArticle(art),
      [{ symbol: "ACME", event_id: ev, event_date: daysAhead(2) }],
      { fetchImages: fetchAll },
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ bogeysStored: 0, eventsMatched: 0 });
    const row = db.prepare(`SELECT bogeys_scanned_at FROM research_articles WHERE id = ?`).get(art) as {
      bogeys_scanned_at: string | null;
    };
    expect(row.bogeys_scanned_at).toBeNull();
  });

  it("a 400 on a text-only call is not retried", async () => {
    const ev = seedEvent("ACME");
    const art = seedArticle(TEXT_ONLY_HTML);
    generateTextMock.mockRejectedValueOnce(rejected(400));
    await extractBogeysFromArticle(db, loadArticle(art), [{ symbol: "ACME", event_id: ev, event_date: daysAhead(2) }], {
      fetchImages: fetchAll,
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("armed rescan with images", () => {
  const stepWith = (fetchImages: FetchNewsletterImagesFn) =>
    makeNewsletterRescanStep({
      extract: (d, a, e, deps) => extractBogeysFromArticleForEvent(d, a, e, { ...deps, fetchImages }),
    });

  const bankV2 = (ev: number, art: number) =>
    db
      .prepare(
        `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, model_id, attempts, scanned_at, updated_at)
         VALUES (?, ?, ?, 'no_numbers', 'claude-test-model', 0, datetime('now'), datetime('now'))`,
      )
      .run(ev, art, NEWSLETTER_EXTRACTOR_VERSION);

  it("re-reads an image article the text-only extractor banked no_numbers; skips the text-only one", async () => {
    const ev = seedEvent("ACME");
    const imageArt = seedArticle(STORED_HTML, daysAgo(1));
    const textArt = seedArticle(TEXT_ONLY_HTML, daysAgo(1));
    bankV2(ev, imageArt);
    bankV2(ev, textArt);
    generateTextMock.mockResolvedValue({ text: BOTH_COMPANIES });

    const out = await stepWith(fetchAll).run(db, ev, ctx);

    expect(out.status).toBe("done");
    expect(generateTextMock).toHaveBeenCalledTimes(1); // the image article only
    expect(generateTextMock.mock.calls[0][1].messages[0].content).toHaveLength(3);
    expect(ledger(ev)).toEqual([
      { article_id: imageArt, extractor_version: NEWSLETTER_EXTRACTOR_VERSION, status: "no_numbers", attempts: 0 },
      { article_id: imageArt, extractor_version: NEWSLETTER_IMAGE_EXTRACTOR_VERSION, status: "hit", attempts: 1 },
      { article_id: textArt, extractor_version: NEWSLETTER_EXTRACTOR_VERSION, status: "no_numbers", attempts: 0 },
    ]);
    // ZETA shares the image but is not this event's company.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 1 });
  });

  it("unreadable images: never a final no_numbers; retried a bounded number of times, the step never fails", async () => {
    const ev = seedEvent("ACME");
    const imageArt = seedArticle(STORED_HTML, daysAgo(1));
    generateTextMock.mockResolvedValue({ text: "[]" });
    const step = stepWith(fetchNone);

    const first = await step.run(db, ev, ctx);
    expect(first.status).toBe("pending");
    expect(ledger(ev)).toEqual([
      { article_id: imageArt, extractor_version: NEWSLETTER_IMAGE_EXTRACTOR_VERSION, status: "error", attempts: 1 },
    ]);

    for (let i = 1; i < SCAN_MAX_ATTEMPTS; i += 1) {
      expect((await step.run(db, ev, ctx)).status).toBe("pending");
    }
    const spent = await step.run(db, ev, ctx);
    expect(spent.status).toBe("done");
    expect(generateTextMock).toHaveBeenCalledTimes(SCAN_MAX_ATTEMPTS);
    expect(ledger(ev)).toEqual([
      {
        article_id: imageArt,
        extractor_version: NEWSLETTER_IMAGE_EXTRACTOR_VERSION,
        status: "error",
        attempts: SCAN_MAX_ATTEMPTS,
      },
    ]);
  });
});
