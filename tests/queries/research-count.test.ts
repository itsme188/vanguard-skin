/**
 * tests/queries/research-count.test.ts
 *
 * Regression for the QA finding
 * `research-digest--silently-caps-at-30-newest-articles-no-disclosure`.
 *
 * The digest generators fetch the N newest articles in a window and then
 * print "<N> articles from <k> sources" as if N were the window total, so a
 * 107-article window renders byte-identical to a 30-article one. Disclosing
 * the drop needs a window count — and per CLAUDE.md a count must use the
 * IDENTICAL predicate as its list, so `countRecentArticles` and
 * `getRecentArticles` share one predicate builder. These tests pin that
 * agreement across every filter combination.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getRecentArticles, countRecentArticles } from "@/lib/queries/research";

let db: Database.Database;
let sourceA: number;
let sourceB: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  sourceA = db
    .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
    .run("Source A", "a@example.test").lastInsertRowid as number;
  sourceB = db
    .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
    .run("Source B", "b@example.test").lastInsertRowid as number;
});

function seed(opts: {
  sourceId: number;
  subject: string;
  receivedAt: string;
  processed?: boolean;
  relevant?: 0 | 1;
  summary?: string;
}): void {
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment,
        processed_at, is_relevant)
     VALUES (?, ?, 'x@example.test', ?, 'body', ?, 'neutral', ?, ?)`,
  ).run(
    opts.sourceId,
    opts.subject,
    opts.receivedAt,
    opts.summary ?? "Summary text",
    opts.processed === false ? null : new Date().toISOString(),
    opts.relevant ?? 1,
  );
}

/** N processed, relevant articles today on Source A. */
function seedBulk(n: number, sourceId = sourceA, prefix = "Note"): void {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (let i = 0; i < n; i++) {
    seed({ sourceId, subject: `${prefix} ${i + 1}`, receivedAt: now });
  }
}

describe("countRecentArticles", () => {
  it("counts the whole window, ignoring the fetch limit", () => {
    seedBulk(47);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const filter = { startDate: yesterday, processedOnly: true, relevantOnly: true };

    expect(getRecentArticles(db, { ...filter, limit: 30 })).toHaveLength(30);
    expect(countRecentArticles(db, filter)).toBe(47);
  });

  it("agrees with the unlimited list under every filter combination", () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const old = "2020-01-02 09:00:00";

    seed({ sourceId: sourceA, subject: "relevant today", receivedAt: now });
    seed({ sourceId: sourceA, subject: "filtered today", receivedAt: now, relevant: 0 });
    seed({ sourceId: sourceA, subject: "unprocessed today", receivedAt: now, processed: false });
    seed({ sourceId: sourceB, subject: "other source today", receivedAt: now });
    seed({ sourceId: sourceA, subject: "relevant long ago", receivedAt: old });
    seed({
      sourceId: sourceB,
      subject: "keyword hit",
      receivedAt: now,
      summary: "mentions widgets",
    });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const combos = [
      {},
      { processedOnly: true },
      { relevantOnly: true },
      { processedOnly: true, relevantOnly: true },
      { startDate: yesterday },
      { startDate: yesterday, processedOnly: true, relevantOnly: true },
      { sourceId: sourceA },
      { sourceId: sourceB, relevantOnly: true },
      { search: "widgets" },
      { search: "relevant", processedOnly: true },
      { endDate: "2020-01-02" },
      { endDateTime: "2020-01-03 00:00:00" },
    ];

    for (const combo of combos) {
      const listed = getRecentArticles(db, { ...combo, limit: 1000 }).length;
      expect(countRecentArticles(db, combo), JSON.stringify(combo)).toBe(listed);
    }
  });

  it("returns 0 on an empty window", () => {
    expect(countRecentArticles(db, { startDate: "2099-01-01" })).toBe(0);
  });
});
