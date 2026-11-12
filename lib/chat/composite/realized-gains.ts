/**
 * query_realized_gains: one tax year's realized gains from
 * `generateTaxReport(db, year, { accountName })`, called exactly as
 * `app/api/tax-report/route.ts` (the Tax Lots page's Tax Report card) calls
 * it. The engine takes one account name or none, so a scope of several
 * accounts is refused with the names to choose from (never summed here and
 * never collapsed to the first account).
 *
 * Wash sales (plan P8): the engine's replacement-purchase scan reads every
 * account, so a report scoped to one account can carry facts about another
 * account. A scoped answer therefore returns the wash-sale COUNT only, and
 * shows adjustments only inside each total's gain; the All Accounts answer
 * shows the detail.
 */
import type Database from "better-sqlite3";
import { generateTaxReport, type Form8949Row } from "@/lib/compute/tax-report";
import { isTaxConventionPending } from "@/lib/compute/tax-convention";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  accountNamesFor,
  oneAccountOnlyError,
  readCount,
  scopeBlock,
  takeList,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_REALIZED_GAINS_NAME = "query_realized_gains";

const ROWS_DEFAULT = 15;
const ROWS_MAX = 25;
const WASH_SALES_SHOWN = 10;

/**
 * Said when no account carries a tax-advantaged treatment yet: the report
 * then cannot leave an IRA's sales out. The Tax Report card has its own
 * sentence (NO_RETIREMENT_STAMP_COPY), but it lives in a "use client" file
 * that lib must not import, so this is the chat's own neutral wording.
 */
export const NO_RETIREMENT_MARK_NOTE =
  "No account is marked as a retirement account yet, so the sales of an IRA, if any, are still inside these totals.";

const definition: CompositeTool["definition"] = {
  name: QUERY_REALIZED_GAINS_NAME,
  description:
    `Realized gains for one tax year, as the Tax Lots page's Tax Report card computes them: short-term and long-term totals (proceeds, cost basis, gain), row counts, possible wash sales, which retirement accounts were left out (sales in a tax-advantaged account are not taxable), how many non-USD sales were left out of the USD totals, and whether the figures are filing-ready. Unless filing_ready is true the figures are NOT FOR FILING. rows lists the sales themselves (symbol, name, account, quantity, dates, proceeds, cost basis, gain, term), largest absolute gain first, so an answer can name what made up the total. Reads one account or every account: a scope word naming several accounts returns an error listing them. With one account named, wash sales are given as a count only (the replacement purchase may sit in another account); omit account_name in the All Accounts scope for the detail. Use for 'realized gains this year', 'short vs long term', 'wash sales'. Do NOT use for unrealized gains, open lots or harvest candidates (use query_tax_lots), or for lifetime totals.`,
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: ACCOUNT_NAME_FIELD,
      year: {
        type: "integer",
        description: "Tax year, e.g. 2026. Default: the current year (Eastern time). 2000 to 2100.",
      },
      include_rows: {
        type: "boolean",
        description: `Optional. The sale rows come back by default (largest absolute gain first); false leaves them out.`,
      },
      limit: {
        type: "integer",
        description: `Sale rows to return: an integer, default ${ROWS_DEFAULT}, max ${ROWS_MAX}. list_info says whether more rows exist; the totals always cover every sale.`,
      },
    },
  },
};

/** MM/DD/YYYY (the engine's Form 8949 form) as YYYY-MM-DD. */
function isoFrom8949(d: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
}

/**
 * One sale row from the engine's own Form 8949 rows (`generateTaxReport`):
 * `quantity` is the engine's description ("10 sh AAA", "2 contracts ..."),
 * `name` the security's stored name. A wash-sale flag and adjustment only on
 * an all-accounts answer (P8). A non-USD row names its currency and says it
 * is not in the USD totals, as the totals treat it.
 */
function shapeRow(r: Form8949Row, allAccounts: boolean, names: Map<string, string | null>) {
  return {
    symbol: r.symbol,
    name: names.get(r.symbol) ?? null,
    account: r.accountName,
    quantity: r.description,
    acquired: isoFrom8949(r.dateAcquired),
    sold: isoFrom8949(r.dateSold),
    term: r.isLongTerm ? "long" : "short",
    proceeds: r.proceeds,
    cost_basis: r.costBasis,
    gain_loss: r.gainOrLoss,
    ...(r.currency !== "USD" ? { currency: r.currency, in_usd_totals: false } : {}),
    ...(allAccounts && r.isWashSale
      ? { wash_sale: true, adjustment_code: r.adjustmentCode, adjustment_amount: r.adjustmentAmount }
      : {}),
  };
}

