/**
 * Manually run the newsletter AI-processing pass (summary/sentiment/symbols)
 * over every research_articles row with processed_at IS NULL — the same
 * pass research-sync runs. Companion to scripts/backfill-longform-bodies.ts
 * --reprocess, which queues rows by NULLing processed_at.
 *
 * Usage: npx tsx scripts/process-unprocessed-articles.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { processUnprocessedArticles } from "../lib/gmail/process";

processUnprocessedArticles(db)
  .then((res) => {
    console.log("processed:", JSON.stringify(res));
  })
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
