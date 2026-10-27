import type { ReactNode } from "react";
import Link from "next/link";
import type { TaxLotSummary, AccountTaxSummary } from "@/lib/queries/tax-lots";
import type { TaxLotStalenessMarker } from "@/lib/compute/tax-convention";
import {
  PENDING_REASON_ORDER,
  type PendingDisclosureRow,
} from "@/lib/queries/pending-statement-types";
import { Count, Money } from "@/lib/privacy/components";
import {
  PENDING_STATEMENT_FILTER_OFF_LABEL,
  PENDING_STATEMENT_FILTER_ON_LABEL,
  pendingFigureWords,
  pendingLineAction,
  pendingLineLead,
} from "./pending-statement-copy";

/**
 * QA finding: tax-lots--headline-tiles-stale-until-recompute-no-marker.
 *
 * The tiles below are drawn from STORED tax_lots / tax_lot_sales rows. Those
 * rows only move when someone presses Recompute, so they can lag the
 * transaction ledger (every material tax-input change advances
 * `tax_input_generation`) or predate the current engine convention. The page
 * showed the figures with no hint of either, and Recompute then silently
 * changed them.
 *
 * This says so in plain language, right beside the Recompute button. It is a
 * pure display of `describeTaxLotStaleness` — rendering the page NEVER starts a
 * recompute (USER RULING: no auto-recompute on load).
 */
export function TaxLotStalenessNotice({
  marker,
  className,
}: {
  marker: TaxLotStalenessMarker;
  className?: string;
}) {
  if (!marker.stale) return null;
  const n = marker.inputChangesSince;
  return (
    <div
      role="status"
      className={`text-xs text-warn border border-warn/40 bg-warn/10 rounded px-2 py-1.5 leading-snug${
        className ? ` ${className}` : ""
      }`}
    >
      {marker.reason === "legacy" ? (
        <>
          These figures were computed under an earlier lot convention
          {/* Noun first and always plural, as in the "behind" branch below. */}
          {n != null ? (
            <>
              {" "}(tax-input changes since: <Count value={n} />)
            </>
          ) : null}
          {" — press Recompute to refresh them."}
        </>
      ) : marker.reason === "revision" ? (
        /* An earlier revision of the current engine (v3 -> v3r2, spec
           2026-10-02 statement-only synthetic closes §2.5). Names what the
           CURRENT revision changed — update when the revision bumps. */
        <>
          These figures were computed before closes required broker-statement
          evidence — press Recompute to refresh them.
        </>
      ) : marker.reason === "never" ? (
        <>These figures have no recompute stamp — press Recompute to refresh them.</>
      ) : n != null ? (
        <>
          {/* "Tax-input change" (not "ledger change") to match the counter's
              own definition (lib/compute/tax-convention.ts: "the generation
              counter advances on every MATERIAL tax-input mutation") — it
              also counts sync-driven bookkeeping writes, not just entries a
              user typed into a ledger. Noun first and always plural: a
              noun that switched with the count would say, under Hide
              amounts, whether the hidden count is one. */}
          These figures predate later tax-input changes (changes since:{" "}
          <Count value={n} />) — press Recompute to refresh them.
        </>
      ) : (
        /* A stamp we cannot measure a distance from — say only what is
           certain rather than quote a number we do not have. */
        <>These figures do not match the current ledger — press Recompute to refresh them.</>
      )}
    </div>
  );
}

/**
 * Same wording family as the row-level "Estimated" chip in TaxLotTables /
 * the security detail hub, so a user who sees the chip on a Closed Sales row
 * recognises the tile disclosure as the same thing counted up.
 */
export const ENGINE_ESTIMATED_TITLE =
  "Engine-generated reconciliation entries (no matching broker sale) — those realized figures are estimated. They are included in this economic total and excluded from the Tax Report card and the 8949 exports below.";

/**
 * "(incl. engine-estimated closes: M, +$Y)" — the disclosure half of the
 * "disclose, never exclude" ruling on QA finding
 * tax-lots--headline-tiles-include-reconcile-close-engine-rows. The figure
 * beside it stays whole; this line says how much of it the engine estimated.
 * Renders nothing when the bucket has no engine-estimated close.
 */
