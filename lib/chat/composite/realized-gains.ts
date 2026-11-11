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

const ROWS_DEFAULT = 20;
const ROWS_MAX = 25;
const WASH_SALES_SHOWN = 10;

const definition: CompositeTool["definition"] = {
  name: QUERY_REALIZED_GAINS_NAME,
  description:
    `Realized gains for one tax year, as the Tax Lots page's Tax Report card computes them: short-term and long-term totals (proceeds, cost basis, gain), row counts, possible wash sales, which retirement accounts were left out (sales in a tax-advantaged account are not taxable), how many non-USD sales were left out of the USD totals, and whether the figures are filing-ready. Unless filing_ready is true the figures are NOT FOR FILING. Reads one account or every account: a scope word naming several accounts returns an error listing them. With one account named, wash sales are given as a count only (the replacement purchase may sit in another account); omit account_name in the All Accounts scope for the detail. Use for 'realized gains this year', 'short vs long term', 'wash sales'. Do NOT use for unrealized gains, open lots or harvest candidates (use query_tax_lots), or for lifetime totals.`,
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
        description: `Optional. true adds the Form 8949-style sale rows (short-term first, then long-term). Default false.`,
      },
      limit: {
        type: "integer",
        description: `Rows to return when include_rows is true: an integer, default ${ROWS_DEFAULT}, max ${ROWS_MAX}. list_info says whether more rows exist.`,
      },
    },
  },
};

/**
 * One sale row, compact: `description` already names quantity, unit and
 * symbol; the account is named only on an all-accounts answer; a row's
 * currency is stated only when it is not USD; a wash-sale adjustment only
 * on an all-accounts answer and only where the row carries one.
 */
function shapeRow(r: Form8949Row, allAccounts: boolean) {
  return {
    description: r.description,
    ...(allAccounts ? { account: r.accountName } : {}),
    acquired: r.dateAcquired,
    sold: r.dateSold,
    term: r.isLongTerm ? "long" : "short",
    proceeds: r.proceeds,
    cost_basis: r.costBasis,
    gain_loss: r.gainOrLoss,
    ...(r.currency !== "USD" ? { currency: r.currency } : {}),
    ...(allAccounts && r.adjustmentCode ? { adjustment_code: r.adjustmentCode, adjustment_amount: r.adjustmentAmount } : {}),
  };
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
  if (input.include_rows === true) {
    const limit = readCount(input.limit, ROWS_DEFAULT, ROWS_MAX);
    const all = [...report.shortTermRows, ...report.longTermRows].map((r) => shapeRow(r, !scoped));
    rows = takeList(all, limit, ROWS_MAX);
  }

  return {
    as_of: ctx.today,
    year,
    scope: scopeBlock(db, accountIds),
    filing_ready: report.filingReady,
    ...(report.filingReady ? {} : { not_for_filing: true }),
    tax_lot_recompute_pending: isTaxConventionPending(db),
    retirement_account: report.retirementAccount,
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
      rows: "USD unless the row names another currency (then that currency, never converted); dates MM/DD/YYYY as on Form 8949",
      gain_loss: scoped
        ? "proceeds - cost basis, with any wash-sale adjustment already inside it"
        : "proceeds - cost basis + adjustments",
      rows_count: "number of sale rows behind each total, non-USD rows included",
    },
    currency: "USD",
  };
}

export const queryRealizedGainsTool: CompositeTool = { definition, run, acceptsScopeList: false };
