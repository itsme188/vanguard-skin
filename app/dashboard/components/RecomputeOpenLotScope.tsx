import type { TaxLotRecomputeOpenLotBreakdown } from "@/lib/compute/tax-lot-recompute-summary";
import { Count } from "@/lib/privacy/components";

/**
 * Says what the Recompute preview's open-lot count includes.
 *
 * The preview counts every open lot in every account. The Open Lots table
 * below it shows fewer rows: it follows the account and security filters, and
 * the page lists expired option lots and currency-conversion lots in their own
 * places. Without this line the two counts disagree with no reason given.
 *
 * Display only. `breakdown` may be missing on a response from an older server
 * build; the scope sentence still renders and the two "includes" lines are
 * left out rather than shown as zero.
 */
export function RecomputeOpenLotScope({
  breakdown,
}: {
  breakdown?: TaxLotRecomputeOpenLotBreakdown | null;
}) {
  const expired = breakdown?.expiredOptionLots ?? { before: 0, after: 0 };
  const currency = breakdown?.currencyConversionLots ?? { before: 0, after: 0 };
  const showExpired = expired.before > 0 || expired.after > 0;
  const showCurrency = currency.before > 0 || currency.after > 0;
  return (
    <div className="text-ink-faint">
      <div>Counts every open lot in every account, whatever filter the page shows.</div>
      {showExpired && (
        <div>
          Includes expired option lots awaiting a closing entry: <Count value={expired.before} /> →{" "}
          <Count value={expired.after} />
        </div>
      )}
      {showCurrency && (
        <div>
          Includes currency-conversion lots: <Count value={currency.before} /> →{" "}
          <Count value={currency.after} />
        </div>
      )}
      {(showExpired || showCurrency) && (
        <div>The Open Lots table lists those apart, so it shows fewer rows.</div>
      )}
    </div>
  );
}
