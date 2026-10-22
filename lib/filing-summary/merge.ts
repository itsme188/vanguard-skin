/**
 * The filing summary's event-merge handler (spec Hardening 2, R14).
 *
 * Runs SYNCHRONOUSLY inside `mergeEarningsEventState`'s transaction, BEFORE
 * the donor event is deleted (every 099 table cascades on that delete, and
 * the donor may also be merely superseded, so nothing is left on it):
 *
 *  - event row: the target's is kept when it has one; the model choice and
 *    its lock come from whichever side is locked (the target wins a tie). With
 *    no target row the donor's row moves.
 *  - filings (keyed by event + accession): a donor accession the target
 *    already has is folded into the target's row: the donor's sections are
 *    re-pointed at the target filing, then the donor filing is deleted (its
 *    document rows cascade; files on disk are keyed by accession, so nothing
 *    is lost). Any other donor filing moves, numbered after the target's.
 *  - runs: move, renumbered after the target's highest `run_no`, in donor
 *    order. A donor section with a live claim is released (`pending`, no
 *    claim) so the next tick retakes it under the target; the old worker's
 *    finalize then fails its claim check and writes nothing.
 *  - pushes: move (the key is the primary key and does not change).
 *
 * Revalidating filings when a move changes the date or issuer is NOT done
 * here (the gate needs document text and the handler must stay SQL-only).
 */
import type { EventMergeContext, EventMergeTableResult } from "@/lib/earnings/event-merge";

export const FILING_SUMMARY_MERGE_HANDLER_NAME = "filing-summary";

function tableResult(table: string): EventMergeTableResult {
  return { table, moved: 0, merged: 0, deleted: 0, notes: [] };
}

interface EventRowRaw {
  family: string | null;
  effort: string | null;
  locked_at: string | null;
}

export function mergeFilingSummaryState(ctx: EventMergeContext): EventMergeTableResult[] {
  const { db, donorEventId, targetEventId } = ctx;
  const events = tableResult("filing_summary_events");
  const filings = tableResult("filing_summary_filings");
  const runs = tableResult("filing_summary_runs");
  const sections = tableResult("filing_summary_sections");
  const pushes = tableResult("filing_summary_pushes");
  const out = [events, filings, runs, sections, pushes];
  if (donorEventId === targetEventId) return out;

  // ---- event row
  const donorEvent = db
    .prepare(`SELECT family, effort, locked_at FROM filing_summary_events WHERE event_id = ?`)
    .get(donorEventId) as EventRowRaw | undefined;
  if (donorEvent) {
    const targetEvent = db
      .prepare(`SELECT family, effort, locked_at FROM filing_summary_events WHERE event_id = ?`)
      .get(targetEventId) as EventRowRaw | undefined;
    if (!targetEvent) {
      db.prepare(
        `UPDATE filing_summary_events SET event_id = ?, updated_at = datetime('now') WHERE event_id = ?`,
      ).run(targetEventId, donorEventId);
      events.moved = 1;
    } else {
      if (donorEvent.locked_at !== null && targetEvent.locked_at === null) {
        db.prepare(
          `UPDATE filing_summary_events
              SET family = ?, effort = ?, locked_at = ?, updated_at = datetime('now')
            WHERE event_id = ?`,
        ).run(donorEvent.family, donorEvent.effort, donorEvent.locked_at, targetEventId);
        events.notes.push("the donor's locked model choice carried to the target");
      }
      db.prepare(`DELETE FROM filing_summary_events WHERE event_id = ?`).run(donorEventId);
      events.merged = 1;
      events.deleted = 1;
    }
  }

  // ---- filings
  const donorFilings = db
    .prepare(
      `SELECT id, accession FROM filing_summary_filings WHERE event_id = ? ORDER BY discovery_seq, id`,
    )
    .all(donorEventId) as Array<{ id: number; accession: string }>;
  const targetByAccession = db.prepare(
    `SELECT id FROM filing_summary_filings WHERE event_id = ? AND accession = ?`,
  );
  const repointSections = db.prepare(
    `UPDATE filing_summary_sections SET filing_id = ? WHERE filing_id = ?`,
  );
  const deleteFiling = db.prepare(`DELETE FROM filing_summary_filings WHERE id = ?`);
  const moveFiling = db.prepare(
    `UPDATE filing_summary_filings SET event_id = ?, discovery_seq = ? WHERE id = ?`,
  );
  let nextSeq =
    (
      db
        .prepare(
          `SELECT COALESCE(MAX(discovery_seq), 0) AS m FROM filing_summary_filings WHERE event_id = ?`,
        )
        .get(targetEventId) as { m: number }
    ).m + 1;
  for (const f of donorFilings) {
    const twin = targetByAccession.get(targetEventId, f.accession) as { id: number } | undefined;
    if (twin) {
      const repointed = repointSections.run(twin.id, f.id).changes;
      deleteFiling.run(f.id);
      filings.merged += 1;
      filings.deleted += 1;
      if (repointed > 0) {
        filings.notes.push(`${repointed} section(s) re-pointed to the target's copy of ${f.accession}`);
      }
      continue;
    }
    moveFiling.run(targetEventId, nextSeq, f.id);
    nextSeq += 1;
    filings.moved += 1;
  }

  // ---- runs, renumbered after the target's
  const donorRuns = db
    .prepare(`SELECT id FROM filing_summary_runs WHERE event_id = ? ORDER BY run_no, id`)
    .all(donorEventId) as Array<{ id: number }>;
  if (donorRuns.length > 0) {
    let nextRunNo =
      (
        db
          .prepare(`SELECT COALESCE(MAX(run_no), 0) AS m FROM filing_summary_runs WHERE event_id = ?`)
          .get(targetEventId) as { m: number }
      ).m + 1;
    const moveRun = db.prepare(`UPDATE filing_summary_runs SET event_id = ?, run_no = ? WHERE id = ?`);
    const releaseClaims = db.prepare(
      `UPDATE filing_summary_sections
          SET status = 'pending', claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL
        WHERE run_id = ? AND status = 'running'`,
    );
    for (const r of donorRuns) {
      moveRun.run(targetEventId, nextRunNo, r.id);
      nextRunNo += 1;
      runs.moved += 1;
      const released = releaseClaims.run(r.id).changes;
      if (released > 0) {
        sections.merged += released;
        sections.notes.push(`${released} live claim(s) released on moved run ${r.id}`);
      }
    }
  }

  // ---- pushes
  pushes.moved = db
    .prepare(`UPDATE filing_summary_pushes SET event_id = ?, updated_at = datetime('now') WHERE event_id = ?`)
    .run(targetEventId, donorEventId).changes;

  return out;
}
