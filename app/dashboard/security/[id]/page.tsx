export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { unrealizedGainRatio } from "@/lib/format";
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
import { Section } from "../../components/Section";
import { SecurityEarningsEmails } from "../../components/SecurityEarningsEmails";
import { getSentEarningsEmails } from "@/lib/queries/earnings-emails";
import { Chip, type ChipTone } from "../../components/Chip";
import { HoldingPeriodBadge } from "../../components/HoldingPeriodBadge";
import { TranscriptsRefreshButton } from "./TranscriptsRefreshButton";
import { FactorProfileSection } from "./FactorProfileSection";
import { computeSecurityFactorShare } from "@/lib/compute/factors";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import { QuoteStats } from "../../components/QuoteStats";
import { Money, Pct, Shares } from "@/lib/privacy/components";
import type { EarningsTranscript } from "@/lib/types";

function gainClass(value: number | null): string {
  if (value == null) return "text-ink-dim";
  return value >= 0 ? "text-up" : "text-down";
}

function gradeTone(g: string | null): ChipTone {
  if (g === "A" || g === "B") return "up";
  if (g === "C") return "gold";
  if (g === "D" || g === "F") return "down";
  return "neutral";
}

function impactTone(impact: string | null | undefined): ChipTone {
  if (impact === "high") return "down";
  if (impact === "medium") return "gold";
  return "neutral";
}

function noteTone(noteType: string | null): ChipTone {
  if (noteType === "trade_thesis") return "up";
  if (noteType === "earnings") return "info";
  return "gold";
}

function noteLabel(noteType: string | null): string {
  // trade_thesis is presented as "Stock note" app-wide (2026-06-09 Notes
  // rework): the DB value stays for compat, but the type's scope broadened
  // from formal theses to any stock-specific thought — position notes,
  // thesis updates, "why I'm watching this". Journal = market psychology.
  if (noteType === "trade_thesis") return "Stock note";
  if (noteType === "earnings") return "Earnings";
  return "Journal";
}

function sentimentTone(s: string | null | undefined): ChipTone {
  if (s === "positive" || s === "bullish") return "up";
  if (s === "negative" || s === "bearish") return "down";
  return "neutral";
}

/** Uppercase-label + value cell, used in the option-contract strip. */
function OptionCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono uppercase text-ink-faint mb-1" style={{ fontSize: "11px", letterSpacing: "0.22em" }}>
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

const TH_CLASS =
  "px-4 py-2.5 text-left text-xs font-medium text-ink-faint uppercase tracking-wider bg-raised border-b border-edge";
const TH_RIGHT = TH_CLASS.replace("text-left", "text-right");
const TH_CENTER = TH_CLASS.replace("text-left", "text-center");
const TD_CLASS = "px-4 py-2.5 text-sm text-ink border-b border-edge";
const TD_MONO = "px-4 py-2.5 text-sm text-ink font-mono tabular-nums border-b border-edge";

const TRANSCRIPTS_VISIBLE = 8;

function TranscriptRow({
  transcript: t,
  showTopBorder,
}: {
  transcript: EarningsTranscript;
  showTopBorder: boolean;
}) {
  return (
    <div className={`px-5 py-3.5 ${showTopBorder ? "border-t border-edge" : ""}`}>
      <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
        <span className="text-sm font-semibold text-ink font-mono">
          Q{t.quarter} {t.year}
        </span>
        {t.sentiment_label && (
          <Chip tone={sentimentTone(t.sentiment_label)} size="xs">
            {t.sentiment_label}
          </Chip>
        )}
        <span
          className="ml-auto font-mono uppercase text-ink-faint"
          style={{ fontSize: "11px", letterSpacing: "0.14em" }}
        >
          {t.source}
        </span>
      </div>
      {t.summary && (
        <p className="line-clamp-2 text-sm leading-snug text-ink-dim">{t.summary}</p>
      )}
    </div>
  );
}

