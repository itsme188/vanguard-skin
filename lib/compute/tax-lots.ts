import type Database from "better-sqlite3";
import { marketValue, unitPriceFromMarketValue } from "@/lib/valuation";
import { stampTaxLotsConventionIfPresent } from "@/lib/compute/tax-convention";

interface TaxLotComputeResult {
  lotsCreated: number;
  salesProcessed: number;
  totalRealizedGain: number;
  replayWarnings: string[];
  /** Lots reduced by a confirmed, lot-assigned donation this run (spec §9). */
  donationsConsumed: number;
}

interface TransactionRow {
  id: number;
  account_id: number;
  security_id: number;
  trade_date: string;
  type: string;
  quantity: number;
  price_per_share: number;
  amount: number;
  fees: number;
  /** Lower-cased `securities.security_type` ('' when unset) — unit convention. */
  security_type: string;
  /** `COALESCE(securities.multiplier, 1)` — contract size for options. */
  multiplier: number;
}

interface OpenLot {
  id: number;
  acquisition_date: string;
  acquisition_price: number;
  quantity_acquired: number;
  quantity_remaining: number;
  cost_basis: number;
  is_short: number;
}

interface SplitEvent {
  id: number;
  security_id: number;
  account_id: number | null;
  effective_date: string;
  ratio: number;
  quantity_delta: number | null;
  symbol: string;
}

interface OptionExerciseRow {
  id: number;
  account_id: number;
  security_id: number;
  trade_date: string;
  type: string;
  quantity: number;
  /** NULL on rows the source booked without a premium — see the fail-closed skip. */
  price_per_share: number | null;
  underlying_symbol: string;
  option_type: string;
  multiplier: number;
}

/**
 * One donation's lot consumption, replayed at its OUT leg's trade_date. The
 * account and security come from that same leg — they scope the lot lookup so
 * a bad assignment can never reach across an account or security line.
 */
interface DonationConsumption {
  donationId: number;
  outLegDate: string;
  accountId: number;
  securityId: number;
  assignments: { acquisitionTransactionId: number; quantity: number }[];
}

/**
 * One entry in the engine's single chronological replay stream. Same-date
 * ordering is the `kind` rank: sells (0) → donation consumptions (1) →
 * corporate-action splits (2). Splits last preserves the end-of-day rule
 * (a same-date trade executed in pre-split units), and donations sit with
 * the trades because their assignments are expressed in the same basis.
 *
 * Within the sells, `rank` is a THREE-level sub-rank, computable per event
 * (so the sort stays transitive and import-order independent):
 *
 *   0 — ordinary events. A same-date same-security ordinary option close
 *       selects its lots BEFORE the exercise does: OCC exercise/assignment
 *       notices land after the close, so an intraday close on that option
 *       traded first — the same end-of-day reasoning the kind order encodes.
 *   1 — EXERCISED/ASSIGNED. The premium is only known once the exercise has
 *       consumed its option lots.
 *   2 — any sell on a security that is an exercise-link TARGET that date
 *       (precomputed from computeExerciseLinks). Stock-side activity on a
 *       link-target security must land AFTER the exercise's rollover
 *       UPDATE/deposit, so a forced same-day stock sale absorbs the premium
 *       and a same-day ordinary stock sale allocates the rolled-in basis.
 *
 * A blanket exercise-before-everything rank was tried first and re-selected
 * lots for same-date ordinary closes on the SAME option — recognition moved
 * between rows (conserving, but wrong rows). Levels 0/1 fix that; level 2
 * preserves the stock-leg-after-exercise guarantee the blanket rank existed
 * for.
 */
type ReplayEvent =
  | { kind: 0; rank: 0 | 1 | 2; date: string; id: number; sell: TransactionRow }
  | { kind: 1; date: string; id: number; donation: DonationConsumption }
  | { kind: 2; date: string; id: number; split: SplitEvent };

/**
 * Where an exercised/assigned option's premium goes — the LINK only. The
 * dollars are deliberately NOT resolved here: they are whatever basis the
 * replay actually zeroes when the exercise consumes its lots, which is the
 * only figure that can conserve. Resolving them ahead of the replay (from a
 * blind FIFO walk over `tax_lots`) silently mis-rolls whenever an ordinary
 * close consumed a different lot first — a plain scale-in / take-half-off
 * pattern.
 */
interface ExerciseLink {
  /** Transaction id of the underlying leg this premium belongs to. */
  stockTxnId: number;
  /** Which side of the underlying leg absorbs it. */
  target: "cost" | "proceeds";
  /** +1 where the premium was PAID, -1 where it was RECEIVED. */
  sign: 1 | -1;
}

/**
 * One exercise's premium waiting on a not-yet-processed stock SALE leg.
 * Contributions are kept per option transaction (never pre-summed) so a
 * partially covered stock sale can push each option's unlanded share back
 * onto that option's own rows.
 */
interface SaleRolloverContribution {
  /** The exercised/assigned option close transaction the dollars came from. */
  optionTxnId: number;
  /** link.sign × storedDollars — the figure the stock leg absorbs. */
  signedDollars: number;
  /** Magnitude zeroed on the option's rollover rows. */
  storedDollars: number;
}

