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

  const parsed = splitRecipientList(row.value);

  return parsed.length > 0 ? parsed : null;
}

/** The one splitting rule: comma-separated, each entry trimmed, blanks dropped. */
export function splitRecipientList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ADDRESS_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** True when the entry has one @, a local part, a dotted domain and no spaces. */
export function looksLikeEmailAddress(entry: string): boolean {
  return ADDRESS_RE.test(entry);
}

/**
 * Check a comma-separated recipient value. An empty or blank value is fine
 * (it clears the key). Returns the first bad entry, or null when all are ok.
 */
export function firstBadRecipient(value: string): string | null {
  for (const entry of splitRecipientList(value)) {
    if (!looksLikeEmailAddress(entry)) return entry;
  }
  return null;
}
