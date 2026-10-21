/**
 * Re-fetch the stored HTML of named research articles from Gmail (2026-10-21).
 *
 * Before the footer-trim fix in lib/gmail/sanitize.ts, a newsletter whose
 * "View in browser" header link sat behind a long preheader was stored cut off
 * at that link: the whole post, images included, was gone from `raw_html`.
 * The newsletter bogey scan reads images from `raw_html`, so such an article
 * needs its HTML fetched again before a rescan can see its figures.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/repair-refetch-article-html.ts --ids=110642 [--apply] [--rescan] [--db=<path>]
 *
 *   --ids      comma-separated research_articles ids (required; never a sweep)
 *   --apply    write; without it nothing is written (dry run)
 *   --rescan   with --apply: also clear `bogeys_scanned_at` on each rewritten
 *              article, so the next global bogey scan reads it again, now with
 *              its images, for every covered reporter in its window
 *   --db       database path; else REPAIR_DB_PATH; else data/vanguard.db
 *
 * Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in the
 * environment (read-only Gmail scope).
 */
import path from "node:path";
import Database from "better-sqlite3";
import { getGmailClient } from "@/lib/gmail/auth";
import { refetchArticleHtml } from "@/lib/gmail/fetch";
import { newsletterImageUrls } from "@/lib/earnings/newsletter-images";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const APPLY = process.argv.includes("--apply");
const RESCAN = process.argv.includes("--rescan");
const DB_PATH = arg("db") ?? process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const IDS = (arg("ids") ?? "")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0);

async function main() {
  console.log(`[refetch-article-html] ${APPLY ? "APPLY" : "dry run"}${RESCAN ? " + rescan" : ""}, db: ${DB_PATH}`);
  if (IDS.length === 0) {
    console.error("--ids=<id,id,...> is required");
    process.exit(2);
  }
  if (RESCAN && !APPLY) console.log("--rescan has no effect without --apply");

  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  try {
    const outcomes = await refetchArticleHtml(db, getGmailClient(), IDS, { apply: APPLY });
    const imagesOf = db.prepare(`SELECT raw_html FROM research_articles WHERE id = ?`);
    for (const o of outcomes) {
      const html = (imagesOf.get(o.id) as { raw_html: string | null } | undefined)?.raw_html ?? null;
      console.log(
        `  article ${o.id}: ${o.status} (html ${o.beforeLength} -> ${o.afterLength} chars)` +
          (o.status === "rewritten" ? `, ${newsletterImageUrls(html).length} fetchable image(s)` : "") +
          (o.error ? ` — ${o.error}` : ""),
      );
    }
    if (APPLY && RESCAN) {
      const rewritten = outcomes.filter((o) => o.status === "rewritten").map((o) => o.id);
      const clear = db.prepare(`UPDATE research_articles SET bogeys_scanned_at = NULL WHERE id = ?`);
      for (const id of rewritten) clear.run(id);
      console.log(`  cleared bogeys_scanned_at on ${rewritten.length} article(s)`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
