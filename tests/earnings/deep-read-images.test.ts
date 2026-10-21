/**
 * The armed-event deep read reads newsletter images too (2026-10-21): an
 * article whose figures are screenshots sends them to the model as image
 * blocks, each named by the article it came from. A text-only event keeps its
 * old fingerprint (no re-run); an unreadable image is left out, never a failure.
 * Synthetic issuers, hosts and figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));

import { gatherDeepReadInputs, runDeepRead, DEEP_READ_VERSION } from "@/lib/earnings/deep-read-bogeys";
import { makeNewsletterSynthesisStep } from "@/lib/earnings/prepare-steps/newsletter-synthesis";
import { stableHash } from "@/lib/earnings/prepare-armed-event";
import type { FetchNewsletterImagesFn, NewsletterImageFetchResult } from "@/lib/earnings/newsletter-images";
import { IMG_DAY1, IMG_DAY2, PNG_BYTES } from "../helpers/substack-email-fixture";

const FILLER = " Market color with nothing about any company in it, padding the body past the scan floor.".repeat(4);
const IMAGE_HTML = `<h3>Tuesday: XMPL, ZETA</h3><figure><img src="${IMG_DAY1}" width="550"></figure><figure><img src="${IMG_DAY2}" width="550"></figure>`;

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Notes')`).run();
});
afterEach(() => generateTextMock.mockReset());

function seedEvent(): number {
  db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('XMPL', 'Exemplar Devices, Inc.', 'Stock')`).run();
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol)
         VALUES ('manual','earnings','2026-10-22','AMC','XMPL','manual:XMPL:2026-10-22','XMPL')`,
      )
      .run().lastInsertRowid,
  );
}

function seedArticle(receivedAtUtc: string, body: string, rawHtml: string | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, raw_html)
         VALUES (9001, 'Desk Bogeys', 'desk@example.test', ?, ?, ?)`,
      )
      .run(receivedAtUtc, body + FILLER, rawHtml).lastInsertRowid,
  );
}

const fetchAll: FetchNewsletterImagesFn = async (urls): Promise<NewsletterImageFetchResult> => ({
  images: urls.map((url) => ({ url, mediaType: "image/png" as const, data: new Uint8Array(PNG_BYTES) })),
  expected: urls.length,
  failures: [],
});
const fetchNone: FetchNewsletterImagesFn = async (urls): Promise<NewsletterImageFetchResult> => ({
  images: [],
  expected: urls.length,
  failures: urls.map(() => "HTTP 503"),
});

const SHEET = (articleId: number) =>
  JSON.stringify([{ eps_consensus: 1.15, sources: [{ figure: "eps", article_id: articleId }], conflicts: [] }]);

describe("deep read with images", () => {
  it("gathers each article's fetchable image URLs", () => {
    const ev = seedEvent();
    const img = seedArticle("2026-10-21 12:00:00", "Tuesday: XMPL, ZETA", IMAGE_HTML);
    const txt = seedArticle("2026-10-20 12:00:00", "XMPL whisper above the Street.", "<p>XMPL words</p>");
    const inputs = gatherDeepReadInputs(db, ev)!;
    expect(inputs.articles.map((a) => [a.id, a.imageUrls])).toEqual([
      [img, [IMG_DAY1, IMG_DAY2]],
      [txt, []],
    ]);
  });

  it("a text-only event keeps its fingerprint; an image article changes it", () => {
    const ev = seedEvent();
    const txt = seedArticle("2026-10-20 12:00:00", "XMPL whisper above the Street.", "<p>XMPL words</p>");
    const step = makeNewsletterSynthesisStep();
    const legacy = stableHash([
      "newsletter_synthesis",
      DEEP_READ_VERSION,
      ev,
      "XMPL",
      "2026-10-22",
      "2026-10-22T20:00:00.000Z",
      [txt],
    ]);
    expect(step.fingerprint(db, ev)).toBe(legacy);
    seedArticle("2026-10-21 12:00:00", "Tuesday: XMPL, ZETA", IMAGE_HTML);
    expect(step.fingerprint(db, ev)).not.toBe(legacy);
  });

  it("attaches the images as image blocks, each named by its article", async () => {
    const ev = seedEvent();
    const img = seedArticle("2026-10-21 12:00:00", "Tuesday: XMPL, ZETA", IMAGE_HTML);
    generateTextMock.mockResolvedValueOnce({ text: SHEET(img) });

    const out = await runDeepRead(db, ev, { fetchImages: fetchAll });

    expect(out).toMatchObject({ articlesRead: 1, stored: true, imagesRead: 2, imagesUnreadable: 0 });
    const opts = generateTextMock.mock.calls[0][1];
    expect(opts.prompt).toBeUndefined();
    const [text, ...images] = opts.messages[0].content;
    expect(text.text).toContain(`image 1 is from ARTICLE ${img}`);
    expect(text.text).toContain(`image 2 is from ARTICLE ${img}`);
    expect(text.text).toMatch(/read only the block headed by XMPL/);
    expect(images).toEqual([
      { type: "image", image: new Uint8Array(PNG_BYTES), mediaType: "image/png" },
      { type: "image", image: new Uint8Array(PNG_BYTES), mediaType: "image/png" },
    ]);
  });

  it("unreadable images are left out and counted; the read still runs on the text", async () => {
    const ev = seedEvent();
    const img = seedArticle("2026-10-21 12:00:00", "Tuesday: XMPL, ZETA", IMAGE_HTML);
    generateTextMock.mockResolvedValueOnce({ text: SHEET(img) });

    const out = await runDeepRead(db, ev, { fetchImages: fetchNone });

    expect(out).toMatchObject({ articlesRead: 1, stored: true, imagesRead: 0, imagesUnreadable: 2 });
    const opts = generateTextMock.mock.calls[0][1];
    expect(typeof opts.prompt).toBe("string");
    expect(opts.prompt).not.toContain("IMAGES:");
  });
});