/** One planned FIFO consumption of a lot by a sale, before any row is written. */
interface PlannedConsumption {
  lot: OpenLot;
  quantitySold: number;
  /** The sale leg's dollars apportioned to this lot. */
  allocatedLegDollars: number;
  /** The LOT's own stored dollars apportioned to this consumption. */
  storedLegAllocated: number;
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * IRS long-term test, single-sourced: held MORE than one year — strictly
 * after the CALENDAR anniversary of acquisition (Pub 550), not a fixed
 * 365-day count (which called an anniversary sale spanning Feb 29
 * long-term because that span is 366 days). Used for
 * `tax_lot_sales.is_long_term` here and for the LT/ST split of donated lots
 * (which never produce a sale row) — both must answer the question the same
 * way.
 *
 * A Feb-29 acquisition yields the anniversary string `YYYY-02-29`, a date
 * that does not exist in the following non-leap year; ISO strings compare
 * lexicographically, so `'YYYY-03-01' > 'YYYY-02-29'` gives exactly the
 * "more than one year" answer (pinned by test).
 */
export function isLongTermHolding(acquisitionDate: string, dispositionDate: string): boolean {
  const [y, m, d] = acquisitionDate.split("-").map(Number);
  const anniversary = `${String(y + 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return dispositionDate > anniversary;
}

/**
 * Net economic dollars of ONE transaction leg, in the security's native
 * currency (FX stays a read-time concern). This is the single derivation
 * every stored dollar column routes through, so bond ÷100 and option
 * ×multiplier conventions can never diverge between the lot side and the
 * sale side.
 *
 * A statement `amount` is the broker's own figure for the leg and takes
 * precedence when present — deriving from qty×price would double-count or
 * drop the fees the broker already netted. Only its MAGNITUDE is
 * authoritative: the ledger's `amount` sign encodes cash direction (a buy is
 * negative cash), not leg orientation. Reversal rows carry a negative
 * quantity, and that negative leg rides through both paths untouched.
 * A zero `amount` is treated as absent (unpriced/placeholder rows).
 *
 * SOURCES DISAGREE ABOUT WHETHER `amount` IS GROSS OR NET, so the figure is
 * self-detected rather than trusted blanket. IBKR's activity report writes
 * its *Proceeds* column into `amount` and its commission separately into
 * `fees` — Proceeds is GROSS (IBKR's own Basis column is Proceeds + Comm),
 * so taking `|amount|` verbatim silently dropped the commission on every
 * IBKR-imported row. The Vanguard canonical shape stores an already-netted
 * amount. The tell: when a row carries fees AND `|amount|` lands on the
 * qty×price gross within a cent or two, the source stored gross and the fee
 * still has to be applied; otherwise the fee is already inside it. A
 * zero-fee row is unambiguous — both readings give the same answer.
 * (Importer semantics are deliberately untouched: `amount` is load-bearing
 * for `source_key` dedupe.)
 *
 * Two escape hatches for callers whose effective price is ENGINE-DERIVED
 * rather than the broker's:
 * - `forceDerivation` ignores `amount` entirely (zero-price option closes:
 *   the row's amount describes something other than this $0 close).
 * - `amountIsNet` takes `|amount|` verbatim and skips the gross/net probe.
 *   Required on the REDEMPTION path, where the price was itself derived AS
 *   `|amount|/qty×100`: the gross then equals `|amount|` by construction, so
 *   the probe would classify every fee-bearing maturity as gross and subtract
 *   the fee, breaking the at-cost-realizes-$0 invariant. A maturity's
 *   principal IS the net proceeds.
 */
/** Floor tolerance for "this amount IS the gross figure" — printed-cent slack. */
const GROSS_AMOUNT_TOL_USD = 0.02;
/** Relative slack on top of the floor, for legs large enough that cents scale. */
const GROSS_AMOUNT_TOL_REL = 1e-6;
/**
 * Below this shortfall a stock sale counts as fully covering its quantity —
 * float slack on quantity ratios only, never a materiality threshold.
 */
const LANDED_FRACTION_TOL = 1e-6;

function netLegDollars(
  row: {
    quantity: number;
    amount: number | null;
    fees: number | null;
    security_type: string;
    multiplier: number;
  },
  perUnitPrice: number,
  side: "acquire" | "dispose" | "short_open" | "cover",
  opts: { forceDerivation?: boolean; amountIsNet?: boolean } = {}
): number {
  const { forceDerivation = false, amountIsNet = false } = opts;
  const gross = marketValue(row.quantity, perUnitPrice, row.security_type, row.multiplier);
  const fees = row.fees ?? 0;
  // Buy-side fees are capitalized into basis and a cover's fees are part of
  // what closing the position cost (both ADD); sale proceeds are net of the
  // fees withheld from them and a short open's stored leg is likewise the NET
  // premium received (both SUBTRACT).
  const feeSign = side === "acquire" || side === "cover" ? 1 : -1;

  if (!forceDerivation && row.amount != null && row.amount !== 0) {
    const magnitude = Math.abs(row.amount);
    const tolerance = Math.max(
      GROSS_AMOUNT_TOL_USD,
      Math.abs(gross) * GROSS_AMOUNT_TOL_REL
    );
    const amountIsGross =
      !amountIsNet && fees > 0 && Math.abs(magnitude - Math.abs(gross)) <= tolerance;
    const net = amountIsGross ? magnitude + feeSign * fees : magnitude;
    return row.quantity < 0 ? -net : net;
  }
  return gross + feeSign * fees;
}

export function computeTaxLots(db: Database.Database): TaxLotComputeResult {
  return db.transaction(() => {
    // Clear existing computed data — including the engine-owned synthetic
    // RECONCILE_CLOSE transactions from prior runs. They are regenerated at
    // the end of this run only where an orphan open lot still exists, so a
    // later-imported real SELL naturally supersedes its synthetic stand-in.
    db.prepare("DELETE FROM tax_lot_sales").run();
    db.prepare("DELETE FROM tax_lots").run();
    db.prepare("DELETE FROM transactions WHERE type = 'RECONCILE_CLOSE'").run();

    // ── Create tax lots from BUY-like transactions ──
    // Includes: BUY, REINVESTMENT, BUY_TO_OPEN (long option), SELL_TO_OPEN (short option),
    // TRANSFER_IN (ACATS in-kind arrival — the security physically arrived from another
    // broker, so it opens a real FIFO lot at its transferred cost basis). Deliberately
    // does NOT include TRANSFER_OUT on the sell side below — outbound security transfers
    // (e.g. donated-in-kind shares) are the R4 donation-tracking workstream, not a sale.
    const buys = db
      .prepare(
        `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity,
                t.price_per_share, t.amount, t.fees,
                LOWER(COALESCE(s.security_type, '')) AS security_type,
                COALESCE(s.multiplier, 1) AS multiplier
         FROM transactions t
         JOIN securities s ON s.id = t.security_id
         WHERE LOWER(t.type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open', 'transfer_in')
           AND t.security_id IS NOT NULL
           AND t.price_per_share IS NOT NULL AND t.quantity IS NOT NULL
         ORDER BY t.trade_date, t.id`
      )
      .all() as TransactionRow[];

    const insertLot = db.prepare(
      `INSERT INTO tax_lots
       (account_id, security_id, acquisition_transaction_id, acquisition_date,
        acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let lotsCreated = 0;
    /** Buy transaction id → the lot it created, for the premium-rollover pass. */
    const lotByBuyTxn = new Map<
      number,
      {
        id: number;
        quantity: number;
        costBasis: number;
        acquisitionPrice: number;
        securityType: string;
        multiplier: number;
      }
    >();
    for (const buy of buys) {
      const isShort = buy.type.toLowerCase() === "sell_to_open" ? 1 : 0;
      // TRUE ECONOMIC DOLLARS: bonds ÷100, options ×multiplier, fees on the
      // side that bears them. For a short open the stored dollar column is
      // the lot's opening leg — which for a short IS its net proceeds.
      const costBasis = netLegDollars(
        buy,
        buy.price_per_share,
        isShort ? "short_open" : "acquire"
      );
      const inserted = insertLot.run(
        buy.account_id,
        buy.security_id,
        buy.id,
        buy.trade_date,
        buy.price_per_share,
        buy.quantity,
        buy.quantity,
        costBasis,
        isShort
      );
      lotByBuyTxn.set(buy.id, {
        id: inserted.lastInsertRowid as number,
        quantity: buy.quantity,
        costBasis,
        acquisitionPrice: buy.price_per_share,
        securityType: buy.security_type,
        multiplier: buy.multiplier,
      });
      lotsCreated++;
    }

    // ── Exercised/assigned option premium → the underlying leg ──
    // LINKS ONLY. The dollars are resolved inside the replay, at the moment
    // the exercise consumes its lots, because only that figure is guaranteed
    // to equal the basis the rollover rows actually zero.
    const { links: exerciseLinks, targetSecuritiesByDate: linkTargetsByDate } =
      computeExerciseLinks(db);
    const updateLotBasis = db.prepare(
      "UPDATE tax_lots SET cost_basis = ?, acquisition_price = ? WHERE id = ?"
    );
    const lotRemainingStmt = db.prepare(
      "SELECT quantity_remaining, quantity_acquired FROM tax_lots WHERE id = ?"
    );
    /** Premium waiting to be absorbed by a not-yet-processed stock SALE leg. */
    const pendingSaleRollover = new Map<number, SaleRolloverContribution[]>();
    const processedSellTxnIds = new Set<number>();
    /** An option close's already-written rollover rows, for the partial-fill unwind. */
    const rolloverRowsForTxn = db.prepare(
      `SELECT tls.id, tls.proceeds, tls.cost_basis_allocated, tl.is_short
         FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
        WHERE tls.sale_transaction_id = ? AND tls.premium_rollover = 1`
    );
    const unwindRolloverRow = db.prepare(
      `UPDATE tax_lot_sales
          SET proceeds = ?, cost_basis_allocated = ?, realized_gain_loss = ?,
              premium_rollover = 0
        WHERE id = ?`
    );

    // ── Import-sourced corporate-action splits (replay events) ──
    // 'manual' rows already rewrote history at apply time (legacy road) and
    // are excluded here — replaying them would double-apply. Only
    // 'import' rows (statement-sourced) are replayed chronologically,
    // merged into the sells loop below.
    const splitEvents = db
      .prepare(
        `SELECT ca.id, ca.security_id, ca.account_id, ca.effective_date,
                CAST(ca.ratio_numerator AS REAL) / ca.ratio_denominator AS ratio,
                ca.quantity_delta, s.symbol
         FROM corporate_actions ca
         JOIN securities s ON s.id = ca.security_id
         WHERE ca.source = 'import'
         ORDER BY ca.effective_date, ca.id`
      )
      .all() as SplitEvent[];
    const replayWarnings: string[] = [];
    const clearDelta = db.prepare(
      "UPDATE corporate_actions SET reconcile_delta = NULL WHERE id = ?"
    );
    const setDelta = db.prepare(
      "UPDATE corporate_actions SET reconcile_delta = ? WHERE id = ?"
    );

    const applySplitEvent = (ev: SplitEvent) => {
      // Cross-check scope: the importing account's open lots only (the
      // statement is single-account evidence). The adjustment itself is
      // market-wide — a split applies to every account holding the security.
      const preOpen =
        ev.account_id != null
          ? (
              db
                .prepare(
                  `SELECT COALESCE(SUM(CASE WHEN is_short = 1 THEN -quantity_remaining ELSE quantity_remaining END), 0) AS q
                   FROM tax_lots
                   WHERE security_id = ? AND account_id = ? AND quantity_remaining > 0 AND acquisition_date <= ?`
                )
                .get(ev.security_id, ev.account_id, ev.effective_date) as { q: number }
            ).q
          : null;

      db.prepare(
        `UPDATE tax_lots
         SET quantity_acquired = quantity_acquired * ?,
             quantity_remaining = quantity_remaining * ?,
             acquisition_price = acquisition_price / ?
         WHERE security_id = ? AND quantity_remaining > 0 AND acquisition_date <= ?`
      ).run(ev.ratio, ev.ratio, ev.ratio, ev.security_id, ev.effective_date);

      if (ev.quantity_delta != null && preOpen != null) {
        const implied = preOpen * (ev.ratio - 1);
        const delta = implied - ev.quantity_delta;
        if (Math.abs(delta) <= 1e-6) {
          clearDelta.run(ev.id);
        } else {
          setDelta.run(delta, ev.id);
          replayWarnings.push(
            `${ev.symbol} ${ev.effective_date} split: ledger-implied share delta differs from the statement's — the ledger may have been missing shares before the split`
          );
        }
      } else {
        clearDelta.run(ev.id);
      }
    };

    // ── Process SELL-like transactions ──
    // Includes: SELL, SELL_TO_CLOSE, REDEMPTION, BUY_TO_COVER, EXPIRED,
    //           EXERCISED, ASSIGNED, BUY_TO_CLOSE
    const sells = db
      .prepare(
        `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity,
                t.price_per_share, t.amount, t.fees,
                LOWER(COALESCE(s.security_type, '')) AS security_type,
                COALESCE(s.multiplier, 1) AS multiplier
         FROM transactions t
         JOIN securities s ON s.id = t.security_id
         WHERE LOWER(t.type) IN ('sell', 'sell_to_close', 'redemption', 'buy_to_cover',
                                'expired', 'exercised', 'assigned', 'buy_to_close')
           AND t.security_id IS NOT NULL
           AND t.quantity IS NOT NULL
           AND (t.price_per_share IS NOT NULL
                OR LOWER(t.type) IN ('expired', 'exercised', 'assigned')
                -- Bond/bill maturities carry no per-share price; the principal
                -- return lives in amount (statement convention). Without this
                -- exemption every matured bond's lot sat open forever.
                OR (LOWER(t.type) = 'redemption' AND t.amount IS NOT NULL))
         ORDER BY t.trade_date, t.id`
      )
      .all() as Array<TransactionRow>;

    const insertSale = db.prepare(
      `INSERT INTO tax_lot_sales
       (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds,
        cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days,
        sale_date, premium_rollover)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const updateLotRemaining = db.prepare(
      "UPDATE tax_lots SET quantity_remaining = ? WHERE id = ?"
    );

    let salesProcessed = 0;
    let totalRealizedGain = 0;

    /** Every sell-like row the replay will actually process. */
    const sellIdsInReplay = new Set(sells.map((s) => s.id));

    /**
     * Move an exercise's premium onto its underlying leg. Returns whether the
     * dollars PROVABLY landed — only then may the option close be flagged a
     * rollover and zeroed. Every refusal is a warning, never a silent drop.
     */
    const landRollover = (
      link: ExerciseLink,
      dollars: number,
      sell: TransactionRow
    ): boolean => {
      const signed = link.sign * dollars;
      if (link.target === "cost") {
        // The underlying leg is a BUY whose lot already exists. Accumulate
        // (never overwrite): two exercises can legitimately resolve to the
        // same stock purchase, and each one's premium belongs in that basis.
        const lot = lotByBuyTxn.get(link.stockTxnId);
        if (!lot) {
          replayWarnings.push(
            `${sell.trade_date}: option close ${sell.id} links to stock transaction ${link.stockTxnId}, which opened no tax lot (no price on the row?) — the premium stays on the option close as a realized result rather than vanishing into the underlying`
          );
          return false;
        }
        const before = lotRemainingStmt.get(lot.id) as
          | { quantity_remaining: number; quantity_acquired: number }
          | undefined;
        if (before && before.quantity_remaining < before.quantity_acquired) {
          replayWarnings.push(
            `${sell.trade_date}: part of the stock lot from transaction ${link.stockTxnId} was already sold before this exercise's premium rolled in — those earlier sale rows used the pre-rollover basis`
          );
        }
        lot.costBasis += signed;
        // Invert over the lot's CURRENT quantity_acquired from the DB, not the
        // in-memory at-purchase quantity: a split replayed between the
        // purchase and this exercise has already rescaled the DB column, and
        // inverting over the stale pre-split figure wrote a ratio× wrong
        // per-unit price (dollars are split-invariant; share counts are not).
        const currentQuantityAcquired = before?.quantity_acquired ?? lot.quantity;
        const newPrice =
          unitPriceFromMarketValue(
            lot.costBasis,
            currentQuantityAcquired,
            lot.securityType,
            lot.multiplier
          ) ?? lot.acquisitionPrice;
        updateLotBasis.run(lot.costBasis, newPrice, lot.id);
        return true;
      }
      // The underlying leg is a SALE. It must still be ahead of us in the
      // replay, otherwise there is no row left to absorb the premium.
      if (!sellIdsInReplay.has(link.stockTxnId) || processedSellTxnIds.has(link.stockTxnId)) {
        replayWarnings.push(
          `${sell.trade_date}: option close ${sell.id} links to stock sale ${link.stockTxnId}, which the replay cannot still adjust — the premium stays on the option close as a realized result`
        );
        return false;
      }
      const contribs = pendingSaleRollover.get(link.stockTxnId) ?? [];
      contribs.push({ optionTxnId: sell.id, signedDollars: signed, storedDollars: dollars });
      pendingSaleRollover.set(link.stockTxnId, contribs);
      return true;
    };

