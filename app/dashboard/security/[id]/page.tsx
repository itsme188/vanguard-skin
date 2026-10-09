export const dynamic = "force-dynamic";

import { GOLD_FILL_CLASSES } from "@/app/dashboard/components/chip-tone-text";
import { db } from "@/lib/db";
import { unrealizedGainRatio } from "@/lib/format";
import { assetClassLabel, getSecurityDetail, transcriptPreviewText } from "@/lib/queries/security-detail";
import { MarkdownMessage } from "../../components/MarkdownMessage";
import { isOnWatchlist, getWatchlistItem } from "@/lib/queries/watchlist";
import { getResearchDocumentsForSymbol } from "@/lib/queries/research-documents";
import { ResearchDocumentsPanel } from "../../components/ResearchDocumentsPanel";
import { ScrollFade } from "../../components/ScrollFade";
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
import { PENDING_STATEMENT_CHIP_LABEL, PENDING_STATEMENT_TITLE } from "../../components/pending-statement-copy";
import { HoldingPeriodBadge } from "../../components/HoldingPeriodBadge";
import { TranscriptsRefreshButton } from "./TranscriptsRefreshButton";
import { FactorProfileSection } from "./FactorProfileSection";
import { tradeGradeGroupCaption } from "./trade-grade-group";
import { computeSecurityFactorShareView } from "@/lib/compute/factors";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import { QuoteStats } from "../../components/QuoteStats";
import { Count, Money, Pct, Shares, PrivateText, QuantityUnit } from "@/lib/privacy/components";
import { computeBasisDisagreements, computeLotCoverageGaps, computeLotSignMismatches } from "@/lib/compute/lot-coverage";
import { getTranscriptsForSecurity } from "@/lib/queries/transcripts";
import { daysToExpiry, liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import type { EarningsTranscript } from "@/lib/types";
import { resolveOptionUnderlying } from "@/lib/queries/securities";
import { getNotesForSecurity } from "@/lib/queries/notes";
import { hasDeskNote, isFilingRow, kindLabel } from "@/lib/transcripts/presentation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { EarningsConflictMarker } from "../../components/calendar/EarningsConflictMarker";
// DISPLAY ONLY (user ruling 2026-10-06): the usual time / "time unknown" for a
// slot-less earnings row. app/** is an allowed importer.
import { displayEarningsTime } from "@/lib/calendar/display-earnings-time";
import { expiredContractQuantity, recentSalesTaxLotsLink } from "./tax-lot-wording";

const GROSS_GAIN_PERCENT_TOOLTIP =
  "Gain % uses gross cost basis (absolute long basis plus short proceeds) when a short is present.";

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

/**
 * "read ▾" / "collapse ▴" under a clamped card — a full-height tap target.
 * No display utility here: each label sets its own, so `hidden` never has to
 * beat an `inline-block` on the same element (both labels used to show).
 */
const EXPANDER_CLASS =
  "mt-1 py-1.5 text-xs font-medium text-blue hover:brightness-110 transition-colors";

/** A note longer than this (or with a line break) is clamped and gets an expander. */
const NOTE_CLAMP_CHARS = 160;

/**
 * One cached row. An `edgar_8k` row is the SEC 8-K earnings press release, not
 * a call transcript, and its `summary` is only an AI desk note when the filing
 * was fat enough to summarize — so the badge names the KIND (never the raw
 * `source` token) and the analysis surfaces (summary + sentiment chip) render
 * only when there is something real behind them. Same rules, same wording as
 * the Research-wall card: lib/transcripts/presentation.ts.
 */
function TranscriptRow({
  transcript: t,
  showTopBorder,
}: {
  transcript: EarningsTranscript;
  showTopBorder: boolean;
}) {
  const showAnalysis = !isFilingRow(t) || hasDeskNote(t);
  return (
    <div className={`px-5 py-3.5 ${showTopBorder ? "border-t border-edge" : ""}`}>
      <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
        <span className="text-sm font-semibold text-ink font-mono">
          Q{t.quarter} {t.year}
        </span>
        {showAnalysis && t.sentiment_label && (
          <Chip tone={sentimentTone(t.sentiment_label)} size="xs">
            {t.sentiment_label}
          </Chip>
        )}
        <span
          className="ml-auto font-mono uppercase text-ink-faint"
          style={{ fontSize: "11px", letterSpacing: "0.14em" }}
        >
          {kindLabel(t)}
        </span>
      </div>
      {/* Collapsed: two lines of real prose (transcriptPreviewText skips the
          markdown title and the operator's dial-in turn). Open: the desk note
          rendered as markdown, or the stored excerpt as written. Native
          <details>, so this server component needs no client state. */}
      {showAnalysis && t.summary && (
        <details className="group">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <span className="line-clamp-2 text-sm leading-snug text-ink-dim group-open:hidden">
              {transcriptPreviewText(t.summary)}
            </span>
            <span className={`${EXPANDER_CLASS} inline-block group-open:hidden`}>read ▾</span>
            <span className={`${EXPANDER_CLASS} hidden group-open:inline-block`}>collapse ▴</span>
          </summary>
          <div className="mt-2 text-sm leading-snug text-ink-dim">
            {hasDeskNote(t) ? (
              <MarkdownMessage content={t.summary} />
            ) : (
              <p className="whitespace-pre-wrap">{t.summary}</p>
            )}
          </div>
        </details>
      )}
      {!showAnalysis && (
        <p className="text-xs italic leading-snug text-ink-faint">
          SEC 8-K filing — no call transcript is cached for this quarter.
        </p>
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

// Browser-tab title (qa:page-head--same-tab-title-every-route-...).
// No symbol here on purpose: a tab title is readable over the shoulder even
// in privacy mode.
export const metadata = { title: "Security" };

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

  const { security, price, kpis, positions, openTaxLots, expiredOptionLotsAwaitingClose, closedSales, closedSalesTotal, recentTransactions, relatedOptionTransactions, notes, upcomingEvents, factors, transcripts, tradeGrades, tradeGradesExcluded, researchMentions, researchMentionsTotal } = detail;

  const expiredContracts = expiredContractQuantity(expiredOptionLotsAwaitingClose);
  // The Tax Lots page shows one sale year at a time, so the link under Recent
  // Sales names the year of this security's newest sale.
  const recentSalesLink = recentSalesTaxLotsLink(securityId, closedSales);

  // Per-account reconciliation: a position's quantity should equal the sum of
  // that account's open tax lots. Statement import and computeTaxLots are
  // independent pipelines, so they can silently drift (partial lot backfill,
  // or a whole account leg with no lots at all) — surfaced here rather than
  // left as an unexplained contradiction between the two sections below.
  const lotCoverageGaps = computeLotCoverageGaps(positions, openTaxLots);
  // The other half of that reconciliation: accounts with open lots and NO
  // position row. They get a line inside the Positions frame, so the lots
  // table below never stands alone and unexplained.
  const { lotsWithoutPosition, positionsWithoutBasis, unknownBasisLotNotes, expiredOptionSnapshotRows } = detail;
  // A short position over long open lots: the coverage check skips shorts, so
  // the contradiction is named on its own line above the lots table.
  const lotSignMismatches = computeLotSignMismatches(positions, openTaxLots);
  // Lots fully cover the position yet their basis differs from the holding's
  // (broker) basis: disclosed in Positions, nothing recomputed.
  // Stocks and funds only for now: a bond holding's basis can be on a
  // per-100-face convention and an option's carries the multiplier, while lots
  // store economic dollars, so those two could show a false difference until
  // their units are checked against real rows.
  const basisNoteApplies = ["stock", "etf", "mutual fund"].includes(
    (security.security_type ?? "").toLowerCase(),
  );
  const basisDisagreements = basisNoteApplies
    ? computeBasisDisagreements(positions, openTaxLots, { usdPerUnit: detail.usdPerUnit })
    : [];
  // Value sums every position; cost basis, gain and % sum only the ones with
  // a known basis. When some are left out the three figures are marked "~"
  // and a line under the table names what they leave out.
  const totalIsPartial = positionsWithoutBasis.length > 0 && detail.totalCostBasis !== null;
  const partialMark = totalIsPartial ? "~" : "";
  const totalGainHasShort = positions.some((p) => p.unrealized_gain !== null && (p.cost_basis ?? 0) < 0);

  // Option hubs: notes are filed under the UNDERLYING (the composer has no
  // option picker). Resolve it through the existing option→underlying relation.
  const isOptionHub = (security.security_type ?? "").toLowerCase() === "option";
  const optionUnderlying = isOptionHub ? resolveOptionUnderlying(db, securityId) : null;
  const underlyingNotes = optionUnderlying ? getNotesForSecurity(db, optionUnderlying.id) : [];
  const underlyingNoteIds = new Set(underlyingNotes.map((n) => n.id));
  // Newest first by the displayed date; created_at breaks same-day ties.
  const shownNotes = [...notes, ...underlyingNotes].sort(
    (a, b) =>
      b.event_date.localeCompare(a.event_date) ||
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  // An option contract has no earnings calls. Its hub shows the UNDERLYING's
  // transcripts and points the refresh at the underlying's symbol, so the
  // fetch (and its cache) is the one the underlying's own hub uses.
  const shownTranscripts = isOptionHub
    ? optionUnderlying
      ? getTranscriptsForSecurity(db, optionUnderlying.id)
      : []
    : transcripts;
  const transcriptSymbol = isOptionHub ? optionUnderlying?.symbol ?? null : security.symbol;
  const noteComposerHref = isOptionHub
    ? optionUnderlying
      ? `/dashboard/research?view=notes&type=trade_thesis&symbol=${encodeURIComponent(optionUnderlying.symbol)}&security=${optionUnderlying.id}&via=option`
      : `/dashboard/research?view=notes&type=trade_thesis&via=option`
    : `/dashboard/research?view=notes&type=trade_thesis&symbol=${encodeURIComponent(security.symbol)}&security=${securityId}`;

  const watched = isOnWatchlist(db, securityId);
  const watchlistItem = watched ? getWatchlistItem(db, securityId) : null;

  const researchDocuments = security.symbol
    ? getResearchDocumentsForSymbol(db, security.symbol, 10)
    : [];

  // Block 3 of the Factor Profile — fast pure read over getFactorHeatmap, so
  // compute server-side and pass as a prop (no client fetch needed).
  const factorShareView = computeSecurityFactorShareView(db, securityId);

  // IBKR snapshot enrichment (IV / HV / 52-week range) — public market data,
  // null until a quote has been captured by the IBKR refresh.
  const quote = getSecurityQuote(db, securityId);

  const typeLabel = [
    security.security_type?.replace(/_/g, " "),
    security.sector,
    assetClassLabel(security.asset_class),
  ]
    .filter(Boolean)
    // "Option · Option": the asset class often repeats the type.
    .filter((part, i, parts) => parts.findIndex((q) => q!.toLowerCase() === part!.toLowerCase()) === i)
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
        securityType={security.security_type}
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
          href={noteComposerHref}
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
      <QuoteStats
        quote={quote}
        // The same range object the stats strip above prints (kpis.week52*).
        range={detail.week52}
        currentPrice={price?.close_price ?? null}
        usdPerUnit={detail.usdPerUnit}
      />

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
                    {(() => {
                      const dte = daysToExpiry(security.expiration_date);
                      // Unreadable stored date: show it as stored, with no day count.
                      if (dte === null) return null;
                      return dte < 0 ? "(expired)" : `(${dte}d)`;
                    })()}
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
      <FactorProfileSection securityId={securityId} factors={factors} factorShare={factorShareView.entries} positionHeld={factorShareView.held} siblingHeldSymbols={factorShareView.siblingHeldSymbols} />

      {/* Alerts history for this security (auto-hides if empty). */}
      <RecentAlertsPanel securityId={securityId} />

      {/* Positions */}
      {(positions.length > 0 || lotsWithoutPosition.length > 0) && (
        <Section title="Positions">
          {positions.length > 0 && (
          <ScrollFade>
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
                      {partialMark}
                      <Money value={detail.totalCostBasis} fallback="–" />
                    </td>
                    <td className={`${TD_MONO} text-right font-semibold`}>
                      <Money value={detail.totalValue} />
                    </td>
                    <td className={`${TD_MONO} text-right font-semibold ${gainClass(detail.totalUnrealizedGain)}`}>
                      {detail.totalUnrealizedGain !== null && partialMark}
                      <Money value={detail.totalUnrealizedGain} fallback="–" />
                    </td>
                    {/* Gain over GROSS basis (|long basis| + |short proceeds|)
                        of the positions that are in the gain — a short's
                        negative basis must never shrink the denominator. */}
                    <td
                      className={`${TD_MONO} text-right font-semibold ${gainClass(detail.totalUnrealizedGain)}`}
                      title={totalGainHasShort ? GROSS_GAIN_PERCENT_TOOLTIP : undefined}
                    >
                      {detail.totalGainRatio !== null ? (
                        <>
                          {partialMark}
                          <Pct value={detail.totalGainRatio * 100} digits={2} signed />
                        </>
                      ) : (
                        "–"
                      )}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </ScrollFade>
          )}
          {positions.length > 1 && totalIsPartial && (
            <p className="px-5 py-3 border-t border-edge text-xs text-ink-faint">
              ~ Total cost basis, gain and % leave out{" "}
              {positionsWithoutBasis.map((p, i) => (
                <span key={p.account_id}>
                  {i > 0 && ", "}
                  <span className="text-ink-dim">{p.account_name}</span> (<Shares value={p.quantity} />{" "}
                  <QuantityUnit securityType={security.security_type} quantity={p.quantity} />)
                </span>
              ))}
              : cost basis unknown.
              {detail.gainCoveredValue !== null && (
                <>
                  {" "}They cover <Money value={detail.gainCoveredValue} /> of the{" "}
                  <Money value={detail.totalValue} /> total value.
                </>
              )}
            </p>
          )}
          {unknownBasisLotNotes.length > 0 && (
            <div className="px-5 py-3 border-t border-edge flex flex-col gap-1">
              {unknownBasisLotNotes.map((note) => (
                <p key={note.accountId} className="text-xs text-ink-faint">
                  <span className="text-ink-dim">{note.accountName}</span>: cost basis and gain are unknown
                  here because the holdings row carries no cost basis. Open-lot cost basis below: <Money value={note.lotCostBasis} /> for{" "}
                  <Shares value={note.lotQty} />{" "}
                  <QuantityUnit securityType={security.security_type} quantity={note.lotQty} />; this row
                  does not use that figure.
                </p>
              ))}
            </div>
          )}
          {basisDisagreements.length > 0 && (
            <div className="px-5 py-3 border-t border-edge flex flex-col gap-1">
              {basisDisagreements.map((d) => (
                <p key={d.accountId} className="text-xs text-ink-faint">
                  <span className="text-ink-dim">{d.accountName}</span>: Broker-reported basis differs from
                  the ledger lots by <Money value={Math.abs(d.difference)} />.
                </p>
              ))}
              <p className="text-xs text-ink-faint">
                Common causes: a different lot-relief method at the broker, wash-sale adjustments the
                broker carries, or reinvested-dividend lots.
              </p>
            </div>
          )}
          {lotsWithoutPosition.length > 0 && (
            <div className={`px-5 py-3 flex flex-col gap-1 ${positions.length > 0 ? "border-t border-edge" : ""}`}>
              {lotsWithoutPosition.map((orphan) => (
                <p key={orphan.accountId} className="text-xs text-ink-faint">
                  <span className="text-ink-dim">{orphan.accountName}</span>: no current position, yet the
                  ledger still holds open{" "}
                  {orphan.shortLotCount === orphan.lotCount ? "short-sale lots" : "lots"} here:{" "}
                  <Count value={orphan.lotCount} /> (<Shares value={orphan.quantity} />{" "}
                  <QuantityUnit securityType={security.security_type} quantity={orphan.quantity} />).{" "}
                  {orphan.allPendingStatement
                    ? "The broker's live data shows the position closed; the lots stay open until the statement with the closing trade is imported."
                    : "Either the closing trade is missing from the ledger, or Recompute (Tax Lots page) has not run since it was imported."}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Tax Lots */}
      {(openTaxLots.length > 0 || expiredOptionLotsAwaitingClose.length > 0 || lotCoverageGaps.length > 0) && (
        <Section
          title={
            <>
              Open Tax Lots · <Count value={openTaxLots.length} />
            </>
          }
          action={
            <Link href={`/dashboard/tax-lots?security=${securityId}`} className={ACTION_LINK_CLASS}>
              Open in Tax Lots →
            </Link>
          }
        >
          {lotCoverageGaps.length > 0 && (
            <div className="px-5 py-3 border-b border-edge flex flex-col gap-1">
              {lotCoverageGaps.map((gap) => (
                <p key={gap.accountId} className="text-xs text-ink-faint">
                  <span className="text-ink-dim">{gap.accountName}</span>: lots cover{" "}
                  <Shares value={gap.coveredQty} /> of <Shares value={gap.positionQty} />{" "}
                  <QuantityUnit securityType={security.security_type} quantity={gap.positionQty} />
                  {" — "}
                  {gap.missingQty > 0 ? (
                    <>
                      no cost-basis history for <Shares value={gap.missingQty} />{" "}
                      <QuantityUnit securityType={security.security_type} quantity={gap.missingQty} />
                    </>
                  ) : (
                    <>
                      <Shares value={Math.abs(gap.missingQty)} /> more{" "}
                      <QuantityUnit securityType={security.security_type} quantity={gap.missingQty} />{" "}
                      in lots than the position shows
                    </>
                  )}
                </p>
              ))}
            </div>
          )}
          {lotSignMismatches.length > 0 && (
            <div className="px-5 py-3 border-b border-edge flex flex-col gap-1">
              {lotSignMismatches.map((m) => (
                <p key={m.accountId} className="text-xs text-ink-faint">
                  <span className="text-ink-dim">{m.accountName}</span>: the position is short{" "}
                  <Shares value={Math.abs(m.positionQty)} />{" "}
                  <QuantityUnit securityType={security.security_type} quantity={m.positionQty} />, yet the
                  ledger holds <Shares value={m.longLotQty} /> long (open lots: <Count value={m.longLotCount} />).
                  The two are not reconciled, so the position&apos;s
                  gain above and the lots&apos; gain below cannot both be right.
                </p>
              ))}
            </div>
          )}
          {expiredOptionLotsAwaitingClose.length > 0 && (
            <p className="px-5 py-3 border-b border-edge text-xs text-ink-dim">
              {/* Contracts, not lots (two purchases of one series are two
                  lots), and no "is / are" beside the figure: under Hide
                  amounts the wording must not say whether it is one. Only an
                  option has an expiration, so the unit is the option's. */}
              Expired and awaiting a closing entry: <Shares value={expiredContracts} />{" "}
              <QuantityUnit securityType="Option" quantity={expiredContracts} />.
            </p>
          )}
          {openTaxLots.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-faint">
              No open tax lots on record for this security
              {lotCoverageGaps.length > 0 && (
                <>
                  {" "}— the position&apos;s{" "}
                  <QuantityUnit
                    securityType={security.security_type}
                    quantity={lotCoverageGaps.reduce((sum, gap) => sum + gap.positionQty, 0)}
                  />{" "}
                  above came from a holdings snapshot with no matching purchase in the ledger
                </>
              )}
              .
            </p>
          ) : (
          <ScrollFade>
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
                  const isLT = !lot.is_short && holdingPeriodLabel(lot.acquisition_date) === "LT";
                  return (
                    <tr key={lot.id}>
                      <td className={`${TD_MONO} text-ink-dim`}>
                        {lot.acquisition_date}
                        {/* Phone only: the Unrealized column, where the chip
                            stands in for the figure, is off-screen at phone
                            width, so the first column repeats it there. */}
                        {lot.pending_statement && (
                          <span className="block md:hidden mt-1 font-sans">
                            <Chip tone="neutral" size="xs" title={PENDING_STATEMENT_TITLE}>
                              {PENDING_STATEMENT_CHIP_LABEL}
                            </Chip>
                          </span>
                        )}
                      </td>
                      <td className={TD_CLASS}>{lot.account_name}</td>
                      <td className={`${TD_MONO} text-right`}>
                        <Shares value={lot.quantity_remaining} />
                      </td>
                      <td className={`${TD_MONO} text-right text-ink-dim`}>
                        <Money value={lot.adjusted_cost_basis} />
                      </td>
                      <td className={`${TD_MONO} text-right ${gainClass(lot.unrealized_gain)}`}>
                        {/* Pending statement: closed per live data, the
                            closing trade not imported yet. The shared read
                            model nulls its unrealized (not held), so the chip
                            stands in for the figure rather than a bare dash. */}
                        {lot.pending_statement ? (
                          <Chip tone="neutral" size="xs" title={PENDING_STATEMENT_TITLE}>
                            {PENDING_STATEMENT_CHIP_LABEL}
                          </Chip>
                        ) : (
                          <Money value={lot.unrealized_gain} fallback="–" />
                        )}
                      </td>
                      <td className={`${TD_CLASS} text-center`}>
                        <Chip tone={isLT ? "up" : "gold"} size="xs" uppercase>
                          {lot.is_short ? "Short sale" : isLT ? "LT" : "ST"}
                        </Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollFade>
          )}
        </Section>
      )}

      {/* Closed Sales */}
      {closedSales.length > 0 && (
        <Section
          title={
            closedSalesTotal > closedSales.length ? (
              <>
                Recent Sales · <Count value={closedSales.length} /> of <Count value={closedSalesTotal} />
              </>
            ) : (
              <>
                Recent Sales · <Count value={closedSales.length} />
              </>
            )
          }
          action={
            closedSalesTotal > closedSales.length ? (
              <Link href={recentSalesLink.href} className={ACTION_LINK_CLASS}>
                {recentSalesLink.label}
              </Link>
            ) : undefined
          }
        >
          <ScrollFade>
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
                      <span className="inline-flex items-center gap-1.5">
                        <Money value={sale.realized_gain_loss} />
                        {sale.is_synthetic_close && (
                          <Chip
                            tone="neutral"
                            size="xs"
                            title="This close is an engine-generated reconciliation entry (no matching broker sale) — the realized figure is estimated."
                          >
                            Estimated
                          </Chip>
                        )}
                      </span>
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
          </ScrollFade>
        </Section>
      )}

      {/* Trade Grades (from AI reviews) */}
      {(tradeGrades.length > 0 || tradeGradesExcluded > 0) && (
        <Section
          title={
            <>
              AI Trade Grades · <Count value={tradeGrades.length} />
            </>
          }
          action={
            <Link href="/dashboard/analysis?view=trade-reviews" className={ACTION_LINK_CLASS}>
              All reviews →
            </Link>
          }
        >
          {/* A stored trip dated entry-after-exit is a pairing artefact: it is
              left out of the cards and counted here instead. */}
          {tradeGradesExcluded > 0 && (
            <p className="px-5 py-3 text-xs text-ink-dim">
              Trips excluded: <Count value={tradeGradesExcluded} /> — pairing under review
            </p>
          )}
          {tradeGrades.some((grade) => grade.pairings_stale) && (
            <p className="mb-3 text-xs text-gold-ink">
              Some saved grades use outdated or unresolved trade pairings. Dates, metrics and
              assessments may be wrong; resolve the lot history and regenerate those reviews.
            </p>
          )}
          {tradeGrades.length > 0 && (
          <ScrollFade>
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
          </ScrollFade>
          )}
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
                  const groupCaption = tradeGradeGroupCaption(tg.coversRoundtrips, tg.exit_date);
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
                      {/* One AI verdict covers every leg closed that day — say so,
                          or the grade reads as a verdict on a single roundtrip. */}
                      {groupCaption && (
                        <p className="text-ink-faint mb-1" style={{ fontSize: "12px" }}>
                          {groupCaption}
                        </p>
                      )}
                      {assessment && (
                        <p className="text-ink-dim mb-0.5">
                          <span
                            className="font-mono uppercase text-ink-faint mr-2"
                            style={{ fontSize: "12px", letterSpacing: "0.14em" }}
                          >
                            Assessment
                          </span>
                          <PrivateText>{assessment}</PrivateText>
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
                          <PrivateText>{whatWorked}</PrivateText>
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
                          <PrivateText>{whatDidnt}</PrivateText>
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
      {shownNotes.length > 0 && (
        <Section
          title={
            underlyingNotes.length > 0 && optionUnderlying
              ? `Notes · ${shownNotes.length} (includes ${optionUnderlying.symbol} notes, filed under the underlying)`
              : `Notes · ${shownNotes.length}`
          }
          action={
            <span className="flex items-center gap-4">
              <Link
                href={noteComposerHref}
                className={ACTION_LINK_CLASS}
              >
                + Add note
              </Link>
              <Link
                href={`/dashboard/research?security=${optionUnderlying ? optionUnderlying.id : securityId}`}
                className={ACTION_LINK_CLASS}
              >
                View all →
              </Link>
            </span>
          }
        >
          <div>
            {shownNotes.slice(0, 5).map((note, idx) => {
              // Note prose can carry portfolio-derived detail (share counts,
              // P&L) — mask it like every other such surface. Built once so
              // the clamped and the open copy can never differ in masking.
              const noteBody = <PrivateText>{note.content}</PrivateText>;
              return (
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
                  {optionUnderlying && underlyingNoteIds.has(note.id) && (
                    <span className="text-xs text-ink-faint">
                      filed under {optionUnderlying.symbol}
                    </span>
                  )}
                  {note.sentiment && (
                    <span
                      className="font-mono uppercase text-ink-faint"
                      style={{ fontSize: "11px", letterSpacing: "0.14em" }}
                    >
                      · {note.sentiment}
                    </span>
                  )}
                </div>
                {/* A long note is clamped to two lines and opens in place
                    (native <details>; the clamp is the collapsed state). */}
                {note.content.length > NOTE_CLAMP_CHARS || note.content.includes("\n") ? (
                  <details className="group">
                    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      <span className="line-clamp-2 text-sm leading-snug text-ink-dim group-open:hidden">
                        {noteBody}
                      </span>
                      <span className={`${EXPANDER_CLASS} inline-block group-open:hidden`}>read ▾</span>
                      <span className={`${EXPANDER_CLASS} hidden group-open:inline-block`}>collapse ▴</span>
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-snug text-ink-dim">
                      {noteBody}
                    </p>
                  </details>
                ) : (
                  <p className="text-sm leading-snug text-ink-dim">{noteBody}</p>
                )}
              </div>
              );
            })}
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
      <ResearchMentionsSection
        ticker={security.symbol}
        mentions={researchMentions}
        totalCount={researchMentionsTotal}
      />


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
                <EarningsConflictMarker
                  dateStatus={event.date_status}
                  dateConflictWith={event.date_conflict_with}
                  className="flex-shrink-0"
                />
                {event.date_status === "user_confirmed" && (
                  <Chip
                    tone="neutral"
                    size="xs"
                    title="You confirmed this date by hand. A vendor calendar does not move it."
                    className="flex-shrink-0"
                  >
                    confirmed
                  </Chip>
                )}
                <span className="truncate text-sm text-ink">{event.title}</span>
                {event.event_type === "earnings" && (
                  <span className="ml-auto flex-shrink-0 font-mono text-[11px] text-ink-faint">
                    {displayEarningsTime(db, event).label}
                  </span>
                )}
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
        // "Latest" is keyed per-(account, security) via latestHoldingsPredicate,
        // never a global MAX(as_of_date) across ALL holdings: the prior global
        // MAX picked one as_of_date for the entire table, so an account whose
        // newest row trailed another account's contributed zero related-option
        // rows regardless of whether it actually held any. Per-pair keying also
        // adds the default quantity != 0 clause (a deliberate behavior fix —
        // this query previously had no quantity filter at all, so a closed
        // option position's quantity=0 tombstone row could render as a related
        // option with 0 qty). Expired contracts drop out on the ET calendar
        // via the shared liveOptionExpirationSql (same cutoff as the hub's
        // Positions read) — the purge's 1-day grace can leave yesterday's
        // contract in holdings.
        const relatedOptions = db
          .prepare(
            `SELECT s.id, s.symbol, s.option_type, s.strike_price, s.expiration_date,
                    h.quantity, COALESCE(s.multiplier, 1) AS multiplier
             FROM holdings h
             JOIN securities s ON s.id = h.security_id
             WHERE s.underlying_symbol = ?
               AND LOWER(s.security_type) = 'option'
               AND ${latestHoldingsPredicate()}
               AND ${liveOptionExpirationSql("s")}
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
          <Section
            title={
              <>
                Related Options · <Count value={relatedOptions.length} />
              </>
            }
          >
            <ScrollFade>
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
            </ScrollFade>
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
          shownTranscripts.length > 0
            ? `Earnings Transcripts & Filings · ${shownTranscripts.length}`
            : "Earnings Transcripts & Filings"
        }
        subtitle={
          isOptionHub && optionUnderlying ? (
            <>
              for{" "}
              <Link href={`/dashboard/security/${optionUnderlying.id}`} className="text-gold-ink hover:underline">
                {optionUnderlying.symbol}
              </Link>
              , the underlying
            </>
          ) : undefined
        }
        action={transcriptSymbol ? <TranscriptsRefreshButton ticker={transcriptSymbol} /> : undefined}
      >
        {transcriptSymbol === null ? (
          <p className="px-5 py-5 text-sm text-ink-dim leading-relaxed">
            An option contract has no earnings calls of its own, and its underlying is not a security
            in this book, so there is nothing to fetch here.
          </p>
        ) : shownTranscripts.length === 0 ? (
          <div className="px-5 py-5 text-sm text-ink-dim leading-relaxed">
            <p>No earnings transcripts cached for {transcriptSymbol}.</p>
            <p className="mt-2 text-xs text-ink-faint">
              Click <span className="text-ink-dim">↻ refresh</span> to fetch the most recent
              quarter. Sources tried in order: API Ninjas (paid) → Motley Fool → SEC EDGAR 8-K
              (free, fiscal-quarter matched).
            </p>
          </div>
        ) : (
          <TranscriptList transcripts={shownTranscripts} />
        )}
      </Section>

      {/* An expired contract the latest holdings snapshot still lists. No
          reader counts it as held; say so, and say what clears the row,
          instead of the import call to action below. */}
      {expiredOptionSnapshotRows.length > 0 && (
        <div className="rounded-xl border border-dashed border-edge p-6">
          <p className="text-sm text-ink-dim">
            {security.symbol} expired{security.expiration_date ? ` on ${security.expiration_date}` : ""} and
            is awaiting a statement. The latest holdings snapshot still lists it, but an expired contract
            is not counted as a held position. The row clears when the statement that records the expiry is
            imported.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {expiredOptionSnapshotRows.map((row) => (
              <li key={row.account_id} className="text-xs text-ink-faint">
                <span className="text-ink-dim">{row.account_name}</span>: <Shares value={row.quantity} />{" "}
                <QuantityUnit securityType={security.security_type} quantity={row.quantity} /> on the{" "}
                {row.as_of_date} snapshot
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty state — no positions, no data */}
      {expiredOptionSnapshotRows.length === 0 &&
        positions.length === 0 &&
        openTaxLots.length === 0 &&
        expiredOptionLotsAwaitingClose.length === 0 &&
        closedSales.length === 0 &&
        recentTransactions.length === 0 &&
        relatedOptionTransactions.length === 0 &&
        shownNotes.length === 0 && (
          <div className="rounded-xl border border-dashed border-edge p-8 text-center">
            <p className="text-sm text-ink-dim">
              No portfolio data for {security.symbol}. Import holdings or
              transactions to see data here.
            </p>
            <Link
              href="/dashboard/import"
              className={`mt-3 inline-block px-4 py-2 rounded-lg ${GOLD_FILL_CLASSES} text-sm font-medium hover:brightness-110 transition-[filter,scale] active:scale-[0.96]`}
            >
              Import Files
            </Link>
          </div>
        )}
    </div>
  );
}