function EngineEstimatedNote({
  count,
  gain,
  className,
}: {
  count: number;
  gain: number;
  className?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span className={className} title={ENGINE_ESTIMATED_TITLE}>
      {/* Noun first and always plural: a "close" / "closes" switch beside a
          masked count would say whether the count is one. */}
      (incl. engine-estimated closes: <Count value={count} />,{" "}
      {/* Keep the sign glued to its figure: the note can wrap inside a
          tile, and a line break between "−" and "$704" reads as two
          tokens (same class as the security-detail Amount column fix). */}
      <span className="whitespace-nowrap"><Money value={gain} signed />)</span>
    </span>
  );
}

function GainCard({
  label,
  value,
  sublabel,
  engineEstimatedCount = 0,
  engineEstimatedGain = 0,
}: {
  label: string;
  value: number;
  sublabel?: ReactNode;
  engineEstimatedCount?: number;
  engineEstimatedGain?: number;
}) {
  const isPositive = value >= 0;
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-2">
        {label}
      </div>
      <Money
        value={value}
        signed
        className={`block text-2xl font-semibold font-mono tabular-nums tracking-tight ${
          value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
        }`}
      />
      {sublabel && (
        <div className="text-xs text-ink-faint mt-1">{sublabel}</div>
      )}
      <EngineEstimatedNote
        count={engineEstimatedCount}
        gain={engineEstimatedGain}
        className="block text-xs text-ink-faint mt-1"
      />
    </div>
  );
}

/**
 * The pending disclosure under the tiles (plan 2026-10-26 Task 9; spec
 * 2026-10-08 live-closed options and shorts). Pending lots are not held as
 * recorded, so their paper gain is not unrealized and their realized figure
 * is unknown until the missing entry arrives. The Unrealized tile excludes
 * them, and these lines say so.
 *
 * One paragraph per REASON present (awaiting statement, closing entry
 * missing, re-symbol repair pending), in the shared reason order. Inside a
 * paragraph, one figure per SIDE present, each named by what it is: a long
 * side's cost basis, a short side's short-sale proceeds. The two are never
 * added together (money paid and money received are not one number). The
 * rows come from `reducePendingDisclosure`, the one reducer every surface
 * shares. Renders nothing when no position is pending.
 *
 * The explanation is visible text, never a `title` (hover does not exist on a
 * phone). `filter` adds the one "show pending only" link that narrows the
 * Open Lots table to every pending lot, whatever its reason; the page owns
 * the URL (`?pending=1`).
 */
export interface PendingStatementFilter {
  /** Where the link goes: the same page with the filter flipped. */
  href: string;
  /** True while the Open Lots table is already narrowed to pending lots. */
  active: boolean;
}

export function PendingStatementLines({
  rows,
  filter,
}: {
  rows: readonly PendingDisclosureRow[];
  filter?: PendingStatementFilter;
}) {
  const present = rows.filter((r) => r.positions > 0);
  if (present.length === 0) return null;
  return (
    <div className="text-xs text-ink-faint mt-2 space-y-1">
      {PENDING_REASON_ORDER.map((reason) => {
        const sides = present.filter((r) => r.reason === reason);
        if (sides.length === 0) return null;
        // Distinct positions: the reducer keys a position by account,
        // security AND side, so its per-side counts never overlap and add up.
        const positions = sides.reduce((n, r) => n + r.positions, 0);
        return (
          <p key={reason} data-pending-reason={reason}>
            {/* Noun first and always plural: under Hide amounts a noun that
                switched with the count would say whether it is one. */}
            {pendingLineLead(reason)}: <Count value={positions} /> (
            {sides.map((r, i) => (
              <span key={r.side}>
                {i > 0 ? "; " : ""}
                <Money value={r.figure} /> {pendingFigureWords(r.figureKind)}
              </span>
            ))}
            , excluded from Unrealized). {pendingLineAction(reason)}
          </p>
        );
      })}
      {filter && (
        <Link
          href={filter.href}
          scroll={false}
          className="inline-flex items-center min-h-11 text-sm font-medium text-gold-ink underline underline-offset-2"
        >
          {filter.active ? PENDING_STATEMENT_FILTER_OFF_LABEL : PENDING_STATEMENT_FILTER_ON_LABEL}
        </Link>
      )}
    </div>
  );
}

