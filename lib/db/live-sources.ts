/**
 * Live broker-snapshot sources for `monthly_snapshots` rows.
 *
 * 'tws'   — TWS sync + IBKR Web API path (both stamp 'tws' deliberately)
 * 'plaid' — Plaid Investments daily Vanguard pull
 *
 * These rows are CURRENT-value snapshots, not month-end statements. Every
 * historical read (TWR, XIRR, chart, account summaries, data confidence)
 * must exclude them via excludeLiveSnapshotsSql(); readers that ask "was
 * this anchor a live row?" use onlyLiveSnapshotsSql(), and the current-value
 * live pick uses currentValueLiveSnapshotSql() (TWS only).
 *
 * A lint test (tests/db/live-sources.test.ts) rejects any raw `!= 'tws'`
 * comparison outside this file — never inline the source list.
 */
export const LIVE_SNAPSHOT_SOURCES = ["tws", "plaid"] as const;

const QUOTED = LIVE_SNAPSHOT_SOURCES.map((s) => `'${s}'`).join(",");

/** SQL fragment: row is a statement/historical snapshot (NOT live). */
export function excludeLiveSnapshotsSql(col = "source"): string {
  return `${col} NOT IN (${QUOTED})`;
}

/** SQL fragment: row is a live broker snapshot (tws or plaid). */
export function onlyLiveSnapshotsSql(col = "source"): string {
  return `${col} IN (${QUOTED})`;
}

/**
 * The live sources whose snapshot may stand as an account's CURRENT value
 * (plan v4 ruling E1, 2026-11-15/16). Only 'tws': the TWS sync and the IBKR
 * Web API path read the broker's net liquidation value during or after the
 * session the row is dated on. A Plaid snapshot is the PREVIOUS session's
 * close (it is read before the open), so it is never a current value; the
 * Vanguard current value comes from `daily_valuations` instead.
 */
export const CURRENT_VALUE_LIVE_SNAPSHOT_SOURCES = ["tws"] as const satisfies readonly (typeof LIVE_SNAPSHOT_SOURCES)[number][];

const CURRENT_VALUE_QUOTED = CURRENT_VALUE_LIVE_SNAPSHOT_SOURCES.map((s) => `'${s}'`).join(",");

/**
 * SQL fragment: row is a live snapshot that may be the current-value "live"
 * pick (TWS only). History readers keep `onlyLiveSnapshotsSql`, which still
 * means "a live row of either source".
 */
export function currentValueLiveSnapshotSql(col = "source"): string {
  return `${col} IN (${CURRENT_VALUE_QUOTED})`;
}
