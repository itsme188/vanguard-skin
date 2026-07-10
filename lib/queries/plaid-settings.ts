import type Database from "better-sqlite3";

// Plaid connection state lives in the SQLite `settings` table (runtime-
// obtained by the web app; DB is local + gitignored). Static creds
// (PLAID_CLIENT_ID/SECRET) come from env — see lib/plaid/client.ts.
const KEY_ACCESS_TOKEN = "plaid_access_token";
const KEY_ITEM_ID = "plaid_item_id";
const KEY_ACCOUNT_MAP = "plaid_account_map";
const KEY_ACCOUNTS_CACHE = "plaid_accounts_cache";
const KEY_CONNECTION_STATUS = "plaid_connection_status";
const KEY_LAST_SYNC_AT = "plaid_last_sync_at";
const KEY_REAUTH_ALERTED_AT = "plaid_reauth_alerted_at";

export interface PlaidAccountInfo {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
}

export interface PlaidConnection {
  accessToken: string | null;
  itemId: string | null;
  accountMap: Record<string, number>;
  connectionStatus: "ok" | "reauth_required" | "disconnected";
  lastSyncAt: string | null;
  plaidAccounts: PlaidAccountInfo[];
}

function getValue(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setValue(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(key, value);
}

function deleteValue(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getPlaidConnection(db: Database.Database): PlaidConnection {
  const accessToken = getValue(db, KEY_ACCESS_TOKEN);
  const rawStatus = getValue(db, KEY_CONNECTION_STATUS);
  const map = parseJson<Record<string, number>>(getValue(db, KEY_ACCOUNT_MAP), {});
  return {
    accessToken,
    itemId: getValue(db, KEY_ITEM_ID),
    accountMap: typeof map === "object" && map !== null && !Array.isArray(map) ? map : {},
    connectionStatus: !accessToken
      ? "disconnected"
      : rawStatus === "reauth_required"
        ? "reauth_required"
        : "ok",
    lastSyncAt: getValue(db, KEY_LAST_SYNC_AT),
    plaidAccounts: parseJson<PlaidAccountInfo[]>(getValue(db, KEY_ACCOUNTS_CACHE), []),
  };
}

export function setPlaidItem(db: Database.Database, accessToken: string, itemId: string): void {
  setValue(db, KEY_ACCESS_TOKEN, accessToken);
  setValue(db, KEY_ITEM_ID, itemId);
  setValue(db, KEY_CONNECTION_STATUS, "ok");
}

export function setPlaidAccountMap(db: Database.Database, map: Record<string, number>): void {
  setValue(db, KEY_ACCOUNT_MAP, JSON.stringify(map));
}

export function setPlaidAccountsCache(db: Database.Database, accounts: PlaidAccountInfo[]): void {
  setValue(db, KEY_ACCOUNTS_CACHE, JSON.stringify(accounts));
}

export function setPlaidConnectionStatus(
  db: Database.Database,
  status: "ok" | "reauth_required",
): void {
  setValue(db, KEY_CONNECTION_STATUS, status);
}

export function setPlaidLastSyncAt(db: Database.Database, iso: string): void {
  setValue(db, KEY_LAST_SYNC_AT, iso);
}

export function getPlaidReauthAlertedAt(db: Database.Database): string | null {
  return getValue(db, KEY_REAUTH_ALERTED_AT);
}

export function setPlaidReauthAlertedAt(db: Database.Database, iso: string | null): void {
  if (iso === null) deleteValue(db, KEY_REAUTH_ALERTED_AT);
  else setValue(db, KEY_REAUTH_ALERTED_AT, iso);
}
