export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import Link from "next/link";
import { getAlerts } from "@/lib/queries/security-levels";
import { getLevelsNearPrice } from "@/lib/queries/briefing-levels";
import { getAccountByName } from "@/lib/queries/accounts";
import { getPortfolioTotals } from "@/lib/queries/dashboard";
import { getEventsByWeek } from "@/lib/queries/calendar";
import { getCurrentMonday, todayET, resolveWeekOfParam } from "@/lib/calendar/date-utils";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import type { LevelAlert, CalendarEvent } from "@/lib/types";
import { NearbyLevelsCard } from "../components/NearbyLevelsCard";
import { OpenChatButton } from "../components/OpenChatButton";
import { SignificantMovesCard } from "./SignificantMovesCard";
import { Money, Pct, Shares } from "@/lib/privacy/components";
import { TodayReleases } from "../components/TodayReleases";
import { MomentumPulse } from "../components/MomentumPulse";
import { computeMomentumPulse } from "@/lib/compute/momentum-spread";
import { EarningsCockpit } from "./EarningsCockpit";
import { EarningsHub } from "./EarningsHub";
import { WeekAheadView } from "./WeekAheadView";
import { IbkrRefreshButton } from "./IbkrRefreshButton";
import { SnapshotAge } from "../components/SnapshotAge";

interface EnrichedAlert extends LevelAlert {
  symbol: string | null;
  security_name: string | null;
  level_type: string | null;
  level_price: number | null;
  source_author: string | null;
}

interface TodayHolding {
  security_id: number;
  symbol: string;
  security_name: string | null;
  quantity: number;
  current_price: number | null;
  current_value: number | null;
  prior_close: number | null;
  today_gain: number | null;
  today_pct: number | null;
  price_date: string | null;
  price_source: string | null;
}

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

function triggeredToday(isoTs: string): boolean {
  const t = new Date(isoTs);
  if (isNaN(t.getTime())) return false;
  return t.toDateString() === new Date().toDateString();
}

