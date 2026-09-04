import type { TaxLotSummary, AccountTaxSummary } from "@/lib/queries/tax-lots";
import { Count, Money } from "@/lib/privacy/components";

/**
 * Same wording family as the row-level "Estimated" chip in TaxLotTables /
 * the security detail hub, so a user who sees the chip on a Closed Sales row
 * recognises the tile disclosure as the same thing counted up.
 */
export const ENGINE_ESTIMATED_TITLE =
  "Engine-generated reconciliation entries (no matching broker sale) — those realized figures are estimated. They are included in this economic total and excluded from the Tax Report card and the 8949 exports below.";

/**
 * "(incl. M engine-estimated closes, +$Y)" — the disclosure half of the
 * "disclose, never exclude" ruling on QA finding
 * tax-lots--headline-tiles-include-reconcile-close-engine-rows. The figure
 * beside it stays whole; this line says how much of it the engine estimated.
 * Renders nothing when the bucket has no engine-estimated close.
 */
function EngineEstimatedNote({
  count,
  gain,
  className,
}: {
  count: number;
  gain: number;
  className?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span className={className} title={ENGINE_ESTIMATED_TITLE}>
      (incl. <Count value={count} /> engine-estimated close
      {count !== 1 ? "s" : ""}, <Money value={gain} signed />)
    </span>
  );
}

function GainCard({
  label,
  value,
  sublabel,
  engineEstimatedCount = 0,
  engineEstimatedGain = 0,
}: {
  label: string;
  value: number;
  sublabel?: string;
  engineEstimatedCount?: number;
  engineEstimatedGain?: number;
}) {
  const isPositive = value >= 0;
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-2">
        {label}
      </div>
      <Money
        value={value}
        signed
        className={`block text-2xl font-semibold font-mono tabular-nums tracking-tight ${
          value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
        }`}
      />
      {sublabel && (
        <div className="text-xs text-ink-faint mt-1">{sublabel}</div>
      )}
      <EngineEstimatedNote
        count={engineEstimatedCount}
        gain={engineEstimatedGain}
        className="block text-xs text-ink-faint mt-1"
      />
    </div>
  );
}

export function TaxLotSummaryCards({
  summary,
  year,
}: {
  summary: TaxLotSummary;
  year: number;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GainCard
          label="Unrealized"
          value={summary.totalUnrealizedGain}
          sublabel={`${summary.totalOpenLots} open lot${summary.totalOpenLots !== 1 ? "s" : ""}`}
        />
        <GainCard
          label={`${year} Realized`}
          value={summary.totalRealizedGain}
          sublabel={`${summary.totalClosedSales} sale${summary.totalClosedSales !== 1 ? "s" : ""}`}
          engineEstimatedCount={summary.engineEstimatedSales}
          engineEstimatedGain={summary.engineEstimatedGain}
        />
        <GainCard
          label={`${year} Long-Term`}
          value={summary.longTermGain}
          sublabel="economic realized · > 365 days"
          engineEstimatedCount={summary.engineEstimatedLongTermSales}
          engineEstimatedGain={summary.engineEstimatedLongTermGain}
        />
        <GainCard
          label={`${year} Short-Term`}
          value={summary.shortTermGain}
          sublabel="economic realized · calendar year"
          engineEstimatedCount={summary.engineEstimatedShortTermSales}
          engineEstimatedGain={summary.engineEstimatedShortTermGain}
        />
      </div>
      {summary.excludedNonUsdSales > 0 && (
        <p className="text-xs text-ink-faint mt-2">
          USD totals exclude {summary.excludedNonUsdSales} non-USD sale
          {summary.excludedNonUsdSales !== 1 ? "s" : ""} — shown in native
          currency in Closed Sales below.
        </p>
      )}
    </div>
  );
}

export function AccountSummaryCards({
  accounts,
  year,
}: {
  accounts: AccountTaxSummary[];
  year: number;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-3">
        {year} Short-Term by Account
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {accounts.map((acct) => {
          const isPositive = acct.shortTermGain >= 0;
          return (
            <div
              key={acct.account_id}
              className="rounded-xl border border-edge bg-panel p-4"
            >
              <div className="text-xs text-ink-faint mb-1.5 truncate">
                {acct.account_name}
              </div>
              <Money
                value={acct.shortTermGain}
                signed
                className={`block text-lg font-semibold font-mono tabular-nums ${
                  acct.shortTermGain === 0
                    ? "text-ink-dim"
                    : isPositive
                      ? "text-up"
                      : "text-down"
                }`}
              />
              {/* The headline above is the account's SHORT-TERM economic
                  figure, so its disclosure is the short-term bucket's. */}
              <EngineEstimatedNote
                count={acct.engineEstimatedShortTermSales}
                gain={acct.engineEstimatedShortTermGain}
                className="block text-[11px] text-ink-faint mt-1"
              />
              <div className="text-[11px] text-ink-faint mt-1">
                {acct.totalClosedSales} sale{acct.totalClosedSales !== 1 ? "s" : ""}
                {/* Also shown when the LT figure nets to zero BUT carries
                    engine-estimated closes — otherwise offsetting engine
                    rows would hide their own disclosure. */}
                {(acct.longTermGain !== 0 || acct.engineEstimatedLongTermSales > 0) && (
                  <>
                    {" "}· LT: <Money value={acct.longTermGain} signed />{" "}
                    <EngineEstimatedNote
                      count={acct.engineEstimatedLongTermSales}
                      gain={acct.engineEstimatedLongTermGain}
                    />
                  </>
                )}
                {acct.excludedNonUsdSales > 0 && (
                  <> · excludes {acct.excludedNonUsdSales} non-USD</>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
