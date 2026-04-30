/**
 * Shared Today rendering for all design preview options.
 *
 * Layout knobs:
 *  - density: "default" | "compact"
 *      - default: card padding p-5 / sm:p-6, row gaps roomy
 *      - compact: card padding p-3 / sm:p-4, row gaps tighter
 *      - Font sizes are unchanged across both densities.
 *  - header: "hero" | "strip"
 *      - hero: standalone Hero card with the portfolio total (current pick)
 *      - strip: portfolio total moves to a slim horizontal row above the
 *        rest of the page, no card chrome — peer-weight cards below it
 *
 * Mock data only — every preview shares the same data so visual differences
 * are isolated to the layout/density choices being compared.
 */

import {
  MOCK_PORTFOLIO,
  MOCK_TODAY_DATE,
  MOCK_HOLDINGS,
  MOCK_ALERTS,
  MOCK_EVENTS_TODAY,
  MOCK_WEEK_AHEAD,
  MOCK_NEARBY_LEVELS,
} from "./mock-data";

const fmtUSD = (n: number, max = 0) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: max });
const fmtUSD2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number, signed = true) =>
  `${signed && n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

function fmtTime(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map((s) => parseInt(s, 10));
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export type TodayDensity = "default" | "medium" | "compact";
export type TodayHeader = "hero" | "strip";

export interface TodayPreviewProps {
  density?: TodayDensity;
  header?: TodayHeader;
}

export function TodayPreview({
  density = "default",
  header = "hero",
}: TodayPreviewProps) {
  const todayAlerts = MOCK_ALERTS.filter((a) => a.triggeredToday);
  const olderAlerts = MOCK_ALERTS.filter((a) => !a.triggeredToday);

  // Density-driven className constants — all spacing/padding flows from here.
  // Three tiers:
  //   default — roomy padding (Bloomberg-light spec) for first-time visitors
  //   medium  — halfway tier: card padding 16-20px, gaps proportionally tightened
  //   compact — Bloomberg/TradingView density: 12-14px padding, tight rows
  const cardPad =
    density === "compact" ? "p-3 sm:p-4" :
    density === "medium" ? "p-4 sm:p-5" :
    "p-5 sm:p-6";
  const cardPadTight =
    density === "compact" ? "p-3" :
    density === "medium" ? "p-4" :
    "p-5";
  const sectionGap =
    density === "compact" ? "space-y-3" :
    density === "medium" ? "space-y-4" :
    "space-y-6";
  const titleGap =
    density === "compact" ? "mb-2" :
    density === "medium" ? "mb-2" :
    "mb-3";
  const rowPad =
    density === "compact" ? "py-1.5" :
    density === "medium" ? "py-2" :
    "py-2.5";
  const rowSpacing =
    density === "compact" ? "space-y-1.5" :
    density === "medium" ? "space-y-2" :
    "space-y-2";
  const eventPad =
    density === "compact" ? "p-2.5" :
    density === "medium" ? "p-3" :
    "p-3";
  const dayCardPad =
    density === "compact" ? "p-3 sm:p-4" :
    density === "medium" ? "p-4 sm:p-5" :
    "p-5 sm:p-6";
  const dayHeaderGap =
    density === "compact" ? "mb-2" :
    density === "medium" ? "mb-3" :
    "mb-4";
  const eventTilePad =
    density === "compact" ? "p-2.5" :
    density === "medium" ? "p-3" :
    "p-3.5";
  const heroPad =
    density === "compact" ? "p-4 sm:p-5" :
    density === "medium" ? "p-4 sm:p-5" :
    "p-5 sm:p-6";

  // Group week-ahead by weekday for the 5-col grid
  const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
  const weekByDay = weekDays.map((wd) => ({
    weekday: wd,
    label:
      MOCK_WEEK_AHEAD.find((e) => e.weekday === wd)?.date.slice(5).replace("-", "/") ?? "",
    events: MOCK_WEEK_AHEAD.filter((e) => e.weekday === wd),
    isToday: MOCK_WEEK_AHEAD.find((e) => e.weekday === wd)?.isToday ?? false,
  }));

  return (
    <div className={sectionGap}>
      {/* ── Page header (date + Today title + week-ahead link) ── */}
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <p className="preview-eyebrow text-[11px] uppercase tracking-widest text-ink-faint mb-1">
            {MOCK_TODAY_DATE}
          </p>
          <h1 className="preview-page-title font-serif text-2xl text-gold tracking-tight">
            Today
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono rounded px-2 py-0.5 text-up bg-up/20">
            live · Apr 30
          </span>
          <span className="text-[11px] uppercase tracking-widest text-ink-faint border border-edge rounded-full px-3 py-1">
            Week ahead →
          </span>
        </div>
      </header>

      {/* ── Portfolio: Hero card OR slim strip ── */}
      {header === "hero" ? (
        <section className={`preview-card preview-hero rounded-xl border border-edge bg-panel ${heroPad}`}>
          <p className="preview-eyebrow-brand text-[11px] uppercase tracking-widest text-ink-faint mb-2">
            Portfolio
          </p>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1
              className="font-mono font-semibold tabular-nums text-ink"
              style={{ fontSize: "clamp(28px, 5vw, 44px)", lineHeight: 1, letterSpacing: "-0.02em" }}
            >
              {fmtUSD(MOCK_PORTFOLIO.totalValue)}
            </h1>
            <span className="text-[13px] font-mono tabular-nums rounded-full px-2.5 py-1 bg-up/10 text-up">
              ▲ {fmtUSD(MOCK_PORTFOLIO.totalChange)}{" "}
              <span className="text-ink-faint">{MOCK_PORTFOLIO.changeLabel}</span>
            </span>
          </div>
          <p className="text-[13px] text-ink-faint mt-2">
            {MOCK_PORTFOLIO.accountCount} accounts · as of {MOCK_PORTFOLIO.asOf}
          </p>
        </section>
      ) : (
        <div className="border-b border-edge pb-3 flex items-baseline gap-4 flex-wrap">
          <p className="text-[11px] uppercase tracking-widest text-ink-faint">Portfolio</p>
          <span
            className="font-mono font-semibold tabular-nums text-ink"
            style={{ fontSize: "clamp(22px, 3vw, 28px)", lineHeight: 1, letterSpacing: "-0.02em" }}
          >
            {fmtUSD(MOCK_PORTFOLIO.totalValue)}
          </span>
          <span className="text-[12px] font-mono tabular-nums rounded-full px-2 py-0.5 bg-up/10 text-up">
            ▲ {fmtUSD(MOCK_PORTFOLIO.totalChange)}{" "}
            <span className="text-ink-faint">{MOCK_PORTFOLIO.changeLabel}</span>
          </span>
          <span className="text-[12px] text-ink-faint ml-auto">
            {MOCK_PORTFOLIO.accountCount} accounts · as of {MOCK_PORTFOLIO.asOf}
          </span>
        </div>
      )}

      {/* ── Today's releases ── */}
      <section className={`preview-card preview-context rounded-xl border border-edge bg-panel ${cardPad}`}>
        <div className={`${titleGap} flex items-baseline justify-between`}>
          <h2 className="preview-section-title text-sm font-medium text-ink">
            Today&rsquo;s releases
          </h2>
          <span className="text-[11px] text-ink-faint font-mono">
            {MOCK_EVENTS_TODAY.length} events
          </span>
        </div>
        <ul className={rowSpacing}>
          {MOCK_EVENTS_TODAY.map((e, i) => (
            <li key={i} className={`preview-event-row rounded-lg bg-raised border border-edge ${eventPad}`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[11px] font-mono text-ink-faint tabular-nums">
                  {fmtTime(e.time)}
                </span>
                {e.symbol ? (
                  <span className="font-mono text-[14px] font-medium text-ink">{e.symbol}</span>
                ) : (
                  <span className="text-[10px] uppercase tracking-widest rounded-full px-2 py-0.5 bg-down/10 text-down">
                    Macro · {e.impact}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-ink-dim">{e.title}</p>
              {e.consensus && (
                <p className="text-[12px] font-mono text-ink-faint mt-1">Cons: {e.consensus}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ── Alerts | Levels grid ── */}
      <div className={`grid grid-cols-1 md:grid-cols-2 ${density === "compact" ? "gap-3" : density === "medium" ? "gap-4" : "gap-6"}`}>
        <section className={`preview-card rounded-xl border border-edge bg-panel ${cardPad}`}>
          <div className={`${titleGap} flex items-baseline justify-between`}>
            <h2 className="preview-section-title text-sm font-medium text-ink">Alerts</h2>
            <span className="text-[11px] text-ink-faint font-mono">
              {MOCK_ALERTS.length} pending
            </span>
          </div>
          <div className={density === "compact" ? "space-y-2" : density === "medium" ? "space-y-3" : "space-y-4"}>
            {todayAlerts.length > 0 && (
              <div>
                <h3 className={`text-[11px] uppercase tracking-widest text-ink-dim ${density === "compact" ? "mb-1.5" : "mb-2"}`}>
                  Triggered today
                </h3>
                <ul className={rowSpacing}>
                  {todayAlerts.map((a, i) => (
                    <li key={i} className="text-[14px]">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono font-medium text-ink w-14 shrink-0">
                          {a.symbol}
                        </span>
                        <span className="flex-1 text-ink-dim">
                          <span className="uppercase">{a.levelType.replace("_", " ")}</span>
                          {" @ "}
                          <span className="text-ink">{fmtUSD2(a.levelPrice)}</span>
                          {" "}
                          <span className="text-ink-faint">
                            (hit {fmtUSD2(a.triggeredPrice)})
                          </span>
                          {" — "}
                          <span className="text-ink-faint italic">{a.source}</span>
                        </span>
                      </div>
                      {a.suggestion && (
                        <p className="ml-16 mt-0.5 text-[12px] text-ink-faint italic">
                          {a.suggestion}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {olderAlerts.length > 0 && (
              <div>
                <h3 className={`text-[11px] uppercase tracking-widest text-ink-faint ${density === "compact" ? "mb-1.5" : "mb-2"}`}>
                  Older pending
                </h3>
                <ul className={density === "compact" ? "space-y-1" : "space-y-1.5"}>
                  {olderAlerts.map((a, i) => (
                    <li key={i} className="text-[13px] flex items-baseline gap-2">
                      <span className="font-mono font-medium text-ink w-14 shrink-0">
                        {a.symbol}
                      </span>
                      <span className="flex-1 text-ink-dim">
                        <span className="uppercase">{a.levelType.replace("_", " ")}</span>
                        {" @ "}
                        <span className="text-ink">{fmtUSD2(a.levelPrice)}</span>
                        {" "}
                        <span className="text-ink-faint italic">— {a.source}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className={`preview-card rounded-xl border border-edge bg-panel ${cardPad}`}>
          <div className={`${titleGap} flex items-baseline justify-between`}>
            <div>
              <h2 className="preview-section-title text-sm font-medium text-ink">
                Levels within 5%
              </h2>
              <p className="text-[11px] text-ink-faint mt-0.5">
                Armed levels close to triggering.
              </p>
            </div>
            <span className="text-[11px] text-ink-faint font-mono">
              {MOCK_NEARBY_LEVELS.length}
            </span>
          </div>
          <ul className={rowSpacing}>
            {MOCK_NEARBY_LEVELS.map((l, i) => (
              <li key={i} className="text-[14px] flex items-baseline gap-2">
                <span className="font-mono font-medium text-ink w-14 shrink-0">{l.symbol}</span>
                <span className="flex-1 text-ink-dim">
                  <span className="uppercase">{l.levelType.replace("_", " ")}</span>
                  {" @ "}
                  <span className="text-ink">{fmtUSD2(l.price)}</span>
                </span>
                <span className="font-mono text-[12px] text-blue tabular-nums">
                  {fmtPct(l.distancePct)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ── Holdings ── */}
      <section className={`preview-card rounded-xl border border-edge bg-panel ${cardPadTight}`}>
        <div className={`${titleGap} flex items-baseline justify-between ${density === "compact" ? "px-0" : ""}`}>
          <h2 className="preview-section-title text-sm font-medium text-ink">IBKR today</h2>
          <span className="text-[11px] text-ink-faint font-mono">
            {MOCK_HOLDINGS.length} · today&rsquo;s move
          </span>
        </div>
        <ul className={`divide-y divide-edge ${density === "compact" ? "-mx-3" : density === "medium" ? "-mx-4" : "-mx-5"}`}>
          {MOCK_HOLDINGS.map((h) => {
            const todayGain = (h.price - h.priorClose) * h.quantity;
            const todayPct = ((h.price - h.priorClose) / h.priorClose) * 100;
            const gainSign = todayGain >= 0 ? "text-up" : "text-down";
            return (
              <li key={h.symbol} className={`${density === "compact" ? "px-3" : density === "medium" ? "px-4" : "px-5"} ${rowPad} flex items-center gap-3`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[14px] font-medium text-ink">
                      {h.symbol}
                    </span>
                    <span className="text-[11px] text-ink-faint truncate">{h.name}</span>
                  </div>
                  <div className="text-[12px] text-ink-faint font-mono mt-0.5 flex items-center gap-2">
                    <span>
                      {h.quantity} @ {fmtUSD2(h.price)}
                    </span>
                    <span>=</span>
                    <span>{fmtUSD(h.price * h.quantity)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-[14px] font-mono tabular-nums ${gainSign}`}>
                    {todayGain >= 0 ? "+" : ""}
                    {fmtUSD(todayGain)}
                  </div>
                  <div className={`text-[12px] font-mono tabular-nums ${gainSign}`}>
                    {fmtPct(todayPct)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Week-ahead embedded ── */}
      <section className={density === "compact" ? "space-y-2" : density === "medium" ? "space-y-3" : "space-y-4"}>
        <div className="flex items-baseline justify-between">
          <h2 className="preview-section-title font-serif text-2xl text-gold tracking-tight">
            Week ahead
          </h2>
          <span className="text-[11px] text-ink-faint font-mono">
            {MOCK_WEEK_AHEAD.length} events
          </span>
        </div>
        <div className={`preview-week-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 ${density === "compact" ? "gap-3" : density === "medium" ? "gap-4" : "gap-5"}`}>
          {weekByDay.map((day) => (
            <div
              key={day.weekday}
              data-today={day.isToday ? "true" : undefined}
              className={`preview-card preview-day-card rounded-xl border ${dayCardPad} min-w-0 ${
                day.isToday ? "border-blue bg-blue/8" : "border-edge bg-panel"
              }`}
            >
              <div className={`flex items-baseline justify-between ${dayHeaderGap}`}>
                <div>
                  <p
                    className={`preview-eyebrow text-[11px] uppercase tracking-widest mb-1 ${
                      day.isToday ? "text-blue" : "text-ink-faint"
                    }`}
                  >
                    {day.weekday}
                  </p>
                  <p className="font-serif text-2xl text-ink leading-tight">{day.label}</p>
                </div>
                {day.isToday && (
                  <span className="text-[11px] uppercase tracking-widest text-blue border border-blue rounded-full px-2.5 py-0.5">
                    Today
                  </span>
                )}
              </div>
              <ul className={density === "compact" ? "space-y-1.5" : density === "medium" ? "space-y-2" : "space-y-2.5"}>
                {day.events.length === 0 ? (
                  <li className="text-[13px] text-ink-faint italic">No events</li>
                ) : (
                  day.events.map((e, i) => (
                    <li
                      key={i}
                      className={`preview-event-row rounded-lg bg-raised border border-edge ${eventTilePad}`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[11px] font-mono text-ink-faint tabular-nums">
                          {fmtTime(e.time)}
                        </span>
                        {e.symbol ? (
                          <span className="font-mono text-[14px] font-medium text-ink">
                            {e.symbol}
                          </span>
                        ) : (
                          <span
                            className={`text-[11px] uppercase tracking-widest rounded-full px-2 py-0.5 ${
                              e.impact === "high"
                                ? "bg-down/10 text-down"
                                : e.impact === "medium"
                                  ? "bg-blue/15 text-blue"
                                  : "bg-raised text-ink-faint"
                            }`}
                          >
                            Macro
                          </span>
                        )}
                        {e.actual && (
                          <span className="text-[11px] font-mono text-up bg-up/10 rounded px-1.5 py-0.5 ml-auto">
                            actual
                          </span>
                        )}
                      </div>
                      <p className="text-[13px] text-ink-dim leading-snug">{e.title}</p>
                      {e.consensus && !e.actual && (
                        <p className="text-[12px] font-mono text-ink-faint mt-1.5">
                          Cons: {e.consensus}
                        </p>
                      )}
                    </li>
                  ))
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
