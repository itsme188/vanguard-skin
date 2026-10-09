/**
 * repair-manual-feed-earnings-pairs.ts — hide the feed copy of an earnings
 * print that is showing beside a hand-entered row for the same symbol and date.
 *
 * Why it exists (owner rulings 2026-08-15 and 2026-10-02,
 * qa:today-week-ahead--duplicate-manual-and-feed-cards-same-print-regression-1):
 * one company shows one earnings card per day. A hand-entered row dated on
 * the print IS the print, so the hand-entered row stays and the feed row
 * (Finnhub / Nasdaq / Wall Street Horizon) is hidden. The reconciler does this
 * on every refresh, but only inside its window (21 days back, 30 days ahead of
 * today). A pair that an older rule left showing and that has since aged out
 * of the window is never looked at again. This script closes those pairs.
 *
 * What it changes, per pair, through the reconciler's own `createTwinFolder`
 * (the exact write a reconcile pass makes for a losing row):
 *   - the feed row: `superseded = 1`, date status cleared. It is NOT deleted
 *     and keeps every value it holds;
 *   - the hand-entered row: empty consensus / actual / reaction / enrichment
 *     columns are filled from the feed row. A value already there is never
 *     overwritten, and its date status is not touched (no confirmation is
 *     written);
 *   - bogeys, sent-email records and skips on the feed row move to the
 *     hand-entered row. A record that collides with one the hand-entered row
 *     already holds stays on the hidden feed row;
 *   - one armed-events outbox row when an arm or its ledgers moved.
 *
 * Pairs left alone and listed as skipped:
 *   - two or more showing hand-entered rows on that symbol and date;
 *   - a feed row with an email being sent right now.
 * Only an exact symbol match is paired; share-class siblings are not.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/repair-manual-feed-earnings-pairs.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/repair-manual-feed-earnings-pairs.ts --apply --acknowledge-repair
 *
 * Dry run is the default and opens the database read-only. `--apply` needs
 * `--acknowledge-repair` and writes every pair in one transaction. Running it
 * again changes nothing. Rehearse on a copy first
 * (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`).
 *
 * The output names row ids, symbols, dates, source names and counts of email
 * records. It prints no estimate, actual or other figure.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { createTwinFolder, type TwinDonor } from "@/lib/calendar/reconcile-earnings-dates";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { isLiveClaim } from "@/lib/earnings/email-states";
import { todayET } from "@/lib/calendar/date-utils";

const ACK_FLAG = "--acknowledge-repair";
const KNOWN_FLAGS = new Set(["--apply", ACK_FLAG]);

export type PairSkipReason =
  /** More than one showing hand-entered row on the symbol and date. */
  | "several_hand_entered_rows"
  /** An email on a feed row is claimed or on the wire. */
  | "email_in_flight";

export interface FeedTwin {
  id: number;
  source: string;
  /** Email records on the row, any phase and state. */
  emails: number;
}

export interface ManualFeedPair {
  symbol: string;
  eventDate: string;
  /** The hand-entered row that stays showing. */
  manualId: number;
  /** Showing feed rows on the same symbol and date, freshest-enriched first. */
  feedRows: FeedTwin[];
}

export interface SkippedPair {
  symbol: string;
  eventDate: string;
  manualIds: number[];
  feedIds: number[];
  reason: PairSkipReason;
}

export interface ManualFeedPairPlan {
  pairs: ManualFeedPair[];
  skipped: SkippedPair[];
}

