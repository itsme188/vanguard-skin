/**
 * repair-earnings-preview-audit.ts — Repairs `earnings_emails` /
 * `earnings_email_skips` preview-phase rows dragged onto the wrong
 * `calendar_events` row by the unconditional-repoint defect fixed in
 * `lib/calendar/reconcile-earnings-dates.ts` (qa/NBIS 2026-08-10).
 *
 * Root cause: `reconcileEarningsDates` clusters earnings rows per issuer
 * within 14 days and repoints every superseded row's child audit rows onto
 * the canonical — unconditionally, until this fix. A preview sent for a
 * WRONG vendor date (e.g. NBIS: a preview sent 2026-07-29 for finnhub's
 * phantom 7/29 claim) then got dragged onto whatever the canonical later
 * resolved to (NBIS's real print, 2026-08-12), even though the preview
 * never covered that print. This both (a) falsely showed "preview sent" for
 * a release the email never described, and (b) permanently blocked the
 * genuine preview from ever firing — `findEmailCandidates`
 * (lib/calendar/enrichment-runner.ts) treats ANY existing preview-phase row
 * on an event as "already handled" (`ee.id IS NULL AND es.id IS NULL`).
 * The reconcile-side fix stops new damage; this script repairs the rows
 * already dragged by the old behavior.
 *
 * What it does, in order, inside ONE transaction:
 *   1. Rule-based: for every preview-phase row (earnings_emails or
 *      earnings_email_skips) sitting on an event — ANY superseded state —
 *      it could not plausibly have covered (`date(sent_at) < date(event_date, '-1 day')`
 *      — a genuine preview's send date always equals its print date, +/-1
 *      day for UTC sent_at vs ET event_date; PREVIEW_WINDOW_MIN/MAX_MS in
 *      enrichment-runner.ts), finds the ORIGIN event — same UPPER(symbol),
 *      any superseded state, dated within [sent_date-1, sent_date+3] —
 *      closest by julianday distance to the sent date, preferring the
 *      future-side event on a tie. Repoints the row there (UPDATE OR
 *      IGNORE, so a UNIQUE(event_id, phase) collision keeps the origin's own
 *      row). No origin candidate found -> the row is left untouched and
 *      reported (never guessed).
 *   2. Targeted + guarded: deletes the phantom `manual:OCUL:2026-08-10:earnings`
 *      row IF AND ONLY IF it has zero children left after step 1 (in
 *      earnings_emails, earnings_email_skips, earnings_bogeys) AND another
 *      OCUL earnings event within the 14 days before it shows reported
 *      evidence (actual_value or raw_json entry.epsActual). Manual rows are
 *      not sync-re-inserted, so a plain DELETE is safe once every audit
 *      trail pointing at it is gone.
 *   3. Targeted + guarded: backfills the real OCUL print
 *      (`nasdaq:OCUL:2026-08-03`)'s `actual_value` from its own raw_json
 *      epsActual (never overwrites a non-NULL actual_value), stamps
 *      `enriched_at`, and inserts a recap-phase `earnings_email_skips` row
 *      so the sweep's enriched_at-based recap window can't retro-fire a
 *      stale recap for an old print.
 *   4. Re-runs `reconcileEarningsDates` so the corrected audit trail feeds
 *      back through the (now-fixed) reconcile pass and the affected
 *      clusters resolve cleanly.
 *   5. Summarizes every NBIS/OCUL earnings event in scope (id, source_key,
 *      event_date, superseded, date_status, preview-email/skip presence),
 *      and states whether the NBIS 8/12 canonical row is now
 *      preview-candidate-eligible.
 *
 * Steps 1 and 4 are pure rule-based logic — no hardcoded row ids. Steps 2
 * and 3 are intentionally TARGETED at the two specific known-bad rows
 * (guarded by exact `source_key`, never by row id) — this is a one-time
 * cleanup of a specific incident, not a general pattern.
 *
 * Idempotent: after a successful apply, step 1 finds no more stale rows
 * (their events are either superseded — excluded — or their current event's
 * date now plausibly covers the send date), step 2's source_key no longer
 * resolves, and step 3's actual_value is already set — so a re-run reports
 * nothing further and writes nothing.
 *
 * Dry-run reporting reflects the FULL hypothetical outcome (including what
 * step 2/3's guards would see after step 1's repoints, and what step 4's
 * reconcile would resolve to): every step always executes inside one
 * transaction, and a dry run rolls the whole transaction back at the very
 * end rather than skipping the writes — so the printed report is accurate,
 * never a partial preview.
 *
 * NOT touched: recap-phase earnings_emails/earnings_email_skips rows (the
 * reconcile-side fix always repoints those unconditionally — they document
 * whichever print they're attached to), earnings_bogeys (always unconditional),
 * and any preview row whose send date already plausibly covers its current
 * event (nothing wrong with it).
 *
 * Usage:
 *   npx tsx scripts/repair-earnings-preview-audit.ts                # dry-run (default)
 *   npx tsx scripts/repair-earnings-preview-audit.ts --apply         # write
 *   npx tsx scripts/repair-earnings-preview-audit.ts --db <path>     # override DB
 */

