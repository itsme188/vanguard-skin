export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { getSecurityDetail } from "@/lib/queries/security-detail";
import { isOnWatchlist, getWatchlistItem } from "@/lib/queries/watchlist";
import { getResearchDocumentsForSymbol } from "@/lib/queries/research-documents";
import { ResearchDocumentsPanel } from "../../components/ResearchDocumentsPanel";
import { notFound } from "next/navigation";
import Link from "next/link";
import { CorporateActionsSection } from "../../components/CorporateActionsSection";
import { MarketDataPanel } from "../../components/MarketDataPanel";
import { WatchlistButton } from "../../components/WatchlistButton";
import { RecentAlertsPanel } from "../../components/RecentAlertsPanel";
import { TransactionsSection } from "../../components/TransactionsSection";
import { ResearchMentionsSection } from "../../components/ResearchMentionsSection";
import { TerminalSection, TerminalTH, TerminalTD, TerminalTag } from "../../components/TerminalSection";
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

/** Terminal-aesthetic color for gain/loss values. Returns hex for inline styles. */
function gainColor(value: number | null): string {
  if (value == null) return "#888";
  return value >= 0 ? "#22c55e" : "#ef4444";
}

/** Uppercase-label + value cell, used in the option-contract strip. */
function OptionCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--font-mono), monospace",
          fontSize: "11px",
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "#666",
          marginBottom: "4px",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
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

  const { security, price, positions, openTaxLots, closedSales, recentTransactions, relatedOptionTransactions, notes, upcomingEvents, factors, transcripts, tradeGrades, researchMentions } = detail;
  const watched = isOnWatchlist(db, securityId);
  const watchlistItem = watched ? getWatchlistItem(db, securityId) : null;

  const researchDocuments = security.symbol
    ? getResearchDocumentsForSymbol(db, security.symbol, 10)
    : [];

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

      {/* Market data panel — Terminal-style dark module holding symbol header,
          chart, and levels. Designed to survive a future app-wide light theme
          by staying dark-on-whatever. */}
      <MarketDataPanel
        securityId={securityId}
        symbol={security.symbol}
        name={security.name ?? null}
        typeLabel={typeLabel || null}
        currentPrice={price?.close_price ?? null}
        priceChange={price?.change ?? null}
        priceChangePct={price?.change_pct ?? null}
        priceDate={price?.date ?? null}
      />

      {/* Action buttons — terminal-styled bordered pills */}
      <div className="flex items-center gap-2">
        <Link
          href={`/dashboard/charts?id=${securityId}`}
          style={{
            padding: "6px 14px",
            border: "1px solid #333",
            color: "#999",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "12px",
            fontWeight: 600,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            borderRadius: "2px",
          }}
          className="hover:border-ink-faint hover:text-ink transition-colors"
        >
          Full Chart
        </Link>
        <Link
          href={`/dashboard/research?security=${securityId}`}
          style={{
            padding: "6px 14px",
            border: "1px solid #333",
            color: "#999",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "12px",
            fontWeight: 600,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            borderRadius: "2px",
          }}
          className="hover:border-ink-faint hover:text-ink transition-colors"
        >
          + Note
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
        <TerminalSection title="Option Contract">
          <div className="flex items-center gap-8 flex-wrap p-5">
            <OptionCell label="Underlying">
              <Link
                href={`/dashboard/security/${(() => {
                  const underlying = db
                    .prepare("SELECT id FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' LIMIT 1")
                    .get(security.underlying_symbol!) as { id: number } | undefined;
                  return underlying?.id ?? securityId;
                })()}`}
                style={{ color: "#ffb84d", fontFamily: "var(--font-mono), monospace", fontSize: "18px", fontWeight: 600 }}
                className="hover:underline"
              >
                {security.underlying_symbol}
              </Link>
            </OptionCell>
            <OptionCell label="Type">
              <span style={{ color: security.option_type === "CALL" ? "#22c55e" : "#ef4444", fontFamily: "var(--font-mono), monospace", fontSize: "18px", fontWeight: 600 }}>
                {security.option_type}
              </span>
            </OptionCell>
            {security.strike_price && (
              <OptionCell label="Strike">
                <span style={{ color: "#ddd", fontFamily: "var(--font-mono), monospace", fontSize: "18px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  <Money value={security.strike_price} precise />
                </span>
              </OptionCell>
            )}
            {security.expiration_date && (
              <OptionCell label="Expiration">
                <span style={{ color: "#ddd", fontFamily: "var(--font-mono), monospace", fontSize: "18px", fontWeight: 600 }}>
                  {security.expiration_date}
                  <span style={{ fontSize: "12px", color: "#666", marginLeft: "6px" }}>
                    ({Math.max(0, Math.floor((new Date(security.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))}d)
                  </span>
                </span>
              </OptionCell>
            )}
            <OptionCell label="Multiplier">
              <span style={{ color: "#ddd", fontFamily: "var(--font-mono), monospace", fontSize: "18px", fontWeight: 600 }}>
                {security.multiplier}x
              </span>
            </OptionCell>
          </div>
        </TerminalSection>
      )}

      {/* Alerts history for this security (auto-hides if empty). */}
      <RecentAlertsPanel securityId={securityId} />

      {/* Positions */}
      {positions.length > 0 && (
        <TerminalSection title="Positions">
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <TerminalTH>Account</TerminalTH>
                  <TerminalTH align="right">Qty</TerminalTH>
                  <TerminalTH align="right">Cost Basis</TerminalTH>
                  <TerminalTH align="right">Value</TerminalTH>
                  <TerminalTH align="right">Gain</TerminalTH>
                  <TerminalTH align="right">%</TerminalTH>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pct =
                    p.cost_basis && p.unrealized_gain
                      ? (p.unrealized_gain / p.cost_basis) * 100
                      : null;
                  return (
                    <tr key={p.account_id}>
                      <TerminalTD>{p.account_name}</TerminalTD>
                      <TerminalTD align="right" mono>
                        <Shares value={p.quantity} />
                      </TerminalTD>
                      <TerminalTD align="right" mono color="#888">
                        <Money value={p.cost_basis} fallback="–" />
                      </TerminalTD>
                      <TerminalTD align="right" mono>
                        <Money value={p.current_value} fallback="–" />
                      </TerminalTD>
                      <TerminalTD align="right" mono color={gainColor(p.unrealized_gain)}>
                        <Money value={p.unrealized_gain} fallback="–" />
                      </TerminalTD>
                      <TerminalTD align="right" mono color={gainColor(pct)}>
                        <Pct value={pct} digits={2} signed fallback="–" />
                      </TerminalTD>
                    </tr>
                  );
                })}
              </tbody>
              {positions.length > 1 && (
                <tfoot>
                  <tr style={{ background: "#111" }}>
                    <TerminalTD color="#ccc">
                      <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "11px", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 600 }}>Total</span>
                    </TerminalTD>
                    <TerminalTD align="right" mono color="#eee">
                      <Shares value={positions.reduce((sum, p) => sum + p.quantity, 0)} />
                    </TerminalTD>
                    <TerminalTD align="right" mono color="#888">
                      <Money value={detail.totalCostBasis} />
                    </TerminalTD>
                    <TerminalTD align="right" mono color="#eee">
                      <Money value={detail.totalValue} />
                    </TerminalTD>
                    <TerminalTD align="right" mono color={gainColor(detail.totalUnrealizedGain)}>
                      <Money value={detail.totalUnrealizedGain} />
                    </TerminalTD>
                    <TerminalTD align="right" mono color={gainColor(detail.totalUnrealizedGain)}>
                      {detail.totalCostBasis > 0 ? (
                        <Pct value={(detail.totalUnrealizedGain / detail.totalCostBasis) * 100} digits={2} signed />
                      ) : (
                        "–"
                      )}
                    </TerminalTD>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </TerminalSection>
      )}

      {/* Tax Lots */}
      {openTaxLots.length > 0 && (
        <TerminalSection
          title={`Open Tax Lots · ${openTaxLots.length}`}
          action={
            <Link
              href="/dashboard/tax-lots"
              style={{
                fontFamily: "var(--font-mono), monospace",
                fontSize: "11px",
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#ffb84d",
              }}
              className="hover:underline"
            >
              View all →
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <TerminalTH>Acquired</TerminalTH>
                  <TerminalTH>Account</TerminalTH>
                  <TerminalTH align="right">Qty</TerminalTH>
                  <TerminalTH align="right">Cost Basis</TerminalTH>
                  <TerminalTH align="right">Unrealized</TerminalTH>
                  <TerminalTH align="center">Term</TerminalTH>
                </tr>
              </thead>
              <tbody>
                {openTaxLots.map((lot) => {
                  const isLT = holdingPeriodLabel(lot.acquisition_date) === "LT";
                  return (
                    <tr key={lot.id}>
                      <TerminalTD mono color="#888">{lot.acquisition_date}</TerminalTD>
                      <TerminalTD>{lot.account_name}</TerminalTD>
                      <TerminalTD align="right" mono>
                        <Shares value={lot.quantity_remaining} />
                      </TerminalTD>
                      <TerminalTD align="right" mono color="#888">
                        <Money value={lot.adjusted_cost_basis} />
                      </TerminalTD>
                      <TerminalTD align="right" mono color={gainColor(lot.unrealized_gain)}>
                        <Money value={lot.unrealized_gain} fallback="–" />
                      </TerminalTD>
                      <TerminalTD align="center">
                        <TerminalTag color={isLT ? "#22c55e" : "#ffb84d"} variant="outline" size="xs">
                          {isLT ? "LT" : "ST"}
                        </TerminalTag>
                      </TerminalTD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TerminalSection>
      )}

      {/* Closed Sales */}
      {closedSales.length > 0 && (
        <TerminalSection title={`Recent Sales · ${closedSales.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <TerminalTH>Sale Date</TerminalTH>
                  <TerminalTH>Account</TerminalTH>
                  <TerminalTH align="right">Qty</TerminalTH>
                  <TerminalTH align="right">Proceeds</TerminalTH>
                  <TerminalTH align="right">Realized</TerminalTH>
                  <TerminalTH align="center">Term</TerminalTH>
                </tr>
              </thead>
              <tbody>
                {closedSales.map((sale) => (
                  <tr key={sale.id}>
                    <TerminalTD mono color="#888">{sale.sale_date}</TerminalTD>
                    <TerminalTD>{sale.account_name}</TerminalTD>
                    <TerminalTD align="right" mono>
                      <Shares value={sale.quantity_sold} />
                    </TerminalTD>
                    <TerminalTD align="right" mono color="#888">
                      <Money value={sale.proceeds} />
                    </TerminalTD>
                    <TerminalTD align="right" mono color={gainColor(sale.realized_gain_loss)}>
                      <Money value={sale.realized_gain_loss} />
                    </TerminalTD>
                    <TerminalTD align="center">
                      <TerminalTag color={sale.is_long_term ? "#22c55e" : "#ffb84d"} variant="outline" size="xs">
                        {sale.is_long_term ? "LT" : "ST"}
                      </TerminalTag>
                    </TerminalTD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TerminalSection>
      )}

      {/* Trade Grades (from AI reviews) */}
      {tradeGrades.length > 0 && (
        <TerminalSection
          title={`AI Trade Grades · ${tradeGrades.length}`}
          action={
            <Link
              href="/dashboard/research?view=reviews"
              style={{
                fontFamily: "var(--font-mono), monospace",
                fontSize: "11px",
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#ffb84d",
              }}
              className="hover:underline"
            >
              All reviews →
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <TerminalTH align="center">Grade</TerminalTH>
                  <TerminalTH>Entry</TerminalTH>
                  <TerminalTH>Exit</TerminalTH>
                  <TerminalTH align="right">Days</TerminalTH>
                  <TerminalTH align="right">P&amp;L</TerminalTH>
                  <TerminalTH align="right">Return</TerminalTH>
                </tr>
              </thead>
              <tbody>
                {tradeGrades.map((tg, i) => {
                  const gradeColor = (g: string | null) => {
                    if (g === "A" || g === "B") return "#22c55e";
                    if (g === "C") return "#ffb84d";
                    if (g === "D" || g === "F") return "#ef4444";
                    return "#666";
                  };
                  return (
                    <tr key={i}>
                      <TerminalTD align="center">
                        {tg.grade ? (
                          <TerminalTag color={gradeColor(tg.grade)}>
                            {tg.grade}
                          </TerminalTag>
                        ) : (
                          <span style={{ color: "#555" }}>—</span>
                        )}
                      </TerminalTD>
                      <TerminalTD mono color="#888">{tg.entry_date}</TerminalTD>
                      <TerminalTD mono color="#888">{tg.exit_date}</TerminalTD>
                      <TerminalTD align="right" mono color="#888">{tg.holding_days}</TerminalTD>
                      <TerminalTD align="right" mono color={gainColor(tg.realized_pnl)}>
                        <Money value={tg.realized_pnl} />
                      </TerminalTD>
                      <TerminalTD align="right" mono color={gainColor(tg.return_pct)}>
                        <Pct value={tg.return_pct} digits={1} signed />
                      </TerminalTD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {tradeGrades.some(tg => tg.entry_thesis) && (
            <div style={{ borderTop: "1px solid #1f1f1f", padding: "14px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              {tradeGrades.filter(tg => tg.entry_thesis || tg.exit_assessment).map((tg, i) => {
                const gradeColor = (g: string | null) => {
                  if (g === "A" || g === "B") return "#22c55e";
                  if (g === "C") return "#ffb84d";
                  if (g === "D" || g === "F") return "#ef4444";
                  return "#666";
                };
                return (
                  <div key={i} style={{ fontFamily: "Geist, system-ui, sans-serif", fontSize: "14px", lineHeight: 1.55 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      {tg.grade && (
                        <TerminalTag color={gradeColor(tg.grade)} size="xs">
                          {tg.grade}
                        </TerminalTag>
                      )}
                      <span style={{ color: "#666", fontFamily: "var(--font-mono), monospace", fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                        {tg.entry_date} → {tg.exit_date}
                      </span>
                    </div>
                    {tg.entry_thesis && (
                      <p style={{ color: "#bbb", marginBottom: "3px" }}>
                        <span style={{ color: "#666", fontFamily: "var(--font-mono), monospace", fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", marginRight: "0.5em" }}>Entry</span>
                        {tg.entry_thesis}
                      </p>
                    )}
                    {tg.exit_assessment && (
                      <p style={{ color: "#bbb" }}>
                        <span style={{ color: "#666", fontFamily: "var(--font-mono), monospace", fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", marginRight: "0.5em" }}>Exit</span>
                        {tg.exit_assessment}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TerminalSection>
      )}

      {/* Recent Transactions (client component — handles account + stock/option filters) */}
      <TransactionsSection
        stockTransactions={recentTransactions}
        optionTransactions={relatedOptionTransactions}
      />


      {/* Notes & Theses */}
      {notes.length > 0 && (
        <TerminalSection
          title={`Notes & Theses · ${notes.length}`}
          action={
            <Link
              href={`/dashboard/research?security=${securityId}`}
              style={{
                fontFamily: "var(--font-mono), monospace",
                fontSize: "11px",
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#ffb84d",
              }}
              className="hover:underline"
            >
              View all →
            </Link>
          }
        >
          <div>
            {notes.slice(0, 5).map((note, idx) => {
              const noteColor = note.note_type === "trade_thesis"
                ? "#22c55e"
                : note.note_type === "earnings"
                  ? "#60a5fa"
                  : "#ffb84d";
              const noteLabel = note.note_type === "trade_thesis"
                ? "Thesis"
                : note.note_type === "earnings"
                  ? "Earnings"
                  : "Journal";
              return (
                <div
                  key={note.id}
                  style={{
                    padding: "14px 20px",
                    borderTop: idx === 0 ? undefined : "1px solid #161616",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <TerminalTag color={noteColor} size="xs">
                      {noteLabel}
                    </TerminalTag>
                    <span
                      style={{
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: "11px",
                        color: "#666",
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                      }}
                    >
                      {note.event_date}
                    </span>
                    {note.sentiment && (
                      <span
                        style={{
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "11px",
                          color: "#888",
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                        }}
                      >
                        · {note.sentiment}
                      </span>
                    )}
                  </div>
                  <p
                    className="line-clamp-2"
                    style={{
                      fontFamily: "Geist, system-ui, sans-serif",
                      fontSize: "14px",
                      lineHeight: 1.55,
                      color: "#bbb",
                    }}
                  >
                    {note.content}
                  </p>
                </div>
              );
            })}
          </div>
        </TerminalSection>
      )}

      {/* Research Documents (uploaded PDFs mentioning this security) */}
      <ResearchDocumentsPanel
        symbol={security.symbol}
        documents={researchDocuments}
      />

      {/* Research Mentions — client component handles filtering URL-fragment
          false positives, inline expansion, and click-through to article. */}
      <ResearchMentionsSection ticker={security.symbol} mentions={researchMentions} />


      {/* Upcoming Events */}
      {upcomingEvents.length > 0 && (
        <TerminalSection title="Upcoming Events" dense>
          <div>
            {upcomingEvents.map((event, idx) => {
              const impactColor =
                event.expected_impact === "high"
                  ? "#ef4444"
                  : event.expected_impact === "medium"
                    ? "#ffb84d"
                    : "#666";
              return (
                <div
                  key={event.id}
                  style={{
                    padding: "11px 20px",
                    borderTop: idx === 0 ? undefined : "1px solid #161616",
                    display: "flex",
                    alignItems: "center",
                    gap: "14px",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "12px",
                      color: "#888",
                      letterSpacing: "0.1em",
                      width: "90px",
                      flexShrink: 0,
                    }}
                  >
                    {event.event_date}
                  </div>
                  <TerminalTag color={impactColor} variant="outline" size="xs">
                    {event.event_type.replace(/_/g, " ")}
                  </TerminalTag>
                  <span
                    className="truncate"
                    style={{
                      fontFamily: "Geist, system-ui, sans-serif",
                      fontSize: "14px",
                      color: "#ddd",
                    }}
                  >
                    {event.title}
                  </span>
                </div>
              );
            })}
          </div>
        </TerminalSection>
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
          <TerminalSection title={`Related Options · ${relatedOptions.length}`}>
            <div className="overflow-x-auto">
              <table className="w-full" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <TerminalTH>Type</TerminalTH>
                    <TerminalTH align="right">Strike</TerminalTH>
                    <TerminalTH>Expiration</TerminalTH>
                    <TerminalTH align="right">Qty</TerminalTH>
                  </tr>
                </thead>
                <tbody>
                  {relatedOptions.map((o) => (
                    <tr key={o.id}>
                      <TerminalTD>
                        <Link
                          href={`/dashboard/security/${o.id}`}
                          style={{ color: o.option_type === "CALL" ? "#22c55e" : "#ef4444", fontFamily: "var(--font-mono), monospace", fontWeight: 600 }}
                          className="hover:underline"
                        >
                          {o.option_type}
                        </Link>
                      </TerminalTD>
                      <TerminalTD align="right" mono>
                        <Money value={o.strike_price} precise />
                      </TerminalTD>
                      <TerminalTD mono color="#888">{o.expiration_date}</TerminalTD>
                      <TerminalTD align="right" mono color={o.quantity < 0 ? "#ef4444" : "#ddd"}>
                        {o.quantity > 0 ? "+" : ""}<Shares value={o.quantity} />
                      </TerminalTD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TerminalSection>
        );
      })()}

      {/* Corporate Actions */}
      <CorporateActionsSection securityId={security.id} symbol={security.symbol} />

      {/* Factor Exposure */}
      {factors && (
        <TerminalSection title="Factor Exposure">
          <div
            className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3"
            style={{ padding: "18px 20px" }}
          >
            {FACTOR_COLUMNS.map((col) => {
              const value = factors[col as keyof typeof factors] as string | null;
              if (!value || value === "Unknown") return null;
              return (
                <div key={col} className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 shrink-0"
                    style={{ background: getFactorColor(value), borderRadius: "2px" }}
                  />
                  <span
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "11px",
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: "#888",
                    }}
                  >
                    {FACTOR_LABELS[col as FactorColumn]}
                  </span>
                  <span
                    style={{
                      fontFamily: "Geist, system-ui, sans-serif",
                      fontSize: "14px",
                      color: "#ddd",
                      fontWeight: 500,
                      marginLeft: "auto",
                    }}
                  >
                    {value}
                  </span>
                </div>
              );
            })}
          </div>
        </TerminalSection>
      )}

      {/* Transcripts */}
      {transcripts.length > 0 && (
        <TerminalSection title={`Earnings Transcripts · ${transcripts.length}`}>
          <div>
            {transcripts.slice(0, 4).map((t, idx) => {
              const sentimentColor = t.sentiment_label === "positive"
                ? "#22c55e"
                : t.sentiment_label === "negative"
                  ? "#ef4444"
                  : "#888";
              return (
                <div
                  key={t.id}
                  style={{
                    padding: "14px 20px",
                    borderTop: idx === 0 ? undefined : "1px solid #161616",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span
                      style={{
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "#eee",
                        letterSpacing: "0.02em",
                      }}
                    >
                      Q{t.quarter} {t.year}
                    </span>
                    {t.sentiment_label && (
                      <TerminalTag color={sentimentColor} variant="outline" size="xs">
                        {t.sentiment_label}
                      </TerminalTag>
                    )}
                    <span
                      style={{
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: "11px",
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                        color: "#666",
                        marginLeft: "auto",
                      }}
                    >
                      {t.source}
                    </span>
                  </div>
                  {t.summary && (
                    <p
                      className="line-clamp-2"
                      style={{
                        fontFamily: "Geist, system-ui, sans-serif",
                        fontSize: "14px",
                        lineHeight: 1.55,
                        color: "#bbb",
                      }}
                    >
                      {t.summary}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </TerminalSection>
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
