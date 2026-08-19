import type Database from "better-sqlite3";
import { marketValue } from "@/lib/valuation";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { statementSourcedHoldingSql, isPlaidSourcedHolding } from "@/lib/db/holding-sources";

/** Don't carry a price forward more than 45 days — beyond that, the position
 *  was likely liquidated or the data is too stale to be meaningful. */
const PRICE_STALENESS_DAYS = 45;

interface DailyValuationResult {
  datesComputed: number;
  accountsProcessed: number;
}

interface PriceDateRow {
  date: string;
}

interface HoldingRow {
  security_id: number;
  quantity: number;
  security_type: string | null;
  fund_category: string | null;
  multiplier: number;
  currency: string | null;
  as_of_date: string;
  source_key: string | null;
}

interface PriceRow {
  close_price: number;
  price_date: string;
}

interface CashAnchor {
  month_end_date: string;
  snapshot_total: number;
  holdings_value: number | null;
  cash_value: number | null;
}

/**
 * Given `sortedDates` (ascending, `YYYY-MM-DD` strings — lexicographic order
 * matches chronological order), return the latest date that is `<= target`,
 * or `null` if every date in the list is after `target` (or the list is
 * empty). Binary search — O(log n).
 *
 * This replaces a correlated `MAX(as_of_date) <= ?` subquery: resolving the
 * date in JS against a small in-memory list lets the caller bind a plain
 * equality predicate instead, see `computeDailyValuations` below.
 */
