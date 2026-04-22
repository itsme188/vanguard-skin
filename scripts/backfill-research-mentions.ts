/**
 * Re-verify research_article_securities links using the two-layer gate
 * (word-boundary + Haiku). Each article's existing links are cleared and
 * rebuilt from the stored `mentioned_symbols` list.
 *
 * Usage:
 *   npx tsx scripts/backfill-research-mentions.ts [--dry-run] [--limit=N]
 *
 * The --limit flag caps the number of articles processed per run; default
 * processes all. Haiku verification costs ~$0.0005/article, so the full
 * 295-article backfill costs ~$0.15 total.
 */

import Database from "better-sqlite3";
import { verifyMentions } from "../lib/research/verify-mentions";

interface ArticleRow {
  id: number;
  subject: string;
  raw_text: string;
  mentioned_symbols: string | null;
  sentiment: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 0;

  const dbPath = process.env.VANGUARD_DB_PATH ?? "data/vanguard.db";
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const articleSql = `
    SELECT id, subject, raw_text, mentioned_symbols, sentiment
    FROM research_articles
    WHERE mentioned_symbols IS NOT NULL
      AND mentioned_symbols != '[]'
      AND processed_at IS NOT NULL
    ORDER BY received_at DESC
    ${limit > 0 ? "LIMIT " + limit : ""}
  `;
  const articles = db.prepare(articleSql).all() as ArticleRow[];

  console.log(`Found ${articles.length} processed articles with mentions.`);
  console.log(`Dry run: ${dryRun}\n`);

  const findSecurity = db.prepare(
    `SELECT id FROM securities WHERE symbol = ? LIMIT 1`,
  );
  const clearLinks = db.prepare(
    `DELETE FROM research_article_securities WHERE article_id = ?`,
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO research_article_securities
     (article_id, security_id, mention_context, sentiment)
     VALUES (?, ?, ?, ?)`,
  );
  const updateMentioned = db.prepare(
    `UPDATE research_articles SET mentioned_symbols = ? WHERE id = ?`,
  );

  let totalCandidates = 0;
  let totalSurvived = 0;
  let totalLinksBefore = 0;
  let totalLinksAfter = 0;
  let errors = 0;
  const droppedBySymbol = new Map<string, number>();

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const progress = `[${i + 1}/${articles.length}]`;

    let rawSymbols: string[] = [];
    try {
      rawSymbols = JSON.parse(article.mentioned_symbols || "[]");
    } catch {
      console.warn(`${progress} article ${article.id}: malformed mentioned_symbols, skipping`);
      continue;
    }
    if (rawSymbols.length === 0) continue;

    const existingLinks = db
      .prepare(
        `SELECT COUNT(*) AS n FROM research_article_securities WHERE article_id = ?`,
      )
      .get(article.id) as { n: number };
    totalLinksBefore += existingLinks.n;
    totalCandidates += rawSymbols.length;

    try {
      const verified = await verifyMentions(
        rawSymbols,
        article.subject,
        article.raw_text,
      );
      const verifiedSymbols = verified.map((v) => v.symbol);
      totalSurvived += verifiedSymbols.length;

      const dropped = rawSymbols.filter(
        (s) => !verifiedSymbols.includes(s.toUpperCase().trim()),
      );
      for (const d of dropped) {
        droppedBySymbol.set(d, (droppedBySymbol.get(d) ?? 0) + 1);
      }

      console.log(
        `${progress} article ${article.id} "${article.subject.slice(0, 50)}" → kept ${verifiedSymbols.length}/${rawSymbols.length} (dropped: ${dropped.join(", ") || "none"})`,
      );

      if (!dryRun) {
        clearLinks.run(article.id);
        let linkCount = 0;
        for (const { symbol, context } of verified) {
          const sec = findSecurity.get(symbol) as { id: number } | undefined;
          if (sec) {
            insertLink.run(article.id, sec.id, context, article.sentiment);
            linkCount++;
          }
        }
        updateMentioned.run(JSON.stringify(verifiedSymbols), article.id);
        totalLinksAfter += linkCount;
      }
    } catch (err) {
      errors++;
      console.error(
        `${progress} article ${article.id}: error - ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  db.close();

  console.log("");
  console.log("Summary:");
  console.log(`  Articles processed:     ${articles.length}`);
  console.log(`  Candidate mentions:     ${totalCandidates}`);
  console.log(`  Survived both gates:    ${totalSurvived}`);
  console.log(`  Dropped:                ${totalCandidates - totalSurvived}`);
  console.log(`  Link rows before:       ${totalLinksBefore}`);
  if (!dryRun) {
    console.log(`  Link rows after:        ${totalLinksAfter}`);
  }
  console.log(`  Errors:                 ${errors}`);

  if (droppedBySymbol.size > 0) {
    console.log("");
    console.log("Dropped mentions by symbol (top 20):");
    const sorted = Array.from(droppedBySymbol.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    for (const [sym, n] of sorted) {
      console.log(`  ${sym.padEnd(8)} ${n}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
