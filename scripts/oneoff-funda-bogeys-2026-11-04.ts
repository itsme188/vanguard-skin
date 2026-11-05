/**
 * OPERATOR ONE-OFF (owner-approved 2026-11-04). NOT a rule change.
 *
 * 1. Extract bogeys from FundaAI article 121342 ("Preview | APP & U 3Q26") for
 *    APP event 2161 and Unity event 2308, through the pipeline's own per-event
 *    path (`extractBogeysFromArticleForEvent`) and the rescan step's own ledger
 *    protocol (claim row -> call -> CAS finalise). The standing TMT-only source
 *    gate (lib/earnings/bogey-scan-eligibility.ts) is bypassed HERE ONLY, for
 *    this one article id: the script never calls the gate and changes no lib/ code.
 *    Stored rows: earnings_bogeys source 'newsletter', source_label 'FundaAI ...'.
 * 2. Retire two stale newsletter_synthesis rows (AAPL event 2012, SHOP event 2170;
 *    both already printed and recapped) into the runner's own spent state:
 *    status 'failed', attempts = PREPARE_MAX_ATTEMPTS, last_error 'retired: ...'
 *    (the shape `retireRow` in lib/earnings/prepare-armed-event.ts writes).
 * 3. With --run-synthesis, run the prepare runner for events 2161 and 2308 so their
 *    parked newsletter_synthesis steps run now instead of waiting for the cadence.
 *
 * Writes touch ONLY: article 121342 x events 2161/2308 (scan ledger + bogey rows),
 * newsletter_synthesis rows of events 2012/2170, and (with --run-synthesis) the
 * prepare/synthesis rows and the deep-read bogey row of events 2161/2308.
 *
 * Database: --db <path> or REPAIR_DB_PATH (required; the path is printed first).
 * Dry run by default; --apply writes, after a VACUUM backup next to the database.
 * Needs the AI keys in the environment (source .env.local); no secret is printed.
 *
 *   npx tsx scripts/oneoff-funda-bogeys-2026-11-04.ts --db <path>
 *   npx tsx scripts/oneoff-funda-bogeys-2026-11-04.ts --db <path> --apply [--run-synthesis]
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  extractBogeysFromArticleForEvent,
  newsletterExtractorVersionForArticle,
  type ArticleInput,
} from "../lib/earnings/extract-newsletter-bogeys";
import { accountFailureOf } from "../lib/earnings/ai-unavailable";
import { PREPARE_MAX_ATTEMPTS, runPrepareSteps } from "../lib/earnings/prepare-armed-event";

const ARTICLE_ID = 121342;
const EVENT_IDS = [2161, 2308] as const;
const STALE_SYNTHESIS_EVENTS = [2012, 2170] as const;
const SCAN_MAX_ATTEMPTS = 3; // same cap the rescan step uses
const RETIRE_NOTE = "retired: print already recapped; stale synthesis retired by operator one-off 2026-11-04";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface EventRow { id: number; symbol: string | null; event_date: string }

async function main(): Promise<void> {
  const dbPath = argValue("--db") ?? process.env.REPAIR_DB_PATH;
  if (!dbPath) throw new Error("Pass --db <path> or set REPAIR_DB_PATH.");
  const apply = process.argv.includes("--apply");
  const runSynthesis = process.argv.includes("--run-synthesis");
  const abs = path.resolve(dbPath);
  console.log(`[oneoff-funda] database: ${abs}`);
  console.log(`[oneoff-funda] mode: ${apply ? "APPLY" : "dry run"}${runSynthesis ? " + run synthesis" : ""}`);

  const db: Database.Database = new BetterSqlite3(abs);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 15000");

  // ---- Preconditions (read-only) -------------------------------------------
  const art = db
    .prepare(
      `SELECT a.id, a.source_id, rs.name AS source_name, a.subject, a.received_at, a.raw_text, a.raw_html
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`,
    )
    .get(ARTICLE_ID) as (ArticleInput & { source_id: number; raw_html: string | null }) | undefined;
  if (!art) throw new Error(`article ${ARTICLE_ID} not found`);
  if (art.source_id !== 21 || !/APP & U 3Q26/.test(art.subject)) {
    throw new Error(`article ${ARTICLE_ID} is not the expected FundaAI preview (source ${art.source_id}, "${art.subject}")`);
  }
  console.log(`[oneoff-funda] article ${art.id}: ${art.source_name} | ${art.subject} | ${art.received_at}`);

  const events = EVENT_IDS.map((id) => {
    const e = db.prepare(`SELECT id, symbol, event_date FROM calendar_events WHERE id = ?`).get(id) as EventRow | undefined;
    if (!e?.symbol) throw new Error(`event ${id} missing or has no symbol`);
    return e as EventRow & { symbol: string };
  });
  for (const e of events) console.log(`[oneoff-funda] event ${e.id}: ${e.symbol} ${e.event_date}`);

  const stepRow = (id: number) =>
    db.prepare(`SELECT status, attempts, last_error FROM earnings_prepare_steps WHERE event_id = ? AND step = 'newsletter_synthesis'`).get(id) as
      | { status: string; attempts: number; last_error: string | null }
      | undefined;
  for (const id of STALE_SYNTHESIS_EVENTS) {
    const e = db.prepare(`SELECT symbol, event_date FROM calendar_events WHERE id = ?`).get(id) as { symbol: string; event_date: string } | undefined;
    console.log(`[oneoff-funda] stale synthesis event ${id} (${e?.symbol} ${e?.event_date}):`, JSON.stringify(stepRow(id)));
  }
  for (const e of events) console.log(`[oneoff-funda] synthesis event ${e.id}:`, JSON.stringify(stepRow(e.id)));

  if (!apply) {
    console.log("[oneoff-funda] dry run: nothing written. Re-run with --apply.");
    return;
  }

  // ---- Backup, then writes ---------------------------------------------------
  const backup = `${abs}.pre-funda-oneoff-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`[oneoff-funda] backup: ${backup}`);

  // 1. Retire the stale syntheses (guarded: only a pending row of those two events).
  for (const id of STALE_SYNTHESIS_EVENTS) {
    const n = db
      .prepare(
        `UPDATE earnings_prepare_steps
            SET status = 'failed', attempts = ?, last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = 'newsletter_synthesis' AND status = 'pending'`,
      )
      .run(PREPARE_MAX_ATTEMPTS, RETIRE_NOTE, id).changes;
    console.log(`[oneoff-funda] retired synthesis for event ${id}: ${n} row(s)`);
  }

  // 2. Extraction, with the rescan step's ledger protocol.
  const version = newsletterExtractorVersionForArticle(art);
  let aiDown = false;
  for (const e of events) {
    if (aiDown) break;
    const token = randomUUID();
    // Stale-claim cutoff bound from JS (an instant, not a UTC calendar day).
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const claimed = db
      .prepare(
        `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, claim_token, updated_at)
         VALUES (?, ?, ?, 'claimed', ?, datetime('now'))
         ON CONFLICT(event_id, article_id, extractor_version) DO UPDATE SET
           claim_token = excluded.claim_token, status = 'claimed', updated_at = datetime('now'),
           attempts = earnings_bogey_scans.attempts + CASE WHEN earnings_bogey_scans.status = 'claimed' THEN 1 ELSE 0 END
         WHERE earnings_bogey_scans.attempts < ?
           AND (earnings_bogey_scans.status = 'error'
                OR (earnings_bogey_scans.status = 'claimed' AND datetime(earnings_bogey_scans.updated_at) < datetime(?)))`,
      )
      .run(e.id, art.id, version, token, SCAN_MAX_ATTEMPTS, staleBefore).changes;
    if (claimed === 0) {
      console.log(`[oneoff-funda] event ${e.id}: ledger row already final or claimed; skipping extraction`);
      continue;
    }
    const finalize = (status: "hit" | "no_numbers" | "error", modelId: string | null, delta: number) =>
      db
        .prepare(
          `UPDATE earnings_bogey_scans
              SET status = ?, model_id = ?, attempts = attempts + ?,
                  scanned_at = CASE WHEN ? = 'error' THEN scanned_at ELSE datetime('now') END,
                  claim_token = NULL, updated_at = datetime('now')
            WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
        )
        .run(status, modelId, delta, status, e.id, art.id, version, token);
    try {
      const r = await extractBogeysFromArticleForEvent(
        db,
        { id: art.id, source_name: art.source_name, subject: art.subject, received_at: art.received_at, raw_text: art.raw_text, raw_html: art.raw_html },
        { event_id: e.id, symbol: e.symbol, event_date: e.event_date },
      );
      if (!r.called) {
        db.prepare(`DELETE FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`).run(e.id, art.id, version, token);
        console.log(`[oneoff-funda] event ${e.id}: symbol not found in article; nothing called`);
        continue;
      }
      finalize(r.bogeysStored > 0 ? "hit" : r.imagesIncomplete ? "error" : "no_numbers", r.modelId, 1);
      console.log(`[oneoff-funda] event ${e.id}: bogeysStored=${r.bogeysStored} model=${r.modelId} imagesIncomplete=${!!r.imagesIncomplete}`);
    } catch (err) {
      const af = accountFailureOf(err);
      if (af) {
        finalize("error", null, 0); // no attempt spent: the account failed, not the article
        console.error(`[oneoff-funda] event ${e.id}: AI unavailable (${af}); stopping. No attempt counted.`);
        aiDown = true;
      } else {
        finalize("error", null, 1);
        console.error(`[oneoff-funda] event ${e.id}: extraction failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // 3. Stored rows, verbatim.
  for (const e of events) {
    const rows = db
      .prepare(`SELECT id, source, source_label, research_article_id, eps_consensus, eps_whisper, notes FROM earnings_bogeys WHERE event_id = ? AND research_article_id = ?`)
      .all(e.id, art.id);
    console.log(`[oneoff-funda] STORED event ${e.id} (${e.symbol}):`, JSON.stringify(rows, null, 2));
  }

  // 4. Expedite the parked syntheses.
  if (runSynthesis && !aiDown) {
    for (const e of events) {
      const rep = await runPrepareSteps(db, { eventId: e.id });
      console.log(`[oneoff-funda] runner event ${e.id}:`, JSON.stringify(rep), JSON.stringify(stepRow(e.id)));
    }
  }
  for (const e of events) console.log(`[oneoff-funda] FINAL synthesis event ${e.id}:`, JSON.stringify(stepRow(e.id)));
  db.close();
}

main().catch((err) => {
  console.error("[oneoff-funda] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
