/**
 * Cloud-side price-level scan with Pushover fan-out.
 *
 * Closes the travel-resilience gap where Pushover alerts silently stop firing
 * when the Mac is asleep — the Mac-side findCrossedLevels + detectAndFireAlerts
 * pipeline runs only after TWS auto-refresh, which requires the Electron app
 * to be alive.
 *
 * Scope (v1, static levels only):
 *   - Reads `securityLevels` from the v4 R2 snapshot (Mac writes nightly at 2am).
 *   - For each unique symbol with at least one active level, fetches the latest
 *     1-min price from Yahoo. ~10 symbols typical → ~5-8s with pacing.
 *   - Compares each level against the latest price using the same direction
 *     semantics as Mac's findCrossedLevels (support/entry/scale_in/stop fire
 *     when price <= level; resistance/exit fire when price >= level).
 *   - Dedups against `cloud-fired-level-{levelId}` KV markers (24h TTL).
 *   - Pre-checks `mac-recent-scan` marker (set by Mac after each auto-refresh
 *     scan completes) to avoid duplicate firing during the overlap when Mac
 *     wakes mid-window.
 *   - Sends Pushover notification per new cross; writes KV marker.
 *
 * Mac reconcile (separate route on the app side): the Mac wakes, sees the
 * KV markers, inserts level_alerts rows so the inbox catches up, then deletes
 * the markers. Pushover already fired — reconcile is purely audit/UI.
 *
 * MA-based levels (sma_*, ema_*) are intentionally excluded — they require
 * OHLCV bars to resolve effective_price and would need a heavier snapshot.
 * ~90% coverage of typical user levels at current volumes (9 of 10 static
 * as of 2026-05-11 audit).
 */

import type { Snapshot, SecurityLevelRow } from "./state";
import { loadLatestSnapshot } from "./state";
import { fetchYahooLastPrice } from "./yahoo";
import { sendLevelAlertPush, type PushoverEnv } from "./pushover";

export interface LevelScanEnv extends PushoverEnv {
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
}

export interface LevelScanResult {
  scanned: number;
  fired: number;
  deduped: number;
  skipped: number;
  results: Array<{
    levelId: number;
    symbol: string;
    levelType: string;
    levelPrice: number;
    triggeredPrice: number;
    outcome: "fired" | "deduped" | "skipped" | "mac_already_scanning";
    reason?: string;
  }>;
}

const KV_FIRED_PREFIX = "cloud-fired-level-";
const KV_MAC_SCAN_MARKER = "mac-recent-scan";
const FIRED_TTL_SECONDS = 24 * 60 * 60; // 24h
const MAC_SCAN_RECENCY_SECONDS = 90 * 60; // 90 min — wider than the 30-min auto-refresh window

/**
 * Pure helper exported for tests. Determines whether `price` crosses `level`
 * given the level type's direction semantics.
 *
 * Mirrors the Mac-side direction logic in findCrossedLevels:
 *   "going down" types (support/entry/scale_in/stop) — fire when price <= level.
 *   "going up"   types (resistance/exit)            — fire when price >= level.
 *
 * Any other level_type returns false (defensive — never fire on unknown shape).
 */
export function isLevelCrossed(level: { level_type: string; price: number }, currentPrice: number): boolean {
  const goingDown = ["support", "entry", "scale_in", "stop"].includes(level.level_type);
  if (goingDown) return currentPrice <= level.price;
  if (["resistance", "exit"].includes(level.level_type)) return currentPrice >= level.price;
  return false;
}

interface RunOpts {
  /** Override the snapshot loader for tests. */
  loadSnapshot?: (bucket: R2Bucket) => Promise<Snapshot | null>;
  /** Override the price fetcher for tests. */
  fetchPrice?: (symbol: string) => Promise<{ price: number; tMs: number } | null>;
  /** Override the push sender for tests. */
  sendPush?: typeof sendLevelAlertPush;
  /** Skip the pacing delay between Yahoo fetches (used in tests). */
  pacingMs?: number;
  /** When true, do everything except write KV markers (for smoke testing). */
  dryRun?: boolean;
}

