export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { getSecurityDetail } from "@/lib/queries/security-detail";
import { isOnWatchlist, getWatchlistItem } from "@/lib/queries/watchlist";
import { notFound } from "next/navigation";
import Link from "next/link";
import { CorporateActionsSection } from "../../components/CorporateActionsSection";
import { SecurityChart } from "../../components/SecurityChart";
import { WatchlistButton } from "../../components/WatchlistButton";
import { LevelsPanel } from "../../components/LevelsPanel";
import { RecentAlertsPanel } from "../../components/RecentAlertsPanel";
import { Money, Pct, Shares } from "@/lib/privacy/components";
import {
  FACTOR_COLUMNS,
  FACTOR_LABELS,
  getFactorColor,
  type FactorColumn,
} from "@/lib/factors";

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

  const { security, price, positions, openTaxLots, closedSales, recentTransactions, notes, upcomingEvents, factors, transcripts, tradeGrades, researchMentions } = detail;
  const watched = isOnWatchlist(db, securityId);
  const watchlistItem = watched ? getWatchlistItem(db, securityId) : null;

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
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
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
          <div className="md:text-right">
            <div className="text-2xl font-mono font-bold text-ink">
              <Money value={price.close_price} precise />
            </div>
            {price.change != null && price.change_pct != null && (
              <div
                className={`text-sm font-mono ${gainClass(price.change)}`}
              >
                <Money value={price.change} precise signed /> (<Pct value={price.change_pct} digits={2} signed />)
              </div>
            )}
            <div className="text-xs text-ink-faint mt-0.5">
              as of {price.date}
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
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
        <WatchlistButton
          securityId={securityId}
          initialWatched={watched}
          priceTargetLow={watchlistItem?.price_target_low ?? null}
          priceTargetHigh={watchlistItem?.price_target_high ?? null}
        />
      </div>

      {/* Watchlist price targets */}
      {watched && watchlistItem && (watchlistItem.price_target_low || watchlistItem.price_target_high) && (
        <div className="flex items-center gap-4 text-xs">
          {watchlistItem.price_target_low && (
            <span className="text-ink-faint">
              Target Low:{" "}
              <Money value={watchlistItem.price_target_low} precise className="font-mono text-down" />
            </span>
          )}
          {watchlistItem.price_target_high && (
            <span className="text-ink-faint">
              Target High:{" "}
              <Money value={watchlistItem.price_target_high} precise className="font-mono text-up" />
            </span>
          )}
          {watchlistItem.thesis && (
            <span className="text-ink-faint truncate max-w-xs" title={watchlistItem.thesis}>
              Thesis: {watchlistItem.thesis}
            </span>
          )}
        </div>
      )}

      {/* Option Details (only for option securities) */}
      {security.security_type?.toLowerCase() === "option" && security.underlying_symbol && (
        <section className="rounded-xl border border-edge bg-panel p-5">
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <span className="text-xs text-ink-faint uppercase">Underlying</span>
              <p className="font-mono text-ink font-medium">
                <Link
                  href={`/dashboard/security/${(() => {
                    const underlying = db
                      .prepare("SELECT id FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' LIMIT 1")
                      .get(security.underlying_symbol!) as { id: number } | undefined;
                    return underlying?.id ?? securityId;
                  })()}`}
                  className="text-gold hover:underline"
                >
                  {security.underlying_symbol}
                </Link>
              </p>
            </div>
            <div>
              <span className="text-xs text-ink-faint uppercase">Type</span>
              <p className={`font-mono font-medium ${security.option_type === "CALL" ? "text-up" : "text-down"}`}>
                {security.option_type}
              </p>
            </div>
            {security.strike_price && (
              <div>
                <span className="text-xs text-ink-faint uppercase">Strike</span>
                <p className="font-mono text-ink font-medium">
                  <Money value={security.strike_price} precise />
                </p>
              </div>
            )}
            {security.expiration_date && (
              <div>
                <span className="text-xs text-ink-faint uppercase">Expiration</span>
                <p className="font-mono text-ink font-medium">
                  {security.expiration_date}
                  <span className="text-xs text-ink-faint ml-1">
                    ({Math.max(0, Math.floor((new Date(security.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))}d)
                  </span>
                </p>
              </div>
            )}
            <div>
              <span className="text-xs text-ink-faint uppercase">Multiplier</span>
              <p className="font-mono text-ink font-medium">{security.multiplier}x</p>
            </div>
          </div>
        </section>
      )}

      {/* Chart */}
      <section className="rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="h-[280px] md:h-[400px]">
          <SecurityChart securityId={securityId} symbol={security.symbol} />
        </div>
      </section>

      {/* Levels & Alerts */}
      <LevelsPanel
        securityId={securityId}
        symbol={security.symbol}
        currentPrice={price?.close_price ?? null}
      />

      {/* Alerts history for this security (auto-hides if empty). */}
      <RecentAlertsPanel securityId={securityId} />

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
                  <th className="hidden md:table-cell text-right px-5 py-2 font-medium">%</th>
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
                        <Shares value={p.quantity} />
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                        <Money value={p.cost_basis} fallback="–" />
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-ink">
                        <Money value={p.current_value} fallback="–" />
                      </td>
                      <td
                        className={`px-5 py-2.5 text-right font-mono ${gainClass(p.unrealized_gain)}`}
                      >
                        <Money value={p.unrealized_gain} fallback="–" />
                      </td>
                      <td
                        className={`hidden md:table-cell px-5 py-2.5 text-right font-mono ${gainClass(pct)}`}
                      >
                        <Pct value={pct} digits={2} signed fallback="–" />
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
                      <Shares value={positions.reduce((sum, p) => sum + p.quantity, 0)} />
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      <Money value={detail.totalCostBasis} />
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono font-semibold text-ink">
                      <Money value={detail.totalValue} />
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono font-semibold ${gainClass(detail.totalUnrealizedGain)}`}
                    >
                      <Money value={detail.totalUnrealizedGain} />
                    </td>
                    <td
                      className={`hidden md:table-cell px-5 py-2.5 text-right font-mono ${gainClass(detail.totalUnrealizedGain)}`}
                    >
                      {detail.totalCostBasis > 0 ? (
                        <Pct
                          value={(detail.totalUnrealizedGain / detail.totalCostBasis) * 100}
                          digits={2}
                          signed
                        />
                      ) : (
                        "\u2013"
                      )}
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
                  <th className="hidden md:table-cell text-left px-5 py-2 font-medium">Account</th>
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
                    <td className="hidden md:table-cell px-5 py-2.5 text-ink">
                      {lot.account_name}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      <Shares value={lot.quantity_remaining} />
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      <Money value={lot.adjusted_cost_basis} />
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono ${gainClass(lot.unrealized_gain)}`}
                    >
                      <Money value={lot.unrealized_gain} fallback="–" />
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
                  <th className="hidden md:table-cell text-left px-5 py-2 font-medium">Account</th>
                  <th className="hidden md:table-cell text-right px-5 py-2 font-medium">Qty</th>
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
                    <td className="hidden md:table-cell px-5 py-2.5 text-ink">
                      {sale.account_name}
                    </td>
                    <td className="hidden md:table-cell px-5 py-2.5 text-right font-mono text-ink">
                      <Shares value={sale.quantity_sold} />
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink-dim">
                      <Money value={sale.proceeds} />
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right font-mono ${gainClass(sale.realized_gain_loss)}`}
                    >
                      <Money value={sale.realized_gain_loss} />
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

      {/* Trade Grades (from AI reviews) */}
      {tradeGrades.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              AI Trade Grades ({tradeGrades.length})
            </h2>
            <Link
              href="/dashboard/research?view=reviews"
              className="text-xs text-gold hover:brightness-125 transition-colors"
            >
              View All Reviews →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint text-xs">
                  <th className="text-center px-5 py-2 font-medium">Grade</th>
                  <th className="text-left px-5 py-2 font-medium">Entry</th>
                  <th className="text-left px-5 py-2 font-medium">Exit</th>
                  <th className="hidden md:table-cell text-right px-5 py-2 font-medium">Days</th>
                  <th className="text-right px-5 py-2 font-medium">P&L</th>
                  <th className="text-right px-5 py-2 font-medium">Return</th>
                </tr>
              </thead>
              <tbody>
                {tradeGrades.map((tg, i) => {
                  const gradeStyle: Record<string, string> = {
                    A: "bg-up/20 text-up border-up/30",
                    B: "bg-up/10 text-up/80 border-up/20",
                    C: "bg-gold/15 text-gold border-gold/25",
                    D: "bg-down/10 text-down/80 border-down/20",
                    F: "bg-down/20 text-down border-down/30",
                  };
                  return (
                    <tr key={i} className="border-b border-edge/50 last:border-0">
                      <td className="px-5 py-2.5 text-center">
                        {tg.grade ? (
                          <span className={`inline-flex items-center justify-center w-7 h-7 rounded-md border text-xs font-bold ${gradeStyle[tg.grade] ?? "bg-muted text-ink-dim border-edge"}`}>
                            {tg.grade}
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs text-ink-dim">
                        {tg.entry_date}
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs text-ink-dim">
                        {tg.exit_date}
                      </td>
                      <td className="hidden md:table-cell px-5 py-2.5 text-right font-mono text-ink-dim">
                        {tg.holding_days}
                      </td>
                      <td className={`px-5 py-2.5 text-right font-mono ${gainClass(tg.realized_pnl)}`}>
                        <Money value={tg.realized_pnl} />
                      </td>
                      <td className={`px-5 py-2.5 text-right font-mono ${gainClass(tg.return_pct)}`}>
                        <Pct value={tg.return_pct} digits={1} signed />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* AI Assessment detail for graded trades */}
          {tradeGrades.some(tg => tg.entry_thesis) && (
            <div className="border-t border-edge px-5 py-3 space-y-2">
              {tradeGrades.filter(tg => tg.entry_thesis || tg.exit_assessment).map((tg, i) => (
                <div key={i} className="text-xs space-y-0.5">
                  <div className="flex items-center gap-2">
                    {tg.grade && (
                      <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${
                        { A: "bg-up/20 text-up", B: "bg-up/10 text-up/80", C: "bg-gold/15 text-gold", D: "bg-down/10 text-down/80", F: "bg-down/20 text-down" }[tg.grade] ?? "bg-muted text-ink-dim"
                      }`}>
                        {tg.grade}
                      </span>
                    )}
                    <span className="text-ink-faint">{tg.entry_date} → {tg.exit_date}</span>
                  </div>
                  {tg.entry_thesis && <p className="text-ink-dim"><span className="text-ink-faint">Entry:</span> {tg.entry_thesis}</p>}
                  {tg.exit_assessment && <p className="text-ink-dim"><span className="text-ink-faint">Exit:</span> {tg.exit_assessment}</p>}
                </div>
              ))}
            </div>
          )}
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
                  <th className="hidden md:table-cell text-left px-5 py-2 font-medium">Account</th>
                  <th className="text-right px-5 py-2 font-medium">Qty</th>
                  <th className="hidden md:table-cell text-right px-5 py-2 font-medium">Price</th>
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
                    <td className="hidden md:table-cell px-5 py-2.5 text-ink-dim">
                      {t.account_name}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      <Shares value={t.quantity} fallback="–" />
                    </td>
                    <td className="hidden md:table-cell px-5 py-2.5 text-right font-mono text-ink-dim">
                      <Money value={t.price_per_share} precise fallback="–" />
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      <Money value={t.amount} fallback="–" />
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

      {/* Research Mentions */}
      {researchMentions.length > 0 && (
        <section className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              Research Mentions ({researchMentions.length})
            </h2>
            <Link
              href="/dashboard/research?view=feeds"
              className="text-xs text-gold hover:underline"
            >
              View All Feeds
            </Link>
          </div>
          <div className="divide-y divide-edge/50">
            {researchMentions.map((mention) => (
              <div key={mention.article_id} className="px-5 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-medium text-gold uppercase tracking-wide">
                    {mention.source_name}
                  </span>
                  <span className="text-xs text-ink-faint font-mono">
                    {mention.received_at.slice(0, 10)}
                  </span>
                  {mention.sentiment && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        mention.sentiment === "bullish"
                          ? "bg-up-tint text-up"
                          : mention.sentiment === "bearish"
                            ? "bg-down-tint text-down"
                            : "bg-raised text-ink-dim"
                      }`}
                    >
                      {mention.sentiment}
                    </span>
                  )}
                </div>
                <p className="text-sm text-ink font-medium truncate">
                  {mention.subject}
                </p>
                {mention.summary && (
                  <p className="text-xs text-ink-dim line-clamp-2 mt-0.5">
                    {mention.summary}
                  </p>
                )}
                {mention.mention_context && (
                  <p className="text-xs text-ink-faint italic line-clamp-1 mt-0.5">
                    &quot;...{mention.mention_context}...&quot;
                  </p>
                )}
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

      {/* Related Options (for stock securities that have option positions) */}
      {security.security_type?.toLowerCase() !== "option" && (() => {
        const relatedOptions = db
          .prepare(
            `SELECT s.id, s.symbol, s.option_type, s.strike_price, s.expiration_date,
                    h.quantity, COALESCE(s.multiplier, 1) AS multiplier
             FROM holdings h
             JOIN securities s ON s.id = h.security_id
             WHERE s.underlying_symbol = ?
               AND s.security_type = 'option'
               AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2)
             ORDER BY s.expiration_date, s.strike_price`
          )
          .all(security.symbol) as Array<{
          id: number;
          symbol: string;
          option_type: string;
          strike_price: number;
          expiration_date: string;
          quantity: number;
          multiplier: number;
        }>;

        if (relatedOptions.length === 0) return null;
        return (
          <section className="rounded-xl border border-edge bg-panel overflow-hidden">
            <div className="px-5 py-3 border-b border-edge">
              <h2 className="text-sm font-semibold text-ink">
                Related Options ({relatedOptions.length})
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-edge text-ink-faint text-xs">
                    <th className="text-left px-5 py-2 font-medium">Type</th>
                    <th className="text-right px-5 py-2 font-medium">Strike</th>
                    <th className="text-left px-5 py-2 font-medium">Expiration</th>
                    <th className="text-right px-5 py-2 font-medium">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedOptions.map((o) => (
                    <tr key={o.id} className="border-b border-edge/50 last:border-0">
                      <td className="px-5 py-2.5">
                        <Link
                          href={`/dashboard/security/${o.id}`}
                          className="text-gold hover:underline font-medium"
                        >
                          {o.option_type}
                        </Link>
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-ink">
                        <Money value={o.strike_price} precise />
                      </td>
                      <td className="px-5 py-2.5 font-mono text-ink-dim text-xs">
                        {o.expiration_date}
                      </td>
                      <td className={`px-5 py-2.5 text-right font-mono ${o.quantity < 0 ? "text-down" : "text-ink"}`}>
                        {o.quantity > 0 ? "+" : ""}<Shares value={o.quantity} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      {/* Corporate Actions */}
      <CorporateActionsSection securityId={security.id} symbol={security.symbol} />

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
