/**
 * repair-requeue-failed-enrichment.ts — companion to the QA finding
 * research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns.
 *
 * What went wrong: the newsletter enrichment pass counted every failure toward
 * its three-attempt cap. While the AI account was out of credit, every article
 * that arrived used its three attempts on the billing error and was excluded
 * as 'enrichment_failed' for good. lib/gmail/process.ts no longer counts an
 * account-level failure; this script recovers the rows the old behaviour
 * already excluded. The owner approves and runs it; nothing runs it
 * automatically.
 *
 * WHICH ROWS. A row is selected when ALL hold:
 *   - excluded_category = 'enrichment_failed' and is_relevant = 0 (still
 *     excluded, still listed on the Filtered tab), and
 *   - its excluded_reason records an ACCOUNT-level last failure, per
 *     classifyStoredFailureReason (lib/gmail/enrichment-failure.ts).
 * The reason text is the only thing a row records about its failure: the
 * status code and error type were never stored. The classes recognised are
 * the out-of-credit message, the AI SDK's "Failed after N attempts. Last
 * error: ..." (it only retries rate limits, server errors and network
 * failures), "Cannot connect to API", "invalid x-api-key", and the repo's own
 * missing-key error. A row whose recorded failure is a refusal, an empty or
 * unparseable result, a rejected request, or anything unrecognised is NEVER
 * selected: nothing proves the article was not at fault.
 *
 * Optional narrowing: --since YYYY-MM-DD and/or --until YYYY-MM-DD keep only
 * rows RECEIVED on or between those dates. received_at is stored in UTC, so
 * these are UTC dates: an evening Eastern-time arrival falls on the next day.
 *
 * WHAT IT WRITES. For each selected row, the same re-queue the Filtered tab's
 * Retry action performs: is_relevant = 1, excluded_category and
 * excluded_reason cleared, processed_at cleared, enrich_attempts = 0. No row
 * is deleted and no other column is touched. The next enrichment pass then
 * analyses the article, which costs one model call per row; passes take 20
 * articles at a time, newest first.
 *
 * Dry-run by default (prints counts and ids only, never subjects or text):
 *   npx tsx scripts/repair-requeue-failed-enrichment.ts
 * Apply (one transaction, after a VACUUM INTO backup beside the database):
 *   npx tsx scripts/repair-requeue-failed-enrichment.ts --apply
 * Rehearse on a copy first (run from the repo root):
 *   sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/repair-requeue-failed-enrichment.ts --apply
 *
 * Idempotent: a re-queued row is no longer 'enrichment_failed', so a second
 * run selects nothing and writes nothing.
 */
import type Database from "better-sqlite3";
import { classifyStoredFailureReason, type StoredFailureKind } from "../lib/gmail/enrichment-failure";
import { requeueArticlesForEnrichment } from "../lib/mutations/research-articles";

export interface RequeueCandidate {
  id: number;
  kind: StoredFailureKind;
}

export interface RequeueWindow {
  /** Inclusive YYYY-MM-DD lower bound on the article's received date. */
  since?: string;
  /** Inclusive YYYY-MM-DD upper bound on the article's received date. */
  until?: string;
}

