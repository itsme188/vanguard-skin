import Link from "next/link";
import { Money, Pct } from "@/lib/privacy/components";
import { CHIP_TONE_TEXT } from "./chip-tone-text";
import { EmptySection } from "./EmptySection";
import {
  FLOW_SOURCE_TEXT,
  METHOD_BLURB,
  METHOD_TEXT,
  MONTH_ABBR,
  REFUSAL_TEXT,
  monthLabel,
} from "./monthly-performance-labels";
import { weakestFlowSource } from "@/lib/compute/monthly-performance";
import type {
  AccountMonthPerformance,
  BlendedMonthPerformance,
  MonthlyFlowSource,
} from "@/lib/compute/monthly-performance";

/**
 * The month view on the Performance page: one month at a time, the blended
 * figure for the selected scope and one row per account.
 *
 * Every figure comes from `lib/compute/monthly-performance.ts`; this file
 * decides nothing about the numbers. Every owner-facing word comes from
 * `monthly-performance-labels.ts`; this file writes none of its own.
 *
 * Nothing on this surface is estimated, and no blended figure is ever
 * computed from the accounts that happen to have a statement: a month with
 * an account missing says which account, and shows the others on their own
 * rows.
 */

/** The checked small-text ink for a gain or a loss (never a faded tone). */
function toneText(value: number | null): string {
  if (value === null || value === 0) return "text-ink";
  return value > 0 ? CHIP_TONE_TEXT.up : CHIP_TONE_TEXT.down;
}

/** The large headline figure may use the plain tokens (well over 18px). */
function headlineTone(value: number | null): string {
  if (value === null) return "text-ink-faint";
  if (value > 0) return "text-up";
  if (value < 0) return "text-down";
  return "text-ink";
}

export interface MonthlyPerformanceSectionProps {
  /** Statement months in the scope, newest first. */
  months: string[];
  /** The month on screen (one of `months`), or null when the scope has none. */
  selectedMonth: string | null;
  accounts: AccountMonthPerformance[];
  /** Null when the scope has no statement month to show. */
  blended: BlendedMonthPerformance | null;
  /** Label for the scope the blend covers, e.g. "All accounts". */
  scopeLabel: string;
  /** Link for a month pill — the parent owns the page's other params. */
  hrefForMonth: (monthEndDate: string) => string;
}