import type Database from "better-sqlite3";
import { reconcileEarningsDates, type ReconcileResult } from "@/lib/calendar/reconcile-earnings-dates";

// ─── Types ────────────────────────────────────────────────────────

export interface MisplacedPreviewRow {
  table: "earnings_emails" | "earnings_email_skips";
  rowId: number;
  currentEventId: number;
  symbol: string;
  currentEventDate: string;
  /** sent_at (earnings_emails) or skipped_at (earnings_email_skips). */
  sentOrSkippedAt: string;
}

export interface PreviewRepointPlan {
  row: MisplacedPreviewRow;
  originEventId: number;
  originEventDate: string;
  originSuperseded: boolean;
}

export interface PreviewRepointSkip {
  row: MisplacedPreviewRow;
  reason: string;
}

export interface MisplacedPreviewResult {
  plans: PreviewRepointPlan[];
  skipped: PreviewRepointSkip[];
}

export interface PhantomDeleteCheck {
  eligible: boolean;
  eventId?: number;
  reason: string;
}

export interface BackfillCheck {
  eligible: boolean;
  eventId?: number;
  epsActual?: number;
  reason: string;
}

export interface AffectedEventSummary {
  id: number;
  symbol: string;
  sourceKey: string;
  eventDate: string;
  superseded: boolean;
  dateStatus: string | null;
  releaseTime: string | null;
  hasPreviewEmail: boolean;
  hasPreviewSkip: boolean;
}

export interface RepairResult {
  previewRepoints: MisplacedPreviewResult;
  /** Rows actually repointed — 0 unless opts.apply is true. */
  repointedCount: number;
  phantomDelete: PhantomDeleteCheck;
  /** True only when opts.apply is true AND the phantom guard was eligible. */
  deleted: boolean;
  backfill: BackfillCheck;
  /** True only when opts.apply is true AND the backfill guard was eligible. */
  backfilled: boolean;
  reconcile: ReconcileResult;
  affectedEvents: AffectedEventSummary[];
}

const PHANTOM_OCUL_SOURCE_KEY = "manual:OCUL:2026-08-10:earnings";
const REAL_OCUL_PRINT_SOURCE_KEY = "nasdaq:OCUL:2026-08-03";
const AFFECTED_SYMBOLS = ["NBIS", "OCUL"];

// ─── Step 1: rule-based misplaced-preview repoint plan ─────────────

interface RawStaleRow {
  rowId: number;
  currentEventId: number;
  symbol: string;
  currentEventDate: string;
  sentOrSkippedAt: string;
}

