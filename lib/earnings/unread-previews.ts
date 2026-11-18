/**
 * The "not read" list on an armed Earnings Hub row, and the one-click read
 * behind it (bogey intake 2026-11-18, Task D; amendment A6 is binding).
 *
 * LISTED for an event: an article whose `raw_text` names the event's ticker
 * family (`isSymbolMentioned` over `issuerSiblings`, the very test
 * `extractBogeysFromArticleForEvent` applies, so the button always reaches the
 * model), received inside the armed deep read's window (DEEP_READ_WINDOW_DAYS
 * before the print's slot floor, cut at the floor and at now), for an event
 * that exists and is not superseded, with NO `earnings_bogey_scans` row for
 * this event at status `hit` or `no_numbers` at any extractor version. The
 * bogey-scan gate (`bogey-scan-eligibility.ts`) is deliberately NOT applied:
 * the list exists to show the owner what the automatic readers skipped or
 * failed on. A name-only mention ("Acmeworks" with no "ACME") is not listed,
 * because the per-article reader needs the ticker; the deep read covers those
 * for sources the gate lets in.
 *
 * Each listed row has a state: `not_read` (no ledger row), `read_failed` (an
 * `error` row, or a claim older than CLAIM_STALE_MINUTES whose worker died),
 * `reading` (a fresher claim; the UI shows no button).
 *
 * READING mirrors the rescan prepare step's ledger protocol
 * (`prepare-steps/newsletter-rescan.ts`): re-check eligibility, claim with a
 * fresh `claim_token` before the model call, finalise by compare-and-set on
 * that token. Owner-click differences, on purpose:
 *   - No SCAN_MAX_ATTEMPTS cap: the owner asked for this read. A takeover of a
 *     dead claim still counts the dead attempt, as in the step.
 *   - An account outage books NOTHING: the row is put back exactly as it was
 *     (deleted when the claim created it), where the step books a no-attempt
 *     `error`. The article stays on the list as it was.
 *   - A read whose images were not all fetched books `error` with an attempt
 *     even when text figures were stored (the step books those `hit`): the
 *     figures are kept, and the article stays listed as "read failed" so the
 *     owner can try again for the pictures.
 * After a read that stored figures or found none, the event's live print
 * sheet is recompiled and the report returned.
 *
 * Logs carry ids and counts only, never article text or model output.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { AMC_FLOOR_ET, BMO_FLOOR_ET } from "@/lib/earnings/pre-print-floor";
import { DEEP_READ_WINDOW_DAYS } from "@/lib/earnings/deep-read-bogeys";
import {
  extractBogeysFromArticleForEvent,
  isSymbolMentioned,
  newsletterExtractorVersionForArticle,
  type ArticleInput,
} from "@/lib/earnings/extract-newsletter-bogeys";
import { accountFailureOf } from "@/lib/earnings/ai-unavailable";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import type { RecompileReport } from "@/lib/print-watch/recompile";
import { recompileLivePrint } from "@/lib/mutations/earnings-bogeys";

/** At most this many rows, newest first. */
export const UNREAD_PREVIEWS_MAX = 10;
/** A `claimed` row older than this belonged to a worker that died (the rescan step's figure). */
const CLAIM_STALE_MINUTES = 5;

export type UnreadPreviewState = "not_read" | "read_failed" | "reading";

export interface UnreadPreview {
  articleId: number;
  sourceName: string;
  subject: string;
  /** As stored: space-separated UTC. */
  receivedAt: string;
  state: UnreadPreviewState;
}

export type ReadArticleRefusal = "not_eligible" | "already_reading" | "ticker_not_found";

const REFUSAL_MESSAGES: Record<ReadArticleRefusal, string> = {
  not_eligible: "This article is not waiting to be read for this print.",
  already_reading: "Already reading this article for this print. Wait a moment and refresh.",
  ticker_not_found: "This article does not name the company's ticker, so there is nothing to read for this print.",
};

/** A read the server refused before or instead of an AI call (HTTP 409). */
export class ReadArticleRefusedError extends Error {
  readonly code: ReadArticleRefusal;
  constructor(code: ReadArticleRefusal) {
    super(REFUSAL_MESSAGES[code]);
    this.name = "ReadArticleRefusedError";
    this.code = code;
  }
}

export interface ReadArticleResult {
  bogeysStored: number;
  /** `images_incomplete`: booked `error` (text figures kept), still listed. */
  status: "hit" | "no_numbers" | "images_incomplete";
  /** The live sheet's recompile report; null when the event has no live print or nothing was re-derived. */
  recompiled: RecompileReport | null;
  /** Present (true) only when the figures were stored but the live sheet's recompile threw. */
  recompileFailed?: true;
}

interface EventRow {
  id: number;
  symbol: string | null;
  event_date: string;
  event_time: string | null;
  raw_json: string | null;
  superseded: number | null;
}

