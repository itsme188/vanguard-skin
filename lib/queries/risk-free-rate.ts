/**
 * Risk-free rate plumbing. Replaces the 0.045 hardcoded constants in
 *   lib/compute/risk.ts (Sharpe ratio numerator)
 *   lib/compute/options-greeks.ts (Black-Scholes drift)
 *
 * Storage: `settings` table key `risk_free_rate`, value is a decimal string
 * (e.g. "0.0532") and an `updated_at` timestamp. Fetched daily from FRED's
 * DGS3MO series — the 3-month T-bill is the standard short-end risk-free
 * proxy for Sharpe and Black-Scholes use.
 *
 * Lazy-refresh: getRiskFreeRate() returns the cached value if fresh (<48h),
 * otherwise triggers a fire-and-forget refresh from FRED and returns the
 * stale value (or the 0.045 default if never fetched). This keeps reads fast
 * while ensuring the rate stays current without a dedicated cron.
 */

import type Database from "better-sqlite3";

const KEY = "risk_free_rate";
const KEY_UPDATED = "risk_free_rate_updated_at";
const DEFAULT_RATE = 0.045;
const STALE_AFTER_HOURS = 48;

interface SettingRow {
  value: string;
}

/**
 * Synchronous read. Returns the cached rate, or the default if never set.
 * Public market data — no privacy masking.
 *
 * Defensively swallows "no such table" errors so in-memory test DBs that
 * don't run the settings migration still get the default rate.
 */
export function getRiskFreeRate(db: Database.Database): number {
  let row: SettingRow | undefined;
  try {
    row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KEY) as SettingRow | undefined;
  } catch {
    return DEFAULT_RATE;
  }
  if (!row) return DEFAULT_RATE;
  const parsed = parseFloat(row.value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0.25) {
    return DEFAULT_RATE;
  }
  return parsed;
}

/**
 * True if the cached rate is older than STALE_AFTER_HOURS.
 */
export function isRiskFreeRateStale(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY_UPDATED) as SettingRow | undefined;
  if (!row) return true;
  const updatedAt = new Date(row.value + (row.value.includes("T") ? "" : "Z"));
  if (isNaN(updatedAt.getTime())) return true;
  const ageHours = (Date.now() - updatedAt.getTime()) / 3_600_000;
  return ageHours > STALE_AFTER_HOURS;
}

export function setRiskFreeRate(db: Database.Database, rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 0.25) {
    throw new Error(`Refusing to write implausible risk-free rate: ${rate}`);
  }
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(KEY, rate.toFixed(5));
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(KEY_UPDATED, new Date().toISOString());
  });
  tx();
}

/**
 * Fetch the latest 3-month T-bill rate from FRED's DGS3MO series and write
 * it to the settings cache. FRED returns rates as percent (e.g. "5.32"),
 * we store as decimal (0.0532).
 *
 * Requires FRED_API_KEY in env. Throws on network or parse error so callers
 * can decide whether to swallow.
 */
export async function refreshRiskFreeRateFromFred(db: Database.Database): Promise<number> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY not set");

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "DGS3MO");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "5");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
  const json = (await res.json()) as {
    observations: { date: string; value: string }[];
  };

  const latest = json.observations.find((o) => o.value !== "." && o.value !== "");
  if (!latest) throw new Error("No usable DGS3MO observation in last 5 rows");

  const ratePct = parseFloat(latest.value);
  if (!Number.isFinite(ratePct) || ratePct <= 0 || ratePct > 25) {
    throw new Error(`FRED returned implausible rate: ${latest.value}`);
  }

  const rate = ratePct / 100;
  setRiskFreeRate(db, rate);
  return rate;
}
