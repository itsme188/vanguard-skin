import type Database from "better-sqlite3";
import {
  reconcileTwrAgainstStatements,
  type TwrReconcileResult,
} from "@/lib/compute/twr-reconcile";
import type { DietzBand } from "@/lib/compute/dietz";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

/** One walked calendar month in an account's cross-check chain. A month
 *  with no statement row at all is "missing" — distinct from a Dietz band,
 *  and (like "investigate"/"insufficient") breaks the chain. */
export interface BandHistoryEntry {
  monthEndDate: string;
  band: DietzBand | "missing";
  divergenceBp: number | null;
}

export interface PerAccountReconciliation {
  accountId: number;
  accountName: string;
  monthEndDate: string | null; // latest statement month, null if the account has no statement row at all
  statementTwr: number | null;
  dietzReturn: number | null;
  divergenceBp: number | null;
  band: DietzBand | null; // null when the account has no statement row at all
  bandHistory: BandHistoryEntry[]; // the walked sequence, 2nd statement month through the latest
}

export interface AnalysisTrustState {
  factorCoverage: {
    totalNames: number;
    classified: number;
    percentage: number;
    missingSymbols: string[];
  };
  lastClassification: string | null;
  crossCheckedThru: string | null; // populated by Slice D; renamed from performanceReconciledThru (Task 13)
  perAccountReconciliation: PerAccountReconciliation[];
  stalePrices: { count: number; symbols: string[] };
  bondDuration: { totalBonds: number; withDuration: number };
}

const STALE_PRICE_DAYS = 4;
const STATEMENT_SOURCES = "'ibkr-activity', 'canonical', 'vanguard-pdf'";

/** The last calendar day of the month AFTER monthEndDate's month, e.g.
 *  "2026-01-31" → "2026-02-28", "2026-12-31" → "2027-01-31". Mirrors
 *  monthly-snapshot-utils.ts's private priorMonthEndDate in the opposite
 *  direction (not exported there, so duplicated here per that file's own
 *  precedent — see dietz.ts). */
function nextMonthEndDate(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00Z");
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  return next.toISOString().slice(0, 10);
}

/**
 * Walks one account's independent Dietz cross-check chain: every calendar
 * month from the account's SECOND statement month (inclusive) through its
 * LATEST statement month (inclusive), stepping one calendar month at a
 * time — not skipping gaps. The first statement month is never a valid
 * chain start: computeMonthlyDietz always needs a prior month-end snapshot
 * (fetchPriorMonthTotal), which the very first statement month can never
 * have.
 *
 * Returns the walked bandHistory and this account's own crossCheckedThru
 * frontier: the latest month such that every walked month up to and
 * including it is "consistent" or "not_comparable". "investigate",
 * "insufficient", and a missing calendar month (no statement row for that
 * exact month) all break the chain at that point — null when the chain
 * breaks on the very first walked month, or when there's no second
 * statement month to start from at all ("chainless").
 */
function walkAccountChain(
  db: Database.Database,
  accountId: number
): { bandHistory: BandHistoryEntry[]; crossCheckedThru: string | null } {
  const stmtMonths = (
    db
      .prepare(
        `SELECT DISTINCT month_end_date FROM monthly_snapshots
         WHERE account_id = ? AND source IN (${STATEMENT_SOURCES})
         ORDER BY month_end_date ASC`
      )
      .all(accountId) as { month_end_date: string }[]
  ).map((r) => r.month_end_date);

  if (stmtMonths.length < 2) {
    return { bandHistory: [], crossCheckedThru: null };
  }

  const chainStart = stmtMonths[1];
  const chainEnd = stmtMonths[stmtMonths.length - 1];

  const bandHistory: BandHistoryEntry[] = [];
  let month = chainStart;
  // chainStart <= chainEnd always holds (stmtMonths is sorted ascending and
  // chainStart is at index 1, chainEnd at the last index).
  while (month <= chainEnd) {
    const r = reconcileTwrAgainstStatements(db, accountId, month);
    if (r === null) {
      bandHistory.push({ monthEndDate: month, band: "missing", divergenceBp: null });
    } else {
      bandHistory.push({
        monthEndDate: month,
        band: r.band,
        divergenceBp: r.divergenceBp,
      });
    }
    month = nextMonthEndDate(month);
  }

  let crossCheckedThru: string | null = null;
  for (const entry of bandHistory) {
    if (entry.band === "consistent" || entry.band === "not_comparable") {
      crossCheckedThru = entry.monthEndDate;
    } else {
      break;
    }
  }

  return { bandHistory, crossCheckedThru };
}

