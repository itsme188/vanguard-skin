export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import Link from "next/link";
import { getAccountByName } from "@/lib/queries/accounts";
import { getPortfolioTotals } from "@/lib/queries/dashboard";
import { getEventsByWeek } from "@/lib/queries/calendar";
import { getCurrentMonday, todayET, resolveWeekOfParam } from "@/lib/calendar/date-utils";
import { getIbkrTodayHoldings, type TodayHolding } from "@/lib/queries/today-holdings";
import type { CalendarEvent } from "@/lib/types";
import { OpenChatButton } from "../components/OpenChatButton";
import { Count, Money, Pct } from "@/lib/privacy/components";
import { TodayReleases } from "../components/TodayReleases";
import { EarningsHub } from "./EarningsHub";
import { WeekAheadView } from "./WeekAheadView";
import { IbkrRefreshButton } from "./IbkrRefreshButton";
import { SnapshotAge } from "../components/SnapshotAge";

function fmtShortDate(iso: string): string {
  const [, month, day] = iso.split("T")[0].split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

function daysAgo(iso: string): number {
  const then = new Date(iso.split("T")[0] + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

function qualityChip(days: number, source: string | null): { label: string; className: string } {
  if (days === 0 && source === "tws") {
    return { label: "live", className: "text-up bg-up/20" };
  }
  if (days <= 1) {
    return { label: "fresh", className: "text-ink-dim bg-raised" };
  }
  if (days <= 4) {
    return { label: `${days}d old`, className: "text-ink-faint bg-raised" };
  }
  return { label: `${days}d old`, className: "text-down bg-down/20" };
}

interface TodayPageProps {
  searchParams: Promise<{ view?: string; weekOf?: string }>;
}

export default async function TodayPage({ searchParams }: TodayPageProps) {
  const { view, weekOf: weekOfParam } = await searchParams;

  // ── Sub-view dispatch: ?view=week-ahead absorbs the old Calendar tab ──
  if (view === "week-ahead") {
    // ?weekOf= is honored (any date snaps to its Monday; garbage falls back
    // to the current week) so past enriched weeks and future conflict weeks
    // are browsable — the Calendar Living Record's only week-level UI.
    const weekOf = resolveWeekOfParam(weekOfParam);
    const events = getEventsByWeek(db, weekOf);
    return <WeekAheadView events={events} weekOf={weekOf} />;
  }

  // ── IBKR holdings snapshot ────────────────────────────────────────────────
  const ibkrAccount = getAccountByName(db, "IBKR");
  let holdings: TodayHolding[] = [];
  let latestPriceDate: string | null = null;

  if (ibkrAccount) {
    // Trading-day-pair move computation lives in lib/queries/today-holdings —
    // never a bare rn=1/rn=2 pairing (weekend phantom rows read as 0.00%).
    holdings = getIbkrTodayHoldings(db, ibkrAccount.id);

    latestPriceDate =
      holdings
        .map((h) => h.price_date)
        .filter((d): d is string => d !== null)
        .sort()
        .at(-1) ?? null;
  }

  // One-line snapshot (spec §2: "Portfolio snapshot shrinks to one line"). The
  // per-name list lives on Accounts now. A null today_gain is UNKNOWN, never
  // zero: names with no prior close contribute to neither sum, and when NO name
  // has one there is no move to report at all — `null`, not `0`.
  const moved = holdings.filter((h) => h.today_gain !== null);
  const todayGain = moved.length === 0 ? null : moved.reduce((sum, h) => sum + (h.today_gain ?? 0), 0);
  const priorClose =
    todayGain === null ? null : moved.reduce((sum, h) => sum + (h.current_value ?? 0), 0) - todayGain;
  const todayPct =
    todayGain !== null && priorClose !== null && priorClose > 0 ? (todayGain / priorClose) * 100 : null;

  // ── Today's calendar releases (with release_time set) ─────────────
  // ET-anchored: calendar event_date is an ET market date, so "today" must be
  // the ET day regardless of server/Mac local TZ (traveling) or UTC.
  const today = todayET();
  const todayReleases = db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE event_date = ?
         AND release_time IS NOT NULL
         AND COALESCE(superseded, 0) = 0
       ORDER BY release_time ASC`,
    )
    .all(today) as CalendarEvent[];

  // Fallback: when today has no releases, surface the next few upcoming ones so
  // the left half of the Today header row is never empty (there's always a
  // macro event or held-name earnings coming up within the week).
  const upcomingReleases =
    todayReleases.length === 0
      ? (db
          .prepare(
            `SELECT * FROM calendar_events
             WHERE event_date > ?
               AND release_time IS NOT NULL
               AND COALESCE(superseded, 0) = 0
             ORDER BY event_date ASC, release_time ASC
             LIMIT 4`,
          )
          .all(today) as CalendarEvent[])
      : [];
  const releases = todayReleases.length > 0 ? todayReleases : upcomingReleases;
  const releasesMode: "today" | "upcoming" =
    todayReleases.length > 0 ? "today" : "upcoming";

  // ── Portfolio totals for the hero (Overview absorption — IA Phase 3) ──
  const portfolio = getPortfolioTotals(db);

  // ── Vanguard snapshot age — surfaces the statement-period staleness
  //    boundary so a glance-at-phone view tells the user when Vanguard
  //    holdings + cash were last refreshed. Picks the OLDER of the two
  //    Vanguard accounts since both share the same statement cadence.
  const vanguardAsOf = db
    .prepare(
      `SELECT MIN(latest) AS earliest
         FROM (
           SELECT MAX(h.as_of_date) AS latest
           FROM holdings h
           JOIN accounts a ON a.id = h.account_id
           WHERE LOWER(a.name) LIKE '%vanguard%'
           GROUP BY h.account_id
         )`,
    )
    .get() as { earliest: string | null } | undefined;
  const vanguardSnapshotDate = vanguardAsOf?.earliest ?? null;

  const overallDaysOld = latestPriceDate ? daysAgo(latestPriceDate) : null;
  const overallSource = holdings.find((h) => h.price_date === latestPriceDate)?.price_source ?? null;
  const overallQuality =
    overallDaysOld !== null ? qualityChip(overallDaysOld, overallSource) : null;

  return (
    <div className="space-y-5 md:space-y-8">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">
            {new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h1 className="hidden md:block text-2xl text-gold tracking-tight font-medium">Today</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {vanguardSnapshotDate && (
            <SnapshotAge asOfDate={vanguardSnapshotDate} label="Vanguard" alwaysShow />
          )}
          {overallQuality && (
            <span className={`text-[11px] font-mono rounded px-2 py-0.5 ${overallQuality.className}`}>
              {overallQuality.label}
              {latestPriceDate && ` · ${fmtShortDate(latestPriceDate)}`}
            </span>
          )}
          <Link
            href="/dashboard/today?view=week-ahead"
            className="text-[11px] uppercase tracking-widest text-ink-faint hover:text-gold border border-edge rounded-full px-3 py-1"
          >
            Week ahead →
          </Link>
        </div>
      </header>

      {/* ── Portfolio strip — locked 2026-04-30 (Phase 3.5): no card chrome,
              hairline border-b only. Sits as a header band above the peer
              cards instead of competing with them as a hero feature. ── */}
      <div className="border-b border-edge pb-3 flex items-baseline gap-4 flex-wrap">
        <p className="text-[11px] uppercase tracking-widest text-ink-faint">Portfolio</p>
        <span
          className="font-mono font-semibold tabular-nums text-ink"
          style={{ fontSize: "clamp(22px, 3vw, 28px)", lineHeight: 1, letterSpacing: "-0.02em" }}
        >
          <Money value={portfolio.totalValue} />
        </span>
        {portfolio.totalChange !== 0 && (
          <span
            className={`text-[12px] font-mono tabular-nums rounded-full px-2 py-0.5 ${
              portfolio.totalChange >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"
            }`}
          >
            {portfolio.totalChange >= 0 ? "▲" : "▼"} <Money value={Math.abs(portfolio.totalChange)} />{" "}
            <span className="text-ink-faint">vs prior month</span>
          </span>
        )}
        <span className="text-[12px] text-ink-faint ml-auto">
          {portfolio.accountCount} {portfolio.accountCount === 1 ? "account" : "accounts"}
          {portfolio.latestDate && ` · as of ${fmtShortDate(portfolio.latestDate)}`}
        </span>
      </div>

      {/* ── Today's releases (full width — the momentum tile moved to
              Analysis · Diagnostics, spec §4.6) ── */}
      {releases.length > 0 ? (
        <TodayReleases releases={releases} mode={releasesMode} />
      ) : (
        <section className="rounded-xl bg-panel p-4">
          <h2 className="text-sm font-medium text-ink">Releases</h2>
          <p className="mt-2 text-[13px] text-ink-faint">
            No upcoming releases scheduled.
          </p>
        </section>
      )}

      {/* ── Week-ahead Earnings Hub (full width — primary attention magnet;
              this is now the one earnings surface — cockpit + print panel
              have been folded into the Hub row and its expansion) ── */}
      <EarningsHub />

      {/* ── Chat ── */}
      <OpenChatButton />

      {/* ── IBKR today — one line (spec §4.6). The per-name list is on Accounts. ── */}
      <section className="rounded-xl bg-panel p-4 card-elev">
        {!ibkrAccount ? (
          <p className="text-[14px] text-ink-faint">No IBKR account set up yet.</p>
        ) : holdings.length === 0 ? (
          <p className="text-[14px] text-ink-faint">
            No holdings found. Connect TWS or import IBKR activity files.
          </p>
        ) : (
          <div className="flex items-baseline gap-3 flex-wrap text-[13px]">
            <h2 className="text-sm font-medium text-ink whitespace-nowrap!">IBKR today</h2>
            <span className="text-ink-dim font-mono tabular-nums">
              <Count value={holdings.length} /> names
            </span>
            {todayGain === null ? (
              <span
                className="font-mono tabular-nums text-ink-faint"
                title="no prior-close prices yet — today's move is unavailable"
              >
                —
              </span>
            ) : (
              <span className={`font-mono tabular-nums ${todayGain >= 0 ? "text-up" : "text-down"}`}>
                <Money value={todayGain} signed />
                {todayPct !== null && (
                  <> (<Pct value={todayPct} digits={2} signed />)</>
                )}
              </span>
            )}
            {moved.length < holdings.length && (
              <span
                className="text-[11px] text-ink-faint"
                title="Names with no prior close are excluded from today's move"
              >
                <Count value={holdings.length - moved.length} /> without a prior close
              </span>
            )}
            <IbkrRefreshButton latestPriceDate={latestPriceDate} />
            <Link href="/dashboard/accounts" className="ml-auto text-[13px] text-gold-ink hover:text-gold">
              Accounts &rarr;
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