export interface RequeueRepairResult {
  /** Rows excluded as 'enrichment_failed' inside the window, whatever the reason. */
  scanned: number;
  /** Of those, the rows whose recorded failure is account-level. */
  matched: RequeueCandidate[];
  /** `scanned - matched`: left alone because the recorded failure is not account-level. */
  skipped: number;
  /** Rows written. 0 on a dry run. */
  requeued: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(label: string, value: string | undefined): void {
  if (value !== undefined && !DATE_RE.test(value)) {
    throw new Error(`${label} must be a date like 2026-01-31 (got "${value}")`);
  }
}

/** Select the excluded rows whose recorded failure is account-level. Read-only. */
export function findRequeueCandidates(
  db: Database.Database,
  window: RequeueWindow = {},
): { scanned: number; matched: RequeueCandidate[] } {
  assertDate("--since", window.since);
  assertDate("--until", window.until);
  if (window.since && window.until && window.since > window.until) {
    throw new Error(`--since (${window.since}) is after --until (${window.until})`);
  }

  const conditions = ["excluded_category = 'enrichment_failed'", "is_relevant = 0"];
  const params: string[] = [];
  if (window.since) {
    conditions.push("substr(received_at, 1, 10) >= ?");
    params.push(window.since);
  }
  if (window.until) {
    conditions.push("substr(received_at, 1, 10) <= ?");
    params.push(window.until);
  }

  const rows = db
    .prepare(
      `SELECT id, excluded_reason
         FROM research_articles
        WHERE ${conditions.join(" AND ")}
        ORDER BY id`,
    )
    .all(...params) as { id: number; excluded_reason: string | null }[];

  const matched: RequeueCandidate[] = [];
  for (const row of rows) {
    const kind = classifyStoredFailureReason(row.excluded_reason);
    if (kind) matched.push({ id: row.id, kind });
  }
  return { scanned: rows.length, matched };
}

/**
 * Dry run (`apply: false`, the default for the CLI): reports, writes nothing.
 * Apply: re-queues every matched row in one transaction.
 */
export function repairRequeueFailedEnrichment(
  db: Database.Database,
  opts: { apply: boolean } & RequeueWindow,
): RequeueRepairResult {
  const { scanned, matched } = findRequeueCandidates(db, { since: opts.since, until: opts.until });
  const requeued =
    opts.apply && matched.length > 0
      ? requeueArticlesForEnrichment(
          db,
          matched.map((m) => m.id),
        )
      : 0;
  return { scanned, matched, skipped: scanned - matched.length, requeued };
}

/** The report the CLI prints: counts and ids only. */
export function formatRequeueReport(result: RequeueRepairResult, apply: boolean): string[] {
  const lines: string[] = [];
  lines.push(`Excluded as enrichment_failed in scope: ${result.scanned}`);
  lines.push(`Recorded failure is account-level:      ${result.matched.length}`);
  lines.push(`Left alone (article-level or unclear):  ${result.skipped}`);

  const byKind = new Map<StoredFailureKind, number[]>();
  for (const m of result.matched) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m.id]);
  for (const [kind, ids] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${kind}: ${ids.length} row(s), ids ${ids.join(", ")}`);
  }

  if (result.matched.length === 0) {
    lines.push("Nothing to re-queue.");
  } else if (apply) {
    lines.push(`Re-queued ${result.requeued} row(s). The next enrichment pass will analyse them.`);
  } else {
    lines.push(`Dry run: ${result.matched.length} row(s) would be re-queued. Re-run with --apply to write.`);
  }
  return lines;
}

/** Parse CLI flags. Throws on anything it does not understand. */
export function parseRequeueArgs(args: string[]): { apply: boolean } & RequeueWindow {
  const out: { apply: boolean } & RequeueWindow = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      out.apply = true;
    } else if (arg === "--since" || arg === "--until") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a date like 2026-01-31`);
      assertDate(arg, value);
      if (arg === "--since") out.since = value;
      else out.until = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument "${arg}". Flags: --apply, --since YYYY-MM-DD, --until YYYY-MM-DD`);
    }
  }
  return out;
}

// ─── CLI entry point ────────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-requeue-failed-enrichment.ts") ||
    process.argv[1].endsWith("repair-requeue-failed-enrichment.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const path = await import("node:path");
    const fs = await import("node:fs");

    let opts: { apply: boolean } & RequeueWindow;
    try {
      opts = parseRequeueArgs(process.argv.slice(2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    const dbPath = process.env.REPAIR_DB_PATH ?? path.default.join(process.cwd(), "data", "vanguard.db");
    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
      return;
    }

    // 60s lock wait: the live app's background sync can hold the write lock
    // past better-sqlite3's 5s default.
    const db = new BetterSqlite3(dbPath, { timeout: 60000 });
    db.pragma("foreign_keys = ON");

    try {
      const scope = [opts.since ? `since ${opts.since}` : null, opts.until ? `until ${opts.until}` : null]
        .filter(Boolean)
        .join(", ");
      console.log(
        `Re-queue failed enrichments ${opts.apply ? "[APPLY]" : "[DRY RUN]"} — db: ${dbPath}` +
          (scope ? ` — received ${scope}` : "") +
          "\n",
      );

      if (opts.apply && findRequeueCandidates(db, opts).matched.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = path.default.join(path.default.dirname(dbPath), "backups");
        fs.default.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.default.join(backupDir, `pre-requeue-failed-enrichment-${timestamp}.db`);
        db.prepare(`VACUUM INTO ?`).run(backupPath);
        console.log(`Backup: ${backupPath}\n`);
      }

      const result = repairRequeueFailedEnrichment(db, opts);
      for (const line of formatRequeueReport(result, opts.apply)) console.log(line);
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