function findStaleRowsForTable(
  db: Database.Database,
  table: "earnings_emails" | "earnings_email_skips",
): RawStaleRow[] {
  const tsColumn = table === "earnings_emails" ? "sent_at" : "skipped_at";
  return db
    .prepare(
      `SELECT t.id AS rowId, t.event_id AS currentEventId, ce.symbol AS symbol,
              ce.event_date AS currentEventDate, t.${tsColumn} AS sentOrSkippedAt
         FROM ${table} t
         JOIN calendar_events ce ON ce.id = t.event_id
        WHERE t.phase = 'preview'
          AND ce.event_type = 'earnings'
          AND ce.symbol IS NOT NULL
          AND date(t.${tsColumn}) < date(ce.event_date, '-1 day')`,
    )
    .all() as RawStaleRow[];
}

interface OriginCandidateRow {
  id: number;
  event_date: string;
  superseded: number;
}

/**
 * Closest same-symbol earnings event to the sent date, within [-1, +3] days
 * of it, preferring the future-side event on a distance tie — a preview
 * sent AT time T is more likely to describe an imminent release than one
 * that already happened. Considers any superseded state: the origin is
 * often itself already superseded (that's WHY the row went astray).
 */
function findOriginCandidate(
  db: Database.Database,
  symbol: string,
  excludeEventId: number,
  sentDateOnly: string,
): OriginCandidateRow | undefined {
  return db
    .prepare(
      `SELECT id, event_date, superseded
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND UPPER(symbol) = UPPER(?)
          AND id != ?
          AND event_date BETWEEN date(?, '-1 day') AND date(?, '+3 day')
        ORDER BY ABS(julianday(event_date) - julianday(?)) ASC,
                 (event_date >= ?) DESC,
                 id ASC
        LIMIT 1`,
    )
    .get(symbol, excludeEventId, sentDateOnly, sentDateOnly, sentDateOnly, sentDateOnly) as
    | OriginCandidateRow
    | undefined;
}

/**
 * Pure read: finds every preview-phase earnings_emails/earnings_email_skips
 * row whose send date could not plausibly have covered its current event's
 * print date, and the origin event it belongs on (or a skip reason when no
 * origin resolves). Never writes.
 *
 * Deliberately scans SUPERSEDED events too: a stale preview parked on a
 * superseded row is harmless to canonical readers today, but it is
 * archivally wrong (the email belongs on the event it was actually sent
 * for) and it is a latent hazard — correctEarningsEventDate's ADOPTION path
 * flips `superseded = 0` on an existing vendor row, which would resurrect a
 * false "preview sent" state (and re-block the genuine preview) the moment
 * that row is adopted as a correction target.
 */
export function findMisplacedPreviewRows(db: Database.Database): MisplacedPreviewResult {
  const plans: PreviewRepointPlan[] = [];
  const skipped: PreviewRepointSkip[] = [];

  for (const table of ["earnings_emails", "earnings_email_skips"] as const) {
    for (const raw of findStaleRowsForTable(db, table)) {
      const row: MisplacedPreviewRow = {
        table,
        rowId: raw.rowId,
        currentEventId: raw.currentEventId,
        symbol: raw.symbol,
        currentEventDate: raw.currentEventDate,
        sentOrSkippedAt: raw.sentOrSkippedAt,
      };
      const sentDateOnly = raw.sentOrSkippedAt.slice(0, 10);
      const origin = findOriginCandidate(db, raw.symbol, raw.currentEventId, sentDateOnly);
      if (!origin) {
        skipped.push({
          row,
          reason:
            `no origin candidate: no other ${raw.symbol} earnings event dated within ` +
            `[${sentDateOnly} -1d, +3d]`,
        });
        continue;
      }
      plans.push({
        row,
        originEventId: origin.id,
        originEventDate: origin.event_date,
        originSuperseded: origin.superseded === 1,
      });
    }
  }

  return { plans, skipped };
}

// ─── Step 2: phantom manual OCUL row (targeted, guarded) ───────────

function hasReportedEvidence(actualValue: string | null, rawJson: string | null): boolean {
  if (actualValue != null && actualValue !== "") return true;
  try {
    const a = JSON.parse(rawJson ?? "{}")?.entry?.epsActual;
    return a != null;
  } catch {
    return false;
  }
}