export async function runLevelScan(
  env: LevelScanEnv,
  opts: RunOpts = {},
): Promise<LevelScanResult> {
  const result: LevelScanResult = { scanned: 0, fired: 0, deduped: 0, skipped: 0, results: [] };

  // Mac-recent-scan check — Mac sets this every time its auto-refresh
  // pipeline completes detectAndFireAlerts. If recently set, the Mac is
  // active and we should not duplicate-fire from the cloud.
  const macScan = await env.CRON_KV.get(KV_MAC_SCAN_MARKER);
  if (macScan) {
    return { ...result, skipped: 1, results: [{ levelId: 0, symbol: "*", levelType: "*", levelPrice: 0, triggeredPrice: 0, outcome: "mac_already_scanning", reason: `mac-recent-scan marker present (${macScan})` }] };
  }

  const loadFn = opts.loadSnapshot ?? loadLatestSnapshot;
  const snapshot = await loadFn(env.ARCHIVE);
  if (!snapshot) {
    return { ...result, skipped: 1, results: [{ levelId: 0, symbol: "*", levelType: "*", levelPrice: 0, triggeredPrice: 0, outcome: "skipped", reason: "no_snapshot" }] };
  }

  const levels = snapshot.securityLevels ?? [];
  if (levels.length === 0) {
    return { ...result, skipped: 1, results: [{ levelId: 0, symbol: "*", levelType: "*", levelPrice: 0, triggeredPrice: 0, outcome: "skipped", reason: "no_levels_in_snapshot" }] };
  }

  // Group by symbol so we only fetch each symbol once.
  const bySymbol = new Map<string, SecurityLevelRow[]>();
  for (const lvl of levels) {
    if (lvl.expires_at && lvl.expires_at < new Date().toISOString().slice(0, 10)) continue;
    const arr = bySymbol.get(lvl.symbol) ?? [];
    arr.push(lvl);
    bySymbol.set(lvl.symbol, arr);
  }

  const fetchFn = opts.fetchPrice ?? fetchYahooLastPrice;
  const sendFn = opts.sendPush ?? sendLevelAlertPush;
  const pacing = opts.pacingMs ?? 200;
  const symbols = Array.from(bySymbol.keys());

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const priceData = await fetchFn(sym);
    if (!priceData) {
      const symbolLevels = bySymbol.get(sym) ?? [];
      for (const lvl of symbolLevels) {
        result.results.push({
          levelId: lvl.id,
          symbol: sym,
          levelType: lvl.level_type,
          levelPrice: lvl.price,
          triggeredPrice: 0,
          outcome: "skipped",
          reason: "no_price",
        });
        result.skipped++;
      }
      if (pacing > 0 && i < symbols.length - 1) await new Promise((r) => setTimeout(r, pacing));
      continue;
    }

    const symbolLevels = bySymbol.get(sym) ?? [];
    for (const lvl of symbolLevels) {
      result.scanned++;
      if (!isLevelCrossed(lvl, priceData.price)) continue;

      const kvKey = `${KV_FIRED_PREFIX}${lvl.id}`;
      const existing = await env.CRON_KV.get(kvKey);
      if (existing) {
        result.deduped++;
        result.results.push({
          levelId: lvl.id,
          symbol: sym,
          levelType: lvl.level_type,
          levelPrice: lvl.price,
          triggeredPrice: priceData.price,
          outcome: "deduped",
        });
        continue;
      }

      if (!opts.dryRun) {
        const payload = JSON.stringify({
          levelId: lvl.id,
          securityId: lvl.security_id,
          symbol: sym,
          levelType: lvl.level_type,
          levelPrice: lvl.price,
          triggeredPrice: priceData.price,
          triggeredAt: new Date(priceData.tMs).toISOString(),
          sourceAuthor: lvl.source_author,
        });
        await env.CRON_KV.put(kvKey, payload, { expirationTtl: FIRED_TTL_SECONDS });
      }

      const pushRes = await sendFn(env, {
        symbol: sym,
        levelType: lvl.level_type,
        triggeredPrice: priceData.price,
        sourceAuthor: lvl.source_author,
        securityId: lvl.security_id,
      });

      result.fired++;
      result.results.push({
        levelId: lvl.id,
        symbol: sym,
        levelType: lvl.level_type,
        levelPrice: lvl.price,
        triggeredPrice: priceData.price,
        outcome: "fired",
        reason: pushRes.sent ? "push_sent" : `push_failed:${pushRes.reason ?? "unknown"}`,
      });
    }

    if (pacing > 0 && i < symbols.length - 1) await new Promise((r) => setTimeout(r, pacing));
  }

  return result;
}

/**
 * Gate: market hours only — Mon-Fri 09:30-16:00 ET. Bounded by hours+minutes
 * to avoid scanning during pre-market / after-hours where Yahoo data is
 * noisier and level alerts would be premature.
 */
export function shouldRunLevelScan(): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = get("weekday");
  const hourStr = get("hour");
  const minuteStr = get("minute");
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dow)) return false;
  // Intl returns "24" for midnight under hour12:false on some runtimes; clamp.
  const hour = parseInt(hourStr, 10) % 24;
  const minute = parseInt(minuteStr, 10);
  const minutesSinceMidnight = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return minutesSinceMidnight >= open && minutesSinceMidnight <= close;
}