    const processSell = (sell: TransactionRow) => {
      // For EXERCISED/ASSIGNED/EXPIRED, the option closes at $0
      const lowerType = sell.type.toLowerCase();
      const isZeroPriceClose =
        lowerType === "exercised" || lowerType === "assigned" || lowerType === "expired";
      let effectiveSalePrice = sell.price_per_share ?? 0;
      let priceFromAmount = false;

      if (isZeroPriceClose) {
        // Option lot closes at $0 — expired worthless or premium rolls into stock
        effectiveSalePrice = 0;
      } else if (
        lowerType === "redemption" &&
        sell.price_per_share == null &&
        sell.amount != null &&
        sell.quantity > 0
      ) {
        priceFromAmount = true;
        // Maturity redemption: derive the price from the principal returned,
        // on the per-100-face basis bond transaction prices (and therefore
        // bond lot cost bases) use repo-wide — |amount|/qty*100 reproduces
        // the statement price exactly, so a bill redeeming at its purchase
        // cost realizes $0 (the discount is INTEREST income, not gain).
        effectiveSalePrice = (Math.abs(sell.amount) / sell.quantity) * 100;
      }

      // A stock sale forced by a put exercise / call assignment absorbs the
      // option leg's stored DOLLARS, applied to the leg total rather than to
      // the per-unit price, so the option leg's fees travel with the premium
      // instead of being stranded. The exercises deposited these while they
      // were processed — earlier in the replay, guaranteed by the sell rank.
      const rolloverContribs = pendingSaleRollover.get(sell.id) ?? [];
      const rolloverOnLeg = rolloverContribs.reduce((sum, c) => sum + c.signedDollars, 0);

      const legOpts = { forceDerivation: isZeroPriceClose, amountIsNet: priceFromAmount };

      // `effectiveSalePrice` stays the RAW per-unit price that the leg dollars
      // derive from; the rollover is applied to those dollars, never folded
      // back into the price (that would double-count it). The stored per-unit
      // `sale_price` mirrors the rolled-in total so the display stays
      // consistent with what the row realized.
      let salePriceDisplay = effectiveSalePrice;
      if (rolloverOnLeg !== 0) {
        const adjustedLeg =
          netLegDollars(sell, effectiveSalePrice, "dispose", legOpts) + rolloverOnLeg;
        salePriceDisplay =
          unitPriceFromMarketValue(
            adjustedLeg,
            sell.quantity,
            sell.security_type,
            sell.multiplier
          ) ?? effectiveSalePrice;
      }

      // Get open lots for this account+security, FIFO order
      const openLots = db
        .prepare(
          `SELECT id, acquisition_date, acquisition_price, quantity_acquired,
                  quantity_remaining, cost_basis, is_short
           FROM tax_lots
           WHERE account_id = ? AND security_id = ? AND quantity_remaining > 0
           ORDER BY acquisition_date, id`
        )
        .all(sell.account_id, sell.security_id) as OpenLot[];

      // PLAN the FIFO consumption before writing anything. An exercise has to
      // know exactly which lots it takes — and therefore exactly how many
      // stored dollars it will zero — BEFORE it can decide whether those
      // dollars can land on the underlying. Resolving that ahead of the replay
      // is what leaked premium when an ordinary close had already consumed a
      // different lot.
      const planned: PlannedConsumption[] = [];
      let remainingToSell = sell.quantity;
      for (const lot of openLots) {
        if (remainingToSell <= 0) break;

        const quantitySold = Math.min(remainingToSell, lot.quantity_remaining);
        // Both sides allocate DOLLAR-proportionally: the sale leg by its share
        // of the sold quantity, the lot leg by its share of the lot's original
        // quantity. Never re-derived from acquisition_price — that column
        // stays per-unit for display and does not carry fees.
        const saleShare = sell.quantity !== 0 ? quantitySold / sell.quantity : 0;
        const lotFraction =
          lot.quantity_acquired !== 0 ? quantitySold / lot.quantity_acquired : 0;
        // Whole-leg dollars for this sale, then this lot's share of them. The
        // fee direction depends on which side of the position the lot is on,
        // so it is resolved per lot (a sale never mixes long and short lots in
        // practice — a cover only meets short lots).
        const allocatedLegDollars =
          (netLegDollars(sell, effectiveSalePrice, lot.is_short ? "cover" : "dispose", legOpts) +
            rolloverOnLeg) *
          saleShare;

        planned.push({
          lot,
          quantitySold,
          allocatedLegDollars,
          storedLegAllocated: lot.cost_basis * lotFraction,
        });
        remainingToSell -= quantitySold;
      }

      // The premium that rolls IS the stored dollars these planned rows are
      // about to zero — equal by construction, for long and short alike.
      let isPremiumRollover = 0;
      if (lowerType === "exercised" || lowerType === "assigned") {
        const link = exerciseLinks.get(sell.id);
        const rolloverDollars = planned.reduce((sum, p) => sum + p.storedLegAllocated, 0);
        if (link && rolloverDollars !== 0) {
          isPremiumRollover = landRollover(link, rolloverDollars, sell) ? 1 : 0;
        }
      }

      for (const { lot, quantitySold, allocatedLegDollars, storedLegAllocated } of planned) {
        let proceeds: number;
        let costBasisAllocated: number;
        if (lot.is_short) {
          // IRS column orientation for a short lifecycle: proceeds are the
          // NET short-open leg (stored in lot.cost_basis), basis is what the
          // cover paid. Correct columns make the old sign negation
          // unnecessary — the gain falls out unsigned.
          proceeds = storedLegAllocated;
          costBasisAllocated = allocatedLegDollars;
        } else {
          proceeds = allocatedLegDollars;
          costBasisAllocated = storedLegAllocated;
        }
        if (isPremiumRollover) {
          // The lot's stored dollars left for the underlying; this close is a
          // rollover, not a disposition. Both columns carry that figure so the
          // magnitude stays visible and the gain is zero by construction.
          proceeds = storedLegAllocated;
          costBasisAllocated = storedLegAllocated;
        }
        const realizedGainLoss = proceeds - costBasisAllocated;

        // Signed display convention preserved: negative holding days identify
        // a short lifecycle on existing surfaces (`is_short` is the flag).
        const spanDays = daysBetween(lot.acquisition_date, sell.trade_date);
        const holdingDays = lot.is_short ? -spanDays : spanDays;
        // §1233 general rule: short-sale gain/loss is short-term regardless of
        // how long the position was open. The substantially-identical-property
        // long-term-loss exception is a documented disclosed limitation.
        const isLongTerm = lot.is_short
          ? 0
          : isLongTermHolding(lot.acquisition_date, sell.trade_date)
            ? 1
            : 0;

        insertSale.run(
          lot.id,
          sell.id,
          quantitySold,
          salePriceDisplay,
          proceeds,
          costBasisAllocated,
          realizedGainLoss,
          isLongTerm,
          holdingDays,
          sell.trade_date,
          isPremiumRollover
        );

        const newRemaining = lot.quantity_remaining - quantitySold;
        updateLotRemaining.run(newRemaining, lot.id);

        totalRealizedGain += realizedGainLoss;
      }

      // ── Landing conservation ──
      // The dollars zeroed on the option rollover rows must equal the dollars
      // actually landed on stock legs. Proceeds-side landing distributes
      // × saleShare per lot, so when the sale's open lots cover only part of
      // its quantity (Σ saleShare = landedFraction < 1) exactly
      // rollover × landedFraction landed — the remainder must NOT vanish: it
      // reverts to a REALIZED result on the option's own rows, scaled by the
      // landed fraction. The flag clears to 0 on those rows because a partial
      // row carries an unrolled realized result the filer needs — leaving it
      // filing-excluded would hide that gain/loss (its residual "proceeds",
      // stored × landedFraction, offsets the stock leg's absorbed share, so
      // filing totals still conserve).
      if (rolloverContribs.length > 0) {
        const soldQuantity = planned.reduce((sum, p) => sum + p.quantitySold, 0);
        const landedFraction = sell.quantity > 0 ? soldQuantity / sell.quantity : 0;
        if (landedFraction < 1 - LANDED_FRACTION_TOL) {
          for (const contrib of rolloverContribs) {
            const rows = rolloverRowsForTxn.all(contrib.optionTxnId) as Array<{
              id: number;
              proceeds: number;
              cost_basis_allocated: number;
              is_short: number;
            }>;
            for (const row of rows) {
              // Both columns currently hold the stored figure (the rollover
              // override). The REAL side stays: basis for a long option,
              // proceeds (the premium received) for a short one. The zeroing
              // side scales down to the landed fraction, so the unlanded
              // remainder realizes: −stored × (1−f) long, +stored × (1−f)
              // short.
              const stored = row.is_short ? row.proceeds : row.cost_basis_allocated;
              const newProceeds = row.is_short ? stored : stored * landedFraction;
              const newBasis = row.is_short ? stored * landedFraction : stored;
              const newGain = newProceeds - newBasis;
              unwindRolloverRow.run(newProceeds, newBasis, newGain, row.id);
              // The rollover rows entered the accumulator at exactly zero.
              totalRealizedGain += newGain;
            }
            const unlanded = contrib.storedDollars * (1 - landedFraction);
            replayWarnings.push(
              `${sell.trade_date}: stock sale ${sell.id} had open lots for only ${(
                landedFraction * 100
              ).toFixed(1)}% of its quantity — $${unlanded.toFixed(
                2
              )} of exercised option ${contrib.optionTxnId}'s $${contrib.storedDollars.toFixed(
                2
              )} premium found no stock leg to land on and stays realized on the option close (premium_rollover cleared); import the missing acquisition and recompute`
            );
          }
        }
      }
      processedSellTxnIds.add(sell.id);
      salesProcessed++;
    };

