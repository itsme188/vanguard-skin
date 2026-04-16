import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { ScrollFade } from "./ScrollFade";

const TYPE_STYLES: Record<string, string> = {
  BUY: "bg-up-tint text-up",
  SELL: "bg-down-tint text-down",
  DIVIDEND: "bg-gold-glow text-gold",
  INTEREST: "bg-blue-tint text-blue",
  FEE: "bg-down-tint text-down",
  COMMISSION: "bg-down-tint text-down",
  TRANSFER: "bg-blue-tint text-blue",
  DEPOSIT: "bg-up-tint text-up",
  WITHDRAWAL: "bg-down-tint text-down",
};

function formatCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

export function TransactionHistory({
  transactions,
}: {
  transactions: TransactionWithSecurity[];
}) {
  if (transactions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
        <p className="text-ink-faint text-sm">
          No transactions yet. Import files to see transaction history.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">
        Recent Transactions
      </h3>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge bg-panel">
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Date
              </th>
              <th className="hidden md:table-cell text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Type
              </th>
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Symbol
              </th>
              <th className="hidden md:table-cell text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Quantity
              </th>
              <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((txn) => (
              <tr
                key={txn.id}
                className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
              >
                <td className="px-4 py-3 font-mono text-xs text-ink-dim">
                  {txn.trade_date}
                </td>
                <td className="hidden md:table-cell px-4 py-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-mono ${
                      TYPE_STYLES[txn.type] ?? "bg-raised text-ink-dim"
                    }`}
                  >
                    {txn.type}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-ink">
                  {txn.security_id != null && txn.symbol ? (
                    <SymbolLink securityId={txn.security_id} symbol={txn.symbol} />
                  ) : (
                    txn.symbol ?? "\u2014"
                  )}
                </td>
                <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                  {txn.quantity !== null
                    ? new Intl.NumberFormat("en-US", {
                        maximumFractionDigits: 4,
                      }).format(txn.quantity)
                    : "\u2014"}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                  {formatCurrency(txn.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </ScrollFade>
      </div>
    </div>
  );
}
