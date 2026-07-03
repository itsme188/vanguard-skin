/**
 * Refetch full bodies for research_articles that were clipped at the old
 * 50k raw_text store cap (R2 long-email audit, 2026-07-03 — 48 live rows
 * sat at exactly LENGTH(raw_text)=50000, 13 of them Eliant Capital
 * weeklies). Gmail still holds the complete messages; this refetches each
 * by gmail_message_id and stores the body/html under the raised caps
 * (lib/gmail/prompt-caps.ts).
 *
 * Usage:
 *   npx tsx scripts/backfill-longform-bodies.ts            # dry-run (default)
 *   npx tsx scripts/backfill-longform-bodies.ts --apply    # write
 *   npx tsx scripts/backfill-longform-bodies.ts --apply --reprocess
 *
 * --reprocess additionally NULLs processed_at/summary on the updated rows
 * so the next research-sync re-analyzes them with the raised 150k
 * extraction prompt cap (costs ~$0.10/article of Sonnet input).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { isGmailConfigured, getGmailClient } from "../lib/gmail/auth";
import { extractBody } from "../lib/gmail/fetch";
import { sanitizeNewsletterHtml, normalizeNewsletterHtml } from "../lib/gmail/sanitize";
import { RAW_TEXT_STORE_CAP, RAW_HTML_STORE_CAP } from "../lib/gmail/prompt-caps";

const APPLY = process.argv.includes("--apply");
const REPROCESS = process.argv.includes("--reprocess");
const OLD_CAP = 50_000;

interface Row {
  id: number;
  gmail_message_id: string;
  subject: string;
  source_name: string;
  text_len: number;
}

async function main() {
  if (!isGmailConfigured()) {
    console.error("Gmail is not configured (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN) — aborting.");
    process.exit(1);
  }
  const gmail = getGmailClient();

  const rows = db
    .prepare(
      `SELECT a.id, a.gmail_message_id, a.subject, s.name AS source_name,
              LENGTH(a.raw_text) AS text_len
       FROM research_articles a
       JOIN research_sources s ON s.id = a.source_id
       WHERE LENGTH(a.raw_text) >= ? AND a.gmail_message_id IS NOT NULL
       ORDER BY a.received_at DESC`,
    )
    .all(OLD_CAP) as Row[];

  console.log(`${rows.length} article(s) at/over the old ${OLD_CAP}-char cap${APPLY ? "" : " (dry-run — pass --apply to write)"}`);

  const updateBody = db.prepare(
    "UPDATE research_articles SET raw_text = ?, raw_html = COALESCE(?, raw_html) WHERE id = ?",
  );
  const markReprocess = db.prepare(
    "UPDATE research_articles SET processed_at = NULL, summary = NULL WHERE id = ?",
  );

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: row.gmail_message_id,
        format: "full",
      });
      const { text, html } = extractBody(msg.data.payload);
      const newText = text.slice(0, RAW_TEXT_STORE_CAP);
      const newHtml = html
        ? normalizeNewsletterHtml(sanitizeNewsletterHtml(html)).slice(0, RAW_HTML_STORE_CAP)
        : null;

      if (newText.length <= row.text_len) {
        unchanged++;
        console.log(`  = #${row.id} [${row.source_name}] "${row.subject.slice(0, 60)}" — full body is ${newText.length} chars (no gain)`);
        continue;
      }

      console.log(`  + #${row.id} [${row.source_name}] "${row.subject.slice(0, 60)}" — ${row.text_len} → ${newText.length} chars`);
      if (APPLY) {
        updateBody.run(newText, newHtml, row.id);
        if (REPROCESS) markReprocess.run(row.id);
      }
      updated++;
    } catch (e) {
      failed++;
      console.warn(`  ! #${row.id} refetch failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(
    `Done. ${updated} ${APPLY ? "updated" : "would update"}, ${unchanged} already-full, ${failed} failed.` +
      (APPLY && REPROCESS && updated > 0
        ? ` ${updated} row(s) queued for re-analysis on the next research-sync.`
        : ""),
  );
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
