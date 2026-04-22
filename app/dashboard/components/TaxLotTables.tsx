import type { TaxLotWithSecurity, TaxLotSaleWithDetails } from "@/lib/queries/tax-lots";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Money, Shares } from "@/lib/privacy/components";
import { ScrollFade } from "./ScrollFade";

function GainCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  return (
    <Money
      value={value}
      precise
      signed
      className={`font-mono tabular-nums ${
        value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
      }`}
    />
  );
}

export function OpenLotsTable({
  lots,
  showAccount = true,
}: {
  lots: TaxLotWithSecurity[];
  showAccount?: boolean;
}) {
  if (lots.length === 0) {
    return null;
  }

  return (
    <div>
      <h4 className="text-xs font-medium text-ink-faint mb-2">
        Open Lots
        <span className="ml-1.5 text-ink-faint/60">({lots.length})</span>
      </h4>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                {showAccount && (
                  <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Account</th>
                )}
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Symbol</th>
                <th className="hidden md:table-cell text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Acquired</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Qty</th>
                <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Cost/Share</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Cost Basis</th>
                <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Mkt Value</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Unrealized</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => {
                const qtyDigits = Number.isInteger(lot.quantity_remaining) ? 0 : 4;
                return (
                  <tr
                    key={lot.id}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    {showAccount && (
                      <td className="px-4 py-3 text-ink-dim text-xs">{lot.account_name}</td>
                    )}
                    <td className="px-4 py-3 font-mono font-medium text-ink">
                      <SymbolLink securityId={lot.security_id} symbol={lot.symbol} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-ink-faint font-mono text-xs">{lot.acquisition_date}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Shares value={lot.quantity_remaining} digits={qtyDigits} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={lot.acquisition_price} precise />
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={lot.adjusted_cost_basis} precise />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Money value={lot.current_value} precise />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <GainCell value={lot.unrealized_gain} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}

export function ClosedSalesTable({
  sales,
  showAccount = true,
}: {
  sales: TaxLotSaleWithDetails[];
  showAccount?: boolean;
}) {
  if (sales.length === 0) {
    return null;
  }

  return (
    <div>
      <h4 className="text-xs font-medium text-ink-faint mb-2">
        Closed Sales
        <span className="ml-1.5 text-ink-faint/60">({sales.length})</span>
      </h4>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                {showAccount && (
                  <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Account</th>
                )}
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Symbol</th>
                <th className="hidden md:table-cell text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Sold</th>
                <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Qty</th>
                <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Proceeds</th>
                <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Cost Basis</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Gain/Loss</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Term</th>
                <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Days</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => {
                const qtyDigits = Number.isInteger(sale.quantity_sold) ? 0 : 4;
                return (
                  <tr
                    key={sale.id}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    {showAccount && (
                      <td className="px-4 py-3 text-ink-dim text-xs">{sale.account_name}</td>
                    )}
                    <td className="px-4 py-3 font-mono font-medium text-ink">
                      <SymbolLink securityId={sale.security_id} symbol={sale.symbol} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-ink-faint font-mono text-xs">{sale.sale_date}</td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Shares value={sale.quantity_sold} digits={qtyDigits} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Money value={sale.proceeds} precise />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={sale.cost_basis_allocated} precise />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <GainCell value={sale.realized_gain_loss} />
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-medium ${
                          sale.is_long_term
                            ? "bg-blue/20 text-blue"
                            : "bg-gold/20 text-gold"
                        }`}
                      >
                        {sale.is_long_term ? "Long" : "Short"}
                      </span>
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-faint text-xs">
                      {sale.holding_period_days}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}