    // ── Donation lot consumption (replay events) ──
    // A TRANSFER_OUT leg with a confirmed 'out' link to a non-reversed
    // donation consumes the lots the user explicitly assigned: the lot's
    // quantity_remaining drops, and NO tax_lot_sales row is written — a
    // charitable gift never enters realized gains, round-trips, or Form 8949.
    // Unlinked or unassigned donations (and bounced transfers, which have no
    // donation row at all) consume nothing: the engine never guesses lots.
    const donationRows = db
      .prepare(
        `SELECT dl.donation_id AS donation_id,
                t.trade_date AS out_leg_date,
                t.account_id AS account_id,
                t.security_id AS security_id,
                ol.acquisition_transaction_id AS acquisition_transaction_id,
                ol.quantity AS quantity
           FROM donation_leg_links dl
           JOIN transactions t ON t.id = dl.transaction_id
           JOIN donation_lots ol ON ol.donation_id = dl.donation_id
           JOIN donations d ON d.id = dl.donation_id
          WHERE dl.role = 'out' AND d.reversed_date IS NULL
          ORDER BY t.trade_date, dl.donation_id, ol.id`
      )
      .all() as Array<{
      donation_id: number;
      out_leg_date: string;
      account_id: number;
      security_id: number;
      acquisition_transaction_id: number;
      quantity: number;
    }>;

