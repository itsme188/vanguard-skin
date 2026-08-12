import type Database from "better-sqlite3";
import { marketValue } from "@/lib/valuation";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";

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
  multiplier: number;
  currency: string | null;
  as_of_date: string;
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
    // NOTE: This site cannot use `latestHoldingsPredicate` because the
    // `as_of_date <= ?` constraint must accept a positional bind (the prepared
    // statement is reused across many target dates inside `computeDailyValuations`).
    // The helper's `asOfDate` option does literal SQL substitution (validated
    // against /^\d{4}-\d{2}-\d{2}$/) and would require re-preparing the
    // statement on every date — losing the prepared-statement optimization
    // this hot loop depends on. Intentionally inline.
    const getHoldings = db.prepare(
      `SELECT h.security_id, h.quantity, s.security_type, COALESCE(s.multiplier, 1) AS multiplier, s.currency, h.as_of_date
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.account_id = ?
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date)
           FROM holdings h2
           WHERE h2.account_id = h.account_id
             AND h2.as_of_date <= ?
         )
       GROUP BY h.security_id`
    );

    let datesComputed = 0;
    const accountsProcessed = new Set<number>();

    for (const account of accounts) {
      for (const { date } of priceDates) {
        // Get holdings as of this date (most recent snapshot on or before this date)
        const holdings = getHoldings.all(account.account_id, date) as HoldingRow[];

        if (holdings.length === 0) continue;

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

        if (pricedCount === 0) continue;

        // Phase 1 placeholder. Phase 2 (below) infers cash from monthly snapshot
        // anchors and overwrites these rows in place — see lines 148-205.
        const cashBalance = 0;
        const totalValue = cashBalance + holdingsValue;

        // Holdings staleness: how old is the holdings snapshot relative to valuation date?
        const holdingsAgeDays = Math.floor(
          (new Date(date).getTime() - new Date(holdings[0].as_of_date).getTime()) / 86_400_000
        );

        // Assess data quality: if holdings are from a prior date, always estimated
        const dataQuality =
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
      // — a mid-window deposit (2026-07-02: [REDACTED] ACH into Vanguard Taxable,
      // a real transactions row with is_external_flow=1) left the series
      // flat through the deposit date and then "arrived" all at once at the
      // NEXT anchor, producing a fake no-flow return day where the deposit
      // landed and a fake flow-less value jump where it was finally
      // absorbed. Fix: within a window, cash is no longer constant —
      // cash(day) = cashResidual + cumulative net external flows with
      // trade_date in (anchor.month_end_date, day]. Reuses
      // fetchNetFlowsByDate (lib/compute/flow-adjusted.ts) — the exact same
      // table filter (is_external_flow=1), sign convention
      // (SIGNED_EXTERNAL_FLOW_SQL), and per-date netting the flow-adjusted
      // return math itself consumes — so a value step here lands on exactly
      // the dates buildFlowAdjustedIndex expects a flow, and its
      // `HAVING SUM(...) != 0` already makes a net-zero day (e.g. the June
      // sub-account TRANSFER_IN/OUT pairs booked at amount=0) a no-op: it
      // simply never appears in this list, so no segment is split there.
      //
      // One query for the account's whole anchor span (not one per window)
      // — flows are then walked with a single monotonic pointer across
      // windows, mirroring buildFlowAdjustedIndex's own pointer convention.
      const maxDateRow = getMaxValuationDate.get(account.account_id) as { max_date: string | null };
      const allFlows = maxDateRow.max_date
        ? fetchNetFlowsByDate(db, [account.account_id], anchors[0].month_end_date, maxDateRow.max_date)
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