function formatPriceSource(source: string): string {
  const m = /^(sma|ema)_(\d+)$/.exec(source);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : source;
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

  // ── Pending alerts (enriched in a single JOIN, same shape as /api/alerts) ──
  const alertRows = getAlerts(db, { response: "pending", limit: 20 });
  const alerts: EnrichedAlert[] = alertRows.map((a) => {
    const sec = db
      .prepare("SELECT symbol, name FROM securities WHERE id = ?")
      .get(a.security_id) as { symbol: string; name: string | null } | undefined;
    const level = db
      .prepare(
        "SELECT level_type, price, price_source, source_author FROM security_levels WHERE id = ?"
      )
      .get(a.level_id) as
      | { level_type: string; price: number; price_source: string; source_author: string | null }
      | undefined;
    return {
      ...a,
      symbol: sec?.symbol ?? null,
      security_name: sec?.name ?? null,
      level_type: level?.level_type ?? null,
      level_price: level?.price ?? null,
      source_author: level?.source_author ?? null,
    };
  });

  const alertsToday = alerts.filter((a) => triggeredToday(a.triggered_at));
  const alertsOlder = alerts.filter((a) => !triggeredToday(a.triggered_at));

  // ── Levels within 5% of current price ─────────────────────────────────────
  const nearbyLevels = getLevelsNearPrice(db, 0.05);

  // ── IBKR holdings snapshot ────────────────────────────────────────────────
  const ibkrAccount = getAccountByName(db, "IBKR");
  let holdings: TodayHolding[] = [];
  let latestPriceDate: string | null = null;

  if (ibkrAccount) {
    const marketValueCurrent = adjustedMarketValueSQL(
      "h.quantity",
      "p_today.close_price",
      "s.security_type",
      "COALESCE(s.multiplier, 1)",
      "COALESCE(fx.usd_per_unit, 1)",
    );
    const marketValuePrior = adjustedMarketValueSQL(
      "h.quantity",
      "p_prior.close_price",
      "s.security_type",
      "COALESCE(s.multiplier, 1)",
      "COALESCE(fx.usd_per_unit, 1)",
    );
    // Rank every price row per security so we can pull the top two.
    // rn=1 is the most recent close, rn=2 is the prior — today's move is
    // the delta between them. When a security has only one price row,
    // p_prior joins null and today_gain/today_pct fall through to null.
    holdings = db
      .prepare(
        `WITH ranked_prices AS (
           SELECT security_id, date, close_price, source,
                  ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY date DESC) AS rn
           FROM prices
         )
         SELECT
           h.security_id,
           s.symbol,
           s.name AS security_name,
           h.quantity,
           p_today.close_price * COALESCE(fx.usd_per_unit, 1) AS current_price,
           p_today.date AS price_date,
           p_today.source AS price_source,
           p_prior.close_price * COALESCE(fx.usd_per_unit, 1) AS prior_close,
           CASE WHEN p_today.close_price IS NOT NULL THEN ${marketValueCurrent} ELSE NULL END AS current_value,
           CASE WHEN p_today.close_price IS NOT NULL AND p_prior.close_price IS NOT NULL
             THEN ${marketValueCurrent} - ${marketValuePrior} ELSE NULL END AS today_gain,
           CASE WHEN p_today.close_price IS NOT NULL AND p_prior.close_price IS NOT NULL
                  AND p_prior.close_price != 0
             THEN (p_today.close_price - p_prior.close_price) / p_prior.close_price ELSE NULL END AS today_pct
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         LEFT JOIN ranked_prices p_today ON p_today.security_id = h.security_id AND p_today.rn = 1
         LEFT JOIN ranked_prices p_prior ON p_prior.security_id = h.security_id AND p_prior.rn = 2
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE h.account_id = ?
           AND h.quantity > 0
           AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings WHERE account_id = ?)
           AND (s.maturity_date IS NULL OR s.maturity_date >= date('now')
                OR LOWER(s.security_type) = 'bond')
         ORDER BY ABS(COALESCE(${marketValueCurrent} - ${marketValuePrior}, 0)) DESC`,
      )
      .all(ibkrAccount.id, ibkrAccount.id) as TodayHolding[];

    latestPriceDate =
      holdings
        .map((h) => h.price_date)
        .filter((d): d is string => d !== null)
        .sort()
        .at(-1) ?? null;
  }

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

  // ── Momentum factor pulse (renders for every state — see component) ──
  const momentumPulse = computeMomentumPulse(db);

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

      {/* ── Today header row — releases (left) + momentum pulse (right) ──
              Both halves always render so the row reads in order: the left
              falls back to upcoming releases when today is empty; the right
              renders for every momentum state (incl. neutral / no-data). ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
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
        <MomentumPulse pulse={momentumPulse} />
      </div>

      {/* ── Earnings-day cockpit (auto-appears on report days) ── */}
      <EarningsCockpit />

      {/* ── Week-ahead Earnings Hub (full width — primary attention magnet) ── */}
      <EarningsHub />

      {/* ── Alerts | Levels @ 5% — side-by-side only when both have content ── */}
      <div className={nearbyLevels.length > 0 ? "grid grid-cols-1 md:grid-cols-2 gap-4" : ""}>
      <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">Alerts</h2>
          <span className="text-[11px] text-ink-faint font-mono">
            {alerts.length} pending
          </span>
        </div>

        {alerts.length === 0 ? (
          <div className="space-y-2">
            <p className="text-[14px] text-ink-faint">
              No pending alerts. Levels are armed — you&rsquo;ll be notified when they trigger.
            </p>
            <Link
              href="/dashboard/alerts?view=armed"
              className="block text-[13px] font-medium text-gold-ink hover:text-gold/80"
            >
              View armed levels &rarr;
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {alertsToday.length > 0 && (
              <AlertGroup title="Triggered today" alerts={alertsToday} />
            )}
            {alertsOlder.length > 0 && (
              <AlertGroup title="Older pending" alerts={alertsOlder} dim />
            )}
            <div className="flex items-center justify-center gap-4 py-1">
              <Link
                href="/dashboard/alerts"
                className="text-[14px] font-medium text-gold-ink hover:text-gold"
              >
                Respond in alerts inbox &rarr;
              </Link>
              <Link
                href="/dashboard/alerts?view=armed"
                className="text-[13px] text-ink-dim hover:text-ink"
              >
                View armed levels
              </Link>
            </div>
          </div>
        )}
      </section>

      {/* ── Levels near price ── */}
      <NearbyLevelsCard levels={nearbyLevels} />
      </div>

      {/* ── Significant moves in Vanguard holdings vs. beta-expected ── */}
      <SignificantMovesCard />

      {/* ── Chat ── */}
      <OpenChatButton />

      {/* ── Holdings ── */}
      <section className="rounded-xl bg-panel p-4 card-elev">
        <div className="mb-2 flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-ink">IBKR today</h2>
          <div className="flex items-baseline gap-3">
            <span className="text-[11px] text-ink-faint font-mono">
              {holdings.length} · today&rsquo;s move
            </span>
            {ibkrAccount && holdings.length > 0 && (
              <IbkrRefreshButton latestPriceDate={latestPriceDate} />
            )}
          </div>
        </div>

        {!ibkrAccount ? (
          <p className="text-[14px] text-ink-faint">
            No IBKR account set up yet.
          </p>
        ) : holdings.length === 0 ? (
          <p className="text-[14px] text-ink-faint">
            No holdings found. Connect TWS or import IBKR activity files.
          </p>
        ) : (
          <ul className="divide-y divide-edge -mx-4">
            {holdings.map((h) => (
              <li key={h.security_id} className="px-4 py-2">
                <Link
                  href={`/dashboard/security/${h.security_id}`}
                  className="flex items-center gap-3 group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[14px] font-medium text-ink group-hover:text-gold">
                        {h.symbol}
                      </span>
                      {h.security_name && h.security_name !== h.symbol ? (
                        <span className="text-[11px] text-ink-faint truncate">
                          {h.security_name}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[12px] text-ink-faint font-mono mt-0.5 flex items-center gap-2">
                      <span>
                        <Shares value={h.quantity} />
                        {" @ "}
                        <Money value={h.current_price} precise />
                      </span>
                      <span>=</span>
                      <span>
                        <Money value={h.current_value} />
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={`text-[14px] font-mono tabular-nums ${
                        h.today_gain === null
                          ? "text-ink-faint"
                          : h.today_gain >= 0
                            ? "text-up"
                            : "text-down"
                      }`}
                    >
                      {h.today_gain === null ? (
                        <span title="No prior-close price — today's move unavailable">&mdash;</span>
                      ) : (
                        <Money value={h.today_gain} signed />
                      )}
                    </div>
                    {h.today_pct !== null && (
                      <div
                        className={`text-[12px] font-mono tabular-nums ${
                          h.today_pct >= 0 ? "text-up" : "text-down"
                        }`}
                      >
                        <Pct value={h.today_pct * 100} digits={2} signed />
                      </div>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AlertGroup({
  title,
  alerts,
  dim = false,
}: {
  title: string;
  alerts: EnrichedAlert[];
  dim?: boolean;
}) {
  return (
    <div>
      <h3 className={`text-[11px] uppercase tracking-widest mb-2 ${dim ? "text-ink-faint" : "text-ink-dim"}`}>
        {title}
      </h3>
      <ul className="space-y-1.5">
        {alerts.map((a) => (
          <li key={a.id} className="text-[14px]">
            <Link
              href={`/dashboard/security/${a.security_id}`}
              className="flex items-baseline gap-2 group"
            >
              <span className="font-mono font-medium text-ink group-hover:text-gold w-14 shrink-0">
                {a.symbol ?? "—"}
              </span>
              <span className="flex-1 text-ink-dim">
                <span className="uppercase">{a.level_type?.replace("_", " ") ?? "level"}</span>
                {" @ "}
                <Money value={a.level_price} precise className="text-ink" />
                {a.level_price !== null && a.triggered_price != null && (
                  <span className="text-ink-faint">
                    {" "}(hit <Money value={a.triggered_price} precise />)
                  </span>
                )}
                {a.source_author && (
                  <span className="text-ink-faint italic"> — {a.source_author}</span>
                )}
              </span>
            </Link>
            {a.suggested_action && (
              <p className="ml-16 mt-0.5 text-[12px] text-ink-faint italic">
                {a.suggested_action}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
