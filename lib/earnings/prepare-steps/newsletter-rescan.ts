/**
 * Live print v2 slice A, spec §4.1 step 1 — the `newsletter_rescan` prepare
 * step.
 *
 * The global newsletter bogey scan (lib/earnings/extract-newsletter-bogeys.ts)
 * walks UNSCANNED articles once and stamps `research_articles.bogeys_scanned_at`.
 * An event armed AFTER an article was scanned therefore never gets that
 * author's numbers. This step re-reads the last RESCAN_WINDOW_DAYS of articles
 * for ONE armed event through the pure per-event path, which shares the global
 * scan's prompt/parser/write and never touches the global marker.
 *
 * Durability: every (event, article, extractor_version) attempt is a row in
 * `earnings_bogey_scans`, CLAIMED BEFORE the model call. That makes the step
 * resumable — an aborted or crashed pass leaves finalised rows finalised and a
 * stale claim the next tick takes over — and caps the cost of a crash loop at
 * SCAN_MAX_ATTEMPTS model calls per pair [C-11], because a takeover counts the
 * dead attempt.
 *
 * [R20] A pair the GLOBAL scan already extracted for this event (the normal case
 * for a held — therefore covered — name that is then armed) is banked straight
 * into the ledger as `hit` off the existing `earnings_bogeys` row, with no model
 * call at all.
 *
 * [R13]/[R22] The step is a LOOP OF MODEL CALLS, each tens of seconds. Three
 * things stop a pass, all of them `pending` (which costs no attempt) so the next
 * tick resumes off the ledger:
 *   - the SOFT BUDGET (RESCAN_MAX_ARTICLES_PER_PASS calls, or
 *     RESCAN_SOFT_DEADLINE_MS on `ctx.now`) — the normal stop, deliberately
 *     inside the runner's 4-minute hard deadline, which would otherwise book the
 *     step `failed` every pass on a large corpus and retire it;
 *   - a pair held by another pass's LIVE claim (`deferred`);
 *   - `ctx.signal.aborted`, the backstop for when the hard deadline wins anyway.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  extractBogeysFromArticleForEvent,
  NEWSLETTER_EXTRACTOR_VERSION,
} from "@/lib/earnings/extract-newsletter-bogeys";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

/** How far back the rescan reaches. Bogeys age out fast; two weeks covers the
 *  weekly + preview newsletters that carry a name into its print. */
export const RESCAN_WINDOW_DAYS = 14;
/** Model calls per (event, article, extractor_version) before the pair is retired.
 *  The cap covers BOTH the error-retry path and the stale-claim takeover path — a
 *  pair that crashes the process mid-call must not be re-claimed forever. */
export const SCAN_MAX_ATTEMPTS = 3;
/**
 * [R22] Model calls one pass will make before handing the rest to the next tick.
 * The runner books a step `failed` at its own 4-minute hard deadline, so a large
 * 14-day corpus would time out pass after pass and retire the step at
 * PREPARE_MAX_ATTEMPTS. The soft budget makes the step return `pending` — which
 * costs no attempt — well before the hard deadline can fire.
 */
export const RESCAN_MAX_ARTICLES_PER_PASS = 8;
/** [R22] Wall-clock half of the soft budget, read off `ctx.now`. Strictly inside
 *  the runner's PREPARE_STEP_TIMEOUT_MS (4 min), for the same reason. */
export const RESCAN_SOFT_DEADLINE_MS = 3 * 60_000;
/** A `claimed` ledger row older than this belonged to a worker that died. */
const CLAIM_STALE_MINUTES = 5;

interface ArticleRow {
  id: number;
  source_name: string;
  subject: string;
  received_at: string;
  raw_text: string;
}
interface EventRow {
  id: number;
  symbol: string | null;
  event_date: string;
}

