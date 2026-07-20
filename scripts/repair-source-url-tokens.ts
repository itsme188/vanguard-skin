/**
 * Strip stored subscriber credentials (?access_token=<JWT>) from
 * research_articles.source_url.
 *
 * Stratechery / Sharp Text (Passport) "view in browser" links embed the
 * subscriber's personal access token; extractSourceUrl stored them verbatim
 * until 2026-07-20, and the digest's Sources section mails source_urls to
 * cc'd recipients. cleanUrl now strips the param at extraction time — this
 * is the one-time repair for the 69 existing rows.
 *
 * Idempotent (re-run is a no-op). Dry-run by default; pass --apply to write.
 *
 *   npx tsx scripts/repair-source-url-tokens.ts [--apply]
 */

import Database from "better-sqlite3";
import path from "path";

const APPLY = process.argv.includes("--apply");

// Same transform as cleanUrl in lib/gmail/extract-url.ts.
function stripAccessToken(url: string): string {
  return url
    .replace(/([?&])access_token=[^&\s]*&?/g, "$1")
    .replace(/[?&]$/, "");
}

const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, source_url FROM research_articles WHERE source_url LIKE '%access_token=%'`,
  )
  .all() as { id: number; source_url: string }[];

let changed = 0;
const update = db.prepare(`UPDATE research_articles SET source_url = ? WHERE id = ?`);

for (const row of rows) {
  const cleaned = stripAccessToken(row.source_url);
  if (cleaned === row.source_url) continue;
  changed++;
  console.log(`#${row.id}: ${row.source_url.slice(0, 60)}… → ${cleaned.slice(0, 80)}`);
  if (APPLY) update.run(cleaned, row.id);
}

console.log(
  `${APPLY ? "Repaired" : "[dry-run] Would repair"} ${changed} of ${rows.length} token-bearing rows.`,
);
