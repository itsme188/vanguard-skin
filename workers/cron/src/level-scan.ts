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
 *   - Once per level per EASTERN day, the day the Mac's own guard counts by
 *     (hasAlertToday): a level is held back only when its last fire was on
 *     the current Eastern day. The last fire is read from the snapshot row's
 *     `triggered_at` (v12) and from this Worker's own
 *     `cloud-fired-level-{levelId}` KV marker. A fire on an earlier Eastern
 *     day never blocks. The marker is ALSO the audit record the Mac
 *     reconciles into its inbox, so it is kept 7 days, not until midnight:
 *     its lifetime does not encode the guard. When a level fires again
 *     before the Mac has reconciled an earlier day's marker, the earlier
 *     record rides along in the new marker's `earlier` list.
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
import { etDateOfStoredUtc, todayET } from "./dst";

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
/**
 * How long a cloud-fired marker is kept for the Mac to reconcile into its
 * alert inbox. The Worker fires exactly when the Mac is down, often for a
 * night or a trip, so the record must outlive the day. The once-a-day guard
 * does NOT depend on this lifetime: it reads the marker's fire date.
 */
export const CLOUD_FIRED_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Most earlier-day records one marker carries (one per day of its lifetime). */
const MAX_EARLIER_RECORDS = 7;
const MAC_SCAN_RECENCY_SECONDS = 90 * 60; // 90 min — wider than the 30-min auto-refresh window

/**
 * Mirrors LEVEL_PLAUSIBILITY_MAX_DISTANCE in Mac's lib/queries/security-levels.ts
 * — keep the two in sync. A level more than 50% away from the live price is a
 * unit/scale error (SPX levels stored on SPY), not a hit.
 */
const LEVEL_PLAUSIBILITY_MAX_DISTANCE = 0.5;

/**
 * Pure helper exported for tests. Determines whether `price` crosses `level`
 * given the level type's direction semantics.
 *
 * Mirrors the Mac-side direction logic in findCrossedLevels:
 *   "going down" types (support/entry/scale_in/stop) — fire when price <= level.
 *   "going up"   types (resistance/exit)            — fire when price >= level.
 *
 * Any other level_type returns false (defensive — never fire on unknown shape).
 * Also mirrors the Mac-side plausibility guard: a price more than 50% away
 * from the level never "crosses" it — mis-scaled levels would otherwise sit
 * permanently hit and push Pushover noise on every cloud scan. (The Mac
 * exempts options from this guard; here no exemption is needed because OCC
 * option symbols never resolve on Yahoo, so option levels never reach this
 * check.)
 */
export function isLevelCrossed(level: { level_type: string; price: number }, currentPrice: number): boolean {
  if (Math.abs(currentPrice - level.price) / level.price > LEVEL_PLAUSIBILITY_MAX_DISTANCE) return false;
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
  /** The scan's clock. Defaults to the real time; tests pin it. */
  now?: Date;
}

/**
 * Did this Worker already alert on the level in the Eastern day `today`?
 *
 * The marker records `firedAt` (when the push went out). Markers written
 * before 2026-10-08 carry only `triggeredAt` (the time of the quote), which
 * is used when `firedAt` is absent. A marker that cannot be read does NOT
 * hold the level back: the marker lives 7 days, so failing closed would
 * silence a level for a week. The next fire overwrites it with a readable
 * marker, which then blocks for the rest of that Eastern day, so the cost of
 * an unreadable marker is at most one extra alert.
 */
function markerFiredOn(raw: string, today: string): boolean {
  let firedAt: unknown;
  try {
    const parsed = JSON.parse(raw) as { firedAt?: unknown; triggeredAt?: unknown } | null;
    firedAt = parsed?.firedAt ?? parsed?.triggeredAt;
  } catch {
    return false;
  }
  if (typeof firedAt !== "string") return false;
  return etDateOfStoredUtc(firedAt) === today;
}

