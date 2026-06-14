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
import type Anthropic from "@anthropic-ai/sdk";
import { resolveTier, type Tier } from "@/lib/ai/model-tiers";

const KEY = "model_catalog";
const KEY_UPDATED = "model_catalog_updated_at";
/** Safety net only (Mac missed the weekly run, e.g. travel) — NOT the cadence. */
const STALE_AFTER_HOURS = 14 * 24;

const TIERS: Tier[] = ["frontier", "workhorse", "cheap"];

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
 * Given the listed model ids and an async `probe(id) -> isCallable`, return the
 * catalog with confirmed-uncallable models removed. A model is dropped ONLY when
 * the probe returns false (caller maps a definitive 404/403 to false; transient
 * 429/500/network to true so we never prune a good model on a blip). We probe
 * only each tier's *selection* (and its next rungs if that selection is dead),
 * reusing results — a handful of probes, not one per model.
 */
export async function pruneToCallable(
  listed: string[],
  probe: (id: string) => Promise<boolean>,
): Promise<string[]> {
  const dead = new Set<string>();
  const knownCallable = new Set<string>();
  for (const tier of TIERS) {
    for (let guard = 0; guard < 8; guard++) {
      const sel = resolveTier(tier, listed, dead);
      if (!listed.includes(sel)) break;       // static fallback not in the listing — nothing to probe
      if (knownCallable.has(sel)) break;       // already verified callable for another tier
      const ok = await probe(sel);
      if (ok) { knownCallable.add(sel); break; }
      dead.add(sel);                           // drop & re-select next rung
    }
  }
  return listed.filter((id) => !dead.has(id));
}

/**
 * Tiny callability probe. Returns false ONLY on a definitive not_found/permission
 * (404/403) — a pulled-but-listed model. Any other error (429/500/network/400) →
 * true (don't prune a good model on a transient blip; reactive failover covers a
 * real mid-week outage).
 */
async function probeCallable(
  client: Anthropic,
  id: string,
): Promise<boolean> {
  try {
    await client.messages.create({
      model: id,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404 || status === 403) return false;
    return true;
  }
}

/**
 * Fetch the current model list from Anthropic, probe each tier's selection for
 * callability, and write only the callable subset to the cache.
 * Uses the raw @anthropic-ai/sdk client (Gateway-routed) — the AI SDK provider
 * doesn't expose models.list(). Graceful: on error, logs and leaves the prior
 * cache intact (returns the existing cached ids).
 *
 * A pulled model (e.g. claude-fable-5 under a gov hold) stays listed in
 * /v1/models but 404s on use. Probing here means resolution proactively picks
 * the best CALLABLE model rather than trying the uncallable one at call time.
 * Transient errors (429/500/network) never cause pruning.
 */
export async function refreshModelCatalog(db: Database.Database): Promise<string[]> {
  const { getRawAnthropicClient } = await import("@/lib/ai/provider");
  try {
    const client = getRawAnthropicClient("chat"); // feature tag only; any key works
    const listed: string[] = [];
    // models.list() auto-paginates on iteration.
    for await (const m of client.models.list()) {
      if (typeof m.id === "string") listed.push(m.id);
    }
    if (listed.length === 0) {
      console.warn("[model-catalog] /v1/models returned 0 ids — keeping prior cache");
      return getModelCatalog(db);
    }
    const callable = await pruneToCallable(listed, (id) => probeCallable(client, id));
    setModelCatalog(db, callable);
    console.log(`[model-catalog] refreshed: ${listed.length} listed, ${callable.length} callable`);
    return callable;
  } catch (err) {
    console.warn(`[model-catalog] refresh failed, keeping prior cache: ${String(err)}`);
    return getModelCatalog(db);
  }
}
