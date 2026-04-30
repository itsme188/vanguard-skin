import { db } from "@/lib/db";
import { getIncomeSummary } from "@/lib/queries/income";
import { resolveScope } from "@/lib/queries/accounts";
import { Money } from "@/lib/privacy/components";

interface IncomeYieldSectionProps {
  scope?: string;
}

/**
 * Lower-priority Analysis section showing dividend + interest income over
 * the trailing 12 months. Surfaces the 167 dividends + 19 interest payments
 * imported from Vanguard activity files (2026-04-23 backfill).
 *
 * All dollar amounts are portfolio-derived (the user's actual income) → use
 * <Money> which masks under privacy mode.
 */
export async function IncomeYieldSection({ scope }: IncomeYieldSectionProps) {
  const accountIds = scope ? resolveScope(db, scope) : undefined;

  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const startDate = yearAgo.toISOString().slice(0, 10);

  const summary = getIncomeSummary(db, startDate, today, accountIds);

  if (summary.netIncome === 0) {
    return (
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-2">Income · trailing 12 months</h3>
        <p className="text-sm text-ink-faint">
          No dividend or interest payments recorded for this scope in the last 12 months.
        </p>
      </section>
    );
  }

  return (
    <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
      <div>
        <h3 className="text-sm font-medium text-ink">Income · trailing 12 months</h3>
        <p className="text-xs text-ink-faint mt-0.5">
          {startDate} → {today}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCell label="Dividends" value={summary.totalDividends} />
        <KpiCell label="Interest" value={summary.totalInterest} />
        <KpiCell label="Fees" value={-summary.totalFees} />
        <KpiCell label="Net income" value={summary.netIncome} bold />
      </div>

      {summary.topPayers.length > 0 && (
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-ink-faint mb-2">
            Top payers
          </h4>
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-widest text-ink-faint">
              <tr className="border-b border-edge">
                <th className="text-left font-medium pb-2">Symbol</th>
                <th className="text-right font-medium pb-2">Dividends</th>
                <th className="text-right font-medium pb-2">Interest</th>
                <th className="text-right font-medium pb-2">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {summary.topPayers.map((p) => (
                <tr key={p.symbol}>
                  <td className="py-2 text-ink font-mono">{p.symbol}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink-dim">
                    <Money value={p.dividends} />
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink-dim">
                    <Money value={p.interest} />
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink">
                    <Money value={p.dividends + p.interest} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.byAccount.length > 1 && (
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-ink-faint mb-2">
            By account
          </h4>
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-widest text-ink-faint">
              <tr className="border-b border-edge">
                <th className="text-left font-medium pb-2">Account</th>
                <th className="text-right font-medium pb-2">Dividends</th>
                <th className="text-right font-medium pb-2">Interest</th>
                <th className="text-right font-medium pb-2">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {summary.byAccount.map((a) => (
                <tr key={a.accountId}>
                  <td className="py-2 text-ink">{a.accountName}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink-dim">
                    <Money value={a.dividends} />
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink-dim">
                    <Money value={a.interest} />
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink">
                    <Money value={a.dividends + a.interest - a.fees} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function KpiCell({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: number;
  bold?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">{label}</p>
      <p
        className={`font-mono tabular-nums text-lg ${
          bold ? "text-ink font-semibold" : "text-ink"
        } ${value < 0 ? "text-down" : ""}`}
      >
        <Money value={value} signed={bold} />
      </p>
    </div>
  );
}
