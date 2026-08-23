import type Database from "better-sqlite3";
import { marketValue } from "@/lib/valuation";
import { stampTaxLotsConvention } from "@/lib/compute/tax-convention";

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
  price_per_share: number;
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
 */
type ReplayEvent =
  | { kind: 0; date: string; id: number; sell: TransactionRow }
  | { kind: 1; date: string; id: number; donation: DonationConsumption }
  | { kind: 2; date: string; id: number; split: SplitEvent };

/** Premium adjustment to apply to a stock transaction's effective price. */
interface PremiumAdjustment {
  /** Per-share premium to add to (buy) or subtract from (sell) the stock price. */
  premiumPerShare: number;
  /**
   * 'increase_cost' — add to stock cost basis (long call exercise, short put assignment)
   * 'increase_proceeds' — add to stock sale proceeds (short call assignment)
   * 'decrease_proceeds' — subtract from stock sale proceeds (long put exercise)
   */
  adjustmentType: "increase_cost" | "increase_proceeds" | "decrease_proceeds";
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
 * Callers that have DERIVED an effective price the broker's `amount` cannot
 * know about — a premium-adjusted exercise leg, a zero-price option close,
 * a bond redemption's per-100-face derivation — pass `forceDerivation` so
 * the adjustment survives.
 */
/** Tolerance for "this amount IS the gross figure" — printed-cent slack. */
const GROSS_AMOUNT_TOL_USD = 0.02;

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
  forceDerivation = false
): number {
  const gross = marketValue(row.quantity, perUnitPrice, row.security_type, row.multiplier);
  const fees = row.fees ?? 0;
  // Buy-side fees are capitalized into basis and a cover's fees are part of
  // what closing the position cost (both ADD); sale proceeds are net of the
  // fees withheld from them and a short open's stored leg is likewise the NET
  // premium received (both SUBTRACT).
  const feeSign = side === "acquire" || side === "cover" ? 1 : -1;

  if (!forceDerivation && row.amount != null && row.amount !== 0) {
    const magnitude = Math.abs(row.amount);
    const amountIsGross =
      fees > 0 && Math.abs(magnitude - Math.abs(gross)) <= GROSS_AMOUNT_TOL_USD;
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

    // ── Pre-processing: Compute premium adjustments for exercise/assignment ──
    const { adjustments: premiumAdjustments, linkedExerciseTxnIds } =
      computePremiumAdjustments(db);

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
    for (const buy of buys) {
      // Apply premium adjustment if this stock buy is linked to an option exercise
      let effectivePrice = buy.price_per_share;
      let premiumAdjusted = false;
      const adj = premiumAdjustments.get(buy.id);
      if (adj && adj.adjustmentType === "increase_cost") {
        effectivePrice += adj.premiumPerShare;
        premiumAdjusted = true;
      }

      const isShort = buy.type.toLowerCase() === "sell_to_open" ? 1 : 0;
      // TRUE ECONOMIC DOLLARS: bonds ÷100, options ×multiplier, fees on the
      // side that bears them. For a short open the stored dollar column is
      // the lot's opening leg — which for a short IS its net proceeds.
      // A premium-adjusted buy must derive from the ADJUSTED price: the
      // broker's `amount` predates the roll-in of the option premium.
      const costBasis = netLegDollars(
        buy,
        effectivePrice,
        isShort ? "short_open" : "acquire",
        premiumAdjusted
      );
      insertLot.run(
        buy.account_id,
        buy.security_id,
        buy.id,
        buy.trade_date,
        effectivePrice,
        buy.quantity,
        buy.quantity,
        costBasis,
        isShort
      );
      lotsCreated++;
    }

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

    const processSell = (sell: TransactionRow) => {
      let remainingToSell = sell.quantity;

      // For EXERCISED/ASSIGNED/EXPIRED, the option closes at $0
      const lowerType = sell.type.toLowerCase();
      const isZeroPriceClose =
        lowerType === "exercised" || lowerType === "assigned" || lowerType === "expired";
      let effectiveSalePrice = sell.price_per_share ?? 0;

      if (isZeroPriceClose) {
        // Option lot closes at $0 — expired worthless or premium rolls into stock
        effectiveSalePrice = 0;
      } else if (
        lowerType === "redemption" &&
        sell.price_per_share == null &&
        sell.amount != null &&
        sell.quantity > 0
      ) {
        // Maturity redemption: derive the price from the principal returned,
        // on the per-100-face basis bond transaction prices (and therefore
        // bond lot cost bases) use repo-wide — |amount|/qty*100 reproduces
        // the statement price exactly, so a bill redeeming at its purchase
        // cost realizes $0 (the discount is INTEREST income, not gain).
        effectiveSalePrice = (Math.abs(sell.amount) / sell.quantity) * 100;
      }

      // Apply premium adjustment for stock sales linked to put exercise / call assignment
      let premiumAdjusted = false;
      const adj = premiumAdjustments.get(sell.id);
      if (adj) {
        if (adj.adjustmentType === "increase_proceeds") {
          effectiveSalePrice += adj.premiumPerShare;
          premiumAdjusted = true;
        } else if (adj.adjustmentType === "decrease_proceeds") {
          effectiveSalePrice -= adj.premiumPerShare;
          premiumAdjusted = true;
        }
      }

      // Premium on an EXERCISED/ASSIGNED option that actually linked to an
      // underlying leg has already moved into that leg's basis/proceeds
      // (Pub 550). Closing the option lot here is a rollover, not a second
      // disposition — the row is flagged and carries zero gain.
      const isPremiumRollover =
        (lowerType === "exercised" || lowerType === "assigned") &&
        linkedExerciseTxnIds.has(sell.id)
          ? 1
          : 0;

      // `forceDerivation` where the effective price is engine-derived rather
      // than the broker's: zero-price option closes and premium-adjusted legs
      // (the statement `amount` cannot know about either).
      const legIsDerived = isZeroPriceClose || premiumAdjusted;

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
          netLegDollars(
            sell,
            effectiveSalePrice,
            lot.is_short ? "cover" : "dispose",
            legIsDerived
          ) * saleShare;

        let proceeds: number;
        let costBasisAllocated: number;
        if (lot.is_short) {
          // IRS column orientation for a short lifecycle: proceeds are the
          // NET short-open leg (stored in lot.cost_basis), basis is what the
          // cover paid. Correct columns make the old sign negation
          // unnecessary — the gain falls out unsigned.
          proceeds = lot.cost_basis * lotFraction;
          costBasisAllocated = allocatedLegDollars;
        } else {
          proceeds = allocatedLegDollars;
          costBasisAllocated = lot.cost_basis * lotFraction;
        }
        if (isPremiumRollover) proceeds = costBasisAllocated;
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
          effectiveSalePrice,
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

        remainingToSell -= quantitySold;
        totalRealizedGain += realizedGainLoss;
      }

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
      ...sells.map(
        (sell): ReplayEvent => ({ kind: 0, date: sell.trade_date, id: sell.id, sell })
      ),
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
    events.sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind - b.kind || a.id - b.id
    );

    for (const event of events) {
      if (event.kind === 0) processSell(event.sell);
      else if (event.kind === 1) applyDonationConsumption(event.donation);
      else applySplitEvent(event.split);
    }

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
    // generation. Minimal test DBs have no `settings` table — skip there.
    const hasSettings = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get();
    if (hasSettings) stampTaxLotsConvention(db);

    return { lotsCreated, salesProcessed, totalRealizedGain, replayWarnings, donationsConsumed };
  })();
}

