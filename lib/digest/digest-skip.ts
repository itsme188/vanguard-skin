import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * The last time the scheduled digest window came back empty.
 *
 * Written only by the skip branch of `sendDigestEmail` (and only for the
 * scheduled `since_last` window); read by `/api/digest/status` so the
 * catch-up banner can say "nothing new to send" instead of "wasn't sent".
 * One row in `settings`, overwritten on each skip. A later successful send
 * does not clear it: the banner compares it with `last_digest_sent_at`.
 */
export const DIGEST_SKIP_KEY = "last_digest_skip";

export interface DigestSkipRecord {
  /** The sender's own reason string. */
  reason: string;
  /** Eastern calendar date of the skip, YYYY-MM-DD. */
  date: string;
  /** When the skip was recorded, ISO UTC. */
  at: string;
}

export function recordDigestSkip(
  db: Database.Database,
  reason: string,
  now: Date = new Date(),
): void {
  const record: DigestSkipRecord = {
    reason,
    date: todayET(now),
    at: now.toISOString(),
  };
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(DIGEST_SKIP_KEY, JSON.stringify(record));
}

/** Read-only. An absent or unreadable row is "no skip recorded". */
export function getLastDigestSkip(db: Database.Database): DigestSkipRecord | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(DIGEST_SKIP_KEY) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { reason, date, at } = parsed as Record<string, unknown>;
    if (typeof reason !== "string" || typeof date !== "string" || typeof at !== "string") {
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { reason, date, at };
  } catch {
    return null;
  }
}
