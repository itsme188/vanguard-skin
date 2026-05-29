/**
 * anomalies.ts — Vanguard holdings anomaly detection for the evening email.
 *
 * Flags securities held in Vanguard (non-Roth) accounts whose daily move
 * significantly deviates from what their beta would predict given SPY's move.
 *
 * Privacy rule: output MUST NOT contain $ amounts, share counts, or position
 * size language. Only public market data (ticker, % move, beta) is emitted.
 */

import type Database from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnomalyFlag {
  securityId: number;
  symbol: string;
  companyName: string | null;
  actualPct: number;    // today's % move
  spyPct: number;       // SPY's % move today
  beta: number;
  expectedPct: number;  // spyPct × beta
  thresholdPct: number; // max(2 × |expectedPct|, 1.0)
  ratio: number;        // |actualPct| / thresholdPct
  directionFlipped: boolean;
}

// ─── Internal row types ───────────────────────────────────────────────────────

interface HeldSecurityRow {
  security_id: number;
  symbol: string;
  name: string | null;
  today_close: number;
  prior_close: number;
  beta: number | null;
}

interface PricePairRow {
  today_close: number;
  prior_close: number;
}

// ─── Main computation ─────────────────────────────────────────────────────────

/**
 * Compute anomaly flags for all securities held in Vanguard (non-Roth) accounts.
 *
 * Algorithm:
 * 1. Find SPY's two most recent prices; compute spyPct.
 * 2. Get all Vanguard-held securities with two most recent prices + cached beta.
 * 3. For each: compute actualPct, expectedPct, thresholdPct; flag if exceeded.
 * 4. Sort by ratio desc.
 */
export function computeAnomalies(db: Database.Database): AnomalyFlag[] {
  // ── 1. SPY latest two closes ────────────────────────────────────────────────
  const spyPrices = db
    .prepare(
      `SELECT p.close_price AS today_close,
              (SELECT p2.close_price
                 FROM prices p2
                WHERE p2.security_id = p.security_id
                  AND p2.date < p.date
                ORDER BY p2.date DESC
                LIMIT 1) AS prior_close
         FROM prices p
         JOIN securities s ON s.id = p.security_id
        WHERE UPPER(s.symbol) = 'SPY'
        ORDER BY p.date DESC
        LIMIT 1`
    )
    .get() as PricePairRow | undefined;

  if (!spyPrices || spyPrices.prior_close == null || spyPrices.prior_close === 0) {
    return [];
  }

  const spyPct =
    ((spyPrices.today_close - spyPrices.prior_close) / spyPrices.prior_close) * 100;

  // ── 2. Vanguard (non-Roth) account IDs ─────────────────────────────────────
  const vanguardAccounts = db
    .prepare(
      `SELECT id FROM accounts
       WHERE LOWER(name) LIKE '%vanguard%'
         AND LOWER(name) NOT LIKE '%roth%'`
    )
    .all() as { id: number }[];

  if (vanguardAccounts.length === 0) return [];

  const accountIds = vanguardAccounts.map((a) => a.id);
  const placeholders = accountIds.map(() => "?").join(",");

  // ── 3. Held securities with two most recent closes + cached beta ────────────
  // We use a correlated subquery to get the second-most-recent close per security.
  // The UNIQUE(security_id, date) constraint on `prices` means at most one row
  // per (security, date), so DESC LIMIT 1 / LIMIT 1 OFFSET 1 gives today/prior.
  const rows = db
    .prepare(
      `SELECT DISTINCT
              s.id AS security_id,
              s.symbol,
              s.name,
              p.close_price AS today_close,
              (SELECT p2.close_price
                 FROM prices p2
                WHERE p2.security_id = p.security_id
                  AND p2.date < p.date
                ORDER BY p2.date DESC
                LIMIT 1) AS prior_close,
              sb.beta
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts  a ON a.id  = h.account_id
         -- Most recent price for each security
         JOIN prices p ON p.security_id = s.id
              AND p.date = (
                SELECT MAX(p3.date) FROM prices p3 WHERE p3.security_id = s.id
              )
         LEFT JOIN security_betas sb
               ON sb.security_id = s.id AND sb.lookback_days = 60
        WHERE h.account_id IN (${placeholders})
          AND UPPER(s.symbol) != 'SPY'`
    )
    .all(...accountIds) as HeldSecurityRow[];

  // ── 4. Compute flags ────────────────────────────────────────────────────────
  const flags: AnomalyFlag[] = [];

  for (const row of rows) {
    // Skip: no beta, no prior close, or zero prior close
    if (row.beta == null) continue;
    if (row.prior_close == null || row.prior_close === 0) continue;
    if (row.today_close == null) continue;

    const actualPct = ((row.today_close - row.prior_close) / row.prior_close) * 100;
    const expectedPct = spyPct * row.beta;
    const thresholdPct = Math.max(2 * Math.abs(expectedPct), 1.0);

    if (Math.abs(actualPct) <= thresholdPct) continue;

    const ratio = Math.abs(actualPct) / thresholdPct;

    // Direction flipped: opposite signs AND |expected| is meaningful (> 0.1%)
    const directionFlipped =
      Math.abs(expectedPct) > 0.1 &&
      Math.sign(actualPct) !== 0 &&
      Math.sign(expectedPct) !== 0 &&
      Math.sign(actualPct) !== Math.sign(expectedPct);

    flags.push({
      securityId: row.security_id,
      symbol: row.symbol,
      companyName: row.name,
      actualPct,
      spyPct,
      beta: row.beta,
      expectedPct,
      thresholdPct,
      ratio,
      directionFlipped,
    });
  }

  // Sort by ratio desc (largest deviation first)
  flags.sort((a, b) => b.ratio - a.ratio);

  return flags;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

/** Format a number as a signed percentage string, e.g. "+1.2%" or "-3.4%". */
function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

/**
 * Format the Vanguard anomalies block for inclusion in an email.
 *
 * Returns "" when there are no anomalies (caller should omit the section).
 * Caps at 5 bullets; appends "(N more flagged — see /dashboard/today)" when
 * there are more.
 *
 * Privacy: output contains only public market data — ticker, % move, beta.
 * No $ amounts, share counts, or position size language.
 */
export function formatVanguardAnomaliesBlock(db: Database.Database): string {
  const allFlags = computeAnomalies(db);
  if (allFlags.length === 0) return "";

  const MAX_DISPLAY = 5;
  const displayed = allFlags.slice(0, MAX_DISPLAY);
  const extras = allFlags.length - MAX_DISPLAY;

  const lines: string[] = [
    "## Significant Moves in Vanguard Holdings (vs. expected)",
    "",
  ];

  for (const flag of displayed) {
    const signedActual = signedPct(flag.actualPct);
    const signedExpected = signedPct(flag.expectedPct);
    const signedSpy = signedPct(flag.spyPct);
    const reason = flag.directionFlipped
      ? "Direction flipped."
      : `${flag.ratio.toFixed(1)}× expected.`;

    lines.push(
      `- **${flag.symbol}** ${signedActual} — expected ${signedExpected} (beta ${flag.beta.toFixed(1)} × SPY ${signedSpy}). ${reason}`
    );
  }

  if (extras > 0) {
    lines.push(
      `*(${extras} more flagged — see /dashboard/today)*`
    );
  }

  lines.push(""); // trailing newline via join("\n") + final ""

  return lines.join("\n");
}