/**
 * Pre-processing: find EXERCISED/ASSIGNED option transactions and compute
 * premium adjustments for the linked stock transactions.
 *
 * IRS rules:
 * - Long call exercised → stock cost basis += option premium per share
 * - Long put exercised → stock sale proceeds -= option premium per share
 * - Short call assigned → stock sale proceeds += option premium per share
 * - Short put assigned → stock cost basis -= option premium per share
 */
function computePremiumAdjustments(db: Database.Database): {
  adjustments: Map<number, PremiumAdjustment>;
  /**
   * Ids of the EXERCISED/ASSIGNED option transactions that actually found an
   * underlying leg to roll their premium into. Only those option closes are
   * premium rollovers; an unlinked one keeps its realized gain/loss so the
   * premium never silently vanishes.
   */
  linkedExerciseTxnIds: Set<number>;
} {
  const adjustments = new Map<number, PremiumAdjustment>();
  const linkedExerciseTxnIds = new Set<number>();

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
         AND s.option_type IS NOT NULL`
    )
    .all() as OptionExerciseRow[];

  for (const ex of exerciseRows) {
    const isLong = ex.type.toLowerCase() === "exercised";
    const isCall = ex.option_type.toUpperCase() === "CALL";
    const premiumPerShare = ex.price_per_share; // already per-share for the underlying

    // Determine what stock transaction to look for and how to adjust
    // Long call exercise → stock BUY → increase cost basis
    // Long put exercise → stock SELL → decrease proceeds
    // Short call assigned → stock SELL → increase proceeds
    // Short put assigned → stock BUY → decrease cost basis (reduce cost)
    let stockType: string;
    let adjustmentType: PremiumAdjustment["adjustmentType"];

    if (isLong && isCall) {
      stockType = "buy";
      adjustmentType = "increase_cost";
    } else if (isLong && !isCall) {
      stockType = "sell";
      adjustmentType = "decrease_proceeds";
    } else if (!isLong && isCall) {
      stockType = "sell";
      adjustmentType = "increase_proceeds";
    } else {
      // Short put assigned → forced buy
      stockType = "buy";
      // Premium RECEIVED reduces cost basis — we subtract
      adjustmentType = "increase_cost"; // but with negative premium (see below)
    }

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

    // For short put assignment, premium received REDUCES cost, so negate
    const effectivePremium =
      !isLong && !isCall ? -premiumPerShare : premiumPerShare;

    adjustments.set(stockTx.id, {
      premiumPerShare: effectivePremium,
      adjustmentType,
    });
    linkedExerciseTxnIds.add(ex.id);
  }

  return { adjustments, linkedExerciseTxnIds };
}
