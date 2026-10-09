import fs from "node:fs";
import path from "node:path";
import { resolveDbDir } from "@/lib/db/db-path";

/**
 * The ONE reader of the private Vanguard account-number -> account-name map.
 *
 * The map lives in `<database dir>/vanguard-accounts.json`, next to the
 * database and never in a committed file (the repo is public):
 *   { "<account number>": "Vanguard Taxable", "<account number>": "Vanguard Roth IRA" }
 * An account number must never be written into source, tests or docs.
 */
export const VANGUARD_ACCOUNTS_FILENAME = "vanguard-accounts.json";

/** An already-loaded map (account number -> account name). */
export type AccountMapSource = Readonly<Record<string, string>>;

export function vanguardAccountsPath(): string {
  return path.join(resolveDbDir(), VANGUARD_ACCOUNTS_FILENAME);
}

/** Validate parsed JSON into a clean map; anything unusable is dropped. */
function cleanMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const k = key.trim();
    const v = value.trim();
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

const cache = new Map<string, { mtimeMs: number; map: Record<string, string> }>();

/**
 * Read the map from `filePath`. Never throws: a missing file, bad JSON or a
 * wrong shape gives an empty map. Cached by modification time, so an edit to
 * the file is picked up on the next parse without a restart.
 */
export function loadVanguardAccountMap(
  filePath: string = vanguardAccountsPath(),
): Record<string, string> {
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const hit = cache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.map;
    const map = cleanMap(JSON.parse(fs.readFileSync(filePath, "utf8")));
    cache.set(filePath, { mtimeMs, map });
    return map;
  } catch {
    cache.delete(filePath);
    return {};
  }
}

export function resolveVanguardAccountName(
  accountNumber: string,
  source?: AccountMapSource,
): { accountName: string; mapped: boolean } {
  const map = source ? cleanMap(source) : loadVanguardAccountMap();
  const key = accountNumber.trim();
  const name = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  if (name) return { accountName: name, mapped: true };
  return { accountName: `Vanguard ${accountNumber}`, mapped: false };
}

/** Preview warning for an unmapped account. Shows only the last four digits. */
export function unmappedAccountWarning(accountNumber: string): string {
  const last4 = accountNumber.trim().slice(-4);
  return `Account ending ${last4} is not in ${VANGUARD_ACCOUNTS_FILENAME} (next to the database); it will import as a new account named 'Vanguard ...${last4}'. Add it to that file and preview again.`;
}