/**
 * Pure read: checks whether the phantom manual OCUL row is safe to delete —
 * zero remaining audit children AND a reported sibling within the 14 days
 * before it (proof the real print already happened elsewhere). Never
 * writes; call this AFTER simulating/applying step 1 so the child count
 * reflects the post-repoint world.
 */
export function findPhantomOculDeleteCandidate(db: Database.Database): PhantomDeleteCheck {
  const row = db
    .prepare("SELECT id, symbol, event_date FROM calendar_events WHERE source_key = ?")
    .get(PHANTOM_OCUL_SOURCE_KEY) as { id: number; symbol: string; event_date: string } | undefined;
  if (!row) {
    return { eligible: false, reason: `no calendar_events row with source_key '${PHANTOM_OCUL_SOURCE_KEY}'` };
  }

  const childCounts = {
    earnings_emails: (
      db.prepare("SELECT COUNT(*) AS c FROM earnings_emails WHERE event_id = ?").get(row.id) as {
        c: number;
      }
    ).c,
    earnings_email_skips: (
      db
        .prepare("SELECT COUNT(*) AS c FROM earnings_email_skips WHERE event_id = ?")
        .get(row.id) as { c: number }
    ).c,
    earnings_bogeys: (
      db.prepare("SELECT COUNT(*) AS c FROM earnings_bogeys WHERE event_id = ?").get(row.id) as {
        c: number;
      }
    ).c,
  };
  const totalChildren =
    childCounts.earnings_emails + childCounts.earnings_email_skips + childCounts.earnings_bogeys;
  if (totalChildren > 0) {
    return {
      eligible: false,
      eventId: row.id,
      reason:
        `row ${row.id} still has ${totalChildren} child row(s) ` +
        `(earnings_emails=${childCounts.earnings_emails}, ` +
        `earnings_email_skips=${childCounts.earnings_email_skips}, ` +
        `earnings_bogeys=${childCounts.earnings_bogeys})`,
    };
  }

  const siblings = db
    .prepare(
      `SELECT actual_value, raw_json
         FROM calendar_events
        WHERE event_type = 'earnings' AND UPPER(symbol) = UPPER(?) AND id != ?
          AND event_date < ? AND event_date >= date(?, '-14 day')`,
    )
    .all(row.symbol, row.id, row.event_date, row.event_date) as Array<{
    actual_value: string | null;
    raw_json: string | null;
  }>;
  const hasReportedSibling = siblings.some((s) => hasReportedEvidence(s.actual_value, s.raw_json));
  if (!hasReportedSibling) {
    return {
      eligible: false,
      eventId: row.id,
      reason: `no ${row.symbol} sibling event within 14 days before ${row.event_date} shows reported evidence`,
    };
  }

  return {
    eligible: true,
    eventId: row.id,
    reason: `guards satisfied: 0 children, a reported sibling event exists within 14 days before ${row.event_date}`,
  };
}

// ─── Step 3: real OCUL print backfill (targeted, guarded) ──────────

/**
 * Pure read: checks whether the real OCUL print's actual_value can be
 * safely backfilled from its own raw_json epsActual. Never overwrites a
 * non-NULL actual_value. Never writes.
 */
export function findOculBackfillCandidate(db: Database.Database): BackfillCheck {
  const row = db
    .prepare("SELECT id, actual_value, raw_json FROM calendar_events WHERE source_key = ?")
    .get(REAL_OCUL_PRINT_SOURCE_KEY) as
    | { id: number; actual_value: string | null; raw_json: string | null }
    | undefined;
  if (!row) {
    return { eligible: false, reason: `no calendar_events row with source_key '${REAL_OCUL_PRINT_SOURCE_KEY}'` };
  }
  if (row.actual_value != null && row.actual_value !== "") {
    return {
      eligible: false,
      eventId: row.id,
      reason: `row ${row.id} already has actual_value ('${row.actual_value}') — refusing to overwrite`,
    };
  }

  let epsActual: number | null = null;
  try {
    const parsed = JSON.parse(row.raw_json ?? "{}");
    const v = parsed?.entry?.epsActual;
    if (typeof v === "number" && Number.isFinite(v)) epsActual = v;
  } catch {
    // malformed JSON -> not eligible, fall through
  }
  if (epsActual === null) {
    return {
      eligible: false,
      eventId: row.id,
      reason: `row ${row.id} raw_json has no numeric entry.epsActual`,
    };
  }

  return { eligible: true, eventId: row.id, epsActual, reason: "guards satisfied" };
}