    const donationEvents: DonationConsumption[] = [];
    const donationById = new Map<number, DonationConsumption>();
    for (const row of donationRows) {
      let ev = donationById.get(row.donation_id);
      if (!ev) {
        ev = {
          donationId: row.donation_id,
          outLegDate: row.out_leg_date,
          accountId: row.account_id,
          securityId: row.security_id,
          assignments: [],
        };
        donationById.set(row.donation_id, ev);
        donationEvents.push(ev);
      }
      ev.assignments.push({
        acquisitionTransactionId: row.acquisition_transaction_id,
        quantity: row.quantity,
      });
    }

    // Scoped to the OUT leg's own account + security: `donation_lots` rows can
    // also arrive from a repair script's --apply, which does not go through
    // assignDonationLots' invariants, and a gift out of one account must never
    // consume another account's shares.
    const lotForAcquisition = db.prepare(
      `SELECT id, quantity_remaining FROM tax_lots
        WHERE acquisition_transaction_id = ? AND account_id = ? AND security_id = ?`
    );

    let donationsConsumed = 0;

    const applyDonationConsumption = (ev: DonationConsumption) => {
      for (const assignment of ev.assignments) {
        const lot = lotForAcquisition.get(
          assignment.acquisitionTransactionId,
          ev.accountId,
          ev.securityId
        ) as { id: number; quantity_remaining: number } | undefined;
        // Neither branch below is reachable through a single assignDonationLots
        // call — its invariants (lib/mutations/donation-links.ts) reject both.
        // They stay because that check is best-effort against the LAST
        // recompute's state, not a live ledger: cross-donation over-commitment
        // between recomputes is accepted at write time by design and clamped
        // HERE, history can drift after an assignment is made (a late statement
        // adds an earlier sell; an import undo removes the acquisition), and a
        // repair --apply can write donation_lots rows directly.
        if (!lot) {
          replayWarnings.push(
            `donation ${ev.donationId}: no lot found for txn ${assignment.acquisitionTransactionId} in the OUT leg's account — assigned ${assignment.quantity} not consumed`
          );
          continue;
        }
        const consumed = Math.min(assignment.quantity, lot.quantity_remaining);
        if (consumed < assignment.quantity - 1e-9) {
          replayWarnings.push(
            `donation ${ev.donationId}: lot from txn ${assignment.acquisitionTransactionId} has ${lot.quantity_remaining} < assigned ${assignment.quantity} — clamped`
          );
        }
        if (consumed <= 0) continue;
        updateLotRemaining.run(lot.quantity_remaining - consumed, lot.id);
        donationsConsumed++;
      }
    };

