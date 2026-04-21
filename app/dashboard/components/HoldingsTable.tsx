import type { HoldingWithSecurity } from "@/lib/queries/holdings";
import { ScrollFade } from "./ScrollFade";
import { SymbolLink } from "./SymbolLink";
import { Money, Shares } from "@/lib/privacy/components";

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

function quantityLabel(holding: HoldingWithSecurity): string {
  if (holding.security_type?.toLowerCase() === "option") return "contracts";
  if (holding.security_type?.toLowerCase() === "bond") return "face value";
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
                        <span>{holding.underlying_symbol ?? holding.symbol}</span>
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
                    {holding.security_name ?? "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    <Shares value={holding.quantity} digits={qtyDigits} />
                    <span className="ml-1 text-xs text-ink-faint font-normal">
                      {quantityLabel(holding)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {holding.cost_basis != null ? (
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
      </div>
    </div>
  );
}