/** Stored `received_at` is space-separated UTC; compare as instants. */
function receivedMs(receivedAt: string): number {
  const raw = receivedAt.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  return Date.parse(raw.replace(" ", "T") + (hasZone ? "" : "Z"));
}

function sqlInstant(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The instant before which a `claimed` row is a dead worker's, as a bound
 * UTC instant (two instants compared, datetime() on both sides). Claim age is
 * read on the wall clock even when a caller passes its own `nowMs` for the
 * article window: claims are stamped with SQLite's datetime('now').
 */
function staleClaimBefore(): string {
  return sqlInstant(Date.now() - CLAIM_STALE_MINUTES * 60_000);
}

function loadEvent(db: Database.Database, eventId: number): EventRow | undefined {
  return db
    .prepare(
      `SELECT id, symbol, event_date, event_time, raw_json, superseded FROM calendar_events WHERE id = ?`,
    )
    .get(eventId) as EventRow | undefined;
}

/**
 * The unread previews for one event, newest first, at most
 * UNREAD_PREVIEWS_MAX. `null` for an unknown event (or one with no symbol);
 * `[]` for a superseded one. Reads only; no AI.
 */
export function listUnreadPreviews(
  db: Database.Database,
  eventId: number,
  nowMs: number = Date.now(),
): UnreadPreview[] | null {
  const ev = loadEvent(db, eventId);
  if (!ev?.symbol) return null;
  if ((ev.superseded ?? 0) !== 0) return [];

  // The deep read's window (gatherDeepReadInputs, lib/earnings/deep-read-bogeys.ts).
  const slot = deriveEarningsSlot({ event_time: ev.event_time, raw_json: ev.raw_json });
  const cutoff = composeReleaseInstant(ev.event_date, slot === "amc" ? AMC_FLOOR_ET : BMO_FLOOR_ET);
  if (!cutoff) return [];
  const fromMs = cutoff.getTime() - DEEP_READ_WINDOW_DAYS * 86_400_000;
  const toMs = Math.min(cutoff.getTime(), nowMs);
  if (toMs <= fromMs) return [];

  const family = issuerSiblings(ev.symbol).map((s) => s.toUpperCase());
  // datetime() on both sides (stored received_at is space-separated UTC); the
  // exact bounds are checked again in JS below. The body floor matches the
  // other readers' corpus (rescan step, deep read).
  const rows = db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text,
              (SELECT MAX(CASE
                        WHEN s.status = 'claimed' AND datetime(s.updated_at) >= datetime(?) THEN 2
                        WHEN s.status IN ('error', 'claimed') THEN 1
                        ELSE 0 END)
                 FROM earnings_bogey_scans s
                WHERE s.event_id = ? AND s.article_id = a.id) AS ledger_state
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
        WHERE a.raw_text IS NOT NULL AND length(a.raw_text) > 200
          AND datetime(a.received_at) >= datetime(?) AND datetime(a.received_at) < datetime(?)
          AND NOT EXISTS (
                SELECT 1 FROM earnings_bogey_scans done
                 WHERE done.event_id = ? AND done.article_id = a.id
                   AND done.status IN ('hit', 'no_numbers'))
        ORDER BY datetime(a.received_at) DESC, a.id DESC`,
    )
    .all(staleClaimBefore(), ev.id, sqlInstant(fromMs), sqlInstant(toMs), ev.id) as Array<{
    id: number;
    source_name: string | null;
    subject: string | null;
    received_at: string;
    raw_text: string;
    ledger_state: number | null;
  }>;

  const out: UnreadPreview[] = [];
  for (const r of rows) {
    const at = receivedMs(r.received_at);
    if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue;
    if (!family.some((sym) => isSymbolMentioned(r.raw_text, sym))) continue;
    out.push({
      articleId: r.id,
      sourceName: r.source_name ?? "",
      subject: r.subject ?? "",
      receivedAt: r.received_at,
      state: r.ledger_state === 2 ? "reading" : r.ledger_state === 1 ? "read_failed" : "not_read",
    });
    if (out.length >= UNREAD_PREVIEWS_MAX) break;
  }
  return out;
}

interface LedgerRow {
  status: string;
  claim_token: string | null;
  model_id: string | null;
  attempts: number;
  scanned_at: string | null;
  updated_at: string;
}

/**
 * One owner click: read this article for this event's bogeys. Throws
 * `ReadArticleRefusedError` (409) for an article that is not listed, a live
 * claim, or an article the extractor finds no ticker in; rethrows the
 * extractor's error otherwise (the route tells an account outage from a
 * failed read with `accountFailureOf`).
 */
export async function readArticleForEvent(
  db: Database.Database,
  eventId: number,
  articleId: number,
  deps: { extract?: typeof extractBogeysFromArticleForEvent; nowMs?: number } = {},
): Promise<ReadArticleResult> {
  const extract = deps.extract ?? extractBogeysFromArticleForEvent;
  const listed = listUnreadPreviews(db, eventId, deps.nowMs ?? Date.now());
  const entry = listed?.find((a) => a.articleId === articleId);
  if (!entry) throw new ReadArticleRefusedError("not_eligible");
  if (entry.state === "reading") throw new ReadArticleRefusedError("already_reading");
  const ev = loadEvent(db, eventId)!;
  const symbol = ev.symbol!.toUpperCase();

  const article = db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text, a.raw_html
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
        WHERE a.id = ?`,
    )
    .get(articleId) as ArticleInput;
  const version = newsletterExtractorVersionForArticle(article);

  const priorStmt = db.prepare(
    `SELECT status, claim_token, model_id, attempts, scanned_at, updated_at FROM earnings_bogey_scans
      WHERE event_id = ? AND article_id = ? AND extractor_version = ?`,
  );
  const prior = priorStmt.get(ev.id, articleId, version) as LedgerRow | undefined;

  // Claim-first, the rescan step's statement without its attempt cap: a fresh
  // row, or a takeover of an `error` row or a dead claim (which counts the
  // dead attempt). A live claim or a finished row is left alone.
  const token = randomUUID();
  const claimed = db
    .prepare(
      `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, claim_token, updated_at)
       VALUES (?, ?, ?, 'claimed', ?, datetime('now'))
       ON CONFLICT(event_id, article_id, extractor_version) DO UPDATE SET
         claim_token = excluded.claim_token, status = 'claimed', updated_at = datetime('now'),
         attempts = earnings_bogey_scans.attempts + CASE WHEN earnings_bogey_scans.status = 'claimed' THEN 1 ELSE 0 END
       WHERE earnings_bogey_scans.status = 'error'
          OR (earnings_bogey_scans.status = 'claimed' AND datetime(earnings_bogey_scans.updated_at) < datetime(?))`,
    )
    .run(ev.id, articleId, version, token, staleClaimBefore()).changes;
  if (claimed === 0) {
    const now = priorStmt.get(ev.id, articleId, version) as LedgerRow | undefined;
    throw new ReadArticleRefusedError(now?.status === "claimed" ? "already_reading" : "not_eligible");
  }

  // Put the row back exactly as it was before the claim (delete it when the
  // claim created it). Compare-and-set on the token.
  const release = () => {
    if (!prior) {
      db.prepare(
        `DELETE FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
      ).run(ev.id, articleId, version, token);
      return;
    }
    db.prepare(
      `UPDATE earnings_bogey_scans
          SET status = ?, claim_token = ?, model_id = ?, attempts = ?, scanned_at = ?, updated_at = ?
        WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
    ).run(
      prior.status,
      prior.claim_token,
      prior.model_id,
      prior.attempts,
      prior.scanned_at,
      prior.updated_at,
      ev.id,
      articleId,
      version,
      token,
    );
  };

  // The rescan step's finalise statement: CAS on the token, so a superseded
  // worker's outcome can never land on top of its successor's.
  const finalize = (status: "hit" | "no_numbers" | "error", modelId: string | null) =>
    db
      .prepare(
        `UPDATE earnings_bogey_scans
            SET status = ?, model_id = ?, attempts = attempts + 1,
                scanned_at = CASE WHEN ? = 'error' THEN scanned_at ELSE datetime('now') END,
                claim_token = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
      )
      .run(status, modelId, status, ev.id, articleId, version, token);

  let r: Awaited<ReturnType<typeof extractBogeysFromArticleForEvent>>;
  try {
    r = await extract(db, article, { event_id: ev.id, symbol, event_date: ev.event_date });
  } catch (err) {
    if (accountFailureOf(err)) {
      // The account failed, not the article: book nothing.
      release();
    } else {
      finalize("error", null);
    }
    console.warn(
      `[earnings/unread-previews] event ${ev.id} article ${articleId}: read failed (${err instanceof Error ? err.name : "error"})`,
    );
    throw err;
  }

  if (!r.called) {
    release();
    throw new ReadArticleRefusedError("ticker_not_found");
  }

  let status: ReadArticleResult["status"];
  if (r.imagesIncomplete) {
    finalize("error", r.modelId);
    status = "images_incomplete";
  } else if (r.bogeysStored > 0) {
    finalize("hit", r.modelId);
    status = "hit";
  } else {
    finalize("no_numbers", r.modelId);
    status = "no_numbers";
  }

  // The read is booked; a recompile failure must not turn it into a failed
  // read (the article has left the list). Reported so the UI can say so.
  if (r.bogeysStored > 0 || status === "no_numbers") {
    try {
      return { bogeysStored: r.bogeysStored, status, recompiled: recompileLivePrint(db, ev.id) };
    } catch (err) {
      console.warn(
        `[earnings/unread-previews] event ${ev.id}: live sheet recompile failed (${err instanceof Error ? err.name : "error"})`,
      );
      return { bogeysStored: r.bogeysStored, status, recompiled: null, recompileFailed: true };
    }
  }
  return { bogeysStored: r.bogeysStored, status, recompiled: null };
}
