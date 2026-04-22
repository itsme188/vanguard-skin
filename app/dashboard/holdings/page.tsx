export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { EmptyState } from "../components/EmptyState";
import { AllHoldingsTable, type AllHoldingsRow } from "../components/AllHoldingsTable";

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

  let holdings: AllHoldingsRow[];
  try {
    holdings = db.prepare(sql).all() as AllHoldingsRow[];
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Holdings</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          {holdings.length} positions across all accounts
        </p>
      </div>
      <AllHoldingsTable holdings={holdings} />
    </div>
  );
}