function TranscriptList({ transcripts }: { transcripts: EarningsTranscript[] }) {
  const visible = transcripts.slice(0, TRANSCRIPTS_VISIBLE);
  const hidden = transcripts.slice(TRANSCRIPTS_VISIBLE);
  return (
    <div>
      {visible.map((t, idx) => (
        <TranscriptRow key={t.id} transcript={t} showTopBorder={idx > 0} />
      ))}
      {hidden.length > 0 && (
        <details>
          <summary
            className="px-5 py-2.5 border-t border-edge cursor-pointer font-mono uppercase text-ink-faint hover:text-ink-dim transition-colors"
            style={{ fontSize: "11px", letterSpacing: "0.18em" }}
          >
            Show {hidden.length} older
          </summary>
          {hidden.map((t) => (
            <TranscriptRow key={t.id} transcript={t} showTopBorder />
          ))}
        </details>
      )}
    </div>
  );
}

const ACTION_LINK_CLASS =
  "text-xs font-medium text-blue hover:brightness-110 transition-colors";

const ACTION_BUTTON_CLASS =
  "px-3 py-1.5 rounded-lg border border-edge text-xs font-medium text-ink hover:bg-raised transition-colors";

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

  const { security, price, kpis, positions, openTaxLots, closedSales, recentTransactions, relatedOptionTransactions, notes, upcomingEvents, factors, transcripts, tradeGrades, researchMentions } = detail;
  const watched = isOnWatchlist(db, securityId);
  const watchlistItem = watched ? getWatchlistItem(db, securityId) : null;

  const researchDocuments = security.symbol
    ? getResearchDocumentsForSymbol(db, security.symbol, 10)
    : [];

  // Block 3 of the Factor Profile — fast pure read over getFactorHeatmap, so
  // compute server-side and pass as a prop (no client fetch needed).
  const factorShare = computeSecurityFactorShare(db, securityId);

  // IBKR snapshot enrichment (IV / HV / 52-week range) — public market data,
  // null until a quote has been captured by the IBKR refresh.
  const quote = getSecurityQuote(db, securityId);

  const typeLabel = [
    security.security_type?.replace(/_/g, " "),
    security.sector,
    security.asset_class,
  ]
    .filter(Boolean)
    .join(" · ");

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
          chart, and levels. Designed to stay dark when the surrounding app is
          in light mode (intentional theme boundary). */}
      <MarketDataPanel
        securityId={securityId}
        symbol={security.symbol}
        name={security.name ?? null}
        typeLabel={typeLabel || null}
        currentPrice={price?.close_price ?? null}
        priceChange={price?.change ?? null}
        priceChangePct={price?.change_pct ?? null}
        priceDate={price?.date ?? null}
        kpis={kpis}
        usdPerUnit={detail.usdPerUnit}
        currency={security.currency}
      />

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={`/dashboard/charts?id=${securityId}`} className={ACTION_BUTTON_CLASS}>
          Full Chart
        </Link>
        {/* type+symbol prefill the composer (it never reads ?security= — that
            param only filters the notes list, which we keep for context).
            A bare ?security= link saved orphaned journal notes with
            security_id NULL — 4-time QA ledger finding. */}
        <Link
          href={`/dashboard/research?view=notes&type=trade_thesis&symbol=${encodeURIComponent(security.symbol)}&security=${securityId}`}
          className={ACTION_BUTTON_CLASS}
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

      {/* IBKR market-data snapshot strip — 52wk range + IV/HV (public data) */}
      <QuoteStats quote={quote} currentPrice={price?.close_price ?? null} usdPerUnit={detail.usdPerUnit} />

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
        <Section title="Option Contract">
          <div className="flex items-center gap-8 flex-wrap p-5">
            <OptionCell label="Underlying">
              <Link
                href={`/dashboard/security/${(() => {
                  const underlying = db
                    .prepare("SELECT id FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' LIMIT 1")
                    .get(security.underlying_symbol!) as { id: number } | undefined;
                  return underlying?.id ?? securityId;
                })()}`}
                className="text-gold font-mono font-semibold text-lg hover:underline"
              >
                {security.underlying_symbol}
              </Link>
            </OptionCell>
            <OptionCell label="Type">
              <span
                className={`font-mono font-semibold text-lg ${security.option_type === "CALL" ? "text-up" : "text-down"}`}
              >
                {security.option_type}
              </span>
            </OptionCell>
            {security.strike_price && (
              <OptionCell label="Strike">
                <span className="font-mono font-semibold text-lg text-ink tabular-nums">
                  <Money value={security.strike_price} precise />
                </span>
              </OptionCell>
            )}
            {security.expiration_date && (
              <OptionCell label="Expiration">
                <span className="font-mono font-semibold text-lg text-ink">
                  {security.expiration_date}
                  <span className="text-xs text-ink-faint ml-1.5">
                    ({Math.max(0, Math.floor((new Date(security.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))}d)
                  </span>
                </span>
              </OptionCell>
            )}
            <OptionCell label="Multiplier">
              <span className="font-mono font-semibold text-lg text-ink">{security.multiplier}x</span>
            </OptionCell>
          </div>
        </Section>
      )}

      {/* Factor Profile — qualitative chips + quantitative regression vs SPY +
          (deferred) portfolio-share contribution. Slotted below the
          hero/chart/option-contract and above the per-position detail rows
          per the P3 Slice B spec. */}
      <FactorProfileSection securityId={securityId} factors={factors} factorShare={factorShare} />

      {/* Alerts history for this security (auto-hides if empty). */}
      <RecentAlertsPanel securityId={securityId} />

      {/* Positions */}
      {positions.length > 0 && (
        <Section title="Positions">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Account</th>
                  <th className={TH_RIGHT}>Qty</th>
                  <th className={TH_RIGHT}>Cost Basis</th>
                  <th className={TH_RIGHT}>Value</th>
                  <th className={TH_RIGHT}>Gain</th>
                  <th className={TH_RIGHT}>%</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const ratio = unrealizedGainRatio(p.unrealized_gain, p.cost_basis);
                  const pct = ratio !== null ? ratio * 100 : null;
                  return (
                    <tr key={p.account_id}>
                      <td className={TD_CLASS}>{p.account_name}</td>
                      <td className={`${TD_MONO} text-right`}>
                        <Shares value={p.quantity} />
                      </td>
                      <td className={`${TD_MONO} text-right text-ink-dim`}>
                        <Money value={p.cost_basis} fallback="–" />
                      </td>
                      <td className={`${TD_MONO} text-right`}>
                        <Money value={p.current_value} fallback="–" />
                      </td>
                      <td className={`${TD_MONO} text-right ${gainClass(p.unrealized_gain)}`}>
                        <Money value={p.unrealized_gain} fallback="–" />
                      </td>
                      <td className={`${TD_MONO} text-right ${gainClass(pct)}`}>
                        <Pct value={pct} digits={2} signed fallback="–" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {positions.length > 1 && (
                <tfoot>
                  <tr className="bg-raised">
                    <td className={TD_CLASS}>
                      <span className="font-mono uppercase font-semibold text-xs tracking-wider">Total</span>
                    </td>
                    <td className={`${TD_MONO} text-right font-semibold`}>
                      <Shares value={positions.reduce((sum, p) => sum + p.quantity, 0)} />
                    </td>
                    <td className={`${TD_MONO} text-right text-ink-dim`}>
                      <Money value={detail.totalCostBasis} fallback="–" />
                    </td>
                    <td className={`${TD_MONO} text-right font-semibold`}>
                      <Money value={detail.totalValue} />
                    </td>
                    <td className={`${TD_MONO} text-right font-semibold ${gainClass(detail.totalUnrealizedGain)}`}>
                      <Money value={detail.totalUnrealizedGain} fallback="–" />
                    </td>
                    <td className={`${TD_MONO} text-right font-semibold ${gainClass(detail.totalUnrealizedGain)}`}>
                      {unrealizedGainRatio(detail.totalUnrealizedGain, detail.totalCostBasis) !== null ? (
                        <Pct
                          value={unrealizedGainRatio(detail.totalUnrealizedGain, detail.totalCostBasis)! * 100}
                          digits={2}
                          signed
                        />
                      ) : (
                        "–"
                      )}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Section>
      )}

      {/* Tax Lots */}
      {openTaxLots.length > 0 && (
        <Section
          title={`Open Tax Lots · ${openTaxLots.length}`}
          action={
            <Link href="/dashboard/tax-lots" className={ACTION_LINK_CLASS}>
              View all →
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Acquired</th>
                  <th className={TH_CLASS}>Account</th>
                  <th className={TH_RIGHT}>Qty</th>
                  <th className={TH_RIGHT}>Cost Basis</th>
                  <th className={TH_RIGHT}>Unrealized</th>
                  <th className={TH_CENTER}>Term</th>
                </tr>
              </thead>
              <tbody>
                {openTaxLots.map((lot) => {
                  const isLT = holdingPeriodLabel(lot.acquisition_date) === "LT";
                  return (
                    <tr key={lot.id}>
                      <td className={`${TD_MONO} text-ink-dim`}>{lot.acquisition_date}</td>
                      <td className={TD_CLASS}>{lot.account_name}</td>
                      <td className={`${TD_MONO} text-right`}>
                        <Shares value={lot.quantity_remaining} />
                      </td>
                      <td className={`${TD_MONO} text-right text-ink-dim`}>
                        <Money value={lot.adjusted_cost_basis} />
                      </td>
                      <td className={`${TD_MONO} text-right ${gainClass(lot.unrealized_gain)}`}>
                        <Money value={lot.unrealized_gain} fallback="–" />
                      </td>
                      <td className={`${TD_CLASS} text-center`}>
                        <Chip tone={isLT ? "up" : "gold"} size="xs" uppercase>
                          {isLT ? "LT" : "ST"}
                        </Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Closed Sales */}
      {closedSales.length > 0 && (
        <Section title={`Recent Sales · ${closedSales.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Sale Date</th>
                  <th className={TH_CLASS}>Account</th>
                  <th className={TH_RIGHT}>Qty</th>
                  <th className={TH_RIGHT}>Proceeds</th>
                  <th className={TH_RIGHT}>Realized</th>
                  <th className={TH_CENTER}>Term</th>
                </tr>
              </thead>
              <tbody>
                {closedSales.map((sale) => (
                  <tr key={sale.id}>
                    <td className={`${TD_MONO} text-ink-dim`}>{sale.sale_date}</td>
                    <td className={TD_CLASS}>{sale.account_name}</td>
                    <td className={`${TD_MONO} text-right`}>
                      <Shares value={sale.quantity_sold} />
                    </td>
                    <td className={`${TD_MONO} text-right text-ink-dim`}>
                      <Money value={sale.proceeds} />
                    </td>
                    <td className={`${TD_MONO} text-right ${gainClass(sale.realized_gain_loss)}`}>
                      <Money value={sale.realized_gain_loss} />
                    </td>
                    <td className={`${TD_CLASS} text-center`}>
                      <Chip tone={sale.is_long_term ? "up" : "gold"} size="xs" uppercase>
                        {sale.is_long_term ? "LT" : "ST"}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Trade Grades (from AI reviews) */}
      {tradeGrades.length > 0 && (
        <Section
          title={`AI Trade Grades · ${tradeGrades.length}`}
          action={
            <Link href="/dashboard/analysis?view=trade-reviews" className={ACTION_LINK_CLASS}>
              All reviews →
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH_CENTER}>Grade</th>
                  <th className={TH_CLASS}>Entry</th>
                  <th className={TH_CLASS}>Exit</th>
                  <th className={TH_RIGHT}>Days</th>
                  <th className={TH_RIGHT}>P&amp;L</th>
                  <th className={TH_RIGHT}>Return</th>
                </tr>
              </thead>
              <tbody>
                {tradeGrades.map((tg, i) => (
                  <tr key={i}>
                    <td className={`${TD_CLASS} text-center`}>
                      {tg.grade ? (
                        <Chip tone={gradeTone(tg.grade)}>{tg.grade}</Chip>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className={`${TD_MONO} text-ink-dim`}>{tg.entry_date}</td>
                    <td className={`${TD_MONO} text-ink-dim`}>{tg.exit_date}</td>
                    <td className={`${TD_MONO} text-right text-ink-dim`}>
                      <HoldingPeriodBadge days={tg.holding_days} className="font-sans" />
                    </td>
                    <td className={`${TD_MONO} text-right ${gainClass(tg.realized_pnl)}`}>
                      <Money value={tg.realized_pnl} />
                    </td>
                    <td className={`${TD_MONO} text-right ${gainClass(tg.return_pct)}`}>
                      <Pct value={tg.return_pct} digits={1} signed />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(() => {
            const visible = tradeGrades.filter(
              (tg) => tg.assessment || tg.what_went_well || tg.what_went_wrong
            );
            if (visible.length === 0) return null;

            return (
              <div className="border-t border-edge px-5 py-4 flex flex-col gap-3">
                {visible.map((tg, i) => {
                  const assessment = tg.assessment;
                  const whatWorked = tg.what_went_well;
                  const whatDidnt = tg.what_went_wrong;
                  return (
                    <div key={i} className="text-sm leading-snug">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        {tg.grade && <Chip tone={gradeTone(tg.grade)} size="xs">{tg.grade}</Chip>}
                        <span
                          className="font-mono uppercase text-ink-faint"
                          style={{ fontSize: "11px", letterSpacing: "0.14em" }}
                        >
                          {tg.entry_date} → {tg.exit_date}
                        </span>
                      </div>
                      {assessment && (
                        <p className="text-ink-dim mb-0.5">
                          <span
                            className="font-mono uppercase text-ink-faint mr-2"
                            style={{ fontSize: "12px", letterSpacing: "0.14em" }}
                          >
                            Assessment
                          </span>
                          {assessment}
                        </p>
                      )}
                      {whatWorked && (
                        <p className="text-up mb-0.5">
                          <span
                            className="font-mono uppercase text-ink-faint mr-2"
                            style={{ fontSize: "12px", letterSpacing: "0.14em" }}
                          >
                            Worked
                          </span>
                          {whatWorked}
                        </p>
                      )}
                      {whatDidnt && (
                        <p className="text-down">
                          <span
                            className="font-mono uppercase text-ink-faint mr-2"
                            style={{ fontSize: "12px", letterSpacing: "0.14em" }}
                          >
                            Didn&apos;t
                          </span>
                          {whatDidnt}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </Section>
      )}

      {/* Recent Transactions (client component — handles account + stock/option filters) */}
      <TransactionsSection
        stockTransactions={recentTransactions}
        optionTransactions={relatedOptionTransactions}
      />


      {/* Notes & Theses */}
      {notes.length > 0 && (
        <Section
          title={`Notes · ${notes.length}`}
          action={
            <span className="flex items-center gap-4">
              <Link
                href={`/dashboard/research?view=notes&type=trade_thesis&symbol=${encodeURIComponent(security.symbol)}`}
                className={ACTION_LINK_CLASS}
              >
                + Add note
              </Link>
              <Link href={`/dashboard/research?security=${securityId}`} className={ACTION_LINK_CLASS}>
                View all →
              </Link>
            </span>
          }
        >
          <div>
            {notes.slice(0, 5).map((note, idx) => (
              <div
                key={note.id}
                className={`px-5 py-3.5 ${idx === 0 ? "" : "border-t border-edge"}`}
              >
                <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                  <Chip tone={noteTone(note.note_type)} size="xs" uppercase>
                    {noteLabel(note.note_type)}
                  </Chip>
                  <span
                    className="font-mono uppercase text-ink-faint"
                    style={{ fontSize: "11px", letterSpacing: "0.14em" }}
                  >
                    {note.event_date}
                  </span>
                  {note.sentiment && (
                    <span
                      className="font-mono uppercase text-ink-faint"
                      style={{ fontSize: "11px", letterSpacing: "0.14em" }}
                    >
                      · {note.sentiment}
                    </span>
                  )}
                </div>
                <p className="line-clamp-2 text-sm leading-snug text-ink-dim">{note.content}</p>
              </div>
            ))}
          </div>
        </Section>
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
        <Section title="Upcoming Events" dense>
          <div>
            {upcomingEvents.map((event, idx) => (
              <div
                key={event.id}
                className={`px-5 py-2.5 flex items-center gap-3.5 ${idx === 0 ? "" : "border-t border-edge"}`}
              >
                <div
                  className="font-mono text-ink-dim flex-shrink-0"
                  style={{ fontSize: "12px", letterSpacing: "0.1em", width: "90px" }}
                >
                  {event.event_date}
                </div>
                <Chip tone={impactTone(event.expected_impact)} size="xs" uppercase>
                  {event.event_type.replace(/_/g, " ")}
                </Chip>
                <span className="truncate text-sm text-ink">{event.title}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Sent earnings emails — family-aware archive rows, rendered only
          when at least one preview/recap was sent for this issuer family. */}
      {(() => {
        if (!security.symbol) return null;
        const sentEmails = getSentEarningsEmails(db, { symbol: security.symbol });
        if (sentEmails.length === 0) return null;
        return (
          <Section title={`Earnings Emails · ${sentEmails.length}`} dense>
            <SecurityEarningsEmails emails={sentEmails} />
          </Section>
        );
      })()}

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
          <Section title={`Related Options · ${relatedOptions.length}`}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>Type</th>
                    <th className={TH_RIGHT}>Strike</th>
                    <th className={TH_CLASS}>Expiration</th>
                    <th className={TH_RIGHT}>Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedOptions.map((o) => (
                    <tr key={o.id}>
                      <td className={TD_CLASS}>
                        <Link
                          href={`/dashboard/security/${o.id}`}
                          className={`font-mono font-semibold hover:underline ${o.option_type === "CALL" ? "text-up" : "text-down"}`}
                        >
                          {o.option_type}
                        </Link>
                      </td>
                      <td className={`${TD_MONO} text-right`}>
                        <Money value={o.strike_price} precise />
                      </td>
                      <td className={`${TD_MONO} text-ink-dim`}>{o.expiration_date}</td>
                      <td className={`${TD_MONO} text-right ${o.quantity < 0 ? "text-down" : "text-ink"}`}>
                        {o.quantity > 0 ? "+" : ""}<Shares value={o.quantity} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        );
      })()}

      {/* Corporate Actions */}
      <CorporateActionsSection securityId={security.id} symbol={security.symbol} />

      {/* Factor Exposure — now superseded by <FactorProfileSection> above
          (see Slice B / B4). Kept removed to avoid showing the same data
          twice on the page. */}

      {/* Transcripts. Always rendered — when the cache is empty we show an
          intentional empty state with the refresh button instead of silently
          hiding the section. The first 8 are visible by default; if more
          are cached, a native `<details>` reveals the rest. */}
      <Section
        title={
          transcripts.length > 0
            ? `Earnings Transcripts · ${transcripts.length}`
            : "Earnings Transcripts"
        }
        action={<TranscriptsRefreshButton ticker={security.symbol} />}
      >
        {transcripts.length === 0 ? (
          <div className="px-5 py-5 text-sm text-ink-dim leading-relaxed">
            <p>No earnings transcripts cached for {security.symbol}.</p>
            <p className="mt-2 text-xs text-ink-faint">
              Click <span className="text-ink-dim">↻ refresh</span> to fetch the most recent
              quarter. Sources tried in order: API Ninjas (paid) → Motley Fool → SEC EDGAR 8-K
              (free, fiscal-quarter matched).
            </p>
          </div>
        ) : (
          <TranscriptList transcripts={transcripts} />
        )}
      </Section>

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
              className="mt-3 inline-block px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-[filter,scale] active:scale-[0.96]"
            >
              Import Files
            </Link>
          </div>
        )}
    </div>
  );
}
