import { mockAlerts, mockCalendarEvents, mockHoldings, mockPortfolio, mockSecurityDetail } from "../../shared/fixtures";
import { MiniSparkline } from "../../shared/Sparkline";
import { HeroBlock } from "../components/HeroBlock";
import { CategoryChip, SectionLabel, SoftCard } from "../components/SoftCard";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function ModernTodayView() {
  const triggeredToday = mockAlerts.filter((a) => a.status === "triggered_today");
  const todayEvents = mockCalendarEvents.filter((e) => e.date === "2026-04-28");
  const movers = [...mockHoldings].sort((a, b) => Math.abs(b.todayChangePct) - Math.abs(a.todayChangePct)).slice(0, 5);

  return (
    <HeroBlock id="today" eyebrow="Tuesday, April 28" title="Hi Yitzi 👋" subtitle="Here's where things stand at market close.">
      {/* Hero portfolio card */}
      <SoftCard tint="amber" padding={36}>
        <SectionLabel>Your portfolio</SectionLabel>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: "clamp(48px, 7vw, 72px)", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1, color: "#0a0a0a" }}>
            {fmtUSD(mockPortfolio.totalValue)}
          </span>
          <CategoryChip tone="up">
            ▲ ${mockPortfolio.todayChange.toLocaleString("en-US", { maximumFractionDigits: 0 })} today ({fmtPct(mockPortfolio.todayChangePct)})
          </CategoryChip>
        </div>
        <p style={{ color: "#71717a", fontSize: 14, marginTop: 16, marginBottom: 0 }}>
          5 accounts · 47 positions · {fmtUSD(mockPortfolio.cashBalance)} cash · YTD +12.4%
        </p>
      </SoftCard>

      {/* Two-card alert + events row */}
      <div className="mb-two-col">
        <SoftCard tint="rose">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>Alerts triggered today</h3>
            <CategoryChip tone="down">{triggeredToday.length} new</CategoryChip>
          </div>
          <div style={{ display: "grid", gap: 14 }}>
            {triggeredToday.map((a) => (
              <div
                key={a.id}
                style={{
                  background: "#fffefb",
                  borderRadius: 12,
                  padding: 14,
                  border: "1px solid rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-geist-mono)" }}>
                    {a.symbol}
                  </span>
                  <CategoryChip tone={a.levelType === "support" ? "up" : "down"}>
                    {a.levelType === "support" ? "Support reclaim" : "Resistance test"}
                  </CategoryChip>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "#71717a" }}>{a.source}</span>
                </div>
                <p style={{ fontSize: 14, color: "#3f3f46", margin: 0, lineHeight: 1.5 }}>
                  {a.recommendation}
                </p>
              </div>
            ))}
          </div>
        </SoftCard>

        <SoftCard tint="lavender">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>Today&rsquo;s releases</h3>
            <CategoryChip tone="blue">{todayEvents.length} events</CategoryChip>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            {todayEvents.map((e) => (
              <div
                key={e.id}
                style={{
                  background: "#fffefb",
                  borderRadius: 12,
                  padding: 14,
                  border: "1px solid rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "#71717a" }}>{e.releaseTime}</span>
                  {e.symbol && (
                    <span style={{ fontFamily: "var(--font-geist-mono)", fontWeight: 700, color: "#0a0a0a" }}>
                      {e.symbol}
                    </span>
                  )}
                  {e.actual && <CategoryChip tone="up">{e.actual} actual</CategoryChip>}
                </div>
                <p style={{ fontSize: 14, color: "#27272a", margin: 0 }}>{e.title}</p>
                {e.consensus && !e.actual && (
                  <p style={{ fontSize: 12, color: "#71717a", margin: 0, marginTop: 4 }}>
                    Consensus: {e.consensus}
                  </p>
                )}
                {e.reactionPct !== undefined && (
                  <p style={{ fontSize: 12, color: e.reactionPct > 0 ? "#15803d" : "#b91c1c", margin: 0, marginTop: 4 }}>
                    SPY reaction {fmtPct(e.reactionPct)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </SoftCard>
      </div>

      {/* Movers */}
      <SoftCard>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
          <h3 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>Today&rsquo;s movers</h3>
          <span style={{ fontSize: 13, color: "#71717a" }}>Sorted by absolute move</span>
        </div>
        <div style={{ display: "grid", gap: 0 }}>
          {movers.map((h, i) => {
            const tone = h.todayChangePct >= 0 ? "#10b981" : "#f43f5e";
            return (
              <div
                key={`${h.symbol}-${i}`}
                className="mb-movers-row"
                style={{
                  padding: "12px 0",
                  borderTop: i === 0 ? "none" : "1px solid #f4f4f5",
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: tone,
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {h.symbol.slice(0, 2)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#0a0a0a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.symbol.includes("  ") ? h.symbol.split("  ")[0] : h.symbol}
                  </div>
                  <div style={{ fontSize: 13, color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</div>
                </div>
                <span className="mb-spark">
                  <MiniSparkline bars={mockSecurityDetail.bars.slice(-30)} color={tone} width={100} height={28} />
                </span>
                <div className="mb-value" style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#0a0a0a" }}>{fmtUSD(h.marketValue)}</div>
                  <div style={{ fontSize: 12, color: "#71717a" }}>{h.account}</div>
                </div>
                <div className="mb-chip" style={{ textAlign: "right" }}>
                  <CategoryChip tone={h.todayChangePct >= 0 ? "up" : "down"}>{fmtPct(h.todayChangePct)}</CategoryChip>
                </div>
              </div>
            );
          })}
        </div>
      </SoftCard>
    </HeroBlock>
  );
}