/**
 * The records an earlier-day marker still owes the Mac's inbox: the marker
 * itself plus whatever it was already carrying, oldest first. Called only for
 * a marker that `markerFiredOn` read successfully and judged "not today".
 * Records older than the marker lifetime are dropped, so a level that fires
 * every day cannot grow its marker without bound.
 */
function unreconciledRecords(raw: string, now: Date): unknown[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { earlier, ...own } = parsed;
    const all = [...(Array.isArray(earlier) ? earlier : []), own];
    const cutoffMs = now.getTime() - CLOUD_FIRED_MARKER_TTL_SECONDS * 1000;
    return all
      .filter((r): r is Record<string, unknown> => {
        if (!r || typeof r !== "object") return false;
        const rec = r as { firedAt?: unknown; triggeredAt?: unknown };
        const at = typeof rec.firedAt === "string" ? rec.firedAt : rec.triggeredAt;
        const ms = typeof at === "string" ? Date.parse(at) : NaN;
        return !Number.isNaN(ms) && ms >= cutoffMs;
      })
      .slice(-MAX_EARLIER_RECORDS);
  } catch {
    return [];
  }
}

export async function runLevelScan(
  env: LevelScanEnv,
  opts: RunOpts = {},
): Promise<LevelScanResult> {
  const result: LevelScanResult = { scanned: 0, fired: 0, deduped: 0, skipped: 0, results: [] };
  const now = opts.now ?? new Date();
  const today = todayET(now);

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
    // Eastern date, not the UTC one: after 20:00 Eastern the UTC date is
    // already tomorrow and would expire a level a day early.
    if (lvl.expires_at && lvl.expires_at < today) continue;
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

      // Once per level per Eastern day. Two memories of the last fire: the
      // snapshot row (the Mac's own record) and this Worker's KV marker.
      const kvKey = `${KV_FIRED_PREFIX}${lvl.id}`;
      const firedTodayOnMac = etDateOfStoredUtc(lvl.triggered_at) === today;
      const existing = firedTodayOnMac ? null : await env.CRON_KV.get(kvKey);
      if (firedTodayOnMac || (existing !== null && markerFiredOn(existing, today))) {
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
          currency: lvl.currency ?? null,
          // When the alert went out. The once-a-day guard reads this, not
          // `triggeredAt`: a thinly traded name's last quote can be a day old.
          firedAt: now.toISOString(),
          // An earlier day's fire the Mac has not reconciled yet. This write
          // replaces that marker, so its record is carried here and the Mac
          // files one inbox row per day (reconcile-cloud-fired.ts).
          ...(existing !== null && unreconciledRecords(existing, now).length > 0
            ? { earlier: unreconciledRecords(existing, now) }
            : {}),
        });
        await env.CRON_KV.put(kvKey, payload, { expirationTtl: CLOUD_FIRED_MARKER_TTL_SECONDS });
      }

      const pushRes = await sendFn(env, {
        symbol: sym,
        levelType: lvl.level_type,
        triggeredPrice: priceData.price,
        sourceAuthor: lvl.source_author,
        securityId: lvl.security_id,
        armedCrossedAt: lvl.armed_crossed_at ?? null,
        currency: lvl.currency ?? null,
      });

      // The marker is written BEFORE the push so two overlapping scans cannot
      // both alert. If the push then did not go out, put things back as they
      // were: otherwise the level would be held for the rest of the day and
      // later filed in the Mac's inbox as an alert nobody received. The next
      // tick tries again; a push that was delivered but reported as failed
      // costs one duplicate alert, the smaller harm.
      if (!pushRes.sent && !opts.dryRun) {
        if (existing !== null) {
          await env.CRON_KV.put(kvKey, existing, { expirationTtl: CLOUD_FIRED_MARKER_TTL_SECONDS });
        } else {
          await env.CRON_KV.delete(kvKey);
        }
      }

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
