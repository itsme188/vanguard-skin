/**
 * Earnings-email user preferences. Stored in the generic `settings` key-value
 * table (same place last_digest_sent_at lives) so reads from the API server
 * pick up changes immediately without restart — no env-var threading and no
 * Electron rebuild needed when the user flips a toggle.
 *
 * Used by:
 *   - findEmailCandidates() in lib/calendar/enrichment-runner.ts (filter)
 *   - /api/settings/earnings/route.ts (UI read/write)
 */

import type Database from "better-sqlite3";

const KEY_ENABLED = "earnings_emails_enabled";
const KEY_MUTED   = "earnings_emails_muted_symbols";

export interface EarningsSettings {
  enabled: boolean;
  mutedSymbols: string[];   // uppercase, deduplicated
}

export function getEarningsSettings(db: Database.Database): EarningsSettings {
  return {
    enabled: getEarningsEmailsEnabled(db),
    mutedSymbols: getMutedEarningsSymbols(db),
  };
}

export function getEarningsEmailsEnabled(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(KEY_ENABLED) as { value: string } | undefined;
  if (!row) return true; // default ON
  return row.value === "1" || row.value.toLowerCase() === "true";
}

export function setEarningsEmailsEnabled(
  db: Database.Database,
  enabled: boolean,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(KEY_ENABLED, enabled ? "1" : "0");
}

export function getMutedEarningsSymbols(db: Database.Database): string[] {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(KEY_MUTED) as { value: string } | undefined;
  if (!row || !row.value.trim()) return [];
  return row.value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export function setMutedEarningsSymbols(
  db: Database.Database,
  symbols: string[],
): void {
  // Dedup + uppercase + drop empties
  const cleaned = Array.from(
    new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)),
  );
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(KEY_MUTED, cleaned.join(","));
}

/**
 * Convenience predicate for the candidate-finding sweep. Returns true if
 * the email should be sent (feature enabled AND symbol not muted), false
 * otherwise. Symbol comparison is case-insensitive.
 */
export function shouldSendEarningsEmail(
  settings: EarningsSettings,
  symbol: string,
): boolean {
  if (!settings.enabled) return false;
  return !settings.mutedSymbols.includes(symbol.toUpperCase());
}
