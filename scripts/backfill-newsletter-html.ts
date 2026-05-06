/**
 * Re-run the sanitizer + normalizer over every existing research_articles
 * row's raw_html column. Idempotent: writes only when the result differs
 * from the stored value.
 *
 * Usage:
 *   npx tsx scripts/backfill-newsletter-html.ts [--dry-run] [--limit=N]
 *
 * --dry-run: print diff sizes for the first 5 articles without writing
 * --limit=N: only process the first N articles (default: all)
 */

import { db } from "@/lib/db";
import {
  sanitizeNewsletterHtml,
  normalizeNewsletterHtml,
} from "@/lib/gmail/sanitize";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  return arg ? Number(arg.split("=")[1]) : null;
})();

interface Row {
  id: number;
  subject: string;
  raw_html: string;
}

function main() {
  const select = db.prepare<[], Row>(
    `SELECT id, subject, raw_html
       FROM research_articles
      WHERE raw_html IS NOT NULL
        AND length(raw_html) > 0
      ORDER BY id ASC
      ${LIMIT ? `LIMIT ${LIMIT}` : ""}`,
  );

  const update = db.prepare(
    `UPDATE research_articles SET raw_html = ? WHERE id = ?`,
  );

  let total = 0;
  let changed = 0;
  let unchanged = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const sampleDiffs: Array<{ id: number; subject: string; before: number; after: number }> = [];

  // Collect all rows up front — better-sqlite3 can't UPDATE while a SELECT
  // cursor is active in the same connection. The set fits in memory (~12MB).
  const rows = select.all();

  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      total++;
      const before = row.raw_html;
      const cleaned = normalizeNewsletterHtml(sanitizeNewsletterHtml(before)).slice(
        0,
        200_000,
      );
      if (cleaned === before) {
        unchanged++;
        continue;
      }
      changed++;
      bytesBefore += before.length;
      bytesAfter += cleaned.length;
      if (sampleDiffs.length < 5) {
        sampleDiffs.push({
          id: row.id,
          subject: row.subject.slice(0, 60),
          before: before.length,
          after: cleaned.length,
        });
      }
      if (!DRY_RUN) update.run(cleaned, row.id);
    }
  });

  tx(rows);

  console.log(`\nProcessed ${total} articles`);
  console.log(`  changed:    ${changed}`);
  console.log(`  unchanged:  ${unchanged}`);
  if (changed > 0) {
    const reductionPct = bytesBefore > 0 ? ((bytesBefore - bytesAfter) / bytesBefore) * 100 : 0;
    console.log(`  total HTML: ${bytesBefore.toLocaleString()} → ${bytesAfter.toLocaleString()} bytes (${reductionPct.toFixed(1)}% reduction)`);
  }
  if (sampleDiffs.length > 0) {
    console.log(`\nFirst ${sampleDiffs.length} diffs:`);
    for (const d of sampleDiffs) {
      const pct = ((d.before - d.after) / d.before) * 100;
      console.log(`  #${d.id}  ${d.before.toLocaleString()} → ${d.after.toLocaleString()} bytes  (-${pct.toFixed(0)}%)  ${d.subject}`);
    }
  }
  if (DRY_RUN) {
    console.log("\n[dry-run] No changes written. Re-run without --dry-run to apply.");
  }
}

main();