export function getAnalysisTrustState(
  db: Database.Database,
  accountIds?: number[]
): AnalysisTrustState {
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

  // ── Factor coverage ──────────────────────────────────────────────────
  const factorRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT CASE WHEN sf.security_id IS NOT NULL OR sf_u.security_id IS NOT NULL THEN s.id END) AS classified,
      GROUP_CONCAT(CASE WHEN sf.security_id IS NULL AND sf_u.security_id IS NULL THEN s.symbol END) AS missing
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    LEFT JOIN security_factors sf ON sf.security_id = s.id
    -- Options inherit factors from their underlying at query time (same rule
    -- as getFactorHeatmap / getFactorCoverage in lib/queries/analysis.ts) —
    -- count them as classified when the underlying has a factor row, or this
    -- metric contradicts the heatmap it sits above.
    LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
    LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
  `
    )
    .get(...params) as { total: number; classified: number; missing: string | null };

  const total = factorRow.total ?? 0;
  const classified = factorRow.classified ?? 0;
  const missingSymbols = factorRow.missing
    ? factorRow.missing.split(",").filter(Boolean)
    : [];
  const percentage = total > 0 ? classified / total : 0;

  // ── Last classification ──────────────────────────────────────────────
  const lastClassRow = db
    .prepare(`SELECT MAX(updated_at) AS last FROM security_factors`)
    .get() as { last: string | null };

  // ── Stale prices ─────────────────────────────────────────────────────
  // Param order: accountIds first (in CTE), STALE_PRICE_DAYS last (outer WHERE)
  const staleRows = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    ),
    latest_prices AS (
      SELECT p.security_id, MAX(p.date) AS latest_date
      FROM prices p
      JOIN latest l ON l.security_id = p.security_id
      GROUP BY p.security_id
    )
    SELECT s.symbol
    FROM latest_prices lp
    JOIN securities s ON s.id = lp.security_id
    WHERE julianday('now') - julianday(lp.latest_date) > ?
    ORDER BY s.symbol
  `
    )
    .all(...params, STALE_PRICE_DAYS) as { symbol: string }[];

  // ── Bond duration coverage ───────────────────────────────────────────
  const bondRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(s.id) AS total_bonds,
      COUNT(s.duration_years) AS with_duration
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    WHERE LOWER(s.security_type) = 'bond'
  `
    )
    .get(...params) as { total_bonds: number; with_duration: number };

  // ── Independent Dietz cross-check ────────────────────────────────────
  // Semantic for the rollup field `crossCheckedThru`: "all accounts have an
  // unbroken chain of statement-vs-independent-Dietz agreement at least
  // through this month." Take the EARLIEST of each account's own chain
  // frontier — anything past that, at least one account's chain has broken
  // (or never started). Per-account detail flows out via
  // `perAccountReconciliation` (headline: the latest statement month) and
  // each row's `bandHistory` (the full walked chain).
  const accountList = accountIds?.length
    ? (db
        .prepare(
          `SELECT id, name FROM accounts WHERE id IN (${accountIds.map(() => "?").join(",")})`,
        )
        .all(...accountIds) as { id: number; name: string }[])
    : (db.prepare("SELECT id, name FROM accounts").all() as {
        id: number;
        name: string;
      }[]);

  const perAccount: PerAccountReconciliation[] = [];
  let rollupCrossCheckedThru: string | null = null;
  let anyChainless = false;

  for (const acct of accountList) {
    const latestStmt = db
      .prepare(
        `SELECT month_end_date FROM monthly_snapshots
         WHERE account_id = ? AND source IN (${STATEMENT_SOURCES})
         ORDER BY month_end_date DESC LIMIT 1`
      )
      .get(acct.id) as { month_end_date: string } | undefined;

    const { bandHistory, crossCheckedThru } = walkAccountChain(db, acct.id);

    if (!latestStmt) {
      // No statement row at all — nothing to reconcile, and the rollup
      // must never advance past an unreconciled account.
      perAccount.push({
        accountId: acct.id,
        accountName: acct.name,
        monthEndDate: null,
        statementTwr: null,
        dietzReturn: null,
        divergenceBp: null,
        band: null,
        bandHistory,
      });
      anyChainless = true;
      continue;
    }

    const headline: TwrReconcileResult | null = reconcileTwrAgainstStatements(
      db,
      acct.id,
      latestStmt.month_end_date
    );

    perAccount.push({
      accountId: acct.id,
      accountName: acct.name,
      monthEndDate: latestStmt.month_end_date,
      statementTwr: headline?.statementTwr ?? null,
      dietzReturn: headline?.dietzReturn ?? null,
      divergenceBp: headline?.divergenceBp ?? null,
      band: headline?.band ?? null,
      bandHistory,
    });

    if (crossCheckedThru === null) {
      anyChainless = true;
    } else if (
      rollupCrossCheckedThru === null ||
      crossCheckedThru < rollupCrossCheckedThru
    ) {
      rollupCrossCheckedThru = crossCheckedThru;
    }
  }

  return {
    factorCoverage: { totalNames: total, classified, percentage, missingSymbols },
    lastClassification: lastClassRow.last,
    crossCheckedThru: anyChainless ? null : rollupCrossCheckedThru,
    perAccountReconciliation: perAccount,
    stalePrices: {
      count: staleRows.length,
      symbols: staleRows.map((r) => r.symbol),
    },
    bondDuration: {
      totalBonds: bondRow.total_bonds,
      withDuration: bondRow.with_duration,
    },
  };
}
