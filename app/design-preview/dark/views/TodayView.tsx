import { mockAlerts, mockCalendarEvents, mockHoldings, mockPortfolio } from "../../shared/fixtures";
import { TerminalFrame, TerminalKpiRow, TerminalRow } from "../components/TerminalFrame";
import { DARK } from "../palette";

const fmtNum = (n: number, frac = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

export function DarkTodayView() {
  const triggeredToday = mockAlerts.filter((a) => a.status === "triggered_today");
  const todayEvents = mockCalendarEvents.filter((e) => e.date === "2026-04-28");
  const movers = [...mockHoldings].sort((a, b) => Math.abs(b.todayChangePct) - Math.abs(a.todayChangePct));

  return (
    <TerminalFrame id="today" title="Today · 2026-04-28 · TUE" meta="MKT CLOSED · 16:00 ET">
      <TerminalKpiRow
        items={[
          { label: "Portfolio", value: fmtNum(mockPortfolio.totalValue, 0), tone: "amber" },
          { label: "Day Δ", value: `+${fmtNum(mockPortfolio.todayChange, 0)}`, tone: "up" },
          { label: "Day %", value: `+${mockPortfolio.todayChangePct.toFixed(2)}`, tone: "up" },
          { label: "Cash", value: fmtNum(mockPortfolio.cashBalance, 0), tone: "neutral" },
          { label: "YTD %", value: `+${mockPortfolio.ytdGainPct.toFixed(1)}`, tone: "up" },
          { label: "1Y %", value: `+${mockPortfolio.oneYearGainPct.toFixed(1)}`, tone: "up" },
        ]}
      />

      {/* Alerts log */}
      <div style={{ borderBottom: `1px solid ${DARK.border}` }}>
        <TerminalRow tone="header" columns="80px 60px 50px 70px 70px 1fr 110px" cells={["TIME", "SYM", "DIR", "TRIG", "PX", "RECOMMENDATION", "SOURCE"]} />
        {triggeredToday.map((a) => (
          <TerminalRow
            key={a.id}
            columns="80px 60px 50px 70px 70px 1fr 110px"
            cells={[
              new Date(a.triggeredAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
              <span key="s" style={{ color: DARK.amber }}>{a.symbol}</span>,
              <span key="d" style={{ color: a.levelType === "support" ? DARK.up : DARK.down }}>
                {a.levelType === "support" ? "S" : a.levelType === "resistance" ? "R" : "MA"}
              </span>,
              fmtNum(a.triggerPrice),
              <span key="p" style={{ color: a.currentPrice >= a.triggerPrice ? DARK.up : DARK.down }}>
                {fmtNum(a.currentPrice)}
              </span>,
              <span key="r" style={{ color: DARK.inkBody, whiteSpace: "normal", fontSize: 14 }}>{a.recommendation}</span>,
              <span key="src" style={{ color: DARK.inkDim, fontSize: 13 }}>{a.source}</span>,
            ]}
          />
        ))}
      </div>

      {/* Today's earnings/macro */}
      <div style={{ borderBottom: `1px solid ${DARK.border}` }}>
        <TerminalRow tone="header" columns="60px 70px 80px 1fr 130px 80px" cells={["TIME", "SYM", "TYPE", "EVENT", "DATA", "REACT"]} />
        {todayEvents.map((e) => (
          <TerminalRow
            key={e.id}
            columns="60px 70px 80px 1fr 130px 80px"
            cells={[
              e.releaseTime ?? "—",
              <span key="s" style={{ color: e.symbol ? DARK.amber : DARK.blue }}>
                {e.symbol ?? "MACRO"}
              </span>,
              <span key="t" style={{ color: DARK.inkDim, fontSize: 13 }}>{e.eventType.toUpperCase()}</span>,
              <span key="e" style={{ color: DARK.inkBody, fontSize: 14 }}>{e.title}</span>,
              <span key="d" style={{ color: e.actual ? DARK.up : DARK.inkDim, fontSize: 13 }}>
                {e.actual ? `act ${e.actual}` : e.consensus ? `cons ${e.consensus}` : "—"}
              </span>,
              <span key="r" style={{ color: e.reactionPct === undefined ? DARK.inkFaint : e.reactionPct > 0 ? DARK.up : DARK.down }}>
                {e.reactionPct !== undefined ? `${fmtPct(e.reactionPct)}%` : "—"}
              </span>,
            ]}
          />
        ))}
      </div>

      {/* Movers */}
      <div>
        <TerminalRow
          tone="header"
          columns="80px 1fr 70px 80px 90px 100px 80px"
          cells={["SYM", "NAME", "ACCT", "QTY", "PX", "MV", "DAY%"]}
        />
        {movers.map((h) => (
          <TerminalRow
            key={`${h.symbol}-${h.account}`}
            columns="80px 1fr 70px 80px 90px 100px 80px"
            cells={[
              <span key="s" style={{ color: DARK.amber, fontWeight: 600 }}>
                {h.symbol.includes("  ") ? h.symbol.split("  ")[0] : h.symbol}
              </span>,
              <span key="n" style={{ color: DARK.inkDim, fontSize: 14 }}>{h.name}</span>,
              <span key="a" style={{ color: DARK.inkDim, fontSize: 13 }}>{h.account}</span>,
              fmtNum(h.quantity, 0),
              fmtNum(h.price),
              fmtNum(h.marketValue, 0),
              <span key="d" style={{ color: h.todayChangePct >= 0 ? DARK.up : DARK.down }}>
                {fmtPct(h.todayChangePct)}
              </span>,
            ]}
          />
        ))}
      </div>
    </TerminalFrame>
  );
}