    // ── The chronological replay ──
    // One merged event stream: sells, donation consumptions, and
    // import-sourced splits, ordered by (date, kind, id). Same-date kind order
    // is 0 sell → 1 donation → 2 split, which encodes the end-of-day rule
    // (strict '<') by construction: a trade or gift dated the split's
    // effective date processes BEFORE that split — extended-hours trading ends
    // 20:00 ET and IBKR stamps split actions after the close (observed 20:25),
    // so every same-date disposition happened in pre-split units. Events with
    // no counterpart (e.g. a split after the last sell) simply sort to the end
    // — there is no separate drain step to keep in sync.
    const events: ReplayEvent[] = [
      ...sells.map((sell): ReplayEvent => {
        const t = sell.type.toLowerCase();
        const isExercise = t === "exercised" || t === "assigned";
        // Three-level same-date sub-rank (rationale on the ReplayEvent type):
        // ordinary closes pick lots before exercises (OCC notices land
        // post-close), while sells on that date's exercise-link TARGET
        // securities go last so they always see the rollover deposit/UPDATE.
        const isLinkTargetSecurity =
          linkTargetsByDate.get(sell.trade_date)?.has(sell.security_id) ?? false;
        return {
          kind: 0,
          rank: isLinkTargetSecurity ? 2 : isExercise ? 1 : 0,
          date: sell.trade_date,
          id: sell.id,
          sell,
        };
      }),
      ...donationEvents.map(
        (donation): ReplayEvent => ({
          kind: 1,
          date: donation.outLegDate,
          id: donation.donationId,
          donation,
        })
      ),
      ...splitEvents.map(
        (split): ReplayEvent => ({ kind: 2, date: split.effective_date, id: split.id, split })
      ),
    ];
    const rankOf = (e: ReplayEvent) => (e.kind === 0 ? e.rank : 0);
    events.sort((a, b) =>
      a.date < b.date
        ? -1
        : a.date > b.date
          ? 1
          : a.kind - b.kind || rankOf(a) - rankOf(b) || a.id - b.id
    );