export function findLatestDateOnOrBefore(sortedDates: string[], target: string): string | null {
  let lo = 0;
  let hi = sortedDates.length - 1;
  let result: string | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] <= target) {
      result = sortedDates[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

export function computeDailyValuations(db: Database.Database): DailyValuationResult {
  return db.transaction(() => {
    // Clear existing valuations
    db.prepare("DELETE FROM daily_valuations").run();

    // Get all accounts that have holdings
    const accounts = db
      .prepare(
        "SELECT DISTINCT account_id FROM holdings ORDER BY account_id"
      )
      .all() as { account_id: number }[];

    // Get all dates that have price data
    const priceDates = db
      .prepare("SELECT DISTINCT date FROM prices ORDER BY date")
      .all() as PriceDateRow[];

    const insertValuation = db.prepare(
      `INSERT OR REPLACE INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count, data_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Use most recent price on or before this date, within staleness window.
    // This carries forward month-end prices for mutual funds/bonds that lack
    // daily pricing, eliminating the month-end spike artifacts.
    const getPrice = db.prepare(
      `SELECT close_price, date AS price_date FROM prices
       WHERE security_id = ? AND date <= ? AND date >= date(?, '-${PRICE_STALENESS_DAYS} days')
       ORDER BY date DESC LIMIT 1`
    );

    // Use the most recent overall holdings snapshot for this account, not
    // per-security MAX. This prevents "ghost holdings" — securities from older
    // snapshots that no longer appear in the latest statement (i.e., sold).
    //
    // NOTE: "Latest snapshot ≤ target date" is resolved in JS beforehand
    // (`findLatestDateOnOrBefore` over a per-account sorted date list loaded
    // once below), not via a correlated `MAX(h2.as_of_date) <= ?` subquery.
    // The correlated form forced SQLite to re-run the subquery once per
    // OUTER holdings row: holdings' only index is
    // UNIQUE(account_id, security_id, as_of_date), so a
    // `WHERE account_id = ? AND as_of_date <= ?` scan can use only the
    // account_id prefix — as_of_date is the 3rd column and unusable for a
    // range — making the subquery an effective per-row table scan (measured
    // 466ms per call × 1,854 account/date pairs ≈ 5 min). Resolving the date
    // in JS lets this statement bind a plain equality (`h.as_of_date = ?`),
    // which the same index serves directly. This also means
    // `latestHoldingsPredicate` still doesn't apply here — there is no
    // per-call range bind left to express with it.
    const getHoldings = db.prepare(
      `SELECT h.security_id, h.quantity, s.security_type, s.fund_category,
              COALESCE(s.multiplier, 1) AS multiplier, s.currency, h.as_of_date, h.source_key
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.account_id = ?
         AND h.as_of_date = ?
       GROUP BY h.security_id`
    );

    // Every snapshot date this account has, ascending — the in-memory list
    // `findLatestDateOnOrBefore` resolves `getHoldings`'s exact-date bind
    // against (one query per account instead of one correlated subquery
    // evaluation per outer row).
    const getAllSnapshotDates = db.prepare(
      `SELECT DISTINCT as_of_date AS date FROM holdings WHERE account_id = ? ORDER BY as_of_date`
    );

    // Bonds from the most recent STATEMENT snapshot on or before a date.
    // Used only to repair Plaid-sourced days — see the carry-forward block
    // in the loop below. Deliberately narrow: statement-authority rows only,
    // real bonds only, live positions only.
    //
    // "Statement-authority" is the whole prefix class, not just 'canonical:'.
    // Which prefix a bond carries depends only on which importer ran, so
    // matching one would make the carry stop the first month the bond arrived
    // through a different path (e.g. the Vanguard PDF statement) — silently
    // dropping its value back into the cash plug. See lib/db/holding-sources.ts.
    const getStatementBonds = db.prepare(
      `SELECT h.security_id, h.quantity, s.security_type, s.fund_category,
              COALESCE(s.multiplier, 1) AS multiplier, s.currency, h.as_of_date, h.source_key
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.account_id = ?
         AND ${statementSourcedHoldingSql("h.source_key")}
         AND LOWER(COALESCE(s.security_type, '')) = 'bond'
         AND h.quantity != 0
         AND h.as_of_date = ?
       GROUP BY h.security_id`
    );

    // Same idea as `getAllSnapshotDates`, restricted to statement-sourced
    // rows — mirrors the old subquery's `statementSourcedHoldingSql(h2.source_key)`
    // filter on the MAX side.
    const getStatementSnapshotDates = db.prepare(
      `SELECT DISTINCT as_of_date AS date FROM holdings
       WHERE account_id = ? AND ${statementSourcedHoldingSql("source_key")}
       ORDER BY as_of_date`
    );

    let datesComputed = 0;
    const accountsProcessed = new Set<number>();

    for (const account of accounts) {
      const allSnapshotDates = (
        getAllSnapshotDates.all(account.account_id) as PriceDateRow[]
      ).map((r) => r.date);
      const statementSnapshotDates = (
        getStatementSnapshotDates.all(account.account_id) as PriceDateRow[]
      ).map((r) => r.date);

      for (const { date } of priceDates) {
        // Get holdings as of this date (most recent snapshot on or before this date)
        const resolvedSnapshotDate = findLatestDateOnOrBefore(allSnapshotDates, date);
        if (resolvedSnapshotDate === null) continue;

        const snapshotRows = getHoldings.all(account.account_id, resolvedSnapshotDate) as HoldingRow[];

        if (snapshotRows.length === 0) continue;

        // Money-market sweep funds are CASH, not positions. The statement
        // path reports them as ordinary holdings rows while the Plaid path
        // folds them into the cash balance, so leaving them in holdings made
        // the cash/holdings split flip every time snapshot ownership changed
        // hands (the 07-31 shape). Excluding them here is the whole fix on
        // this side: their value re-enters through Phase 2's residual
        // (snapshot_total − holdings_value) automatically — never add them
        // to cash by hand here, that would double-count.
        const holdings = snapshotRows.filter((h) => !isCashEquivalentSecurity(h));

        // Plaid never reports Treasuries. On a Plaid-sourced day the bonds
        // simply vanish from holdings and their value silently lands in the
        // cash residual — a phantom cash spike plus a holdings cliff with no
        // trade behind it. Carry the most recent STATEMENT bond rows onto
        // such days so the position stays a position.
        //
        // Gate: the day's snapshot has at least one plaid: row AND no bond
        // rows of its own. Never widen this to "no bonds" alone — TWS
        // reports bonds itself, so carrying into a tws- day would
        // double-count a bond around a mid-month sale.
        //
        // If the latest statement snapshot holds no bonds, nothing is
        // carried (bonds sold). A bond that matures mid-window keeps being
        // carried until its price goes stale (PRICE_STALENESS_DAYS), at
        // which point it stops contributing value — acceptable, and it
        // shows up as degraded data_quality in the meantime.
        const hasPlaidRow = snapshotRows.some((h) => isPlaidSourcedHolding(h.source_key));
        const hasOwnBondRow = snapshotRows.some(
          (h) => h.security_type?.toLowerCase() === "bond"
        );
        if (hasPlaidRow && !hasOwnBondRow) {
          const resolvedStatementDate = findLatestDateOnOrBefore(statementSnapshotDates, date);
          if (resolvedStatementDate !== null) {
            const ownSecurityIds = new Set(snapshotRows.map((h) => h.security_id));
            for (const bond of getStatementBonds.all(
              account.account_id,
              resolvedStatementDate
            ) as HoldingRow[]) {
              // The day's own row always wins on collision.
              if (!ownSecurityIds.has(bond.security_id)) holdings.push(bond);
            }
          }
        }

        let holdingsValue = 0;
        let pricedCount = 0;
        let maxPriceStaleDays = 0;

        for (const holding of holdings) {
          const price = getPrice.get(holding.security_id, date, date) as PriceRow | undefined;

          if (price) {
            holdingsValue += marketValue(
              holding.quantity,
              price.close_price,
              holding.security_type,
              holding.multiplier,
              getUsdPerUnit(db, holding.currency)
            );
            pricedCount++;

            // Track staleness of the oldest price used in this valuation
            const priceDateMs = new Date(price.price_date).getTime();
            const valDateMs = new Date(date).getTime();
            const staleDays = Math.floor((valDateMs - priceDateMs) / 86_400_000);
            if (staleDays > maxPriceStaleDays) maxPriceStaleDays = staleDays;
          }
        }

        // An account (or a day) whose snapshot is nothing but sweep fund has
        // no positions left to value — but Phase 2 still needs a row on this
        // date to attach the anchor's cash to, so write the empty shell
        // instead of skipping and dropping the account out of the series.
        const allHoldingsAreCashEquivalents = holdings.length === 0;
        if (pricedCount === 0 && !allHoldingsAreCashEquivalents) continue;

        // Phase 1 placeholder. Phase 2 (below) infers cash from monthly snapshot
        // anchors and overwrites these rows in place — see the Phase 2 block.
        const cashBalance = 0;
        const totalValue = cashBalance + holdingsValue;

        // Holdings staleness: how old is the holdings snapshot relative to
        // valuation date? Measured off the day's OWN snapshot rows — carried
        // bond rows legitimately carry an older as_of_date and must not
        // make every Plaid day read as stale.
        const holdingsAgeDays = Math.floor(
          (new Date(date).getTime() - new Date(snapshotRows[0].as_of_date).getTime()) / 86_400_000
        );

        // Assess data quality: if holdings are from a prior date, always estimated
        const dataQuality =
          // Nothing priced because there was nothing to price — the value is
          // entirely Phase 2's inferred cash, which is an estimate.
          allHoldingsAreCashEquivalents ? "estimated" :
          holdingsAgeDays > 0 ? "estimated" :
          pricedCount === holdings.length && maxPriceStaleDays <= 1 ? "live" :
          maxPriceStaleDays <= 3 ? "recent" :
          "estimated";

        insertValuation.run(
          account.account_id,
          date,
          cashBalance,
          holdingsValue,
          totalValue,
          holdings.length,
          pricedCount,
          dataQuality
        );

        datesComputed++;
        accountsProcessed.add(account.account_id);
      }
    }

    // Phase 2: Infer cash balances from monthly snapshot anchors.
    // At each snapshot date: cash = snapshot_total − computed_holdings_value.
    // Carry this cash forward until the next snapshot arrives — STEPPED by
    // any recorded external flow that lands inside the window (see below).
    //
    // holdings_value is pulled from the LATEST daily_valuations row within a
    // 5-day lookback window ending at the snapshot date, not an exact-date
    // join. Statement-sourced monthly_snapshots are always dated the true
    // calendar month-end, but Phase 1 only writes a valuation row on dates
    // that have a price row — and TWS-era price series are trading-day-only.
    // When the month-end falls on a weekend/holiday (e.g. 2025-08-31 is a
    // Sunday), no valuation row lands exactly on it, so the old exact-equality
    // LEFT JOIN produced holdings_value = NULL, the anchor loop `continue`d,
    // and the entire following month kept Phase 1's placeholder cash=0 (the
    // IBKR account's fake −96.8% December/June/September drawdowns). A 5-day
    // lookback reaches back to the nearest trading day (Fri 8/29 for the
    // 8/31 Sunday case) so the anchor still resolves. The bound is
    // deliberately narrow: an era with NO valuation rows anywhere near the
    // snapshot (a genuine data gap, not just a weekend) still finds nothing
    // within 5 days and correctly skips — it must never anchor to a stale,
    // unrelated holdings_value from weeks earlier.
    const getCashAnchors = db.prepare(
      `SELECT ms.month_end_date, ms.total_value AS snapshot_total,
              (SELECT dv.holdings_value FROM daily_valuations dv
                WHERE dv.account_id = ms.account_id
                  AND dv.valuation_date <= ms.month_end_date
                  AND dv.valuation_date >= date(ms.month_end_date, '-5 days')
                ORDER BY dv.valuation_date DESC LIMIT 1) AS holdings_value,
              ms.cash_value
       FROM monthly_snapshots ms
       WHERE ms.account_id = ?
       ORDER BY ms.month_end_date`
    );

    const getMaxValuationDate = db.prepare(
      `SELECT MAX(valuation_date) AS max_date FROM daily_valuations WHERE account_id = ?`
    );

    const updateCashRange = db.prepare(
      `UPDATE daily_valuations
       SET cash_balance = ?, total_value = holdings_value + ?
       WHERE account_id = ?
         AND valuation_date >= ?
         AND valuation_date < ?`
    );

    const updateCashFromDate = db.prepare(
      `UPDATE daily_valuations
       SET cash_balance = ?, total_value = holdings_value + ?
       WHERE account_id = ?
         AND valuation_date >= ?`
    );

    // Writes one constant-cash segment: [fromDate, toDateExclusive) when
    // toDateExclusive is given, or [fromDate, +inf) when null (the tail of
    // the last anchor's carry-forward). Identical SQL shape to the pre-fix
    // single-UPDATE-per-window code — a no-flow window calls this exactly
    // once, so that path stays byte-identical to the old behavior.
    function applyCashSegment(
      accountId: number,
      cashValue: number,
      fromDate: string,
      toDateExclusive: string | null
    ): void {
      if (toDateExclusive !== null) {
        updateCashRange.run(cashValue, cashValue, accountId, fromDate, toDateExclusive);
      } else {
        updateCashFromDate.run(cashValue, cashValue, accountId, fromDate);
      }
    }

    for (const account of accounts) {
      const anchors = getCashAnchors.all(account.account_id) as CashAnchor[];
      if (anchors.length === 0) continue;

      // Recorded external flows are invisible to a constant-per-window plug
      // — a mid-window deposit (2026-07-02: a recorded ACH
      // deposit into Vanguard Taxable, is_external_flow=1) left the series
      // flat through the deposit date and then "arrived" all at once at the
      // NEXT anchor, producing a fake no-flow return day where the deposit
      // landed and a fake flow-less value jump where it was finally
      // absorbed. Fix: within a window, cash is no longer constant —
      // cash(day) = cashResidual + cumulative net external flows with
      // trade_date in (anchor.month_end_date, day]. Reuses
      // fetchNetFlowsByDate (lib/compute/flow-adjusted.ts) — the exact same
      // table filter (is_external_flow=1) and sign convention
      // (SIGNED_EXTERNAL_FLOW_SQL) the flow-adjusted return math itself
      // consumes, so a value step here lands on exactly the dates
      // buildFlowAdjustedIndex expects a flow.
      //
      // Reuse contract (2026-08-17, donation tracking §6.3): in-kind
      // TRANSFER_IN/OUT legs (a security moving in or out) now carry the
      // transfer-date FMV as a real positive `amount` — they are NOT cash
      // movements, so they must never step cash_balance. This is enforced
      // by an explicit flag, `{ excludeInKind: true }`, which drops
      // IN_KIND_LEG_SQL rows from fetchNetFlowsByDate's WHERE clause — NOT
      // by relying on those rows netting to zero or being stored at
      // amount=0 (the pre-donation-tracking convention). A same-day
      // journal/routing pair still happens to net to zero on its own, but
      // an UNPAIRED in-kind leg (the common donation shape) does not, and
      // must be excluded unconditionally. Risk/TWR/XIRR readers call
      // fetchNetFlowsByDate WITHOUT this flag, so in-kind flows still reach
      // return math there (spec §6.5 union) — only this cash stepper drops
      // them.
      //
      // One query for the account's whole anchor span (not one per window)
      // — flows are then walked with a single monotonic pointer across
      // windows, mirroring buildFlowAdjustedIndex's own pointer convention.
      const maxDateRow = getMaxValuationDate.get(account.account_id) as { max_date: string | null };
      const allFlows = maxDateRow.max_date
        ? fetchNetFlowsByDate(db, [account.account_id], anchors[0].month_end_date, maxDateRow.max_date, {
            excludeInKind: true,
          })
        : [];
      let flowIdx = 0;

      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        if (anchor.holdings_value === null && anchor.cash_value === null) continue;

        // Anchor the TOTAL to the broker-reported snapshot: inferred cash
        // (snapshot_total − holdings_value) makes total ≡ NetLiq by
        // construction, so reconstruction errors in the holdings rows (ghost
        // positions from intraday TWS syncs, partial captures) cancel out of
        // total_value instead of flowing into it. Pre-fix this preferred the
        // TWS-reported cash_value, which paired real cash with ghost-inflated
        // holdings and produced fake ±13% days in the IBKR series (peak
        // 2026-04-23/24: ±$50-90k vs TWS's own smooth NetLiq). cash_balance is
        // therefore a residual on broker-anchored days, not literal cash.
        // Broker-reported cash_value is only used when holdings can't be
        // reconstructed at the anchor date (no priced row that day).
        const cashResidual = anchor.holdings_value != null
          ? anchor.snapshot_total - anchor.holdings_value
          : anchor.cash_value != null
            ? anchor.cash_value
            : 0;

        // null = open-ended (last anchor, carries forward indefinitely)
        const windowEndExclusive = i < anchors.length - 1 ? anchors[i + 1].month_end_date : null;

        // Flows on/before this anchor's own date are already inside its
        // snapshot_total — stepping them too would double-count. Strictly
        // greater-than on the anchor side (matches fetchNetFlowsByDate's own
        // `trade_date > startDate` convention), inclusive on the day side.
        while (flowIdx < allFlows.length && allFlows[flowIdx].date <= anchor.month_end_date) flowIdx++;

        const windowFlows: { date: string; net: number }[] = [];
        while (
          flowIdx < allFlows.length &&
          (windowEndExclusive === null || allFlows[flowIdx].date < windowEndExclusive)
        ) {
          windowFlows.push(allFlows[flowIdx]);
          flowIdx++;
        }

        if (windowFlows.length === 0) {
          applyCashSegment(account.account_id, cashResidual, anchor.month_end_date, windowEndExclusive);
          continue;
        }

        // Stepped: split the window at each flow date. The flow's own date
        // gets the POST-flow cumulative (inclusive-on-the-day-side).
        let cumulative = cashResidual;
        let segmentStart = anchor.month_end_date;
        for (const flow of windowFlows) {
          if (segmentStart < flow.date) {
            applyCashSegment(account.account_id, cumulative, segmentStart, flow.date);
          }
          cumulative += flow.net;
          segmentStart = flow.date;
        }
        applyCashSegment(account.account_id, cumulative, segmentStart, windowEndExclusive);
      }
    }

    return { datesComputed, accountsProcessed: accountsProcessed.size };
  })();
}
