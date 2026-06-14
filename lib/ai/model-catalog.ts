/**
 * settings-backed cache of AVAILABLE Anthropic model ids (from /v1/models).
 * Mirrors the getRiskFreeRate pattern (lib/queries/risk-free-rate.ts): a
 * synchronous read off the `settings` table, a staleness guard, and a refresh
 * that is graceful on API error (never clobbers a good cache).
 *
 * Cadence is intentionally loose — the catalog only drives NEW-model discovery
 * (weekly is plenty). Pulls are handled reactively at call time, not here.
 */

import type Database from "better-sqlite3";

const KEY = "model_catalog";
const KEY_UPDATED = "model_catalog_updated_at";
/** Safety net only (Mac missed the weekly run, e.g. travel) — NOT the cadence. */
const STALE_AFTER_HOURS = 14 * 24;

interface SettingRow { value: string; }

/** Synchronous read of the cached available-model ids. [] if unset/missing. */
export function getModelCatalog(db: Database.Database): string[] {
  let row: SettingRow | undefined;
  try {
    row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
      | SettingRow
      | undefined;
  } catch {
    return [];
  }
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function isModelCatalogStale(db: Database.Database): boolean {
  let row: SettingRow | undefined;
  try {
    row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY_UPDATED) as
      | SettingRow
      | undefined;
  } catch {
    return true;
  }
  if (!row) return true;
  const updatedAt = new Date(row.value + (row.value.includes("T") ? "" : "Z"));
  if (isNaN(updatedAt.getTime())) return true;
  return (Date.now() - updatedAt.getTime()) / 3_600_000 > STALE_AFTER_HOURS;
}

export function setModelCatalog(db: Database.Database, ids: string[]): void {
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(KEY, JSON.stringify(ids));
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(KEY_UPDATED, new Date().toISOString());
  });
  tx();
}

/**
 * Fetch the current model list from Anthropic and write it to the cache.
 * Uses the raw @anthropic-ai/sdk client (Gateway-routed) — the AI SDK provider
 * doesn't expose models.list(). Graceful: on error, logs and leaves the prior
 * cache intact (returns the existing cached ids).
 */
export async function refreshModelCatalog(db: Database.Database): Promise<string[]> {
  const { getRawAnthropicClient } = await import("@/lib/ai/provider");
  try {
    const client = getRawAnthropicClient("chat"); // feature tag only; any key works
    const ids: string[] = [];
    // models.list() auto-paginates on iteration.
    for await (const m of client.models.list()) {
      if (typeof m.id === "string") ids.push(m.id);
    }
    if (ids.length === 0) {
      console.warn("[model-catalog] /v1/models returned 0 ids — keeping prior cache");
      return getModelCatalog(db);
    }
    setModelCatalog(db, ids);
    console.log(`[model-catalog] refreshed: ${ids.length} models`);
    return ids;
  } catch (err) {
    console.warn(`[model-catalog] refresh failed, keeping prior cache: ${String(err)}`);
    return getModelCatalog(db);
  }
}
