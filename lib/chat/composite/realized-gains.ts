/**
 * query_realized_gains: one tax year's realized gains from
 * `generateTaxReport(db, year, { accountName })`, called exactly as
 * `app/api/tax-report/route.ts` (the Tax Lots page's Tax Report card) calls
 * it. The engine takes one account name or none, so a scope of several
 * accounts is refused with the names to choose from (never summed here and
 * never collapsed to the first account).
 *
 * Wash sales: the engine's replacement-purchase scan reads every account
 * (IRS rule, Rev. Rul. 2008-5). Every answer, one account or all, carries the
 * detail: each total's adjustments, each wash row's code and adjustment, and
 * the replacement purchase's date and account(s). When the answer covers one
 * account, a replacement bought in any other account is named in
 * `replacement_outside_this_answer` (owner ruling 2026-11-12, replacing plan
 * P8's count-only rule; the chat is read by the owner only).
 *
 * A scoped answer also lists, in `washed_by_purchases_in_this_scope`, loss
 * sales in OTHER accounts that a purchase in the scope's accounts washed (a
 * Roth purchase washing a taxable loss disallows that loss for good). They
 * come from the all-accounts report and are never added into this answer's
 * totals or rows.
 *
 * The replacement's account comes from `washSaleReplacementAccounts`
 * (lib/queries/wash-sale-replacements.ts), the one reader shared with the
 * chat Portfolio Context; no figure is recomputed. Every row and total keeps the
 * engine's identity gain = proceeds - cost basis + adjustment.
 */
import type Database from "better-sqlite3";
import { generateTaxReport, type Form8949Row, type WashSaleWarning } from "@/lib/compute/tax-report";
import { isTaxConventionPending } from "@/lib/compute/tax-convention";
import { washSaleReplacementAccounts } from "@/lib/queries/wash-sale-replacements";
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
    `Realized gains for one tax year, as the Tax Lots page's Tax Report card computes them: short-term and long-term totals (proceeds, cost basis, gain), row counts, possible wash sales, which retirement accounts were left out (sales in a tax-advantaged account are not taxable), how many non-USD sales were left out of the USD totals, and whether the figures are filing-ready. Unless filing_ready is true the figures are NOT FOR FILING. rows lists the sales themselves (symbol, name, account, quantity, dates, proceeds, cost basis, gain, term), largest absolute gain first, so an answer can name what made up the total. Reads one account or every account: a scope word naming several accounts returns an error listing them. Wash sales come with their detail in every scope: each total's adjustments, and on each wash-sale row and in wash_sales.shown the adjustment, the replacement purchase's date and the account(s) it was bought in (replacement_accounts); replacement_outside_this_answer names any such account this answer does not cover (for example outside this chat's scope). With one account named, washed_by_purchases_in_this_scope lists loss sales in OTHER accounts that a purchase in this account washed (for example a Roth purchase washing a taxable loss); they are never in this answer's totals. gain = proceeds - cost basis + adjustment. Use for 'realized gains this year', 'short vs long term', 'wash sales'. Do NOT use for unrealized gains, open lots or harvest candidates (use query_tax_lots), or for lifetime totals.`,
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

/** Where an engine-named replacement purchase was bought. */
interface Replacement {
  date: string;
  accounts: string[];
  outsideAnswer: string[];
}

/** Key that ties an engine row to its wash-sale warning. */
function washKey(symbol: string, saleDate: string, account: string, loss: number): string {
  return `${symbol}|${saleDate}|${account}|${Math.abs(loss).toFixed(6)}`;
}

/**
 * For each warning: the sale's own account and where the replacement was
 * bought. Read-only lookups over the lots `detectWashSales` scanned.
 */
function replacementsFor(
  db: Database.Database,
  warnings: WashSaleWarning[],
  scopeAccountNames: Set<string> | null,
): { saleAccount: string; replacement: Replacement }[] {
  const saleAccount = db.prepare(
    `SELECT a.name FROM tax_lot_sales tls
       JOIN tax_lots tl ON tl.id = tls.tax_lot_id
       JOIN accounts a ON a.id = tl.account_id
      WHERE tls.id = ?`,
  );
  return warnings.map((w) => {
    const accounts = washSaleReplacementAccounts(db, w.symbol, w.purchaseDate);
    return {
      saleAccount: (saleAccount.get(w.saleId) as { name: string } | undefined)?.name ?? "",
      replacement: {
        date: w.purchaseDate,
        accounts,
        outsideAnswer: scopeAccountNames ? accounts.filter((a) => !scopeAccountNames.has(a)) : [],
      },
    };
  });
}

function replacementFields(r: Replacement | undefined) {
  if (!r) return {};
  return {
    replacement_date: r.date,
    replacement_accounts: r.accounts,
    ...(r.outsideAnswer.length > 0 ? { replacement_outside_this_answer: r.outsideAnswer } : {}),
  };
}

