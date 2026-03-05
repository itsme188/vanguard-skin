import type { HoldingWithSecurity } from "@/lib/queries/holdings";

function formatCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatOptionDescription(holding: HoldingWithSecurity): string {
  if (holding.security_type !== "option") return "";
  const underlying = holding.underlying_symbol ?? "";
  const strike = holding.strike_price != null ? `$${holding.strike_price}` : "";
  const type = holding.option_type ?? "";
  const expiry = holding.expiration_date
    ? new Date(holding.expiration_date + "T00:00:00").toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "2-digit",
      })
    : "";
  return [underlying, strike, type, expiry].filter(Boolean).join(" ");
}

function quantityLabel(holding: HoldingWithSecurity): string {
  if (holding.security_type === "option") return "contracts";
  if (holding.security_type === "bond") return "face value";
  return "shares";
}

export function HoldingsTable({
  holdings,
}: {
  holdings: HoldingWithSecurity[];
}) {
  if (holdings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
        <p className="text-ink-faint text-sm">
          No holdings data. Import files to see holdings.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">Holdings</h3>
      <div className="rounded-xl border border-edge overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge bg-panel">
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Symbol
              </th>
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Name
              </th>
              <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Quantity
              </th>
              <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Cost Basis
              </th>
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                As Of
              </th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding) => (
              <tr
                key={holding.id}
                className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
              >
                <td className="px-4 py-3 font-mono font-medium text-ink">
                  <span>{holding.security_type === "option" && holding.underlying_symbol ? holding.underlying_symbol : holding.symbol}</span>
                  {holding.security_type === "option" && (
                    <span className="ml-1.5 text-xs text-ink-faint font-normal">
                      {formatOptionDescription(holding)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-dim truncate max-w-[200px]">
                  {holding.security_name ?? "\u2014"}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                  {formatQuantity(holding.quantity)}
                  <span className="ml-1 text-xs text-ink-faint font-normal">
                    {quantityLabel(holding)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                  {formatCurrency(holding.cost_basis)}
                </td>
                <td className="px-4 py-3 text-ink-faint font-mono text-xs">
                  {holding.as_of_date}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
