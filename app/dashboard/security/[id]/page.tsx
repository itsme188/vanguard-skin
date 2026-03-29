import { db } from "@/lib/db";
import { getSecurityDetail } from "@/lib/queries/security-detail";
import { notFound } from "next/navigation";
import Link from "next/link";
import { SecurityChart } from "../../components/SecurityChart";
import {
  FACTOR_COLUMNS,
  FACTOR_LABELS,
  getFactorColor,
  type FactorColumn,
} from "@/lib/factors";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPrecise(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function gainClass(value: number | null): string {
  if (value == null) return "text-ink-dim";
  return value >= 0 ? "text-up" : "text-down";
}

function holdingPeriodLabel(acquisitionDate: string): string {
  const days = Math.floor(
    (Date.now() - new Date(acquisitionDate).getTime()) / (1000 * 60 * 60 * 24)
  );
  return days > 365 ? "LT" : "ST";
}

export default async function SecurityDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const securityId = parseInt(params.id, 10);
  if (isNaN(securityId)) notFound();

  let detail;
  try {
    detail = getSecurityDetail(db, securityId);
  } catch {
    throw new Error(
      "Failed to load security data. The database may be unavailable."
    );
  }

  if (!detail) notFound();

  const { security, price, positions, openTaxLots, closedSales, recentTransactions, notes, upcomingEvents, factors, transcripts } = detail;

  const typeLabel = [
    security.security_type?.replace(/_/g, " "),
    security.sector,
    security.asset_class,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="text-sm text-ink-faint">
        <Link href="/dashboard" className="hover:text-ink transition-colors">
          Dashboard
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink">{security.symbol}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-mono font-bold text-ink">
              {security.symbol}
            </h1>
            {security.name && (
              <span className="text-lg text-ink-dim">{security.name}</span>
            )}
          </div>
          {typeLabel && (
            <p className="text-sm text-ink-faint mt-1 capitalize">
              {typeLabel}
            </p>
          )}
        </div>

        {price && (
          <div className="text-right">
            <div className="text-2xl font-mono font-bold text-ink">
              {formatPrecise(price.close_price)}
            </div>
            {price.change != null && price.change_pct != null && (
              <div
                className={`text-sm font-mono ${gainClass(price.change)}`}
              >
                {price.change >= 0 ? "+" : ""}
                {formatPrecise(price.change)} ({formatPct(price.change_pct)})
              </div>
            )}
            <div className="text-xs text-ink-faint mt-0.5">
              as of {price.date}
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <Link
          href={`/dashboard/charts?id=${securityId}`}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink hover:border-ink-faint transition-colors"
        >
          Full Chart
        </Link>
        <Link
          href={`/dashboard/research?security=${securityId}`}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink hover:border-ink-faint transition-colors"
        >
          + Create Note
        </Link>
      </div>

      {/* Chart */}
      <section className="rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="h-[400px]">
          <SecurityChart securityId={securityId} symbol={security.symbol} />
        </div>
      </section>

      {/* Positions */}
      {positions.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge">
            <h2 className="text-sm font-semibold text-ink">Positions</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint text-xs">
                  <th className="text-left px-5 py-2 font-medium">Account</th>
                  <th className="text-right px-5 py-2 font-medium">Qty</th>
                  <th className="text-right px-5 py-2 font-medium">
                    Cost Basis
                  </th>
                  <th className="text-right px-5 py-2 font-medium">Value</th>
                  <th className="text-right px-5 py-2 font-medium">Gain</th>
                  <th className="text-right px-5 py-2 font-medium">%</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pct =
                    p.cost_basis && p.unrealized_gain
                      ? (p.unrealized_gain / p.cost_basis) * 100
                      : null;
                  return (
                    <tr
                      key={p.account_id}
                      className="border-b border-edge/50 last:border-0"
                    >
                      <td className="px-5 py-2.5 text-ink">
                        {p.account_name}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-ink">
                        {p.quantity.toLocaleString()}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                        {p.cost_basis != null
                          ? formatCurrency(p.cost_basis)
                          : "\u2013"}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-ink">
                        {p.current_value != null
                          ? formatCurrency(p.current_value)
                          : "\u2013"}
                      </td>
                      <td
                        className={`px-5 py-2.5 text-right font-mono ${gainClass(p.unrealized_gain)}`}
                      >
                        {p.unrealized_gain != null
                          ? formatCurrency(p.unrealized_gain)
                          : "\u2013"}
                      </td>
                      <td
                        className={`px-5 py-2.5 text-right font-mono ${gainClass(pct)}`}
                      >
                        {pct != null ? formatPct(pct) : "\u2013"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {positions.length > 1 && (
                <tfoot>
                  <tr className="border-t border-edge bg-raised/50">
                    <td className="px-5 py-2.5 font-semibold text-ink">
                      Total
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono font-semibold text-ink">
                      {positions
                        .reduce((sum, p) => sum + p.quantity, 0)
                        .toLocaleString()}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      {formatCurrency(detail.totalCostBasis)}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono font-semibold text-ink">
                      {formatCurrency(detail.totalValue)}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono font-semibold ${gainClass(detail.totalUnrealizedGain)}`}
                    >
                      {formatCurrency(detail.totalUnrealizedGain)}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono ${gainClass(detail.totalUnrealizedGain)}`}
                    >
                      {detail.totalCostBasis > 0
                        ? formatPct(
                            (detail.totalUnrealizedGain /
                              detail.totalCostBasis) *
                              100
                          )
                        : "\u2013"}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      )}

      {/* Tax Lots */}
      {openTaxLots.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              Open Tax Lots ({openTaxLots.length})
            </h2>
            <Link
              href="/dashboard/tax-lots"
              className="text-xs text-gold hover:underline"
            >
              View All Lots
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint text-xs">
                  <th className="text-left px-5 py-2 font-medium">Acquired</th>
                  <th className="text-left px-5 py-2 font-medium">Account</th>
                  <th className="text-right px-5 py-2 font-medium">Qty</th>
                  <th className="text-right px-5 py-2 font-medium">
                    Cost Basis
                  </th>
                  <th className="text-right px-5 py-2 font-medium">
                    Unrealized
                  </th>
                  <th className="text-center px-5 py-2 font-medium">Term</th>
                </tr>
              </thead>
              <tbody>
                {openTaxLots.map((lot) => (
                  <tr
                    key={lot.id}
                    className="border-b border-edge/50 last:border-0"
                  >
                    <td className="px-5 py-2.5 font-mono text-ink-dim text-xs">
                      {lot.acquisition_date}
                    </td>
                    <td className="px-5 py-2.5 text-ink">
                      {lot.account_name}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      {lot.quantity_remaining}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      {formatCurrency(lot.adjusted_cost_basis)}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono ${gainClass(lot.unrealized_gain)}`}
                    >
                      {lot.unrealized_gain != null
                        ? formatCurrency(lot.unrealized_gain)
                        : "\u2013"}
                    </td>
                    <td className="px-5 py-2.5 text-center">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          holdingPeriodLabel(lot.acquisition_date) === "LT"
                            ? "bg-up/10 text-up"
                            : "bg-gold/10 text-gold"
                        }`}
                      >
                        {holdingPeriodLabel(lot.acquisition_date)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Closed Sales */}
      {closedSales.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge">
            <h2 className="text-sm font-semibold text-ink">
              Recent Sales ({closedSales.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint text-xs">
                  <th className="text-left px-5 py-2 font-medium">
                    Sale Date
                  </th>
                  <th className="text-left px-5 py-2 font-medium">Account</th>
                  <th className="text-right px-5 py-2 font-medium">Qty</th>
                  <th className="text-right px-5 py-2 font-medium">
                    Proceeds
                  </th>
                  <th className="text-right px-5 py-2 font-medium">
                    Realized
                  </th>
                  <th className="text-center px-5 py-2 font-medium">Term</th>
                </tr>
              </thead>
              <tbody>
                {closedSales.map((sale) => (
                  <tr
                    key={sale.id}
                    className="border-b border-edge/50 last:border-0"
                  >
                    <td className="px-5 py-2.5 font-mono text-ink-dim text-xs">
                      {sale.sale_date}
                    </td>
                    <td className="px-5 py-2.5 text-ink">
                      {sale.account_name}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      {sale.quantity_sold}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      {formatCurrency(sale.proceeds)}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono ${gainClass(sale.realized_gain_loss)}`}
                    >
                      {formatCurrency(sale.realized_gain_loss)}
                    </td>
                    <td className="px-5 py-2.5 text-center">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          sale.is_long_term
                            ? "bg-up/10 text-up"
                            : "bg-gold/10 text-gold"
                        }`}
                      >
                        {sale.is_long_term ? "LT" : "ST"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent Transactions */}
      {recentTransactions.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge">
            <h2 className="text-sm font-semibold text-ink">
              Recent Transactions
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint text-xs">
                  <th className="text-left px-5 py-2 font-medium">Date</th>
                  <th className="text-left px-5 py-2 font-medium">Type</th>
                  <th className="text-left px-5 py-2 font-medium">Account</th>
                  <th className="text-right px-5 py-2 font-medium">Qty</th>
                  <th className="text-right px-5 py-2 font-medium">Price</th>
                  <th className="text-right px-5 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recentTransactions.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-edge/50 last:border-0"
                  >
                    <td className="px-5 py-2.5 font-mono text-ink-dim text-xs">
                      {t.trade_date}
                    </td>
                    <td className="px-5 py-2.5">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          t.type.startsWith("BUY")
                            ? "bg-up/10 text-up"
                            : t.type.startsWith("SELL")
                              ? "bg-down/10 text-down"
                              : t.type === "DIVIDEND"
                                ? "bg-gold/10 text-gold"
                                : "bg-muted text-ink-dim"
                        }`}
                      >
                        {t.type}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-ink-dim">
                      {t.account_name}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      {t.quantity != null ? t.quantity.toLocaleString() : "\u2013"}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      {t.price_per_share != null
                        ? formatPrecise(t.price_per_share)
                        : "\u2013"}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      {t.amount != null ? formatCurrency(t.amount) : "\u2013"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Notes & Theses */}
      {notes.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              Notes & Theses ({notes.length})
            </h2>
            <Link
              href={`/dashboard/research?security=${securityId}`}
              className="text-xs text-gold hover:underline"
            >
              View All
            </Link>
          </div>
          <div className="divide-y divide-edge/50">
            {notes.slice(0, 5).map((note) => (
              <div key={note.id} className="px-5 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      note.note_type === "trade_thesis"
                        ? "bg-up/10 text-up"
                        : note.note_type === "earnings"
                          ? "bg-blue/10 text-blue"
                          : "bg-gold/10 text-gold"
                    }`}
                  >
                    {note.note_type === "trade_thesis"
                      ? "Trade Thesis"
                      : note.note_type === "earnings"
                        ? "Earnings"
                        : "Journal"}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {note.event_date}
                  </span>
                  {note.sentiment && (
                    <span className="text-xs text-ink-faint capitalize">
                      {note.sentiment}
                    </span>
                  )}
                </div>
                <p className="text-sm text-ink-dim line-clamp-2">
                  {note.content}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Upcoming Events */}
      {upcomingEvents.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge">
            <h2 className="text-sm font-semibold text-ink">Upcoming Events</h2>
          </div>
          <div className="divide-y divide-edge/50">
            {upcomingEvents.map((event) => (
              <div key={event.id} className="px-5 py-3 flex items-center gap-3">
                <div className="text-xs font-mono text-ink-faint w-20 shrink-0">
                  {event.event_date}
                </div>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
                    event.expected_impact === "high"
                      ? "bg-down/10 text-down"
                      : event.expected_impact === "medium"
                        ? "bg-gold/10 text-gold"
                        : "bg-muted text-ink-dim"
                  }`}
                >
                  {event.event_type.replace(/_/g, " ")}
                </span>
                <span className="text-sm text-ink truncate">{event.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Factor Exposure */}
      {factors && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge">
            <h2 className="text-sm font-semibold text-ink">Factor Exposure</h2>
          </div>
          <div className="px-5 py-4 grid grid-cols-2 md:grid-cols-3 gap-3">
            {FACTOR_COLUMNS.map((col) => {
              const value = factors[col as keyof typeof factors] as
                | string
                | null;
              if (!value || value === "Unknown") return null;
              return (
                <div key={col} className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: getFactorColor(value) }}
                  />
                  <span className="text-xs text-ink-faint">
                    {FACTOR_LABELS[col as FactorColumn]}
                  </span>
                  <span className="text-xs font-medium text-ink ml-auto">
                    {value}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Transcripts */}
      {transcripts.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge">
            <h2 className="text-sm font-semibold text-ink">
              Earnings Transcripts ({transcripts.length})
            </h2>
          </div>
          <div className="divide-y divide-edge/50">
            {transcripts.slice(0, 4).map((t) => (
              <div key={t.id} className="px-5 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-ink">
                    Q{t.quarter} {t.year}
                  </span>
                  {t.sentiment_label && (
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        t.sentiment_label === "positive"
                          ? "bg-up/10 text-up"
                          : t.sentiment_label === "negative"
                            ? "bg-down/10 text-down"
                            : "bg-muted text-ink-dim"
                      }`}
                    >
                      {t.sentiment_label}
                    </span>
                  )}
                  <span className="text-xs text-ink-faint ml-auto">
                    {t.source}
                  </span>
                </div>
                {t.summary && (
                  <p className="text-sm text-ink-dim line-clamp-2">
                    {t.summary}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Empty state — no positions, no data */}
      {positions.length === 0 &&
        openTaxLots.length === 0 &&
        recentTransactions.length === 0 &&
        notes.length === 0 && (
          <div className="rounded-xl border border-dashed border-edge p-8 text-center">
            <p className="text-sm text-ink-dim">
              No portfolio data for {security.symbol}. Import holdings or
              transactions to see data here.
            </p>
            <Link
              href="/dashboard/import"
              className="mt-3 inline-block px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-all"
            >
              Import Files
            </Link>
          </div>
        )}
    </div>
  );
}