/** Read-only. Every showing hand-entered + feed pair, oldest date first. */
export function planManualFeedPairRepair(db: Database.Database): ManualFeedPairPlan {
  const groups = db
    .prepare(
      `SELECT UPPER(m.symbol) AS symbol, m.event_date AS eventDate
         FROM calendar_events m
        WHERE m.event_type = 'earnings' AND m.source = 'manual'
          AND m.symbol IS NOT NULL AND TRIM(m.symbol) != ''
          AND COALESCE(m.superseded, 0) = 0
          AND EXISTS (SELECT 1 FROM calendar_events t
                       WHERE t.event_type = 'earnings' AND t.source != 'manual'
                         AND UPPER(t.symbol) = UPPER(m.symbol)
                         AND t.event_date = m.event_date
                         AND COALESCE(t.superseded, 0) = 0)
        GROUP BY UPPER(m.symbol), m.event_date
        ORDER BY m.event_date, UPPER(m.symbol)`,
    )
    .all() as { symbol: string; eventDate: string }[];

  const manualsOf = db.prepare(
    `SELECT id FROM calendar_events
      WHERE event_type = 'earnings' AND source = 'manual'
        AND UPPER(symbol) = ? AND event_date = ? AND COALESCE(superseded, 0) = 0
      ORDER BY id`,
  );
  // Same donor order as the reconcile pass: freshest-enriched first, because
  // the fold only fills empty columns and the first donor's value wins.
  const feedsOf = db.prepare(
    `SELECT id, source FROM calendar_events
      WHERE event_type = 'earnings' AND source != 'manual'
        AND UPPER(symbol) = ? AND event_date = ? AND COALESCE(superseded, 0) = 0
      ORDER BY COALESCE(enriched_at, '') DESC, id`,
  );
  const emailsOf = db.prepare("SELECT error FROM earnings_emails WHERE event_id = ?");

  const plan: ManualFeedPairPlan = { pairs: [], skipped: [] };
  for (const g of groups) {
    const manualIds = (manualsOf.all(g.symbol, g.eventDate) as { id: number }[]).map((r) => r.id);
    const feeds = feedsOf.all(g.symbol, g.eventDate) as {
      id: number;
      source: string;
    }[];
    const emailRows = new Map(
      feeds.map((f) => [f.id, emailsOf.all(f.id) as { error: string | null }[]]),
    );

    const reason: PairSkipReason | null =
      manualIds.length > 1
        ? "several_hand_entered_rows"
        : feeds.some((f) => emailRows.get(f.id)!.some((e) => isLiveClaim(e.error)))
          ? "email_in_flight"
          : null;
    if (reason) {
      plan.skipped.push({
        symbol: g.symbol,
        eventDate: g.eventDate,
        manualIds,
        feedIds: feeds.map((f) => f.id),
        reason,
      });
      continue;
    }
    plan.pairs.push({
      symbol: g.symbol,
      eventDate: g.eventDate,
      manualId: manualIds[0],
      feedRows: feeds.map((f) => ({
        id: f.id,
        source: f.source,
        emails: emailRows.get(f.id)!.length,
      })),
    });
  }
  return plan;
}

export interface ManualFeedPairResult {
  plan: ManualFeedPairPlan;
  applied: boolean;
  /** Feed rows hidden by this run. */
  hidden: number;
  outboxWritten: boolean;
}

/**
 * Plan, then (only with `apply` AND `acknowledgeRepair`) write. The plan is
 * resolved INSIDE the write transaction, so what is written is what that same
 * read decided; a feed row that does not end hidden rolls the whole run back.
 */
export function runManualFeedPairRepair(
  db: Database.Database,
  opts: { apply?: boolean; acknowledgeRepair?: boolean; today?: string } = {},
): ManualFeedPairResult {
  if (!opts.apply) {
    return { plan: planManualFeedPairRepair(db), applied: false, hidden: 0, outboxWritten: false };
  }
  if (!opts.acknowledgeRepair) {
    throw new Error(
      `Refusing to write without ${ACK_FLAG}. Dry run is the default; rehearse on a REPAIR_DB_PATH copy first.`,
    );
  }
  const today = opts.today ?? todayET();

  return db.transaction((): ManualFeedPairResult => {
    const plan = planManualFeedPairRepair(db);
    const fold = createTwinFolder(db);
    const donor = db.prepare(
      `SELECT id, consensus_estimate, consensus_value, actual_value, manual_actuals_at,
              reaction_snapshot, enriched_at
         FROM calendar_events WHERE id = ?`,
    );
    const isHidden = db.prepare(
      "SELECT COALESCE(superseded, 0) AS superseded FROM calendar_events WHERE id = ?",
    );

    let hidden = 0;
    let anyMerged = false;
    for (const pair of plan.pairs) {
      for (const feed of pair.feedRows) {
        // Fold FIRST, then accumulate (`||=` on the call would skip the fold).
        const merged = fold(donor.get(feed.id) as TwinDonor, pair.manualId, pair.eventDate);
        anyMerged ||= merged;
        const after = isHidden.get(feed.id) as { superseded: number } | undefined;
        if (after?.superseded !== 1) {
          throw new Error(`feed row ${feed.id}: did not end hidden; nothing was written`);
        }
        hidden += 1;
      }
    }
    let outboxWritten = false;
    // Hiding a feed row can change the armed projection's superseded ids even
    // when the fold moved nothing; the writer is a no-op when the projection
    // is unchanged, so ask whenever a row was hidden and report what it did.
    if (anyMerged || hidden > 0) {
      outboxWritten = writeArmedEventsOutboxRow(db, { today }).written;
    }
    return { plan, applied: true, hidden, outboxWritten };
  })();
}

