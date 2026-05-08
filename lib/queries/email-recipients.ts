import type Database from "better-sqlite3";

export type EmailType = "briefing" | "digest" | "evening";

/**
 * Read per-email-type recipient overrides from the `settings` key-value table.
 *
 * Keys:
 *   briefing_email_recipients
 *   digest_email_recipients
 *   evening_email_recipients
 *
 * Values are comma-separated email strings (e.g. "a@x.com, b@x.com").
 * Returns null when the key is absent, empty, or contains only whitespace.
 */
export function getRecipientsFor(
  db: Database.Database,
  type: EmailType
): string[] | null {
  const key = `${type}_email_recipients`;
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;

  if (!row || !row.value) return null;

  const parsed = row.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : null;
}