export function TaxLotSummaryCards({
  summary,
  year,
  pendingFilter,
}: {
  summary: TaxLotSummary;
  year: number;
  pendingFilter?: PendingStatementFilter;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GainCard
          label="Unrealized"
          value={summary.totalUnrealizedGain}
          sublabel={
            <>
              {/* Noun first and always plural: under Hide amounts a
                  "lot" / "lots" switch would say whether the count is one. */}
              Open lots: <Count value={summary.totalOpenLots} />
            </>
          }
        />
        <GainCard
          label={`${year} Realized`}
          value={summary.totalRealizedGain}
          sublabel={
            <>
              {/* Same rule as "Open lots:" beside it: noun first, always
                  plural, so the masked tile reads the same for one sale. */}
              Sales: <Count value={summary.totalClosedSales} />
            </>
          }
          engineEstimatedCount={summary.engineEstimatedSales}
          engineEstimatedGain={summary.engineEstimatedGain}
        />
        <GainCard
          label={`${year} Long-Term`}
          value={summary.longTermGain}
          sublabel="economic realized · > 365 days"
          engineEstimatedCount={summary.engineEstimatedLongTermSales}
          engineEstimatedGain={summary.engineEstimatedLongTermGain}
        />
        <GainCard
          label={`${year} Short-Term`}
          value={summary.shortTermGain}
          sublabel="economic realized · calendar year"
          engineEstimatedCount={summary.engineEstimatedShortTermSales}
          engineEstimatedGain={summary.engineEstimatedShortTermGain}
        />
      </div>
      <PendingStatementLines rows={summary.pendingStatement} filter={pendingFilter} />
      {summary.excludedNonUsdSales > 0 && (
        <p className="text-xs text-ink-faint mt-2">
          USD totals exclude non-USD sales: <Count value={summary.excludedNonUsdSales} />{" "}
          — shown in native currency in Closed Sales below.
        </p>
      )}
    </div>
  );
}

export function AccountSummaryCards({
  accounts,
  year,
}: {
  accounts: AccountTaxSummary[];
  year: number;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-3">
        {year} Short-Term by Account
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {accounts.map((acct) => {
          const isPositive = acct.shortTermGain >= 0;
          return (
            <div
              key={acct.account_id}
              className="rounded-xl border border-edge bg-panel p-4"
            >
              <div className="text-xs text-ink-faint mb-1.5 truncate">
                {acct.account_name}
              </div>
              <Money
                value={acct.shortTermGain}
                signed
                className={`block text-lg font-semibold font-mono tabular-nums ${
                  acct.shortTermGain === 0
                    ? "text-ink-dim"
                    : isPositive
                      ? "text-up"
                      : "text-down"
                }`}
              />
              {/* The headline above is the account's SHORT-TERM economic
                  figure, so its disclosure is the short-term bucket's. */}
              <EngineEstimatedNote
                count={acct.engineEstimatedShortTermSales}
                gain={acct.engineEstimatedShortTermGain}
                className="block text-[11px] text-ink-faint mt-1"
              />
              <div className="text-[11px] text-ink-faint mt-1">
                Sales: <Count value={acct.totalClosedSales} />
                {/* Also shown when the LT figure nets to zero BUT carries
                    engine-estimated closes — otherwise offsetting engine
                    rows would hide their own disclosure. */}
                {(acct.longTermGain !== 0 || acct.engineEstimatedLongTermSales > 0) && (
                  <>
                    {" "}· LT: <Money value={acct.longTermGain} signed />{" "}
                    <EngineEstimatedNote
                      count={acct.engineEstimatedLongTermSales}
                      gain={acct.engineEstimatedLongTermGain}
                    />
                  </>
                )}
                {acct.excludedNonUsdSales > 0 && (
                  <> · excludes <Count value={acct.excludedNonUsdSales} /> non-USD</>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