const SKIP_WORDS: Record<PairSkipReason, string> = {
  several_hand_entered_rows:
    "two or more hand-entered rows show on this date; delete one in the app first",
  email_in_flight: "an email for a feed row is being sent right now; run again later",
};

/** Ids, symbols, dates, source names and counts. Never a figure. */
export function formatPlan(result: ManualFeedPairResult): string[] {
  const { plan, applied } = result;
  const lines: string[] = [];
  const feedTotal = plan.pairs.reduce((n, p) => n + p.feedRows.length, 0);
  lines.push(`pairs ${applied ? "repaired" : "that would be repaired"}: ${plan.pairs.length}`);
  lines.push(`feed rows ${applied ? "hidden" : "that would be hidden"}:    ${applied ? result.hidden : feedTotal}`);
  lines.push(`pairs skipped:                  ${plan.skipped.length}`);
  for (const p of plan.pairs) {
    lines.push("");
    lines.push(`  ${p.symbol} ${p.eventDate}: hand-entered row ${p.manualId} stays showing`);
    for (const f of p.feedRows) {
      lines.push(
        `    ${f.source} row ${f.id} ${applied ? "hidden" : "would be hidden"}` +
          (f.emails > 0
            ? `; ${f.emails} email record(s) move to row ${p.manualId} unless it already holds that phase`
            : ""),
      );
    }
  }
  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped (left exactly as they are):");
    for (const s of plan.skipped) {
      lines.push(
        `  ${s.symbol} ${s.eventDate}: hand-entered row(s) ${s.manualIds.join(", ")}, ` +
          `feed row(s) ${s.feedIds.join(", ")} — ${SKIP_WORDS[s.reason]}`,
      );
    }
  }
  if (result.outboxWritten) {
    lines.push("");
    lines.push("One armed-events outbox row was written (an armed row's state moved).");
  }
  return lines;
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

export function parseArgs(argv: string[]): { apply: boolean; acknowledgeRepair: boolean } {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`unknown argument ${arg} (known: ${[...KNOWN_FLAGS].join(", ")})`);
    }
  }
  const apply = argv.includes("--apply");
  const acknowledgeRepair = argv.includes(ACK_FLAG);
  if (apply && !acknowledgeRepair) {
    throw new Error(
      `Refusing to write without ${ACK_FLAG}. Dry run is the default; rehearse on a REPAIR_DB_PATH copy first.`,
    );
  }
  return { apply, acknowledgeRepair };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = new BetterSqlite3(DB_PATH, {
    readonly: !opts.apply,
    fileMustExist: true,
    timeout: 60_000,
  }) as Database.Database;
  try {
    if (opts.apply) db.pragma("foreign_keys = ON");
    console.log(
      `Hand-entered + feed earnings pair repair ${opts.apply ? "[APPLY]" : "[DRY RUN]"}, db: ${DB_PATH}\n`,
    );
    const result = runManualFeedPairRepair(db, opts);
    for (const line of formatPlan(result)) console.log(line);
    if (!result.applied) {
      console.log(
        `\nDry run (default): nothing was written. Re-run with --apply ${ACK_FLAG} on a rehearsed copy to write.`,
      );
    }
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-option-sectors.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-manual-feed-earnings-pairs.ts") ||
    process.argv[1].endsWith("repair-manual-feed-earnings-pairs.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