    for (const event of events) {
      if (event.kind === 0) processSell(event.sell);
      else if (event.kind === 1) applyDonationConsumption(event.donation);
      else applySplitEvent(event.split);
    }

    // (A stock SALE leg that consumed NO lots at all is the landedFraction=0
    // case of the landing-conservation unwind inside processSell: the option
    // rows revert to their full realized result and the warning fires there —
    // no separate post-replay sweep to keep in step.)

    // ── Broker-close reconciliation pass ──
    // A position the broker snapshot says is CLOSED (explicit quantity-0
    // holdings row — the reconcileClosedEquityHoldings family writes these)
    // can still carry open FIFO lots when the closing SELL hasn't been
    // imported yet (statements lag). Synthesize an engine-owned
    // RECONCILE_CLOSE transaction at the zero-row date and run it through
    // the same FIFO path, so Open Tax Lots stops contradicting Positions
    // with a phantom unrealized gain. Scope mirrors the equity reconciler:
    // stocks/ETFs only (options expire via EXPIRED, bonds mature via
    // REDEMPTION — their purge paths own those lifecycles). Skipped when the
    // ledger is fresher than the snapshot (any position-changing transaction
    // after the zero row means the snapshot is stale, not the ledger).
    const hasHoldings = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'holdings'")
      .get();
    if (hasHoldings) {
      const orphans = db
        .prepare(
          `SELECT tl.account_id, tl.security_id, s.symbol,
                  SUM(tl.quantity_remaining) AS open_qty,
                  -- Stored basis is TRUE DOLLARS, so the still-open share of
                  -- it is dollar-proportional. Dividing by open_qty below
                  -- therefore still yields a correct PER-UNIT breakeven price.
                  SUM(CASE WHEN tl.quantity_acquired != 0
                           THEN tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired
                           ELSE 0 END) AS open_cost,
                  h.as_of_date AS zero_date,
                  COALESCE(s.multiplier, 1) AS multiplier
             FROM tax_lots tl
             JOIN securities s ON s.id = tl.security_id
             JOIN holdings h
               ON h.account_id = tl.account_id AND h.security_id = tl.security_id
              AND h.as_of_date = (
                SELECT MAX(h2.as_of_date) FROM holdings h2
                 WHERE h2.account_id = tl.account_id AND h2.security_id = tl.security_id
              )
            WHERE tl.quantity_remaining > 0
              AND h.quantity = 0
              AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'etf')
              AND NOT EXISTS (
                SELECT 1 FROM transactions t2
                 WHERE t2.account_id = tl.account_id
                   AND t2.security_id = tl.security_id
                   AND t2.trade_date > h.as_of_date
                   AND LOWER(t2.type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open',
                                          'sell', 'sell_to_close', 'redemption', 'buy_to_cover',
                                          'expired', 'exercised', 'assigned', 'buy_to_close')
              )
            GROUP BY tl.account_id, tl.security_id`
        )
        .all() as Array<{
        account_id: number;
        security_id: number;
        symbol: string;
        open_qty: number;
        open_cost: number;
        zero_date: string;
        multiplier: number;
      }>;

      const latestPriceStmt = db.prepare(
        `SELECT close_price FROM prices
          WHERE security_id = ? AND date <= ?
          ORDER BY date DESC LIMIT 1`
      );
      const insertSynthetic = db.prepare(
        `INSERT INTO transactions
           (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees,
            is_external_flow, source_key, notes)
         VALUES (?, ?, ?, 'RECONCILE_CLOSE', ?, ?, ?, 0, 0, ?, ?)`
      );

      for (const orphan of orphans) {
        // Guard: an import-sourced split effective AFTER the zero-holdings
        // date means the orphan's open lots (queried above, post-merge-loop)
        // are already in POST-split units, while `prices` at zero_date is
        // whatever basis the market was quoting on that date — potentially
        // pre-split. Synthesizing a close here would price a post-split
        // quantity off a basis the split cross-check can't vouch for,
        // mixing bases (the "never mix bases" rule). Skip and let the real
        // statement SELL (which arrives in its own correct basis) close it.
        const laterSplit = splitEvents.find(
          (ev) => ev.security_id === orphan.security_id && ev.effective_date > orphan.zero_date
        );
        if (laterSplit) {
          replayWarnings.push(
            `${orphan.symbol}: zero-holdings row on ${orphan.zero_date} predates the ${laterSplit.effective_date} split — skipping the synthetic RECONCILE_CLOSE to avoid mixing pre/post-split bases. Import the missing SELL to close this position.`
          );
          continue;
        }
        const priceRow = latestPriceStmt.get(orphan.security_id, orphan.zero_date) as
          | { close_price: number }
          | undefined;
        // No price at all → breakeven close at the open lots' weighted-average
        // cost (records zero net gain rather than fabricating one).
        const salePrice =
          priceRow?.close_price ?? (orphan.open_qty > 0 ? orphan.open_cost / orphan.open_qty : 0);
        // Scope is stocks/ETFs only, so this equals the old expression — it
        // routes through the shared helper for unit consistency.
        const syntheticAmount = marketValue(
          orphan.open_qty,
          salePrice,
          "stock",
          orphan.multiplier
        );
        const txnResult = insertSynthetic.run(
          orphan.account_id,
          orphan.security_id,
          orphan.zero_date,
          orphan.open_qty,
          salePrice,
          syntheticAmount,
          `reconcile:close:${orphan.account_id}:${orphan.security_id}:${orphan.zero_date}`,
          "Synthesized close — broker snapshot shows this position flat with no matching SELL imported yet; superseded automatically when the real statement lands."
        );
        processSell({
          id: txnResult.lastInsertRowid as number,
          account_id: orphan.account_id,
          security_id: orphan.security_id,
          trade_date: orphan.zero_date,
          type: "RECONCILE_CLOSE",
          quantity: orphan.open_qty,
          price_per_share: salePrice,
          amount: syntheticAmount,
          fees: 0,
          security_type: "stock",
          multiplier: orphan.multiplier,
        });
      }
    }

