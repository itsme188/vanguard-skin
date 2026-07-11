import type Database from "better-sqlite3";
import { loadPlaidConfig } from "@/lib/plaid/client";
import { getPlaidConnection, type PlaidAccountInfo } from "./plaid-settings";
import { getAllAccounts } from "./accounts";

export interface PlaidSettingsPayload {
  configured: boolean;
  connected: boolean;
  connectionStatus: "ok" | "reauth_required" | "disconnected";
  lastSyncAt: string | null;
  plaidAccounts: PlaidAccountInfo[];
  accountMap: Record<string, number>;
  localAccounts: { id: number; name: string }[];
}

export function buildPlaidSettingsPayload(db: Database.Database): PlaidSettingsPayload {
  const conn = getPlaidConnection(db);
  return {
    configured: loadPlaidConfig() !== null,
    connected: conn.accessToken !== null,
    connectionStatus: conn.connectionStatus,
    lastSyncAt: conn.lastSyncAt,
    plaidAccounts: conn.plaidAccounts,
    accountMap: conn.accountMap,
    localAccounts: getAllAccounts(db).map((a) => ({ id: a.id, name: a.name })),
  };
}