/** Stored names of these symbols (securities.symbol is unique). */
function securityNames(db: Database.Database, symbols: string[]): Map<string, string | null> {
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT symbol, name FROM securities WHERE symbol IN (${unique.map(() => "?").join(",")})`)
    .all(...unique) as { symbol: string; name: string | null }[];
  return new Map(rows.map((r) => [r.symbol, r.name]));
}

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  if (accountIds !== undefined && accountIds.length > 1) {
    return oneAccountOnlyError(db, accountIds, "The tax report");
  }
  const accountName =
    accountIds === undefined ? null : (ctx.accountName ?? accountNamesFor(db, accountIds)[0] ?? null);
  if (accountIds !== undefined && accountName === null) return NO_ACCOUNT_IN_SCOPE;

  const defaultYear = Number(ctx.today.slice(0, 4));
  const rawYear = input.year;
  const year =
    rawYear === undefined || rawYear === null
      ? defaultYear
      : typeof rawYear === "number" && Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100
        ? rawYear
        : null;
  if (year === null) return { error: "year must be an integer from 2000 to 2100." };

  const report = generateTaxReport(db, year, { accountName });
  const scoped = accountName !== null;

  const total = (t: typeof report.shortTermTotal, rows: number) => ({
    proceeds: t.proceeds,
    cost_basis: t.costBasis,
    ...(scoped ? {} : { adjustments: t.adjustments }),
    gain_loss: t.gainLoss,
    rows,
  });

  const washCount = report.washSaleWarnings.length;
  const washSales = scoped
    ? {
        count: washCount,
        note:
          washCount > 0
            ? `${washCount} possible wash sale${washCount === 1 ? "" : "s"}; the replacement purchases may sit in other accounts; see the All Accounts scope.`
            : "No possible wash sale found for this account's loss sales.",
      }
    : {
        count: washCount,
        shown: report.washSaleWarnings.slice(0, WASH_SALES_SHOWN).map((w) => ({
          symbol: w.symbol,
          sale_date: w.saleDate,
          replacement_date: w.purchaseDate,
          replacement: w.direction,
          days_from_sale: w.daysFromSale,
          loss: w.lossAmount,
        })),
        ...(washCount > WASH_SALES_SHOWN ? { note: `First ${WASH_SALES_SHOWN} of ${washCount}.` } : {}),
      };

  let rows: { rows: ReturnType<typeof shapeRow>[]; info: ReturnType<typeof takeList>["info"] } | undefined;
  if (input.include_rows !== false) {
    const limit = readCount(input.limit, ROWS_DEFAULT, ROWS_MAX);
    const engineRows = [...report.shortTermRows, ...report.longTermRows];
    const names = securityNames(db, engineRows.map((r) => r.symbol));
    // Largest absolute gain first; ties keep the engine's order (stable sort).
    const ordered = [...engineRows].sort((a, b) => Math.abs(b.gainOrLoss) - Math.abs(a.gainOrLoss));
    rows = takeList(ordered.map((r) => shapeRow(r, !scoped, names)), limit, ROWS_MAX);
  }

  return {
    as_of: ctx.today,
    year,
    scope: scopeBlock(db, accountIds),
    filing_ready: report.filingReady,
    ...(report.filingReady ? {} : { not_for_filing: true }),
    tax_lot_recompute_pending: isTaxConventionPending(db),
    retirement_account: report.retirementAccount,
    retirement_accounts_marked: report.hasTaxAdvantagedAccounts,
    ...(report.hasTaxAdvantagedAccounts ? {} : { retirement_note: NO_RETIREMENT_MARK_NOTE }),
    short_term: total(report.shortTermTotal, report.shortTermRows.length),
    long_term: total(report.longTermTotal, report.longTermRows.length),
    wash_sales: washSales,
    wash_sale_advisory: report.washSaleAdvisory,
    excluded: {
      retirement_accounts: report.excludedRetirementAccounts,
      non_usd_sales: report.excludedNonUsdSales,
      engine_made_closes: report.excludedEngineCloses,
    },
    ...(rows ? { rows: rows.rows, list_info: rows.info } : {}),
    units: {
      totals: "USD; USD-denominated sales only (non-USD sales are counted in excluded.non_usd_sales, never converted)",
      rows: "largest absolute gain first; USD unless the row names another currency (then that currency, never converted, and not in the totals); dates YYYY-MM-DD; quantity as the tax report writes it",
      gain_loss: scoped
        ? "proceeds - cost basis, with any wash-sale adjustment already inside it"
        : "proceeds - cost basis + adjustments",
      rows_count: "number of sale rows behind each total, non-USD rows included",
    },
    currency: "USD",
  };
}

export const queryRealizedGainsTool: CompositeTool = { definition, run, acceptsScopeList: false };