    // Final act, still inside the transaction: mark this rebuild as having run
    // under the v2 true-dollar convention, bound to the current tax-input
    // generation. The shared guard no-ops on minimal DBs without `settings`.
    stampTaxLotsConventionIfPresent(db);

    return { lotsCreated, salesProcessed, totalRealizedGain, replayWarnings, donationsConsumed };
  })();
}

/**
 * Match each EXERCISED/ASSIGNED option transaction to the underlying leg its
 * premium belongs to, and record WHICH SIDE of that leg absorbs it.
 *
 * Deliberately link-only — no lot reads, no dollars. The amount that rolls is
 * whatever stored basis the replay actually zeroes when the exercise consumes
 * its lots, which the replay alone can know: any figure computed here would be
 * a guess about lot state, and it guessed wrong whenever an ordinary close had
 * already taken a different lot.
 *
 * Keyed by EXERCISE transaction id, so two exercises resolving to the same
 * underlying transaction both survive (they accumulate at landing time).
 *
 * Also returns, per exercise trade date, the set of TARGET security ids —
 * the replay's same-date sub-rank uses it to schedule every sell on a
 * link-target security AFTER the exercises of that date, so the target leg
 * always sees the rollover deposit/UPDATE. Keyed by the EXERCISE's date:
 * that is the only date on which the exercise and a target-security event
 * can collide (an earlier-dated target sale is the documented refusal path,
 * a later-dated one is ordered by date alone).
 *
 * IRS rules (Pub 550):
 * - Long call exercised → stock cost basis += option premium
 * - Long put exercised → stock sale proceeds -= option premium
 * - Short call assigned → stock sale proceeds += option premium
 * - Short put assigned → stock cost basis -= option premium
 */
function computeExerciseLinks(db: Database.Database): {
  links: Map<number, ExerciseLink>;
  targetSecuritiesByDate: Map<string, Set<number>>;
} {
  const links = new Map<number, ExerciseLink>();
  const targetSecuritiesByDate = new Map<string, Set<number>>();

  // Find all EXERCISED/ASSIGNED transactions on option securities
  const exerciseRows = db
    .prepare(
      `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type,
              t.quantity, t.price_per_share,
              s.underlying_symbol, s.option_type,
              COALESCE(s.multiplier, 1) AS multiplier
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       WHERE LOWER(t.type) IN ('exercised', 'assigned')
         AND LOWER(s.security_type) = 'option'
         AND s.underlying_symbol IS NOT NULL
         AND s.option_type IS NOT NULL
       ORDER BY t.trade_date, t.id`
    )
    .all() as OptionExerciseRow[];

  for (const ex of exerciseRows) {
    // A price-less exercise row is under-specified evidence. Treating it as a
    // rollover would zero the option close's realized gain/loss while the
    // premium arithmetic on the underlying no-ops — the premium would then
    // exist NOWHERE. Fail closed: skip the link entirely, and the close keeps
    // its own realized result.
    if (ex.price_per_share == null || ex.price_per_share === 0) continue;

    const isLong = ex.type.toLowerCase() === "exercised";
    const isCall = ex.option_type.toUpperCase() === "CALL";

    // Which underlying transaction, which column, which direction.
    // Long call exercise  → stock BUY  → cost      += premium PAID
    // Short put assigned  → stock BUY  → cost      -= premium RECEIVED
    // Long put exercise   → stock SELL → proceeds  -= premium PAID
    // Short call assigned → stock SELL → proceeds  += premium RECEIVED
    const stockType = isCall === isLong ? "buy" : "sell";
    const target: ExerciseLink["target"] = stockType === "buy" ? "cost" : "proceeds";
    // A premium PAID (long option) raises the cost of what it bought and
    // lowers the proceeds of what it sold; a premium RECEIVED (short option)
    // does the reverse.
    const sign: ExerciseLink["sign"] =
      target === "cost" ? (isLong ? 1 : -1) : isLong ? -1 : 1;

    // Find the linked stock transaction: same account, same underlying, same date (±1 day)
    const underlying = db
      .prepare(
        "SELECT id FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' LIMIT 1"
      )
      .get(ex.underlying_symbol) as { id: number } | undefined;

    if (!underlying) continue;

    const stockTx = db
      .prepare(
        `SELECT id FROM transactions
         WHERE account_id = ? AND security_id = ?
           AND LOWER(type) = ?
           AND ABS(julianday(trade_date) - julianday(?)) <= 1
         ORDER BY ABS(julianday(trade_date) - julianday(?))
         LIMIT 1`
      )
      .get(
        ex.account_id,
        underlying.id,
        stockType,
        ex.trade_date,
        ex.trade_date
      ) as { id: number } | undefined;

    if (!stockTx) continue;

    links.set(ex.id, { stockTxnId: stockTx.id, target, sign });
    let targetSet = targetSecuritiesByDate.get(ex.trade_date);
    if (!targetSet) {
      targetSet = new Set<number>();
      targetSecuritiesByDate.set(ex.trade_date, targetSet);
    }
    targetSet.add(underlying.id);
  }

  return { links, targetSecuritiesByDate };
}