// ─── Step 5: verification summary ───────────────────────────────────

/**
 * Pure read: every earnings event for the given symbols, plus whether each
 * one currently carries a preview-phase earnings_emails/earnings_email_skips
 * row. Called both mid-transaction (for the dry-run report) and after a real
 * apply (for the final confirmation) — same query either way.
 */
export function summarizeAffectedEvents(
  db: Database.Database,
  symbols: string[],
): AffectedEventSummary[] {
  if (symbols.length === 0) return [];
  const placeholders = symbols.map(() => "?").join(",");
  const upperSymbols = symbols.map((s) => s.toUpperCase());
  const rows = db
    .prepare(
      `SELECT id, symbol, source_key, event_date, superseded, date_status, release_time
         FROM calendar_events
        WHERE event_type = 'earnings' AND UPPER(symbol) IN (${placeholders})
        ORDER BY symbol, event_date`,
    )
    .all(...upperSymbols) as Array<{
    id: number;
    symbol: string;
    source_key: string;
    event_date: string;
    superseded: number;
    date_status: string | null;
    release_time: string | null;
  }>;

  const previewEmailIds = new Set(
    (
      db.prepare("SELECT DISTINCT event_id FROM earnings_emails WHERE phase = 'preview'").all() as Array<{
        event_id: number;
      }>
    ).map((r) => r.event_id),
  );
  const previewSkipIds = new Set(
    (
      db
        .prepare("SELECT DISTINCT event_id FROM earnings_email_skips WHERE phase = 'preview'")
        .all() as Array<{ event_id: number }>
    ).map((r) => r.event_id),
  );

  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    sourceKey: r.source_key,
    eventDate: r.event_date,
    superseded: r.superseded === 1,
    dateStatus: r.date_status,
    releaseTime: r.release_time,
    hasPreviewEmail: previewEmailIds.has(r.id),
    hasPreviewSkip: previewSkipIds.has(r.id),
  }));
}

// ─── Orchestrator ────────────────────────────────────────────────────

const DRY_RUN_ROLLBACK = Symbol("repair-earnings-preview-audit:dry-run-rollback");

/**
 * Runs all 4 steps inside ONE transaction. Steps 2/3's guards depend on
 * step 1 having already run (they check post-repoint child counts), and
 * step 4 depends on 1-3 — so a dry run can't just skip the writes and
 * report a plan computed against the untouched DB; that would under-report
 * step 2/3 eligibility. Instead every step always executes for real inside
 * the transaction, and `opts.apply === false` throws a sentinel at the very
 * end to force a full rollback (better-sqlite3's `db.transaction()` rolls
 * back automatically on a thrown error) — so a dry run computes and reports
 * the exact same plan --apply would commit, without ever persisting it.
 * `repointedCount` / `deleted` / `backfilled` reflect only what was
 * actually COMMITTED (gated on `opts.apply`); `previewRepoints` /
 * `phantomDelete` / `backfill` / `reconcile` / `affectedEvents` always
 * reflect the full hypothetical outcome, so both modes print an identical,
 * accurate report.
 */
