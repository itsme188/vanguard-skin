/**
 * Live broker-snapshot sources for `monthly_snapshots` rows.
 *
 * 'tws'   — TWS sync + IBKR Web API path (both stamp 'tws' deliberately)
 * 'plaid' — Plaid Investments daily Vanguard pull
 *
 * These rows are CURRENT-value snapshots, not month-end statements. Every
 * historical read (TWR, XIRR, chart, account summaries, data confidence)
 * must exclude them via excludeLiveSnapshotsSql(); surfaces that want the
 * live "current value" opt in via onlyLiveSnapshotsSql().
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
