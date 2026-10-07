import type { HoldingWithSecurity } from "@/lib/queries/holdings";
import { displaySecurityName } from "@/lib/format";
import { ScrollFade } from "./ScrollFade";
import { SymbolLink } from "./SymbolLink";
import { Count, Money, Shares, QuantityUnit } from "@/lib/privacy/components";
import type { AccountCashLine } from "@/lib/queries/account-cash-line";

function formatOptionDescription(holding: HoldingWithSecurity): string {
  if (holding.security_type?.toLowerCase() !== "option") return "";
  const underlying = holding.underlying_symbol ?? "";
  const strike = holding.strike_price != null ? `$${holding.strike_price}` : "";
  const type = holding.option_type ?? "";
  const expiry = holding.expiration_date
    ? (() => {
        const [y, m, d] = holding.expiration_date.split("-");
        return `${Number(m)}/${Number(d)}/${y.slice(-2)}`;
      })()
    : "";
  return [underlying, strike, type, expiry].filter(Boolean).join(" ");
}

/**
 * Positions, cash and the account total for one account, all read from the
 * account's latest daily valuation (lib/queries/account-cash-line.ts), so
 * positions plus cash is the account total by construction. Cash is a line
 * here, never a made-up holdings row.
 *
 * The sentences keep the same wording for one position or many, so Hide
 * amounts cannot leak "exactly one" through the grammar.
 */
function AccountValueLines({ cashLine }: { cashLine: AccountCashLine | null }) {
  if (!cashLine) {
    return (
      <p data-account-value="none" className="px-4 py-3 text-xs text-ink-dim">
        No daily valuation exists for this account yet, so there is no market-value total or
        cash balance to show here.
      </p>
    );
  }

  const asOf = <span className="font-mono">as of {cashLine.valuationDate}</span>;
  const sweepSymbols = cashLine.cashEquivalentSymbols;
  const hasUnpriced =
    cashLine.holdingsCount !== null &&
    cashLine.pricedCount !== null &&
    cashLine.pricedCount < cashLine.holdingsCount;

  return (
    <div data-account-value="lines" className="px-4 py-3 space-y-2 text-sm">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ink-dim">
            Positions at market value <span className="text-xs">({asOf})</span>
          </span>
          <span className="font-mono tabular-nums text-ink">
            <Money value={cashLine.holdingsValue} precise />
          </span>
        </div>
        {hasUnpriced && (
          <p data-account-value="unpriced-note" className="mt-0.5 text-xs text-ink-dim">
            Positions with a price that day: <Count value={cashLine.pricedCount} /> of{" "}
            <Count value={cashLine.holdingsCount} />. The rest are not in the Positions figure.
          </p>
        )}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ink-dim">
            Cash <span className="text-xs">({asOf})</span>
          </span>
          <span className="font-mono tabular-nums text-ink">
            <Money value={cashLine.cashBalance} precise />
          </span>
        </div>
        {cashLine.liveSourceCaption && (
          <p data-account-value="live-note" className="mt-0.5 text-xs text-ink-dim">
            {cashLine.liveSourceCaption}
          </p>
        )}
        {sweepSymbols.length > 0 && (
          <p data-account-value="sweep-note" className="mt-0.5 text-xs text-ink-dim">
            Money-market funds listed above (
            <span className="font-mono">{sweepSymbols.join(", ")}</span>) are counted in Cash,
            not in Positions. Do not add them to the Cash figure again.
          </p>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-3 border-t border-edge pt-2">
        <span className="font-medium text-ink">
          Account total <span className="text-xs font-normal text-ink-dim">({asOf})</span>
        </span>
        <span className="font-mono tabular-nums font-medium text-ink">
          <Money value={cashLine.totalValue} precise />
        </span>
      </div>
    </div>
  );
}

export function HoldingsTable({
  holdings,
  cashLine = null,
}: {
  holdings: HoldingWithSecurity[];
  cashLine?: AccountCashLine | null;
}) {
  if (holdings.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
          <p className="text-ink-faint text-sm">
            No holdings data. Import files to see holdings.
          </p>
        </div>
        {cashLine && (
          <div className="rounded-xl border border-edge overflow-hidden bg-panel/50">
            <AccountValueLines cashLine={cashLine} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">Holdings</h3>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge bg-panel">
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Symbol
              </th>
              <th className="hidden md:table-cell text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Name
              </th>
              <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Quantity
              </th>
              <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Cost Basis
              </th>
              <th className="hidden md:table-cell text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                As Of
              </th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => {
              const qtyDigits = Number.isInteger(holding.quantity) ? 0 : 4;
              return (
                <tr
                  key={holding.id}
                  className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                >
                  <td className="px-4 py-3 font-mono font-medium text-ink">
                    {holding.security_type?.toLowerCase() === "option" ? (
                      <>
                        <SymbolLink
                          securityId={holding.security_id}
                          symbol={holding.underlying_symbol ?? holding.symbol}
                        />
                        <span className="ml-1.5 text-xs text-ink-faint font-normal">
                          {formatOptionDescription(holding)}
                        </span>
                      </>
                    ) : (
                      <SymbolLink
                        securityId={holding.security_id}
                        symbol={holding.symbol}
                      />
                    )}
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 text-ink-dim truncate max-w-[200px]">
                    {displaySecurityName(holding.security_name)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    <Shares value={holding.quantity} digits={qtyDigits} />
                    <QuantityUnit
                      securityType={holding.security_type}
                      quantity={holding.quantity}
                      className="ml-1 text-xs text-ink-faint font-normal"
                    />
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {holding.cost_basis != null && holding.cost_basis !== 0 ? (
                      <Money value={holding.cost_basis} precise />
                    ) : (
                      <span title="Import a Vanguard cost basis CSV to populate" className="cursor-help">—</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 text-ink-faint font-mono text-xs">
                    {holding.as_of_date}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </ScrollFade>
        <div className="border-t-2 border-edge bg-panel/50">
          <AccountValueLines cashLine={cashLine} />
        </div>
      </div>
    </div>
  );
}
