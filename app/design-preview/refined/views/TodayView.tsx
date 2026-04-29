import { mockAlerts, mockCalendarEvents, mockHoldings, mockPortfolio, mockSecurityDetail } from "../../shared/fixtures";
import { MiniSparkline } from "../../shared/Sparkline";
import { HeroBlock } from "../components/HeroBlock";
import { SagePill } from "../components/SagePill";
import { Eyebrow, SectionTitle, SoftCard } from "../components/SoftCard";
import { SAGE } from "../palette";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function RefinedTodayView() {
  const triggeredToday = mockAlerts.filter((a) => a.status === "triggered_today");
  const todayEvents = mockCalendarEvents.filter((e) => e.date === "2026-04-28");
  const movers = [...mockHoldings].sort((a, b) => Math.abs(b.todayChangePct) - Math.abs(a.todayChangePct)).slice(0, 5);

  return (
    <HeroBlock id="today" eyebrow="Tuesday · April 28, 2026" title="Good afternoon, Yitzi." subtitle="Your daily landing — alerts triggered today, this morning's earnings, holdings to scan.">
      {/* Hero portfolio card */}
      <SoftCard tint="sage" padding={28}>
        <Eyebrow color={SAGE.brandSoft}>Portfolio</Eyebrow>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: "clamp(36px, 5vw, 48px)",
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: SAGE.ink,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtUSD(mockPortfolio.totalValue)}
          </span>
          <SagePill tone="up" mono>
            ▲ ${mockPortfolio.todayChange.toLocaleString("en-US", { maximumFractionDigits: 0 })} today ({fmtPct(mockPortfolio.todayChangePct)})
          </SagePill>
        </div>
        <p style={{ color: SAGE.inkDim, fontSize: 15, marginTop: 12, marginBottom: 0 }}>
          5 accounts · 47 positions · {fmtUSD(mockPortfolio.cashBalance)} cash · YTD +12.4%
        </p>
      </SoftCard>

      {/* Two-card alert + events row */}
      <div className="rf-two-col">
        <SoftCard tint="surface">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
            <SectionTitle>Alerts triggered today</SectionTitle>
            <SagePill tone="down" mono>{triggeredToday.length} new</SagePill>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            {triggeredToday.map((a) => (
              <div
                key={a.id}
                style={{
                  background: SAGE.surfaceAlt,
                  borderRadius: 8,
                  padding: 13,
                  border: `1px solid ${SAGE.border}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontFamily: "var(--font-refined-mono)",
                      fontSize: 14,
                      fontWeight: 600,
                      color: SAGE.ink,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {a.symbol}
                  </span>
                  <SagePill tone={a.levelType === "support" ? "up" : "down"} size="xs">
                    {a.levelType === "support" ? "Support reclaim" : "Resistance test"}
                  </SagePill>
                  <span style={{ marginLeft: "auto", fontSize: 13, color: SAGE.inkFaint }}>{a.source}</span>
                </div>
                <p style={{ fontSize: 15, color: SAGE.inkDim, margin: 0, lineHeight: 1.5 }}>
                  {a.recommendation}
                </p>
              </div>
            ))}
          </div>
        </SoftCard>

        <SoftCard tint="surface">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
            <SectionTitle>Today&rsquo;s releases</SectionTitle>
            <SagePill tone="accent" mono>{todayEvents.length} events</SagePill>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {todayEvents.map((e) => (
              <div
                key={e.id}
                style={{
                  background: SAGE.surfaceAlt,
                  borderRadius: 8,
                  padding: 13,
                  border: `1px solid ${SAGE.border}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 13, color: SAGE.inkDim }}>
                    {e.releaseTime}
                  </span>
                  {e.symbol ? (
                    <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 15, fontWeight: 600, color: SAGE.ink }}>
                      {e.symbol}
                    </span>
                  ) : (
                    <SagePill tone="accent" size="xs">Macro</SagePill>
                  )}
                  {e.actual && <SagePill tone="up" size="xs" mono>actual {e.actual}</SagePill>}
                </div>
                <p style={{ fontSize: 15, color: SAGE.ink, margin: 0 }}>{e.title}</p>
                {e.consensus && !e.actual && (
                  <p style={{ fontSize: 13, color: SAGE.inkDim, margin: 0, marginTop: 3, fontFamily: "var(--font-refined-mono)" }}>
                    Consensus: {e.consensus}
                  </p>
                )}
                {e.reactionPct !== undefined && (
                  <p style={{ fontSize: 13, color: e.reactionPct > 0 ? SAGE.up : SAGE.down, margin: 0, marginTop: 3, fontFamily: "var(--font-refined-mono)" }}>
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
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
          <SectionTitle>Today&rsquo;s movers</SectionTitle>
          <span style={{ fontSize: 14, color: SAGE.inkDim }}>Sorted by absolute move</span>
        </div>
        <div style={{ display: "grid", gap: 0 }}>
          {movers.map((h, i) => {
            const tone = h.todayChangePct >= 0 ? SAGE.up : SAGE.down;
            const ticker = h.symbol.includes("  ") ? h.symbol.split("  ")[0] : h.symbol;
            return (
              <div
                key={`${h.symbol}-${i}`}
                className="rf-movers-row"
                style={{
                  padding: "12px 0",
                  borderTop: i === 0 ? "none" : `1px solid ${SAGE.border}`,
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: tone,
                    color: SAGE.surface,
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "var(--font-refined-sans)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {ticker.slice(0, 2)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-refined-mono)",
                      fontSize: 14,
                      fontWeight: 600,
                      color: SAGE.ink,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ticker}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: SAGE.inkDim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h.name}
                  </div>
                </div>
                <span className="rf-spark">
                  <MiniSparkline bars={mockSecurityDetail.bars.slice(-30)} color={tone} width={100} height={26} />
                </span>
                <div className="rf-value" style={{ textAlign: "right" }}>
                  <div
                    style={{
                      fontFamily: "var(--font-refined-mono)",
                      fontSize: 14,
                      fontWeight: 500,
                      color: SAGE.ink,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtUSD(h.marketValue)}
                  </div>
                  <div style={{ fontSize: 13, color: SAGE.inkDim }}>{h.account}</div>
                </div>
                <div className="rf-chip" style={{ textAlign: "right" }}>
                  <SagePill tone={h.todayChangePct >= 0 ? "up" : "down"} mono size="xs">
                    {fmtPct(h.todayChangePct)}
                  </SagePill>
                </div>
              </div>
            );
          })}
        </div>
      </SoftCard>
    </HeroBlock>
  );
}
