/**
 * lib/queries/research.ts — the mentions count equals the mentions list.
 *
 * QA finding security-detail-research-mentions--caps-at-5-prints-3-of-5-
 * filtered-while-hundreds-exist: the hub loads a handful of mentions and had
 * no total to print. countArticlesForSecurity is built from the SAME FROM/WHERE
 * fragment as getArticlesForSecurity, so the total is exactly the number of
 * rows the list would return with no LIMIT.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  ARTICLES_FOR_SECURITY_FROM_WHERE_SQL,
  countArticlesForSecurity,
  getArticlesForSecurity,
} from "@/lib/queries/research";
import { getSecurityDetail } from "@/lib/queries/security-detail";
import { anchorIndex } from "../helpers/source-anchor";

function seed(): { db: Database.Database; aaa: number; zzz: number } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')");
  const aaa = sec.run("AAA", "AAA Corp").lastInsertRowid as number;
  const zzz = sec.run("ZZZ", "ZZZ Corp").lastInsertRowid as number;
  const sourceId = db
    .prepare("INSERT INTO research_sources (name, sender_pattern) VALUES ('Test Source', 'x@example.com')")
    .run().lastInsertRowid as number;

  const article = db.prepare(
    `INSERT INTO research_articles
       (source_id, gmail_message_id, received_at, subject, sender, raw_text, is_relevant, processed_at)
     VALUES (?, ?, ?, ?, 'x@example.com', 'body', ?, ?)`
  );
  const link = db.prepare(
    "INSERT INTO research_article_securities (article_id, security_id) VALUES (?, ?)"
  );
  let n = 0;
  function add(securityId: number, relevant: 0 | 1, processed: boolean): void {
    n += 1;
    const day = String(n).padStart(2, "0");
    const id = article.run(
      sourceId,
      `msg-${n}`,
      `2026-03-${day} 09:00:00`,
      `Article ${n}`,
      relevant,
      processed ? `2026-03-${day} 10:00:00` : null
    ).lastInsertRowid as number;
    link.run(id, securityId);
  }

  for (let i = 0; i < 7; i++) add(aaa, 1, true); // relevant and processed: counted
  for (let i = 0; i < 3; i++) add(aaa, 0, true); // filtered as not relevant
  for (let i = 0; i < 2; i++) add(aaa, 1, false); // not processed yet
  for (let i = 0; i < 4; i++) add(zzz, 1, true); // another security
  return { db, aaa, zzz };
}

describe("countArticlesForSecurity — count equals the list without its LIMIT", () => {
  it("matches for a security with relevant, filtered and unprocessed articles", () => {
    const { db, aaa, zzz } = seed();

    const all = getArticlesForSecurity(db, aaa, 1_000_000);
    expect(all).toHaveLength(7);
    expect(countArticlesForSecurity(db, aaa)).toBe(all.length);

    expect(countArticlesForSecurity(db, zzz)).toBe(getArticlesForSecurity(db, zzz, 1_000_000).length);
    expect(countArticlesForSecurity(db, zzz)).toBe(4);
  });

  it("is zero for a security with no mentions", () => {
    const { db } = seed();
    expect(countArticlesForSecurity(db, 999_999)).toBe(0);
  });

  it("the hub reads the total next to its capped list", () => {
    const { db, aaa } = seed();
    const detail = getSecurityDetail(db, aaa);
    expect(detail?.researchMentions).toHaveLength(5);
    expect(detail?.researchMentionsTotal).toBe(7);
  });

  it("list and count share one FROM/WHERE fragment (no second copy of the predicate)", () => {
    const source = readFileSync(join(process.cwd(), "lib/queries/research.ts"), "utf8");
    const listAt = anchorIndex(source, "export function getArticlesForSecurity(");
    const countAt = anchorIndex(source, "export function countArticlesForSecurity(");
    const list = source.slice(listAt, countAt);
    const count = source.slice(countAt, countAt + 400);
    anchorIndex(list, "${ARTICLES_FOR_SECURITY_FROM_WHERE_SQL}");
    anchorIndex(count, "${ARTICLES_FOR_SECURITY_FROM_WHERE_SQL}");
    expect(list).not.toContain("is_relevant");
    expect(count).not.toContain("is_relevant");
    expect(source.split("FROM research_article_securities ras\n       JOIN research_articles a ON ras.article_id = a.id\n       JOIN research_sources s").length).toBe(2);
    expect(ARTICLES_FOR_SECURITY_FROM_WHERE_SQL).toContain("COALESCE(a.is_relevant, 1) = 1");
  });
});
