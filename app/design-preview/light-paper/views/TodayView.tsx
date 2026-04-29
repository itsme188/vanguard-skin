import { mockAlerts, mockCalendarEvents, mockHoldings, mockPortfolio } from "../../shared/fixtures";
import { MiniSparkline } from "../../shared/Sparkline";
import { mockSecurityDetail } from "../../shared/fixtures";
import { DataLabel, DataModule } from "../components/DataModule";
import { PaperCard, PaperSection } from "../components/PaperSection";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function TodayView() {
  const triggeredToday = mockAlerts.filter((a) => a.status === "triggered_today");
  const todayEvents = mockCalendarEvents.filter((e) => e.date === "2026-04-28");
  const ibkrHoldings = mockHoldings
    .filter((h) => h.account === "IBKR" || h.account === "Roth")
    .slice(0, 5);

  return (
    <PaperSection
      id="today"
      eyebrow="Tuesday · April 28, 2026"
      title="Good afternoon, Yitzi."
      subtitle="Your daily landing — alerts triggered today, this morning's earnings, holdings to scan."
    >
      {/* Hero portfolio number */}
      <PaperCard padding={32}>
        <DataLabel>Portfolio</DataLabel>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(48px, 7vw, 72px)",
              lineHeight: 1,
              letterSpacing: "-0.02em",
            }}
          >
            {fmtUSD(mockPortfolio.totalValue)}
          </span>
          <span style={{ color: "#10802b", fontSize: 18, fontWeight: 500 }}>
            +${mockPortfolio.todayChange.toLocaleString("en-US", { maximumFractionDigits: 0 })} ({fmtPct(mockPortfolio.todayChangePct)})
          </span>
        </div>
        <p style={{ color: "#5a5a5a", fontSize: 14, marginTop: 12, marginBottom: 0 }}>
          5 accounts · 47 positions · {fmtUSD(mockPortfolio.cashBalance)} cash
        </p>
      </PaperCard>

      {/* Alerts triggered today — embedded data module */}
      <DataModule title="Alerts · Triggered Today" subtitle={`${triggeredToday.length} pending response`} action="LIVE">
        <div style={{ display: "grid", gap: 10 }}>
          {triggeredToday.map((a) => (
            <div
              key={a.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 16,
                padding: "10px 0",
                borderBottom: "1px solid #161616",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: a.levelType === "support" ? "#22c55e" : "#ef4444", fontSize: 10, letterSpacing: "0.18em" }}>
                  {a.levelType.toUpperCase()}
                </span>
                <span style={{ color: "#ffb84d", fontWeight: 600, fontSize: 13 }}>{a.symbol}</span>
                <span style={{ color: "#888" }}>${a.triggerPrice.toFixed(2)} → ${a.currentPrice.toFixed(2)}</span>
              </div>
              <span style={{ color: "#bbb", lineHeight: 1.5, fontSize: 12 }}>{a.recommendation}</span>
              <span style={{ color: "#666", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase" }}>
                {a.source}
              </span>
            </div>
          ))}
        </div>
      </DataModule>

      {/* Today's earnings + macro events */}
      <DataModule title="Today · Earnings + Macro" subtitle={`${todayEvents.length} events`}>
        <div style={{ display: "grid", gap: 8 }}>
          {todayEvents.map((e) => (
            <div
              key={e.id}
              style={{
                display: "grid",
                gridTemplateColumns: "60px 80px 1fr auto",
                gap: 12,
                padding: "8px 0",
                fontSize: 12,
              }}
            >
              <span style={{ color: "#888" }}>{e.releaseTime ?? "—"}</span>
              <span style={{ color: e.symbol ? "#ffb84d" : "#60a5fa", fontWeight: 600 }}>
                {e.symbol ?? e.eventType.toUpperCase()}
              </span>
              <span style={{ color: "#ddd" }}>{e.title}</span>
              <span style={{ color: e.actual ? "#22c55e" : "#666", fontSize: 11 }}>
                {e.actual ? `actual ${e.actual}` : e.consensus ? `cons ${e.consensus}` : "—"}
                {e.reactionPct !== undefined && (
                  <span style={{ marginLeft: 8, color: e.reactionPct > 0 ? "#22c55e" : "#ef4444" }}>
                    SPY {fmtPct(e.reactionPct)}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </DataModule>

      {/* Holdings to scan — light card */}
      <PaperCard>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
          <h3 style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 22, margin: 0 }}>
            Today&rsquo;s movers
          </h3>
          <span style={{ fontSize: 12, color: "#7a7a7a" }}>IBKR + Roth · sorted by |today|</span>
        </div>
        <div style={{ display: "grid", gap: 0 }}>
          {ibkrHoldings.map((h) => {
            const tone = h.todayChangePct >= 0 ? "#10802b" : "#b91c1c";
            return (
              <div
                key={h.symbol}
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 1fr 80px 90px 70px",
                  gap: 16,
                  alignItems: "center",
                  padding: "12px 0",
                  borderTop: "1px solid #ece8db",
                  fontSize: 14,
                }}
              >
                <span style={{ fontFamily: "var(--font-geist-mono)", fontWeight: 600 }}>{h.symbol}</span>
                <span style={{ color: "#5a5a5a", fontSize: 13 }}>{h.name}</span>
                <MiniSparkline
                  bars={mockSecurityDetail.bars.slice(-30)}
                  color={h.todayChangePct >= 0 ? "#10b981" : "#ef4444"}
                />
                <span
                  style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right", color: "#1a1a1a" }}
                >
                  {fmtUSD(h.marketValue)}
                </span>
                <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right", color: tone, fontWeight: 500 }}>
                  {fmtPct(h.todayChangePct)}
                </span>
              </div>
            );
          })}
        </div>
      </PaperCard>
    </PaperSection>
  );
}