export function repairEarningsPreviewAudit(
  db: Database.Database,
  opts: { apply: boolean; today: string },
): RepairResult {
  let captured:
    | {
        previewRepoints: MisplacedPreviewResult;
        phantomDelete: PhantomDeleteCheck;
        backfill: BackfillCheck;
        reconcile: ReconcileResult;
        affectedEvents: AffectedEventSummary[];
      }
    | null = null;

  const runInner = () => {
    const previewRepoints = findMisplacedPreviewRows(db);
    const repointEmailStmt = db.prepare(
      "UPDATE OR IGNORE earnings_emails SET event_id = ? WHERE id = ?",
    );
    const repointSkipStmt = db.prepare(
      "UPDATE OR IGNORE earnings_email_skips SET event_id = ? WHERE id = ?",
    );
    for (const plan of previewRepoints.plans) {
      if (plan.row.table === "earnings_emails") {
        repointEmailStmt.run(plan.originEventId, plan.row.rowId);
      } else {
        repointSkipStmt.run(plan.originEventId, plan.row.rowId);
      }
    }

    const phantomDelete = findPhantomOculDeleteCandidate(db);
    if (phantomDelete.eligible && phantomDelete.eventId != null) {
      db.prepare("DELETE FROM calendar_events WHERE id = ?").run(phantomDelete.eventId);
    }

    const backfill = findOculBackfillCandidate(db);
    if (backfill.eligible && backfill.eventId != null && backfill.epsActual != null) {
      db.prepare(
        `UPDATE calendar_events SET actual_value = ?, enriched_at = datetime('now') WHERE id = ?`,
      ).run(`EPS ${backfill.epsActual}`, backfill.eventId);
      db.prepare(
        "INSERT OR IGNORE INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')",
      ).run(backfill.eventId);
    }

    const reconcile = reconcileEarningsDates(db, { today: opts.today });
    const affectedEvents = summarizeAffectedEvents(db, AFFECTED_SYMBOLS);

    captured = { previewRepoints, phantomDelete, backfill, reconcile, affectedEvents };

    if (!opts.apply) {
      throw DRY_RUN_ROLLBACK;
    }
  };

  try {
    db.transaction(runInner)();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }

  const c = captured!;
  return {
    previewRepoints: c.previewRepoints,
    repointedCount: opts.apply ? c.previewRepoints.plans.length : 0,
    phantomDelete: c.phantomDelete,
    deleted: opts.apply && c.phantomDelete.eligible,
    backfill: c.backfill,
    backfilled: opts.apply && c.backfill.eligible,
    reconcile: c.reconcile,
    affectedEvents: c.affectedEvents,
  };
}

// ─── CLI formatting ─────────────────────────────────────────────────

function printReport(result: RepairResult): void {
  console.log("\nStep 1 — misplaced preview repoints:");
  if (result.previewRepoints.plans.length === 0) {
    console.log("  none found.");
  } else {
    for (const p of result.previewRepoints.plans) {
      console.log(
        `  ${p.row.table} id=${p.row.rowId} (${p.row.symbol}, sent/skipped ${p.row.sentOrSkippedAt}) ` +
          `event ${p.row.currentEventId} (${p.row.currentEventDate}) -> ${p.originEventId} ` +
          `(${p.originEventDate}, superseded=${p.originSuperseded})`,
      );
    }
  }
  if (result.previewRepoints.skipped.length > 0) {
    console.log("  SKIP (no origin candidate — left untouched):");
    for (const s of result.previewRepoints.skipped) {
      console.log(`    ${s.row.table} id=${s.row.rowId} (${s.row.symbol}): ${s.reason}`);
    }
  }

  console.log("\nStep 2 — phantom manual OCUL row:");
  console.log(`  ${result.phantomDelete.reason}`);
  console.log(`  ${result.deleted ? "DELETED." : result.phantomDelete.eligible ? "would delete (dry-run)." : "not deleted."}`);

  console.log("\nStep 3 — real OCUL print backfill:");
  console.log(`  ${result.backfill.reason}`);
  console.log(
    `  ${
      result.backfilled
        ? "BACKFILLED actual_value + enriched_at + recap skip."
        : result.backfill.eligible
          ? "would backfill (dry-run)."
          : "not backfilled."
    }`,
  );

  console.log("\nStep 4 — reconciliation:");
  console.log(
    `  confirmed=${result.reconcile.confirmed} conflict=${result.reconcile.conflict} ` +
      `single=${result.reconcile.single} userConfirmed=${result.reconcile.userConfirmed}`,
  );

  console.log("\nStep 5 — verification summary (NBIS + OCUL):");
  for (const e of result.affectedEvents) {
    console.log(
      `  id=${e.id} ${e.sourceKey} date=${e.eventDate} superseded=${e.superseded} ` +
        `date_status=${e.dateStatus ?? "-"} previewEmail=${e.hasPreviewEmail} previewSkip=${e.hasPreviewSkip}`,
    );
  }
  const nbisCanonical = result.affectedEvents.find((e) => e.symbol === "NBIS" && !e.superseded);
  if (nbisCanonical) {
    const eligible =
      !nbisCanonical.hasPreviewEmail && !nbisCanonical.hasPreviewSkip && nbisCanonical.releaseTime != null;
    console.log(
      `\n  NBIS 8/12 canonical row (id=${nbisCanonical.id}) is ${eligible ? "" : "NOT "}` +
        `preview-candidate-eligible (previewEmail=${nbisCanonical.hasPreviewEmail}, ` +
        `previewSkip=${nbisCanonical.hasPreviewSkip}, release_time=${nbisCanonical.releaseTime ?? "NULL"}).`,
    );
  } else {
    console.log("\n  No non-superseded NBIS canonical event found in the affected window.");
  }
}

