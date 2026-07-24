/**
 * Rewrite third-person "the user" phrasing in research_articles.
 * portfolio_relevance (rendered as a blockquote in digest emails).
 * Deliberately does NOT touch `summary` — "the user" there is often
 * legitimate prose about end-users of a product.
 *
 * Dry-run by default; --apply to write.
 */
import Database from "better-sqlite3";
import path from "path";

const apply = process.argv.includes("--apply");
const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, portfolio_relevance FROM research_articles
      WHERE portfolio_relevance LIKE '%the user%'`
  )
  .all() as { id: number; portfolio_relevance: string }[];

const update = db.prepare(`UPDATE research_articles SET portfolio_relevance = ? WHERE id = ?`);
let repaired = 0;

for (const row of rows) {
  const fixed = row.portfolio_relevance
    .replace(/\bthe user(?:'|’)s\b/gi, "your")
    .replace(/\bthe user\b/gi, "you");
  if (fixed === row.portfolio_relevance) continue;
  console.log(`row ${row.id}:\n  - ${row.portfolio_relevance}\n  + ${fixed}`);
  if (apply) {
    update.run(fixed, row.id);
    repaired += 1;
  }
}

console.log(apply ? `Repaired ${repaired} rows.` : `Would repair ${rows.length} rows. Re-run with --apply.`);
db.close();