export function makeNewsletterRescanStep(
  deps: { extract?: typeof extractBogeysFromArticleForEvent } = {},
): PrepareStepDefinition {
  const extract = deps.extract ?? extractBogeysFromArticleForEvent;
  return {
    fingerprint(db, eventId) {
      const e = db.prepare(`SELECT symbol FROM calendar_events WHERE id = ?`).get(eventId) as
        | { symbol: string | null }
        | undefined;
      // Deliberately NOT keyed on the article set. This step is a ONE-SHOT
      // BACKFILL of articles the global sweep consumed BEFORE the arm; articles
      // that arrive AFTER it are the global scan's job, which (since Task 4
      // rewired `getUpcomingReporters` to `coveredForEvents`) already treats an
      // armed event as covered. Drifting on every new article would re-run this
      // whole loop for work the sweep is already doing.
      //
      // Drift is therefore reserved for a change that invalidates what was
      // already scanned: the event's symbol (a Task 7 date correction re-pointing
      // the row) or the extractor version.
      return stableHash([
        "newsletter_rescan",
        eventId,
        e?.symbol ?? null,
        RESCAN_WINDOW_DAYS,
        NEWSLETTER_EXTRACTOR_VERSION,
      ]);
    },

    async run(db, eventId, ctx) {
      const e = db
        .prepare(`SELECT id, symbol, event_date FROM calendar_events WHERE id = ?`)
        .get(eventId) as EventRow | undefined;
      if (!e?.symbol) return { status: "failed", error: `event ${eventId} has no symbol` };

      // Same article floor as the global scan (raw_text present, > 200 chars):
      // the two paths must consider the same corpus or the rescan would "find"
      // articles the sweep never offered the model.
      const candidates = db
        .prepare(
          `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text
             FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
            WHERE a.received_at >= datetime('now', ?) AND a.raw_text IS NOT NULL AND length(a.raw_text) > 200
            ORDER BY a.received_at DESC, a.id DESC`,
        )
        .all(`-${RESCAN_WINDOW_DAYS} days`) as ArticleRow[];

      let scanned = 0;
      let hits = 0;
      let exhausted = 0;
      let errors = 0;
      let deferred = 0;
      let preExisting = 0;
      let modelCalls = 0;
      let budgetReached = false;
      const startedAt = ctx.now();

      for (const article of candidates) {
        // [R13] Between articles only: an in-flight call is allowed to finish and
        // be BOOKED, because its bogey write has already landed — dropping the
        // ledger row would just buy a duplicate model call on the next tick.
        // This stays the BACKSTOP; the soft budget below is what normally stops a
        // pass, early enough that `pending` lands before the runner's hard deadline.
        if (ctx.signal.aborted) return { status: "pending", reason: "aborted; resume next tick" };

        // [R22] Soft budget: hand the rest of the corpus to the next tick rather
        // than let the runner's 4-minute deadline book this step `failed` (which
        // costs an attempt and, repeated, retires the step entirely).
        if (modelCalls >= RESCAN_MAX_ARTICLES_PER_PASS || ctx.now() - startedAt > RESCAN_SOFT_DEADLINE_MS) {
          budgetReached = true;
          break;
        }

        // [R20] The global scan may already have extracted this very article for
        // this event — the normal case for a name that was HELD (so covered) and
        // is then armed. Bank the pair as a hit from the existing bogey row and
        // spend no model call on it. Never disturbs a live claim.
        const already = db
          .prepare(`SELECT 1 AS present FROM earnings_bogeys WHERE event_id = ? AND research_article_id = ? LIMIT 1`)
          .get(e.id, article.id) as { present: number } | undefined;
        if (already) {
          db.prepare(
            `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, attempts, scanned_at, updated_at)
             VALUES (?, ?, ?, 'hit', 0, datetime('now'), datetime('now'))
             ON CONFLICT(event_id, article_id, extractor_version) DO UPDATE SET
               status = 'hit', scanned_at = COALESCE(earnings_bogey_scans.scanned_at, datetime('now')),
               claim_token = NULL, updated_at = datetime('now')
             WHERE earnings_bogey_scans.status <> 'claimed'`,
          ).run(e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION);
          preExisting += 1;
          continue;
        }

        const token = randomUUID();
        // Claim-first: the ledger row is inserted BEFORE the model call, so a crash
        // mid-call leaves a stale claim the next run takes over (<= 1 extra call per
        // crash) instead of an invisible gap. The DO UPDATE fires only for a retryable
        // error row or a stale claim, and — in BOTH cases — only under the attempt
        // cap: without that, a pair that kills the process mid-call would be
        // re-claimed and re-called on every single pass, forever.
        // A `hit`/`no_numbers`/live-claim row is left alone.
        const claimed = db
          .prepare(
            `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, claim_token, updated_at)
             VALUES (?, ?, ?, 'claimed', ?, datetime('now'))
             ON CONFLICT(event_id, article_id, extractor_version) DO UPDATE SET
               claim_token = excluded.claim_token, status = 'claimed', updated_at = datetime('now'),
               attempts = earnings_bogey_scans.attempts + CASE WHEN earnings_bogey_scans.status = 'claimed' THEN 1 ELSE 0 END   -- [C-11] a takeover counts the dead attempt
             WHERE earnings_bogey_scans.attempts < ?
               AND (earnings_bogey_scans.status = 'error'
                    OR (earnings_bogey_scans.status = 'claimed' AND datetime(earnings_bogey_scans.updated_at) < datetime('now', ?)))`,
          )
          .run(
            e.id,
            article.id,
            NEWSLETTER_EXTRACTOR_VERSION,
            token,
            SCAN_MAX_ATTEMPTS,
            `-${CLAIM_STALE_MINUTES} minutes`,
          ).changes;

        if (claimed === 0) {
          const row = db
            .prepare(
              `SELECT status, attempts,
                      CASE WHEN datetime(updated_at) < datetime('now', ?) THEN 1 ELSE 0 END AS stale
                 FROM earnings_bogey_scans
                WHERE event_id = ? AND article_id = ? AND extractor_version = ?`,
            )
            .get(`-${CLAIM_STALE_MINUTES} minutes`, e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION) as
            | { status: string; attempts: number; stale: number }
            | undefined;
          if (row?.status === "claimed" && row.stale === 0) {
            // Someone else's LIVE claim (a concurrent pass, or this process before
            // it crashed less than CLAIM_STALE_MINUTES ago). Not ours to touch —
            // but not "done" either: swallowing it would pin the step row `done`
            // until fingerprint drift and the pair would never be scanned. Defer.
            deferred += 1;
          } else if (row && row.attempts >= SCAN_MAX_ATTEMPTS && (row.status === "error" || row.status === "claimed")) {
            // Spent: an error at the cap, or a stale claim the cap now refuses to
            // take over. Both are terminal for this extractor version.
            exhausted += 1;
          }
          continue; // hit / no_numbers / live claim / spent -> nothing to do
        }

        // CAS on the token, exactly like the prepare runner: a superseded worker's
        // outcome can never land on top of its successor's.
        const finalize = (status: "hit" | "no_numbers" | "error", modelId: string | null, attemptDelta: number) =>
          db
            .prepare(
              `UPDATE earnings_bogey_scans
                  SET status = ?, model_id = ?, attempts = attempts + ?,
                      scanned_at = CASE WHEN ? = 'error' THEN scanned_at ELSE datetime('now') END,
                      claim_token = NULL, updated_at = datetime('now')
                WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
            )
            .run(status, modelId, attemptDelta, status, e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION, token);

        try {
          const r = await extract(db, article, {
            event_id: e.id,
            symbol: e.symbol,
            event_date: e.event_date,
          });
          if (!r.called) {
            // The symbol isn't in this article: not a scan, and not something to
            // bank. Release the claim row so a later re-symbol of the event (or a
            // corrected article body) is free to try again.
            db.prepare(
              `DELETE FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
            ).run(e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION, token);
            continue;
          }
          scanned += 1;
          modelCalls += 1; // [R22] only a real call counts against the pass budget
          if (r.bogeysStored > 0) {
            hits += 1;
            finalize("hit", r.modelId, 1);
          } else {
            finalize("no_numbers", r.modelId, 1);
          }
        } catch (err) {
          errors += 1;
          modelCalls += 1; // a failed call cost just as much time as a good one
          finalize("error", null, 1);
          console.warn(
            `[prepare/newsletter_rescan] event ${e.id} article ${article.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (errors > 0) return { status: "failed", error: `${errors} article scan(s) failed` };
      // Both remaining incomplete outcomes are `pending`: it costs no attempt, and
      // the next tick resumes off the ledger (a foreign claim will have gone stale
      // by then, and the budget resets).
      if (deferred > 0) {
        return { status: "pending", reason: `${deferred} pair(s) claimed by another pass; resume next tick` };
      }
      if (budgetReached) return { status: "pending", reason: "budget reached; resume next tick" };

      const extras: string[] = [];
      if (preExisting > 0) extras.push(`${preExisting} pre-existing from the global scan`);
      if (exhausted > 0) extras.push(`${exhausted} exhausted`);
      const note = `${scanned} scanned, ${hits} hit${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
      return { status: "done", note };
    },
  };
}

export const newsletterRescanStep = makeNewsletterRescanStep();