export function MonthlyPerformanceSection({
  months,
  selectedMonth,
  accounts,
  blended,
  scopeLabel,
  hrefForMonth,
}: MonthlyPerformanceSectionProps) {
  // Years with statement data, newest first, and the months inside the
  // selected year. Derived from the data — never a hardcoded year list, so a
  // month appears here as soon as its statements are imported.
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const selectedYear = selectedMonth?.slice(0, 4) ?? years[0] ?? null;
  const monthsInYear = months.filter((m) => m.slice(0, 4) === selectedYear);
  // The newest month of a year, so a year pill lands somewhere real.
  const newestInYear = (year: string) =>
    months.find((m) => m.slice(0, 4) === year) ?? null;

  if (months.length === 0 || selectedMonth === null || blended === null) {
    return (
      <EmptySection
        title="Monthly performance"
        reason="No month-end statements are imported for this scope yet."
        hint="A month appears here as soon as its statements are imported."
      />
    );
  }

  return (
    <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-ink whitespace-nowrap!">Monthly performance</h3>
          {/* The method, stated on the surface that uses it. */}
          <p className="text-xs text-ink-dim mt-1 max-w-prose">{METHOD_BLURB}</p>
        </div>
      </div>

      {/* Year pills, then the months of that year. Both are plain links so
          this stays a server component. */}
      {years.length > 1 && (
        <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit mt-4">
          {years.map((y) => {
            const target = newestInYear(y);
            return (
              <Link
                key={y}
                href={target ? hrefForMonth(target) : "#"}
                aria-current={selectedYear === y ? "true" : undefined}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  selectedYear === y
                    ? "bg-panel text-ink shadow-sm"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                {y}
              </Link>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit mt-2">
        {monthsInYear.map((m) => (
          <Link
            key={m}
            href={hrefForMonth(m)}
            aria-current={selectedMonth === m ? "true" : undefined}
            className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
              selectedMonth === m
                ? "bg-panel text-ink shadow-sm"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {MONTH_ABBR[Number(m.slice(5, 7)) - 1]}
          </Link>
        ))}
      </div>

      {/* ── Blended headline ──────────────────────────────────────── */}
      <div className="mt-5 pb-4 border-b border-edge">
        <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">
          {scopeLabel} · {monthLabel(selectedMonth)}
        </p>
        {blended.incomplete ? (
          <>
            <p className="text-xl font-mono tabular-nums text-ink-faint">Incomplete</p>
            <p className="text-sm text-ink-dim mt-1 max-w-prose">
              {blended.blockedBy.length > 0 ? (
                <>
                  No blended figure for this month:{" "}
                  {blended.blockedBy.map((b, i) => (
                    <span key={b.accountId}>
                      {i > 0 ? "; " : ""}
                      <strong className="text-ink">{b.accountName}</strong> —{" "}
                      {REFUSAL_TEXT[b.refusal]}
                    </span>
                  ))}
                  . The accounts below are shown on their own; two accounts are never blended
                  into a figure that names three.
                </>
              ) : blended.refusal !== null ? (
                <>No blended figure for this month: {REFUSAL_TEXT[blended.refusal]}.</>
              ) : (
                <>No blended figure for this month.</>
              )}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-4 flex-wrap">
              <p
                className={`font-mono tabular-nums text-3xl ${headlineTone(blended.returnFraction)}`}
              >
                <Pct value={(blended.returnFraction ?? 0) * 100} digits={2} signed />
              </p>
              <p
                className={`font-mono tabular-nums text-xl ${headlineTone(blended.gainLoss)}`}
              >
                <Money value={blended.gainLoss} signed />
              </p>
            </div>
            <p className="text-xs text-ink-faint mt-1">
              {blended.method === null ? "" : METHOD_TEXT[blended.method]} · opening{" "}
              <Money value={blended.beginningValue} /> → closing{" "}
              <Money value={blended.endingValue} />
              {blended.netFlow !== 0 && (
                <>
                  {" "}
                  · deposits and withdrawals <Money value={blended.netFlow} signed /> (removed
                  from the return)
                </>
              )}
            </p>
          </>
        )}
      </div>

      {/* ── Per-account rows ──────────────────────────────────────── */}
      <table className="w-full text-sm mt-4">
        <thead className="text-[11px] uppercase tracking-widest text-ink-faint">
          <tr className="border-b border-edge">
            <th className="text-left font-medium pb-2">Account</th>
            <th className="text-right font-medium pb-2">Return</th>
            <th className="text-right font-medium pb-2">Gain / loss</th>
            <th className="text-right font-medium pb-2 hidden sm:table-cell">
              Deposits / withdrawals
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {accounts.map((a) => (
            <tr key={a.accountId}>
              <td className="py-2 text-ink">
                <div className="[overflow-wrap:anywhere]">{a.accountName}</div>
                {a.refusal !== null && (
                  <div className="text-[11px] text-ink-faint">{REFUSAL_TEXT[a.refusal]}</div>
                )}
              </td>
              <td
                className={`py-2 text-right font-mono tabular-nums ${toneText(a.returnFraction)}`}
              >
                <Pct
                  value={a.returnFraction === null ? null : a.returnFraction * 100}
                  digits={2}
                  signed
                />
              </td>
              <td className={`py-2 text-right font-mono tabular-nums ${toneText(a.gainLoss)}`}>
                <Money value={a.gainLoss} signed />
              </td>
              <td className="py-2 text-right font-mono tabular-nums text-ink-dim hidden sm:table-cell">
                {a.refusal !== null ? "—" : <Money value={a.netFlow} signed />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Flow evidence for the month: the weakest evidence among the
          accounts that produced a figure, so the footnote never claims more
          than the figures above it. */}
      {(() => {
        const sources = accounts
          .map((a) => a.flowSource)
          .filter((s): s is MonthlyFlowSource => s !== null);
        const shown = blended.flowSource ?? weakestFlowSource(sources);
        return shown ? (
          <p className="text-xs text-ink-faint mt-3 max-w-prose">{FLOW_SOURCE_TEXT[shown]}</p>
        ) : null;
      })()}
    </section>
  );
}
