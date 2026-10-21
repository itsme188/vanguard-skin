/**
 * `refetchArticleHtml` (2026-10-21): re-fetch the named articles' HTML from
 * Gmail and store the re-sanitized body, so an article stored cut off at its
 * "View in browser" header link gets its post and images back. Dry run by
 * default; only the named ids; synthetic message only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { gmail_v1 } from "googleapis";
import { runMigrations } from "@/lib/db/migrate";
import { refetchArticleHtml } from "@/lib/gmail/fetch";
import { newsletterImageUrls } from "@/lib/earnings/newsletter-images";
import { CDN_DAY1, CDN_DAY2, substackImageOnlyEmail } from "../helpers/substack-email-fixture";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Letter')`).run();
});

const TRUNCATED = `<div>Week of 10/19</div><table><tbody><tr><td><span><a href="https://substack.com/redirect/2/abc">`;

function seed(gmailId: string | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, gmail_message_id, subject, sender, received_at, raw_text, raw_html)
         VALUES (9001, ?, 'Desk Bogeys', 'desk@example.test', '2026-10-20 15:00:00', 'text', ?)`,
      )
      .run(gmailId, TRUNCATED).lastInsertRowid,
  );
}

function gmailWith(html: string) {
  const get = vi.fn(async () => ({
    data: { payload: { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64") } } },
  }));
  return { client: { users: { messages: { get } } } as unknown as gmail_v1.Gmail, get };
}

const storedHtml = (id: number) =>
  (db.prepare(`SELECT raw_html FROM research_articles WHERE id = ?`).get(id) as { raw_html: string }).raw_html;

describe("refetchArticleHtml", () => {
  it("dry run reports the rewrite and writes nothing", async () => {
    const id = seed("msg-1");
    const { client, get } = gmailWith(substackImageOnlyEmail());
    const out = await refetchArticleHtml(db, client, [id], { apply: false });
    expect(get).toHaveBeenCalledWith({ userId: "me", id: "msg-1", format: "full" });
    expect(out[0].status).toBe("would_rewrite");
    expect(storedHtml(id)).toBe(TRUNCATED);
  });

  it("apply stores the whole post, with its images", async () => {
    const id = seed("msg-1");
    const { client } = gmailWith(substackImageOnlyEmail());
    const out = await refetchArticleHtml(db, client, [id], { apply: true });
    expect(out[0]).toMatchObject({ id, status: "rewritten", beforeLength: TRUNCATED.length });
    expect(newsletterImageUrls(storedHtml(id))).toEqual([CDN_DAY1, CDN_DAY2]);
  });

  it("an article with no Gmail id, or a Gmail error, is reported and left alone", async () => {
    const noGmail = seed(null);
    const failing = seed("msg-2");
    const client = {
      users: { messages: { get: vi.fn(async () => Promise.reject(new Error("quota"))) } },
    } as unknown as gmail_v1.Gmail;
    const out = await refetchArticleHtml(db, client, [noGmail, failing, 999999], { apply: true });
    expect(out.map((o) => o.status)).toEqual(["not_found", "error", "not_found"]);
    expect(storedHtml(failing)).toBe(TRUNCATED);
  });
});