/**
 * One sale row from the engine's own Form 8949 rows (`generateTaxReport`):
 * `quantity` is the engine's description ("10 sh AAA", "2 contracts ..."),
 * `name` the security's stored name. A wash row carries its code, its
 * adjustment and where the replacement was bought, in every scope. A non-USD
 * row names its currency and says it is not in the USD totals, as the totals
 * treat it.
 */
function shapeRow(r: Form8949Row, names: Map<string, string | null>, replacement: Replacement | undefined) {
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
    ...(r.isWashSale
      ? {
          wash_sale: true,
          adjustment_code: r.adjustmentCode,
          adjustment_amount: r.adjustmentAmount,
          ...replacementFields(replacement),
        }
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
  const scopeNames = accountIds === undefined ? null : new Set(accountNamesFor(db, accountIds));

  const total = (t: typeof report.shortTermTotal, rows: number) => ({
    proceeds: t.proceeds,
    cost_basis: t.costBasis,
    adjustments: t.adjustments,
    gain_loss: t.gainLoss,
    rows,
  });

  const washCount = report.washSaleWarnings.length;
  const located = replacementsFor(db, report.washSaleWarnings, scopeNames);
  const washSales = {
    count: washCount,
    shown: report.washSaleWarnings.slice(0, WASH_SALES_SHOWN).map((w, i) => ({
      symbol: w.symbol,
      account: located[i].saleAccount,
      sale_date: w.saleDate,
      replacement_date: w.purchaseDate,
      replacement: w.direction,
      days_from_sale: w.daysFromSale,
      loss: w.lossAmount,
      replacement_accounts: located[i].replacement.accounts,
      ...(located[i].replacement.outsideAnswer.length > 0
        ? { replacement_outside_this_answer: located[i].replacement.outsideAnswer }
        : {}),
    })),
    ...(washCount > WASH_SALES_SHOWN ? { note: `First ${WASH_SALES_SHOWN} of ${washCount}.` } : {}),
  };

  // Loss sales elsewhere washed by a purchase in this scope: read from the
  // whole report, listed apart, never summed into the totals above.
  let washedHere: Record<string, unknown> | undefined;
  if (scopeNames !== null) {
    const whole = generateTaxReport(db, year, { accountName: null });
    const wholeLocated = replacementsFor(db, whole.washSaleWarnings, scopeNames);
    const inbound = whole.washSaleWarnings
      .map((w, i) => ({ w, at: wholeLocated[i] }))
      .filter(
        ({ at }) =>
          !scopeNames.has(at.saleAccount) && at.replacement.accounts.some((a) => scopeNames.has(a)),
      );
    if (inbound.length > 0) {
      washedHere = {
        count: inbound.length,
        note:
          "Loss sales in other accounts that a purchase in this chat's accounts washed. They are not in this answer's totals or rows." +
          (inbound.length > WASH_SALES_SHOWN ? ` First ${WASH_SALES_SHOWN} of ${inbound.length}.` : ""),
        shown: inbound.slice(0, WASH_SALES_SHOWN).map(({ w, at }) => ({
          symbol: w.symbol,
          sale_account: at.saleAccount,
          sale_date: w.saleDate,
          loss: w.lossAmount,
          replacement_date: w.purchaseDate,
          replacement_accounts: at.replacement.accounts,
        })),
      };
    }
  }

  let rows: { rows: ReturnType<typeof shapeRow>[]; info: ReturnType<typeof takeList>["info"] } | undefined;
  if (input.include_rows !== false) {
    const limit = readCount(input.limit, ROWS_DEFAULT, ROWS_MAX);
    const engineRows = [...report.shortTermRows, ...report.longTermRows];
    const names = securityNames(db, engineRows.map((r) => r.symbol));
    // Warnings by (symbol, sale date, account, loss), in the engine's order;
    // each wash row takes the next one with its key.
    const queues = new Map<string, Replacement[]>();
    report.washSaleWarnings.forEach((w, i) => {
      const key = washKey(w.symbol, w.saleDate, located[i].saleAccount, w.lossAmount);
      queues.set(key, [...(queues.get(key) ?? []), located[i].replacement]);
    });
    const shaped = engineRows.map((r) => {
      const replacement = r.isWashSale
        ? queues.get(washKey(r.symbol, isoFrom8949(r.dateSold), r.accountName, r.adjustmentAmount))?.shift()
        : undefined;
      return { gain: r.gainOrLoss, row: shapeRow(r, names, replacement) };
    });
    // Largest absolute gain first; ties keep the engine's order (stable sort).
    const ordered = [...shaped].sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).map((x) => x.row);
    rows = takeList(ordered, limit, ROWS_MAX);
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
    ...(washedHere ? { washed_by_purchases_in_this_scope: washedHere } : {}),
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
      gain_loss: "proceeds - cost basis + adjustment (a wash-sale adjustment adds back the disallowed loss)",
      replacement_accounts:
        "accounts holding a lot of the same security bought on replacement_date; replacement_outside_this_answer lists those this answer does not cover",
      rows_count: "number of sale rows behind each total, non-USD rows included",
    },
    currency: "USD",
  };
}

export const queryRealizedGainsTool: CompositeTool = { definition, run, acceptsScopeList: false };
