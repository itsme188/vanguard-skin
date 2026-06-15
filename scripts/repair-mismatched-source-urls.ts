/**
 * Repair research_articles whose source_url was mis-extracted as an in-body
 * link to a DIFFERENT publication's Substack post (the 2026-06 Sharp Text →
 * soapboxtrade.substack bug). Targets the exact bug signature — a
 * `*.substack.com/p/...` source_url whose host is NOT on the same registrable
 * domain as the sender — and re-runs the now sender-aware extractSourceUrl.
 * Updates each row to the recomputed URL (or NULL when none can be recovered).
 *
 * Dry-run by default; pass --apply to write. Idempotent.
 *
 *   npx tsx scripts/repair-mismatched-source-urls.ts          # preview
 *   npx tsx scripts/repair-mismatched-source-urls.ts --apply  # write
 */
import Database from "better-sqlite3";
import { extractSourceUrl } from "@/lib/gmail/extract-url";

const APPLY = process.argv.includes("--apply");

function registrableDomain(host: string): string {
  return host.toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
}
function senderDomain(sender: string | null): string {
  const m = sender?.match(/@([a-z0-9.-]+)/i);
  return m ? registrableDomain(m[1]) : "";
}
function urlHostDomain(url: string): string {
  try {
    return registrableDomain(new URL(url).host);
  } catch {
    return "";
  }
}

const db = new Database("data/vanguard.db");

// Candidate set: a substack /p/ source_url whose host differs from the sender's
// registrable domain — the precise mis-attribution the fixed extractor avoids.
const rows = db
  .prepare(
    `SELECT id, sender, source_url, raw_html, raw_text
     FROM research_articles
     WHERE source_url LIKE '%.substack.com/p/%'`
  )
  .all() as Array<{
  id: number;
  sender: string | null;
  source_url: string;
  raw_html: string | null;
  raw_text: string | null;
}>;

let mismatched = 0;
let changed = 0;
for (const r of rows) {
  const sd = senderDomain(r.sender);
  const ud = urlHostDomain(r.source_url);
  // Only touch rows where the stored url is cross-publication vs the sender.
  if (!sd || !ud || sd === ud) continue;
  mismatched++;

  const recomputed = extractSourceUrl(r.raw_html, r.raw_text, r.sender);
  if (recomputed === r.source_url) continue; // extractor agrees — leave it
  changed++;
  console.log(
    `#${r.id} (${r.sender})\n  OLD: ${r.source_url}\n  NEW: ${recomputed ?? "(null)"}`,
  );
  if (APPLY) {
    db.prepare(`UPDATE research_articles SET source_url = ? WHERE id = ?`).run(
      recomputed,
      r.id,
    );
  }
}

console.log(
  `\n${rows.length} substack-/p/ rows · ${mismatched} cross-publication · ${changed} ${APPLY ? "updated" : "would change"}` +
    (APPLY ? "" : "  (dry-run — pass --apply to write)"),
);
db.close();
