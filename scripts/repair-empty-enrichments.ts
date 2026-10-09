/**
 * repair-empty-enrichments.ts — companion to the QA finding
 * research-feeds--empty-enrichment-marked-processed-fake-neutral-chip
 * (2026-08-19, HIGH).
 *
 * Root cause: when the newsletter-processing LLM call returned nothing
 * usable, lib/gmail/process.ts still stamped `processed_at` and stored the
 * schema's bare defaults (summary='', key_themes=[], mentioned_symbols=[],
 * portfolio_relevance='', sentiment='neutral', sentiment_score=0) as if
 * they were a genuine successful read. 78 research_articles rows were
 * found in exactly this all-defaults shape — 61/78 on ai_model=
 * claude-sonnet-5, so this was not just a cloud-fallback artifact. The
 * Research Feeds card then rendered a fabricated 'neutral' sentiment chip
 * on an otherwise-empty 121px stub card.
 *
 * lib/gmail/process.ts's processUnprocessedArticles now guards this at the
 * source (isEmptyEnrichmentResult) — an all-defaults parse is treated as a
 * FAILED extraction and no longer stamps processed_at. This script repairs
 * the rows the bug already produced: it clears `processed_at` on any row
 * matching the exact all-defaults signature so the next
 * processUnprocessedArticles pass retries them (its SELECT filters on
 * `processed_at IS NULL`). It never touches summary/key_themes/sentiment/
 * etc — those get overwritten naturally once the retry succeeds.
 *
 * Selector (widened 2026-10-08, owner ruling; ALL must hold):
 *   - summary IS NULL or ''
 *   - key_themes parses to an empty JSON array (or is NULL)
 *   - processed_at IS NOT NULL (nothing to repair on an already-unprocessed
 *     row)
 *   - relevant (COALESCE(is_relevant, 1) = 1): a filtered row is never picked
 *     up by the enrich queue, so clearing it would repair nothing
 * Symbols, relevance prose and sentiment are NOT part of the selector: cloud-
 * fetched rows carry subject-backstop symbols and a model-stamped sentiment
 * yet are just as empty. Same definition as lib/research/empty-enrichment.ts.
 *
 * Re-enrichment costs paid AI calls (at most 20 articles per pass, up to
 * MAX_ENRICH_ATTEMPTS attempts each); the report prints that bound.
 *
 * Dry-run by default:  npx tsx scripts/repair-empty-enrichments.ts
 * Apply:               npx tsx scripts/repair-empty-enrichments.ts --apply
 * Override DB path:    npx tsx scripts/repair-empty-enrichments.ts --db <path>
 *
 * Idempotent: a repaired row's processed_at is NULL, which no longer
 * matches the `processed_at IS NOT NULL` selector clause — a re-run finds
 * 0 rows and writes nothing.
 */
import type Database from "better-sqlite3";
import { isEmptyEnrichment } from "@/lib/research/empty-enrichment";
import { MAX_ENRICH_ATTEMPTS } from "@/lib/gmail/enrichment-failure";

// ─── Selector (pure, unit-tested) ──────────────────────────────────

export interface EmptyEnrichmentRow {
  id: number;
  subject: string;
}

interface RawRow {
  id: number;
  subject: string;
  summary: string | null;
  key_themes: string | null;
  processed_at: string | null;
  is_relevant: number | null;
}

/** The empty-enrichment signature (shared definition) on a processed,
 *  relevant row — see file header. */
function isEmptyEnrichmentRow(row: RawRow): boolean {
  return (
    row.processed_at != null &&
    (row.is_relevant ?? 1) === 1 &&
    isEmptyEnrichment(row.summary, row.key_themes)
  );
}

/** Plain-words bound on the paid AI calls the repaired rows will cost. */
export function reEnrichmentCostNote(rowCount: number): string {
  return (
    `Re-enrichment makes paid AI calls: ${rowCount} row(s), at most 20 per pass, ` +
    `up to ${MAX_ENRICH_ATTEMPTS} attempts each (up to ${rowCount * MAX_ENRICH_ATTEMPTS} calls in the worst case).`
  );
}

/** Finds every research_articles row matching the all-defaults signature. */
export function findEmptyEnrichmentRows(db: Database.Database): EmptyEnrichmentRow[] {
  const rows = db
    .prepare(
      `SELECT id, subject, summary, key_themes, processed_at, is_relevant
         FROM research_articles
        WHERE processed_at IS NOT NULL`,
    )
    .all() as RawRow[];

  return rows
    .filter(isEmptyEnrichmentRow)
    .map((r) => ({ id: r.id, subject: r.subject }));
}

/**
 * Clears processed_at on every row matching the all-defaults signature.
 * `opts.apply === false` (dry-run, default): returns matches, writes
 * nothing. `opts.apply === true`: clears processed_at on all matches
 * inside one transaction.
 */
export function repairEmptyEnrichments(
  db: Database.Database,
  opts: { apply: boolean },
): { matched: EmptyEnrichmentRow[]; repaired: number } {
  const matched = findEmptyEnrichmentRows(db);
  let repaired = 0;

  if (opts.apply && matched.length > 0) {
    const clear = db.prepare(`UPDATE research_articles SET processed_at = NULL WHERE id = ?`);
    const tx = db.transaction((rows: EmptyEnrichmentRow[]) => {
      for (const row of rows) {
        clear.run(row.id);
        repaired += 1;
      }
    });
    tx(matched);
  }

  return { matched, repaired };
}

// ─── CLI entry point ────────────────────────────────────────────────

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-etf-types.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-empty-enrichments.ts") ||
    process.argv[1].endsWith("repair-empty-enrichments.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");

    const dbFlagIdx = args.indexOf("--db");
    const dbPath =
      dbFlagIdx !== -1 && args[dbFlagIdx + 1]
        ? args[dbFlagIdx + 1]
        : path.default.join(process.cwd(), "data", "vanguard.db");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
      return;
    }

    // 60s lock wait — the live app's background sync can hold the write lock
    // past better-sqlite3's 5s default.
    const db = new BetterSqlite3(dbPath, { timeout: 60000 });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    try {
      console.log(
        `Empty-enrichment repair ${apply ? "[APPLY]" : "[DRY RUN]"} — db: ${dbPath}\n`,
      );

      if (apply && findEmptyEnrichmentRows(db).length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = path.default.join(process.cwd(), "data", "backups");
        fs.default.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.default.join(
          backupDir,
          `pre-empty-enrichments-${timestamp}.db`,
        );
        db.prepare(`VACUUM INTO ?`).run(backupPath);
        console.log(`Backup: ${backupPath}\n`);
      }

      const { matched, repaired } = repairEmptyEnrichments(db, { apply });

      if (matched.length === 0) {
        console.log("No empty-enrichment rows found. Nothing to do.");
      } else {
        for (const row of matched) {
          console.log(`row ${row.id}: "${row.subject.slice(0, 80)}"`);
        }
        console.log(
          apply
            ? `\nCleared processed_at on ${repaired} of ${matched.length} row(s) — they will be retried on the next enrich pass.`
            : `\nWould clear processed_at on ${matched.length} row(s). Re-run with --apply.`,
        );
        console.log(reEnrichmentCostNote(matched.length));
      }
    } finally {
      db.close();
    }
  })();
}
