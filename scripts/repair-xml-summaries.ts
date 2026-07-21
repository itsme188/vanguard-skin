/**
 * Repair research_articles.summary rows poisoned with the model's tagged
 * response remnants ("...</summary>\n<key_themes">[...]<sentiment>...").
 *
 * The write-time guard is lib/gmail/process.ts::sanitizeModelSummary (+ the
 * Worker mirror in workers/cron/src/fallback-digest.ts) — this script cleans
 * the rows written before the guard existed. Idempotent: a clean row
 * sanitizes to itself and is skipped.
 *
 * Usage:
 *   npx tsx scripts/repair-xml-summaries.ts          # dry-run (default)
 *   npx tsx scripts/repair-xml-summaries.ts --apply  # write changes
 */
import Database from "better-sqlite3";
import path from "path";
import { sanitizeModelSummary } from "../lib/gmail/process";

const apply = process.argv.includes("--apply");
const dbPath = path.join(__dirname, "..", "data", "vanguard.db");
const db = new Database(dbPath);

const rows = db.prepare(
  `SELECT id, received_at, summary FROM research_articles
   WHERE summary LIKE '%</summary>%'
      OR summary LIKE '%<key_themes%'
      OR summary LIKE '%<sentiment%'
      OR summary LIKE '%<mentioned_symbols%'
      OR summary LIKE '%<portfolio_relevance%'`
).all() as { id: number; received_at: string; summary: string }[];

let changed = 0;
const update = db.prepare("UPDATE research_articles SET summary = ? WHERE id = ?");

for (const row of rows) {
  const clean = sanitizeModelSummary(row.summary);
  if (clean === row.summary) continue;
  changed++;
  console.log(`#${row.id} (${row.received_at}): ${row.summary.length} → ${clean.length} chars`);
  console.log(`  keep: ${clean.slice(0, 100)}${clean.length > 100 ? "…" : ""}`);
  if (apply) update.run(clean, row.id);
}

console.log(
  `${apply ? "Repaired" : "Would repair"} ${changed} of ${rows.length} matched rows${apply ? "" : " (dry-run — pass --apply)"}`
);
db.close();
