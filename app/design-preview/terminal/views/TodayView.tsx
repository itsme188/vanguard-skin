import { mockAlerts, mockCalendarEvents, mockHoldings, mockPortfolio } from "../../shared/fixtures";
import { TerminalFrame, TerminalKpiRow, TerminalRow } from "../components/TerminalFrame";

const fmtNum = (n: number, frac = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

export function TerminalTodayView() {
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
      <div style={{ borderBottom: "1px solid #1f1f1f" }}>
        <TerminalRow tone="header" columns="80px 60px 50px 60px 60px 1fr 100px" cells={["TIME", "SYM", "DIR", "TRIG", "PX", "RECOMMENDATION", "SOURCE"]} />
        {triggeredToday.map((a) => (
          <TerminalRow
            key={a.id}
            columns="80px 60px 50px 60px 60px 1fr 100px"
            cells={[
              new Date(a.triggeredAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
              <span key="s" style={{ color: "#ffb84d" }}>{a.symbol}</span>,
              <span key="d" style={{ color: a.levelType === "support" ? "#22c55e" : "#ef4444" }}>
                {a.levelType === "support" ? "S" : a.levelType === "resistance" ? "R" : "MA"}
              </span>,
              fmtNum(a.triggerPrice),
              <span key="p" style={{ color: a.currentPrice >= a.triggerPrice ? "#22c55e" : "#ef4444" }}>
                {fmtNum(a.currentPrice)}
              </span>,
              <span key="r" style={{ color: "#bbb", whiteSpace: "normal", fontSize: 12 }}>{a.recommendation}</span>,
              <span key="src" style={{ color: "#888", fontSize: 11 }}>{a.source}</span>,
            ]}
          />
        ))}
      </div>

      {/* Today's earnings/macro */}
      <div style={{ borderBottom: "1px solid #1f1f1f" }}>
        <TerminalRow tone="header" columns="60px 70px 80px 1fr 120px 80px" cells={["TIME", "SYM", "TYPE", "EVENT", "DATA", "REACT"]} />
        {todayEvents.map((e) => (
          <TerminalRow
            key={e.id}
            columns="60px 70px 80px 1fr 120px 80px"
            cells={[
              e.releaseTime ?? "—",
              <span key="s" style={{ color: e.symbol ? "#ffb84d" : "#60a5fa" }}>
                {e.symbol ?? "MACRO"}
              </span>,
              <span key="t" style={{ color: "#888", fontSize: 11 }}>{e.eventType.toUpperCase()}</span>,
              <span key="e" style={{ color: "#d4d4d4", fontSize: 12 }}>{e.title}</span>,
              <span key="d" style={{ color: e.actual ? "#22c55e" : "#888", fontSize: 11 }}>
                {e.actual ? `act ${e.actual}` : e.consensus ? `cons ${e.consensus}` : "—"}
              </span>,
              <span key="r" style={{ color: e.reactionPct === undefined ? "#444" : e.reactionPct > 0 ? "#22c55e" : "#ef4444" }}>
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
          columns="80px 1fr 70px 70px 80px 90px 70px"
          cells={["SYM", "NAME", "ACCT", "QTY", "PX", "MV", "DAY%"]}
        />
        {movers.map((h) => (
          <TerminalRow
            key={`${h.symbol}-${h.account}`}
            columns="80px 1fr 70px 70px 80px 90px 70px"
            cells={[
              <span key="s" style={{ color: "#ffb84d", fontWeight: 600 }}>
                {h.symbol.includes("  ") ? h.symbol.split("  ")[0] : h.symbol}
              </span>,
              <span key="n" style={{ color: "#888", fontSize: 12 }}>{h.name}</span>,
              <span key="a" style={{ color: "#666", fontSize: 11 }}>{h.account}</span>,
              fmtNum(h.quantity, 0),
              fmtNum(h.price),
              fmtNum(h.marketValue, 0),
              <span key="d" style={{ color: h.todayChangePct >= 0 ? "#22c55e" : "#ef4444" }}>
                {fmtPct(h.todayChangePct)}
              </span>,
            ]}
          />
        ))}
      </div>
    </TerminalFrame>
  );
}
