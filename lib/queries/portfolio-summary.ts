import type Database from "better-sqlite3";
import { unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import { adjustedMarketValueSQL, scaledCostBasisFallbackSQL } from "@/lib/valuation";
import { formatUSD, formatNumber, resolveOptionFields } from "@/lib/format";
import { parseOCCSymbol } from "@/lib/import/occ-symbol";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { SECTOR_OWN_BUCKET_SQL } from "@/lib/queries/analysis";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { normalizeFundCategory } from "@/lib/securities/normalize-fund-category";
import { todayET } from "@/lib/calendar/date-utils";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { getAllAccounts } from "@/lib/queries/accounts";
import { washSaleReplacementAccounts } from "@/lib/queries/wash-sale-replacements";
import { isTaxableAccount } from "@/lib/compute/tax-treatment";
import { generateTaxReport, washSaleReplacementPhrase, type TaxReportResult } from "@/lib/compute/tax-report";
import { quantityUnitLabel } from "@/lib/format/quantity-unit";
import {
  getPortfolioCurrentValues,
  type AccountValueSourceKind,
} from "@/lib/queries/dashboard";
import { liveOptionExpirationSql, normalizeOptionExpiration } from "@/lib/compute/option-expiry";
import { CURRENCY_CONVERSION_SECURITY_SQL, lotSideSignSql, remainingLotBasisSql } from "@/lib/queries/tax-lots";
import { transactionAmountCurrencySql, transactionAmountUsdSql } from "@/lib/queries/chat-tools";
import { longTermDateSql } from "@/lib/queries/long-term-sql";
import { getPendingStatementIndex, isPendingStatementLot } from "@/lib/queries/pending-statement";
import {
  reducePendingDisclosure,
  type PendingDisclosureInput,
  type PendingDisclosureRow,
} from "@/lib/queries/pending-statement-types";

/**
 * One chat line per (reason, side) pending row. The long "awaiting statement"
 * line keeps its historical text; the others name their reason and the figure
 * kind (cost basis for a long side, short-sale proceeds for a short side).
 * Sentences live here: lib files never import from app/.
 */
function pendingDisclosureLine(row: PendingDisclosureRow): string {
  const lots = `${row.lots} lot${row.lots === 1 ? "" : "s"}`;
  const figureWords = row.figureKind === "short_sale_proceeds" ? "short-sale proceeds" : "cost basis";
  const detail = `${row.positions} (${lots}, ${figureWords}: ${formatUSD(row.figure)})`;
  const sideNote = row.side === "short" ? " (short positions)" : "";
  switch (row.reason) {
    case "closing_entry_missing":
      return `- Positions the broker statement shows closed but with no closing entry in the ledger${sideNote}: ${detail} — not counted as open holdings or unrealized; realized gain unknown until the closing entry is imported`;
    case "resymbol_repair_pending":
      return `- Option positions renamed to a new contract after a split, ledger entries not yet moved${sideNote}: ${detail} — not counted as open holdings or unrealized; realized gain unknown until the entries are moved to the new symbol`;
    default:
      return `- Positions closed per live data, awaiting broker statement${sideNote}: ${detail} — not counted as open holdings or unrealized; realized gain unknown until the statement is imported`;
  }
}

const CONVENTION_PENDING_NOTE =
  "Note: cost-basis figures are pending a recompute under the corrected dollar convention and may be unit-inconsistent.";

/** How each account's value source is named to the model. */
const ACCOUNT_VALUE_SOURCE_LABEL: Record<AccountValueSourceKind, string> = {
  live: "live broker value",
  daily: "daily valuation",
  statement: "statement",
};

interface EnrichedHolding {
  account_name: string;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  asset_class: string | null;
  sector: string | null;
  quantity: number;
  cost_basis: number | null;
  latest_price: number | null;
  market_value: number | null;
  unrealized_gain: number | null;
  /** Gain as a percent of cost: query_holdings' unrealized_gain_pct, same formula. */
  unrealized_gain_pct: number | null;
  position_weight_pct: number | null;
  option_type?: string | null;
  strike_price?: number | null;
  expiration_date?: string | null;
  underlying_symbol?: string | null;
}

interface RecentTransaction {
  account_name: string;
  trade_date: string;
  type: string;
  symbol: string | null;
  security_type: string | null;
  quantity: number | null;
  amount: number | null;
  /** The currency `amount` is stored in (transactionAmountCurrencySql). */
  amount_currency: string;
  /** USD at the current rate; null when no rate is on file. */
  amount_usd: number | null;
}

/**
 * The amount on a recent-transaction line. A buy or sell's direction is in
 * its type, so its magnitude is shown. Interest keeps its direction in
 * words, by the income source's sign rule (lib/queries/income-sql.ts): a
 * positive row is interest earned, a negative one interest paid (margin
 * interest is a cost); a negative dividend is a charge or reversal. A
 * non-USD amount is shown in its own currency, never with a dollar sign,
 * with its USD figure at the current rate when one is on file.
 */
function recentTransactionAmountText(t: RecentTransaction): string {
  const amount = t.amount as number;
  const type = t.type.toUpperCase();
  const label =
    type === "INTEREST"
      ? amount < 0 ? "interest paid" : "interest earned"
      : type === "DIVIDEND" && amount < 0
        ? "dividend charged or reversed"
        : "amount";
  if (t.amount_currency === "USD") return `${label} ${formatUSD(Math.abs(amount))}`;
  const native = `${t.amount_currency} ${formatNumber(Math.abs(amount))}`;
  const usd =
    t.amount_usd != null
      ? ` (about ${formatUSD(Math.abs(t.amount_usd))} at the current rate)`
      : ` (no USD rate on file for ${t.amount_currency})`;
  return `${label} ${native}${usd}`;
}

interface AllocationRow {
  group_name: string;
  total_market_value: number;
  percentage: number;
  count: number;
}

interface HarvestCandidate {
  symbol: string;
  account_name: string;
  /** 1 for a short lot: the figure is signed by side and the line says so. */
  is_short: number;
  unrealized_loss: number;
  cost_basis: number;
  days_held: number;
}

interface ApproachingLongTerm {
  symbol: string;
  account_name: string;
  acquisition_date: string;
  long_term_date: string;
  days_remaining: number;
  unrealized_gain: number | null;
}

/** Join keys selected only to consult the pending-statement read model. */
interface PairKeyed {
  account_id: number;
  security_id: number;
  is_short: number;
}

/**
 * Allocation grouping, by the rules of query_allocation's grouping in
 * lib/queries/chat-tools.ts (getAllocationBreakdown). Those helpers are
 * private to that file, so the same rules are restated here over the
 * repo's exported normalisers, and a parity test
 * (tests/queries/portfolio-summary-allocation-labels.test.ts) pins the two
 * to one answer. Security types fold on case (underscores as spaces) onto the
 * stored canonical spellings; `mapSecurityType` is NOT used: it is an IBKR
 * SecType map that would merge Stock and ETF.
 */
const SECURITY_TYPE_LABELS: Record<string, string> = {
  stock: "Stock",
  etf: "ETF",
  bond: "Bond",
  option: "Option",
  "mutual fund": "Mutual Fund",
  "money market": "Money Market",
};

function assetAllocationLabel(raw: string): string {
  const value = (raw ?? "").trim() || raw;
  const token = value.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
  return SECURITY_TYPE_LABELS[token] ?? value;
}

/** Sectors through normalizeSector (GICS-11), else normalizeFundCategory. "Unknown" stays the unclassified bucket. */
function sectorAllocationLabel(raw: string): string {
  const value = (raw ?? "").trim() || raw;
  if (value === "Unknown") return value;
  return normalizeSector(value) ?? normalizeFundCategory(value) ?? value;
}

/**
 * Sum positions into groups keyed case-insensitively on their label (the
 * label shown is the first spelling in code-point order, so it is stable).
 * Totals are kept whole, so the groups sum to the section total.
 */
function groupAllocationRows(
  positions: Array<{ raw: string; mv: number }>,
  label: (raw: string) => string,
): AllocationRow[] {
  const groups = new Map<string, { names: string[]; total: number; count: number }>();
  for (const p of positions) {
    const name = label(p.raw);
    const key = name.trim().toLowerCase();
    const g = groups.get(key) ?? { names: [], total: 0, count: 0 };
    g.names.push(name);
    g.total += p.mv ?? 0;
    g.count += 1;
    groups.set(key, g);
  }
  const grand = [...groups.values()].reduce((sum, g) => sum + g.total, 0);
  return [...groups.values()]
    .map((g) => ({
      group_name: [...g.names].sort()[0],
      total_market_value: g.total,
      percentage: grand !== 0 ? (g.total * 100) / grand : 0,
      count: g.count,
    }))
    .sort((a, b) => b.total_market_value - a.total_market_value);
}

/**
 * Plain-language leg for an option in the verified-holdings list, e.g.
 * " — long put on AAA, $50 strike, expires 2027-06-18". The caller passes
 * the side (long list or short list). Fields come from
 * the stored columns, else parsed from the OCC symbol (resolveOptionFields),
 * so the model never decodes "271217P" itself: it once read a long December
 * 2027 put as a short January 2027 put. Empty for a non-option or when
 * nothing can be read.
 */
function describeOptionLeg(
  h: Pick<EnrichedHolding, "symbol" | "security_type" | "option_type" | "strike_price" | "expiration_date" | "underlying_symbol">,
  side: "long" | "short" = "long"
): string {
  if ((h.security_type ?? "").toLowerCase() !== "option") return "";
  const fields = resolveOptionFields(h.symbol, h.option_type as "CALL" | "PUT" | null | undefined, h.strike_price, h.expiration_date);
  const kind = fields.optionType === "CALL" ? "call" : fields.optionType === "PUT" ? "put" : null;
  if (!kind) return "";
  const underlying = h.underlying_symbol?.trim() || parseOCCSymbol(h.symbol)?.underlying || null;
  const strike =
    fields.strike != null
      ? `$${Number.isInteger(fields.strike) ? fields.strike : fields.strike.toFixed(2).replace(/\.?0+$/, "")} strike`
      : null;
  const expiry = fields.expiration ? `expires ${normalizeOptionExpiration(fields.expiration)}` : null;
  const parts = [strike, expiry].filter((p): p is string => p !== null);
  return ` — ${side} ${kind}${underlying ? ` on ${underlying}` : ""}${parts.length ? `, ${parts.join(", ")}` : ""}`;
}

/**
 * The chat summary's scope (Contract I of the Portfolio Assistant plan,
 * 2026-11-11):
 *  - `undefined`: every account;
 *  - `{ accountIds, label }`: exactly those ids (`[]` = no accounts), with
 *    `label` naming the scope in the "This total covers ..." sentence;
 *  - a string (legacy): the one account with that exact name; no exact match
 *    is the empty scope, never the whole book.
 */
export type PortfolioSummaryScope = string | { accountIds: number[]; label: string };

export /** The base both allocation sections state once in their header (RF-10). */
const ALLOCATION_SHARE_BASE = "share = of the priced long market value in this scope";

export const NO_ACCOUNT_IN_SCOPE = "No account matches this chat's scope.";
const TAX_ADVANTAGED_NOT_APPLICABLE = "Not applicable: this account is tax-advantaged.";
const ALL_TAX_ADVANTAGED_NOT_APPLICABLE = "Not applicable: every account in this scope is tax-advantaged.";

function resolveSummaryScope(
  db: Database.Database,
  scope: PortfolioSummaryScope | undefined,
): { accountIds: number[] | undefined; label: string | null } {
  if (scope === undefined) return { accountIds: undefined, label: null };
  if (typeof scope === "string") {
    const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(scope) as { id: number } | undefined;
    return { accountIds: row ? [row.id] : [], label: scope };
  }
  // Only ids that name a real account count: [999] is the empty scope, and
  // [999, 3] is one account (so the total sentence counts accounts, not ids).
  const known = new Set(getAllAccounts(db).map((a) => a.id));
  return { accountIds: [...new Set(scope.accountIds)].filter((id) => known.has(id)), label: scope.label };
}

export function getPortfolioSummaryForChat(db: Database.Database, scope?: PortfolioSummaryScope): string {
  // ET day — a UTC slice reads tomorrow from 20:00 ET and shifts every
  // days-to-long-term count and trailing window below by one.
  const today = todayET();
  const lines: string[] = [];
  lines.push("## Portfolio Summary\n");

  // ─── Resolve the scope to an account id list ───────────────────
  // `undefined` = every account; a defined empty list = no accounts. Every
  // filter below is built from this one list (accountScopeAndSql), so no
  // section can read an account outside the scope.
  const { accountIds, label: scopeLabel } = resolveSummaryScope(db, scope);
  if (accountIds !== undefined && accountIds.length === 0) {
    lines.push(NO_ACCOUNT_IN_SCOPE);
    return lines.join("\n");
  }
  const conventionPending = !getTaxConventionState(db).recomputeCurrent;

  const holdingsScope = accountScopeAndSql(accountIds, "h.account_id");
  const holdingsFilter = holdingsScope.sql;
  const holdingsParams = holdingsScope.params;
  const txnScope = accountScopeAndSql(accountIds, "t.account_id");

  // Tax treatment (QA-1): harvesting and long-term timing matter only in a
  // taxable account. `isTaxableAccount` is the one reader of the column.
  const accountsInScope = getAllAccounts(db).filter(
    (a) => accountIds === undefined || accountIds.includes(a.id),
  );
  /** Names of the scope's accounts; null for the whole book. */
  const scopeAccountNames = accountIds === undefined ? null : new Set(accountsInScope.map((a) => a.name));
  const taxableAccountsInScope = accountsInScope.filter((a) => isTaxableAccount(a.tax_treatment));
  const taxableIds = taxableAccountsInScope.map((a) => a.id);
  const noTaxableAccount = accountsInScope.length > 0 && taxableAccountsInScope.length === 0;
  const taxAdvantagedSentence =
    accountsInScope.length === 1 ? TAX_ADVANTAGED_NOT_APPLICABLE : ALL_TAX_ADVANTAGED_NOT_APPLICABLE;
  const taxableTlScope = accountScopeAndSql(taxableIds, "tl.account_id");

  // ─── Account Values ────────────────────────────────────────────
  // Owner ruling 2026-10-08: the chat reads the Portfolio strip's total. The
  // per-account selection (recent live row, else newer daily valuation, else
  // latest statement) is the strip's own, from one shared helper, so the two
  // surfaces cannot state different totals. A named account that matches
  // nothing is an empty scope, never the whole portfolio.
  const portfolioValues = getPortfolioCurrentValues(db, accountIds);

  lines.push("### Account Values");
  for (const av of portfolioValues.accounts) {
    if (av.currentValue !== null) {
      const kind = av.sourceKind ? `, ${ACCOUNT_VALUE_SOURCE_LABEL[av.sourceKind]}` : "";
      lines.push(`- ${av.accountName}: ${formatUSD(av.currentValue)} (as of ${av.asOfDate}${kind})`);
    } else {
      lines.push(`- ${av.accountName}: No data yet`);
    }
  }

  if (portfolioValues.totalValue > 0) {
    const mixedDates =
      portfolioValues.oldestDate !== null && portfolioValues.oldestDate !== portfolioValues.latestDate;
    const asOf = portfolioValues.latestDate
      ? ` (as of ${portfolioValues.latestDate}${
          mixedDates
            ? `; the accounts are valued on different dates, the oldest account value is dated ${portfolioValues.oldestDate}`
            : ""
        })`
      : "";
    lines.push(`- **Total Portfolio**: ${formatUSD(portfolioValues.totalValue)}${asOf}`);
    // The strip on Today adds EVERY account. A summary scoped to one account
    // totals that account alone, so it must not claim the strip's figure.
    const several = accountIds !== undefined && accountIds.length > 1;
    lines.push(
      scopeLabel !== null
        ? several
          ? `- This total covers the ${scopeLabel} accounts only. It is not the whole-portfolio figure on the Portfolio strip on Today, which adds every account. Each account line above states its own date and source.`
          : `- This total covers the ${scopeLabel} account only. It is not the whole-portfolio figure on the Portfolio strip on Today, which adds every account. The account line above states its own date and source.`
        : "- This total is the same figure as the Portfolio strip on Today. Each account line above states its own date and source.",
    );
  }

  // ─── All Holdings with enrichment ──────────────────────────────
  // QA-12: the basis the Accounts page shows and query_holdings reads: the
  // row's own, else the latest earlier row of the pair scaled by quantity.
  const HOLDING_BASIS = scaledCostBasisFallbackSQL("h", "hb");
  const holdings = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (
          SELECT security_id, MAX(date) AS max_date
          FROM prices GROUP BY security_id
        ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
      ),
      portfolio_total AS (
        SELECT COALESCE(SUM(
          CASE WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
            ELSE 0 END
        ), 1) AS total
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        LEFT JOIN fx_rates fx ON fx.currency = s.currency
        WHERE ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
        AND ${unmaturedSecuritySql("s")}
        AND ${liveOptionExpirationSql("s", today)}
        ${holdingsFilter}
      )
      SELECT a.name AS account_name, s.symbol, s.name AS security_name,
              s.security_type, s.asset_class, s.sector,
              s.option_type, s.strike_price, s.expiration_date, s.underlying_symbol,
              h.quantity, ${HOLDING_BASIS} * COALESCE(fx.usd_per_unit, 1) AS cost_basis, h.as_of_date,
              lp.close_price AS latest_price,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
                ELSE NULL
              END AS market_value,
              CASE WHEN lp.close_price IS NOT NULL AND ${HOLDING_BASIS} IS NOT NULL AND ${HOLDING_BASIS} > 0
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (${HOLDING_BASIS} * COALESCE(fx.usd_per_unit, 1))
                ELSE NULL
              END AS unrealized_gain,
              CASE WHEN lp.close_price IS NOT NULL AND ${HOLDING_BASIS} IS NOT NULL AND ${HOLDING_BASIS} > 0
                THEN (${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (${HOLDING_BASIS} * COALESCE(fx.usd_per_unit, 1))) * 100.0 / (${HOLDING_BASIS} * COALESCE(fx.usd_per_unit, 1))
                ELSE NULL
              END AS unrealized_gain_pct,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} * 100.0 / (SELECT total FROM portfolio_total)
                ELSE NULL
              END AS position_weight_pct
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
       AND ${unmaturedSecuritySql("s")}
       AND ${liveOptionExpirationSql("s", today)}
       ${holdingsFilter}
       ORDER BY market_value DESC`
    )
    .all(...holdingsParams, ...holdingsParams) as EnrichedHolding[];

  if (holdings.length > 0) {
    // RF-10: every figure is named. The weight's base is stated once here:
    // the priced long market value of the scope, the same base as
    // query_holdings' position_weight_pct (getHoldingsForChat).
    lines.push(
      "\n### Current Holdings — long positions (verified, quantity > 0; weight = share of the priced long market value in this scope; short positions are listed in the next section)"
    );
    const signed = (n: number) => `${n >= 0 ? "+" : ""}${formatUSD(n)}`;
    for (const h of holdings) {
      const unit = quantityUnitLabel(h.security_type, h.quantity);
      const parts: string[] = [];
      if (h.market_value != null) parts.push(`value ${formatUSD(h.market_value)}`);
      if (h.cost_basis != null && h.cost_basis > 0) parts.push(`cost basis ${formatUSD(h.cost_basis)}`);
      if (h.unrealized_gain != null) {
        const pct =
          h.unrealized_gain_pct != null
            ? ` (${h.unrealized_gain_pct >= 0 ? "+" : ""}${h.unrealized_gain_pct.toFixed(1)}% of cost)`
            : "";
        parts.push(`gain/loss ${signed(h.unrealized_gain)}${pct}`);
      }
      if (h.position_weight_pct != null) parts.push(`weight ${h.position_weight_pct.toFixed(1)}%`);
      if (h.sector) parts.push(`sector ${h.sector}`);
      const leg = describeOptionLeg(h);
      lines.push(
        `- ${h.symbol} (${h.account_name}): ${formatNumber(h.quantity)} ${unit}${leg}${parts.map((p) => `; ${p}`).join("")}`
      );
    }
  }

  // ─── Short positions ─────────────────────────────────────────────
  // The long list above is the book's long side only. A held short was
  // missing from the context altogether, so the model, seeing it in the
  // market snapshot, told the owner the book might not have synced it
  // (QA 2026-10-13). Quantity and market value only: a short's gain is the
  // lot engine's to sign (lib/queries/tax-lots.ts), never derived here.
  const shorts = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT a.name AS account_name, s.symbol, s.security_type, s.sector,
             s.option_type, s.strike_price, s.expiration_date, s.underlying_symbol,
             h.quantity, h.as_of_date,
             CASE WHEN lp.close_price IS NOT NULL
               THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
               ELSE NULL
             END AS market_value
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter: "" })}
         AND h.quantity < 0
         AND ${unmaturedSecuritySql("s")}
         AND ${liveOptionExpirationSql("s", today)}
         ${holdingsFilter}
       ORDER BY market_value ASC`
    )
    .all(...holdingsParams) as Array<{
      account_name: string;
      symbol: string;
      security_type: string | null;
      sector: string | null;
      option_type: string | null;
      strike_price: number | null;
      expiration_date: string | null;
      underlying_symbol: string | null;
      quantity: number;
      as_of_date: string;
      market_value: number | null;
    }>;

  if (shorts.length > 0) {
    lines.push("\n### Current Short Positions (verified, quantity < 0; market value is the liability)");
    for (const h of shorts) {
      const unit = quantityUnitLabel(h.security_type, h.quantity);
      const value = h.market_value != null ? `; value ${formatUSD(h.market_value)} (liability)` : "";
      const sector = h.sector ? `; sector ${h.sector}` : "";
      const leg = describeOptionLeg(h, "short");
      lines.push(`- ${h.symbol} (${h.account_name}): short ${formatNumber(Math.abs(h.quantity))} ${unit}${leg}${value}${sector}`);
    }
  }

  // ─── Asset Allocation ──────────────────────────────────────────
  // One row per priced long position with its RAW labels; the grouping is
  // done in JS by the same rules as query_allocation (getAllocationBreakdown,
  // lib/queries/chat-tools.ts), so "Option"/"option"/"OPTION" or
  // "Information Technology"/"technology" are one line, and the summary and
  // the tool never disagree. The sector label is the tool's own SQL bucket
  // (SECTOR_OWN_BUCKET_SQL: sector, else fund category, bond = Fixed Income).
  const allocationPositions = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        COALESCE(s.asset_class, s.security_type, 'Unknown') AS asset_label,
        ${SECTOR_OWN_BUCKET_SQL} AS sector_label,
        ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS mv
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE lp.close_price IS NOT NULL
        AND ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
        AND ${unmaturedSecuritySql("s")}
        AND ${liveOptionExpirationSql("s", today)}
        ${holdingsFilter}`
    )
    .all(...holdingsParams) as Array<{ asset_label: string; sector_label: string; mv: number }>;

  const assetAllocation = groupAllocationRows(
    allocationPositions.map((p) => ({ raw: p.asset_label, mv: p.mv })),
    assetAllocationLabel,
  );

  if (assetAllocation.length > 0) {
    lines.push(`\n### Asset Allocation (${ALLOCATION_SHARE_BASE})`);
    for (const a of assetAllocation) {
      lines.push(
        `- ${a.group_name}: ${formatUSD(a.total_market_value)} (${a.percentage.toFixed(1)}% share, ${a.count} positions)`
      );
    }
  }

  // Sector allocation (if any sector data exists)
  const sectorAllocation = groupAllocationRows(
    allocationPositions.map((p) => ({ raw: p.sector_label, mv: p.mv })),
    sectorAllocationLabel,
  );

  const hasSectorData = sectorAllocation.some((s) => s.group_name !== "Unknown");
  if (hasSectorData) {
    const withSector = sectorAllocation.filter((s) => s.group_name !== "Unknown");
    const unknown = sectorAllocation.find((s) => s.group_name === "Unknown");
    lines.push(`\n### Sector Allocation (${ALLOCATION_SHARE_BASE})`);
    for (const s of withSector) {
      lines.push(
        `- ${s.group_name}: ${formatUSD(s.total_market_value)} (${s.percentage.toFixed(1)}% share)`
      );
    }
    if (unknown) {
      lines.push(
        `- Unclassified: ${formatUSD(unknown.total_market_value)} (${unknown.percentage.toFixed(1)}% share, ${unknown.count} positions without sector data)`
      );
    }
  }

  // ─── Tax Summary + Harvesting Candidates ───────────────────────
  const taxLotsScope = accountScopeAndSql(accountIds, "tax_lots.account_id");
  // tax_lots.cost_basis is the v2 TRUE-DOLLAR total for the lot's original
  // quantity_acquired (bond ÷100, option ×multiplier, fees included); the
  // still-open share is dollar-proportional (see cost-basis-reconciliation.ts).
  // For a short lot the same column holds the opening short-sale proceeds.
  //
  // Pending-statement lots (positions closed per live data, awaiting the
  // broker statement — lib/queries/pending-statement.ts) are NOT open
  // holdings: grouped per pair so the shared read model can split them out
  // into their own disclosed line, never re-derived here.
  const pendingIndex = getPendingStatementIndex(db, accountIds, { today });
  const taxLotGroups = db
    .prepare(
      `SELECT
        tax_lots.account_id, tax_lots.security_id, tax_lots.is_short,
        COUNT(*) AS open_lots,
        COALESCE(SUM(tax_lots.cost_basis * tax_lots.quantity_remaining / tax_lots.quantity_acquired * COALESCE(fx.usd_per_unit, 1)), 0) AS total_cost_basis
       FROM tax_lots
       JOIN securities s ON s.id = tax_lots.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE quantity_remaining > 0
         AND quantity_acquired != 0
         AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
         AND ${liveOptionExpirationSql("s", today)}
         ${taxLotsScope.sql}
       GROUP BY tax_lots.account_id, tax_lots.security_id, tax_lots.is_short`
    )
    .all(...taxLotsScope.params) as Array<{
    account_id: number;
    security_id: number;
    is_short: number;
    open_lots: number;
    total_cost_basis: number;
  }>;
  // B4: a short lot's figure is short-sale proceeds, never summed with a
  // long cost basis (the pending-lots rule, docs/DECISIONS.md 2026-10-26).
  const taxSummary = { open_lots: 0, long_cost_basis: 0, short_lots: 0, short_proceeds: 0 };
  const pendingInputs: PendingDisclosureInput[] = [];
  for (const g of taxLotGroups) {
    const reason = pendingIndex.reasonFor(g);
    if (reason) {
      pendingInputs.push({
        account_id: g.account_id,
        security_id: g.security_id,
        is_short: g.is_short,
        reason,
        lotCount: g.open_lots,
        figure: g.total_cost_basis,
      });
    } else {
      taxSummary.open_lots += g.open_lots;
      if (g.is_short) {
        taxSummary.short_lots += g.open_lots;
        taxSummary.short_proceeds += g.total_cost_basis;
      } else {
        taxSummary.long_cost_basis += g.total_cost_basis;
      }
    }
  }

  // QA-2: realized gains per tax year (the current Eastern year and the
  // prior one) from the tax report engine, the figures the Tax Lots card
  // shows: taxable accounts only, USD rows only, wash-sale losses disallowed.
  // One report for every account; otherwise one per account in scope,
  // summed (the accounts are disjoint).
  const currentYear = Number(today.slice(0, 4));
  const realizedYears = noTaxableAccount
    ? []
    : [currentYear, currentYear - 1].map((year) => {
        const reports: TaxReportResult[] =
          accountIds === undefined
            ? [generateTaxReport(db, year)]
            : taxableAccountsInScope.map((a) => generateTaxReport(db, year, { accountName: a.name }));
        const relevant = reports.filter(
          (r) => r.shortTermRows.length + r.longTermRows.length > 0 || r.excludedEngineCloses > 0,
        );
        return {
          year,
          shortTerm: reports.reduce((sum, r) => sum + r.shortTermTotal.gainLoss, 0),
          longTerm: reports.reduce((sum, r) => sum + r.longTermTotal.gainLoss, 0),
          excludedNonUsdSales: reports.reduce((sum, r) => sum + r.excludedNonUsdSales, 0),
          rowCount: reports.reduce((sum, r) => sum + r.shortTermRows.length + r.longTermRows.length, 0),
          // Fail-closed, like the report itself: ready only when every report
          // with activity is ready, and never on an empty year.
          filingReady: relevant.length > 0 && relevant.every((r) => r.filingReady),
          washSaleWarnings: reports.flatMap((r) => r.washSaleWarnings),
        };
      });

  const pendingRows = reducePendingDisclosure(pendingInputs);
  if (
    taxSummary.open_lots > 0 ||
    pendingRows.length > 0 ||
    noTaxableAccount ||
    realizedYears.some((y) => y.rowCount > 0 || y.excludedNonUsdSales > 0)
  ) {
    lines.push("\n### Tax Summary");
    const shortPart =
      taxSummary.short_lots > 0 ? `; short-sale proceeds: ${formatUSD(taxSummary.short_proceeds)}` : "";
    lines.push(
      `- Open lots: ${taxSummary.open_lots} (long cost basis: ${formatUSD(taxSummary.long_cost_basis)}${shortPart})`
    );
    for (const row of pendingRows) lines.push(pendingDisclosureLine(row));
    if (noTaxableAccount) {
      lines.push(`- Realized gains: ${taxAdvantagedSentence}`);
    }
    for (const y of realizedYears) {
      // Realized G/L is stored native per security, so only USD rows sum into
      // the dollar figures — same rule and disclosure as the Tax Lots card.
      const nonUsdNote =
        y.excludedNonUsdSales > 0
          ? ` — USD totals exclude ${y.excludedNonUsdSales} non-USD sale${y.excludedNonUsdSales !== 1 ? "s" : ""} (native-currency figures)`
          : "";
      const filing = y.filingReady ? "" : " (not for filing)";
      lines.push(
        `- Realized gains ${y.year} (taxable accounts): short-term ${formatUSD(y.shortTerm)}, long-term ${formatUSD(y.longTerm)}${filing}${nonUsdNote}`
      );
      const washCount = y.washSaleWarnings.length;
      if (washCount === 0) continue;
      // Same detail in every scope (owner ruling 2026-11-12, replacing P8's
      // count-only line for a scoped chat). The scan reads replacement
      // purchases in every account, so a scoped line names the account of a
      // replacement bought outside the scope.
      lines.push(
        `- Wash sales ${y.year}: ${washCount} possible wash sale${washCount === 1 ? "" : "s"} (heuristic 30-day same-security scan; verify before filing):`
      );
      for (const w of y.washSaleWarnings) {
        const outside =
          scopeAccountNames === null
            ? []
            : washSaleReplacementAccounts(db, w.symbol, w.purchaseDate).filter((n) => !scopeAccountNames.has(n));
        const outsideNote = outside.length > 0 ? `; bought in ${outside.join(", ")}, outside this chat's scope` : "";
        lines.push(
          `  - ${w.symbol} sold ${w.saleDate} at a ${formatUSD(Math.abs(w.lossAmount))} loss; ${washSaleReplacementPhrase(w)}${outsideNote}`
        );
      }
    }
    if (conventionPending) {
      lines.push(CONVENTION_PENDING_NOTE);
    }
  }

  // Tax-loss harvesting candidates (positions with unrealized losses).
  // The figure is signed by side, the same way the Tax Lots reads sign it
  // (lib/queries/tax-lots.ts): a short lot gains when the price FALLS, so its
  // unrealized figure is the opening value minus the current value.
  // quantity_remaining is positive for a short lot (is_short is the flag).
  // The opening value is the page's fee-inclusive remaining lot basis (the
  // shared fragment), never quantity x acquisition_price, so this list, the
  // chat tax-lot tool and the Tax Lots page give one figure per lot. The
  // -100 threshold applies to that figure.
  const LOT_SIDE_SIGN = lotSideSignSql("tl");
  const REMAINING_BASIS = remainingLotBasisSql();
  const harvestCandidates = (db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        tl.account_id, tl.security_id, tl.is_short,
        s.symbol,
        a.name AS account_name,
        ${LOT_SIDE_SIGN} * (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
         - ${REMAINING_BASIS}) AS unrealized_loss,
        ${REMAINING_BASIS} AS cost_basis,
        CAST(julianday(?) - julianday(tl.acquisition_date) AS INTEGER) AS days_held
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE tl.quantity_remaining > 0
        AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
        AND ${liveOptionExpirationSql("s", today)}
        AND lp.close_price IS NOT NULL
        AND ${LOT_SIDE_SIGN} * (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
             - ${REMAINING_BASIS}) < -100
        ${taxableTlScope.sql}
      ORDER BY unrealized_loss ASC`
    )
    .all(today, ...taxableTlScope.params) as Array<HarvestCandidate & PairKeyed>)
    // A pending-statement lot is not held — nothing to harvest. LIMIT after
    // the exclusion so a pending lot never crowds out a real candidate.
    .filter((c) => !isPendingStatementLot(pendingIndex, c))
    .slice(0, 5);

  if (noTaxableAccount) {
    lines.push("\n### Tax-Loss Harvesting Candidates (taxable accounts only)");
    lines.push(taxAdvantagedSentence);
  } else if (harvestCandidates.length > 0) {
    lines.push("\n### Tax-Loss Harvesting Candidates (from CURRENT open tax lots in taxable accounts only)");
    for (const c of harvestCandidates) {
      // A short is labelled so the chat model never suggests "selling" it:
      // a short loss is realized by buying to cover.
      lines.push(
        c.is_short
          ? `- ${c.symbol} short (${c.account_name}): ${formatUSD(c.unrealized_loss)} unrealized loss, open ${c.days_held} days (short position: closing it means buying to cover)`
          : `- ${c.symbol} (${c.account_name}): ${formatUSD(c.unrealized_loss)} unrealized loss, held ${c.days_held} days`
      );
    }
  }

  // Lots approaching long-term threshold (within 60 days). The long-term
  // date is the engine's calendar-anniversary rule (shared SQL, pinned to
  // isLongTermHolding), never a fixed day count.
  // Long lots only: the engine books every short close as short-term however
  // long the short was open (section 1233 general rule, computeTaxLots), so a
  // short lot never approaches long-term.
  const LONG_TERM_DATE = longTermDateSql("tl.acquisition_date");
  const approachingLT = (db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        tl.account_id, tl.security_id, tl.is_short,
        s.symbol,
        a.name AS account_name,
        tl.acquisition_date,
        ${LONG_TERM_DATE} AS long_term_date,
        CAST(julianday(${LONG_TERM_DATE}) - julianday(?) AS INTEGER) AS days_remaining,
        CASE WHEN lp.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
               - ${REMAINING_BASIS}
          ELSE NULL END AS unrealized_gain
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE tl.quantity_remaining > 0
        AND tl.is_short = 0
        AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
        AND ${liveOptionExpirationSql("s", today)}
        AND julianday(${LONG_TERM_DATE}) > julianday(?)
        AND julianday(${LONG_TERM_DATE}) - julianday(?) <= 60
        ${taxableTlScope.sql}
      ORDER BY days_remaining ASC`
    )
    .all(today, today, today, ...taxableTlScope.params) as Array<ApproachingLongTerm & PairKeyed>)
    .filter((lot) => !isPendingStatementLot(pendingIndex, lot))
    .slice(0, 10);

  if (noTaxableAccount) {
    lines.push("\n### Lots Approaching Long-Term Status (taxable accounts only)");
    lines.push(taxAdvantagedSentence);
  } else if (approachingLT.length > 0) {
    lines.push("\n### Lots Approaching Long-Term Status (within 60 days, taxable accounts only)");
    for (const lot of approachingLT) {
      const gain = lot.unrealized_gain != null
        ? ` (unrealized: ${lot.unrealized_gain >= 0 ? "+" : ""}${formatUSD(lot.unrealized_gain)})`
        : "";
      lines.push(
        `- ${lot.symbol} (${lot.account_name}): ${lot.days_remaining} days until long-term (${lot.long_term_date})${gain}`
      );
    }
  }

  // ─── Income Summary (trailing 12 months from snapshots) ────────
  const snapshotScope = accountScopeAndSql(accountIds, "monthly_snapshots.account_id");
  const incomeSummary = db
    .prepare(
      `SELECT
        COALESCE(SUM(dividends), 0) AS total_dividends,
        COALESCE(SUM(interest), 0) AS total_interest,
        COALESCE(SUM(COALESCE(fees, 0) + COALESCE(commissions, 0)), 0) AS total_fees
      FROM monthly_snapshots
      WHERE month_end_date >= date(?, '-12 months')
      ${snapshotScope.sql}`
    )
    .get(today, ...snapshotScope.params) as { total_dividends: number; total_interest: number; total_fees: number };

  if (incomeSummary.total_dividends > 0 || incomeSummary.total_interest > 0) {
    lines.push("\n### Income (Trailing 12 Months)");
    lines.push(`- Dividends: ${formatUSD(incomeSummary.total_dividends)}`);
    lines.push(`- Interest: ${formatUSD(incomeSummary.total_interest)}`);
    if (incomeSummary.total_fees > 0) {
      lines.push(`- Fees/Commissions: ${formatUSD(incomeSummary.total_fees)}`);
    }
    const netIncome = incomeSummary.total_dividends + incomeSummary.total_interest - incomeSummary.total_fees;
    lines.push(`- Net Income: ${formatUSD(netIncome)}`);
  }

  // ─── Recent Transactions ───────────────────────────────────────
  // Engine-made closes are not user activity (the transactions list and the
  // chat transactions tool leave them out the same way), so none prints here
  // or uses up one of the 20 slots.
  const recentTxns = db
    .prepare(
      `SELECT a.name AS account_name, t.trade_date, t.type,
              s.symbol, s.security_type, t.quantity, t.amount,
              ${transactionAmountCurrencySql()} AS amount_currency,
              ${transactionAmountUsdSql()} AS amount_usd
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN securities s ON s.id = t.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE t.type != 'RECONCILE_CLOSE' ${txnScope.sql}
       ORDER BY t.trade_date DESC
       LIMIT 20`
    )
    .all(...txnScope.params) as RecentTransaction[];

  if (recentTxns.length > 0) {
    lines.push("\n### Recent Transactions (historical activity — NOT current positions)");
    lines.push("These transactions show what has happened. A security listed here may have been bought AND subsequently sold.");
    for (const t of recentTxns) {
      const sym = t.symbol ?? "CASH";
      const amt = t.amount !== null ? ` ${recentTransactionAmountText(t)}` : "";
      // QA-11: contracts for an option, face value for a bond, never "shares" for all.
      const qty = t.quantity !== null ? ` ${t.quantity} ${quantityUnitLabel(t.security_type, t.quantity)}` : "";
      lines.push(`- ${t.trade_date} | ${t.account_name} | ${t.type} ${sym}${qty}${amt}`);
    }
  }

  // ─── Data Quality Notes ────────────────────────────────────────
  const warnings: string[] = [];

  const holdingsWithoutPrices = holdings.filter((h) => h.latest_price == null);
  if (holdingsWithoutPrices.length > 0) {
    const syms = holdingsWithoutPrices.map((h) => h.symbol).join(", ");
    warnings.push(
      `${holdingsWithoutPrices.length} holding(s) have no price data: ${syms}`
    );
  }

  // B4b: each freshness date is the scope's own. With every account in
  // scope the price date stays the newest price on file; in a scoped
  // summary it is the newest price among the securities the scope holds.
  const latestPriceDate = (
    accountIds === undefined
      ? db.prepare("SELECT MAX(date) AS max_date FROM prices").get()
      : db
          .prepare(
            `SELECT MAX(p.date) AS max_date FROM prices p
             WHERE p.security_id IN (
               SELECT h.security_id FROM holdings h
               WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter: "" })}
               ${holdingsFilter}
             )`
          )
          .get(...holdingsParams)
  ) as { max_date: string | null } | undefined;
  if (latestPriceDate?.max_date) {
    lines.push(`\n### Data Freshness`);
    lines.push(`- Latest price date: ${latestPriceDate.max_date}`);
    // Whole calendar days from the price date to the ET day (both parsed as
    // UTC midnights, so this is pure date arithmetic).
    const priceAge = Math.round(
      (Date.parse(today + "T00:00:00Z") - Date.parse(latestPriceDate.max_date + "T00:00:00Z")) /
        (1000 * 60 * 60 * 24)
    );
    if (priceAge > 7) {
      warnings.push(`Price data is ${priceAge} days old (latest: ${latestPriceDate.max_date})`);
    }
  }

  const snapshotDateScope = accountScopeAndSql(accountIds, "account_id");
  const latestSnapshotDate = db
    .prepare(`SELECT MAX(month_end_date) AS max_date FROM monthly_snapshots WHERE 1=1 ${snapshotDateScope.sql}`)
    .get(...snapshotDateScope.params) as { max_date: string | null };
  if (latestSnapshotDate?.max_date) {
    lines.push(`- Latest snapshot: ${latestSnapshotDate.max_date}`);
  }

  const latestHoldingsDate = db
    .prepare(`SELECT MAX(as_of_date) AS max_date FROM holdings WHERE 1=1 ${snapshotDateScope.sql}`)
    .get(...snapshotDateScope.params) as { max_date: string | null };
  if (latestHoldingsDate?.max_date) {
    lines.push(`- Latest holdings: ${latestHoldingsDate.max_date}`);
  }

  if (warnings.length > 0) {
    lines.push("\n### Data Quality Notes");
    for (const w of warnings) {
      lines.push(`- ⚠ ${w}`);
    }
  }

  return lines.join("\n");
}
