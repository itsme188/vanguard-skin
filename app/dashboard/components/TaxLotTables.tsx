import type { TaxLotWithSecurity, TaxLotSaleWithDetails } from "@/lib/queries/tax-lots";

function formatCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value))
    return new Intl.NumberFormat("en-US").format(value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function GainCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  return (
    <span
      className={`font-mono tabular-nums ${
        value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
      }`}
    >
      {isPositive && value !== 0 ? "+" : ""}
      {formatCurrency(value)}
    </span>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                {showAccount && (
                  <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Account</th>
                )}
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Symbol</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Acquired</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Qty</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Cost/Share</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Cost Basis</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Mkt Value</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Unrealized</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <tr
                  key={lot.id}
                  className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                >
                  {showAccount && (
                    <td className="px-4 py-3 text-ink-dim text-xs">{lot.account_name}</td>
                  )}
                  <td className="px-4 py-3 font-mono font-medium text-ink">{lot.symbol}</td>
                  <td className="px-4 py-3 text-ink-faint font-mono text-xs">{lot.acquisition_date}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    {formatQuantity(lot.quantity_remaining)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {formatCurrency(lot.acquisition_price)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {formatCurrency(lot.adjusted_cost_basis)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    {formatCurrency(lot.current_value)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <GainCell value={lot.unrealized_gain} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                {showAccount && (
                  <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Account</th>
                )}
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Symbol</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Sold</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Qty</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Proceeds</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Cost Basis</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Gain/Loss</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Term</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Days</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <tr
                  key={sale.id}
                  className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                >
                  {showAccount && (
                    <td className="px-4 py-3 text-ink-dim text-xs">{sale.account_name}</td>
                  )}
                  <td className="px-4 py-3 font-mono font-medium text-ink">{sale.symbol}</td>
                  <td className="px-4 py-3 text-ink-faint font-mono text-xs">{sale.sale_date}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    {formatQuantity(sale.quantity_sold)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    {formatCurrency(sale.proceeds)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {formatCurrency(sale.cost_basis_allocated)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <GainCell value={sale.realized_gain_loss} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-medium ${
                        sale.is_long_term
                          ? "bg-blue-tint text-blue"
                          : "bg-gold-glow text-gold"
                      }`}
                    >
                      {sale.is_long_term ? "Long" : "Short"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-faint text-xs">
                    {sale.holding_period_days}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
