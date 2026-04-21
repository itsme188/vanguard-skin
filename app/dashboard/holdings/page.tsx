export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { SymbolLink } from "../components/SymbolLink";
import { ScrollFade } from "../components/ScrollFade";
import { EmptyState } from "../components/EmptyState";

interface HoldingRow {
  account_id: number;
  account_name: string;
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  multiplier: number;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
}

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

function formatPercent(value: number | null): string {
  if (value === null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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

function GainPercentCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  return (
    <span
      className={`font-mono tabular-nums ${
        value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
      }`}
    >
      {isPositive && value !== 0 ? "+" : ""}
      {formatPercent(value)}
    </span>
  );
}

export default async function HoldingsPage() {
  const marketValueExpr = adjustedMarketValueSQL(
    "h.quantity",
    "p.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)"
  );

  const sql = `
    SELECT
      h.account_id,
      a.name AS account_name,
      h.security_id,
      s.symbol,
      s.name AS security_name,
      s.security_type,
      COALESCE(s.multiplier, 1) AS multiplier,
      h.quantity,
      h.cost_basis,
      h.as_of_date,
      p.close_price AS current_price,
      CASE WHEN p.close_price IS NOT NULL
        THEN ${marketValueExpr}
        ELSE NULL END AS current_value,
      CASE WHEN p.close_price IS NOT NULL AND h.cost_basis IS NOT NULL
        THEN ${marketValueExpr} - h.cost_basis
        ELSE NULL END AS unrealized_gain
    FROM holdings h
    JOIN accounts a ON a.id = h.account_id
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN prices p ON p.security_id = h.security_id
      AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
    WHERE h.quantity > 0
      AND h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        WHERE h2.account_id = h.account_id
      )
      AND (s.maturity_date IS NULL OR s.maturity_date >= date('now')
           OR LOWER(s.security_type) = 'bond')
    ORDER BY current_value DESC NULLS LAST
  `;

  let holdings: HoldingRow[];
  try {
    holdings = db.prepare(sql).all() as HoldingRow[];
  } catch {
    throw new Error(
      "Failed to load holdings. The database may be unavailable."
    );
  }

  if (holdings.length === 0) {
    return (
      <EmptyState
        icon={
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
          </svg>
        }
        title="No holdings yet"
        description="Import your Vanguard statements or sync positions from TWS to see your holdings."
        action={{ label: "Import Files", href: "/dashboard/import" }}
      />
    );
  }

  // Compute totals for summary row and allocation percentages
  const totalValue = holdings.reduce(
    (sum, h) => sum + (h.current_value ?? 0),
    0
  );
  // Only sum cost basis for positions that have data — null means "unknown", not zero
  const holdingsWithCost = holdings.filter((h) => h.cost_basis !== null);
  const totalCostBasis = holdingsWithCost.reduce(
    (sum, h) => sum + h.cost_basis!,
    0
  );
  const missingCostCount = holdings.length - holdingsWithCost.length;
  const totalGain = holdings.reduce(
    (sum, h) => sum + (h.unrealized_gain ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Holdings</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          {holdings.length} positions across all accounts
        </p>
      </div>

      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Symbol
                </th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Name
                </th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Account
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Qty
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Cost Basis
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Value
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Gain
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Gain %
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Alloc %
                </th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => {
                const gainPct =
                  h.unrealized_gain !== null && h.cost_basis !== null && h.cost_basis !== 0
                    ? h.unrealized_gain / h.cost_basis
                    : null;
                const allocPct =
                  h.current_value !== null && totalValue > 0
                    ? h.current_value / totalValue
                    : null;

                return (
                  <tr
                    key={`${h.account_id}-${h.security_id}`}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono font-medium text-ink">
                      <SymbolLink
                        securityId={h.security_id}
                        symbol={h.symbol}
                      />
                    </td>
                    <td className="px-4 py-3 text-ink-dim text-xs max-w-[200px] truncate">
                      {h.security_name ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-ink-dim text-xs">
                      {h.account_name}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                      {formatQuantity(h.quantity)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      {formatCurrency(h.cost_basis)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                      {formatCurrency(h.current_value)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <GainCell value={h.unrealized_gain} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <GainPercentCell value={gainPct} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      {allocPct !== null ? formatPercent(allocPct) : "\u2014"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-edge bg-panel/50">
                <td className="px-4 py-3 font-medium text-ink text-xs" colSpan={4}>
                  Total ({holdings.length} positions)
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink-dim">
                  {missingCostCount > 0 ? (
                    <span title={`${missingCostCount} position${missingCostCount > 1 ? "s" : ""} missing cost basis data`} className="cursor-help">
                      ~{formatCurrency(totalCostBasis)}
                    </span>
                  ) : (
                    formatCurrency(totalCostBasis)
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink">
                  {formatCurrency(totalValue)}
                </td>
                <td className="px-4 py-3 text-right">
                  <GainCell value={totalGain} />
                </td>
                <td className="px-4 py-3 text-right">
                  <GainPercentCell
                    value={
                      totalCostBasis !== 0 ? totalGain / totalCostBasis : null
                    }
                  />
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                  100.00%
                </td>
              </tr>
            </tfoot>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}
