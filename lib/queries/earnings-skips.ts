import type Database from "better-sqlite3";

export type EarningsEmailPhase = "preview" | "recap";

/**
 * For a list of event_ids, return which phases the user has marked as
 * skipped. Mirrors getSentPhasesForEvents in earnings-emails.ts so the
 * UI can render skip-state with one round-trip per row block.
 */
export function getSkippedPhasesForEvents(
  db: Database.Database,
  eventIds: number[],
): Record<number, { preview: boolean; recap: boolean }> {
  const out: Record<number, { preview: boolean; recap: boolean }> = {};
  if (eventIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT event_id, phase FROM earnings_email_skips
        WHERE event_id IN (${eventIds.map(() => "?").join(",")})`,
    )
    .all(...eventIds) as { event_id: number; phase: EarningsEmailPhase }[];
  for (const r of rows) {
    const existing = out[r.event_id] ?? { preview: false, recap: false };
    if (r.phase === "preview") existing.preview = true;
    if (r.phase === "recap") existing.recap = true;
    out[r.event_id] = existing;
  }
  return out;
}