// ─── CLI entry point ──────────────────────────────────────────────

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-december-snapshots.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-earnings-preview-audit.ts") ||
    process.argv[1].endsWith("repair-earnings-preview-audit.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { runMigrations } = await import("@/lib/db/migrate");
    const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
    const { todayET } = await import("@/lib/calendar/date-utils");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");

    function argValue(flag: string): string | undefined {
      const eqArg = args.find((a) => a.startsWith(`${flag}=`));
      if (eqArg) return eqArg.slice(flag.length + 1);
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
      return undefined;
    }

    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const defaultDbPath = path.default.join(dataDir, "vanguard.db");
    const dbPath = argValue("--db") ?? defaultDbPath;

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
      return;
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Gated on --apply (mirrors repair-december-snapshots.ts / repair-ah-closes.ts):
    // a dry run must never write, and runMigrations() is a write the instant a
    // pending migration exists.
    if (apply) {
      runMigrations(db);
    }

    const today = todayET();

    console.log(
      `Auditing earnings preview/skip audit rows for the reconcile drag defect ` +
        `${apply ? "[APPLY]" : "[DRY RUN]"} (today=${today})`,
    );

    // Always compute the full plan first (dry-run mode internally — see
    // repairEarningsPreviewAudit's doc comment for why this reflects the
    // exact outcome --apply would commit).
    const plan = repairEarningsPreviewAudit(db, { apply: false, today });
    printReport(plan);

    const nothingToDo =
      plan.previewRepoints.plans.length === 0 &&
      !plan.phantomDelete.eligible &&
      !plan.backfill.eligible;

    if (nothingToDo) {
      console.log("\nNothing to repair.");
      db.close();
      return;
    }

    if (!apply) {
      console.log("\nDry-run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    // NEVER proceed past this line without a verified backup — same
    // VACUUM-INTO convention + "fail hard" behavior as
    // rebuild-ibkr-ledger.ts::ensureBackup / repair-ah-closes.ts /
    // repair-december-snapshots.ts.
    const backupPath = path.default.join(
      dataDir,
      "backups",
      `pre-earnings-preview-audit-repair-${today}.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path} ` +
        `(${backup.sizeBytes.toLocaleString()} bytes).`,
    );

    const applied = repairEarningsPreviewAudit(db, { apply: true, today });
    console.log(
      `\nApplied: repointed ${applied.repointedCount} preview row(s), ` +
        `deleted ${applied.deleted ? 1 : 0} phantom row(s), ` +
        `backfilled ${applied.backfilled ? 1 : 0} row(s).`,
    );
    console.log("\nFinal verification summary (post-commit):");
    printReport(applied);

    db.close();
  })();
}
