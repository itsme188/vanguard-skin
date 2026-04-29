import { mockOverviewKpis, mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { HeroBlock } from "../components/HeroBlock";
import { CategoryChip, SectionLabel, SoftCard } from "../components/SoftCard";

const TINTS: Array<"cream" | "mint" | "lavender" | "rose" | "amber" | "white"> = [
  "amber",
  "mint",
  "lavender",
  "cream",
  "white",
  "rose",
];

export function ModernOverviewView() {
  return (
    <HeroBlock id="overview" eyebrow="Overview" title="Your portfolio at a glance" subtitle="The dashboard you check after market close — performance, allocation, key metrics.">
      {/* KPI grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 16 }}>
        {mockOverviewKpis.map((k, i) => (
          <SoftCard key={k.label} tint={TINTS[i % TINTS.length]}>
            <SectionLabel>{k.label}</SectionLabel>
            <div
              style={{
                fontSize: 32,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: k.deltaTone === "down" ? "#b91c1c" : "#0a0a0a",
                lineHeight: 1.1,
              }}
            >
              {k.value}
            </div>
            {k.delta && (
              <div style={{ marginTop: 8 }}>
                <CategoryChip tone={k.deltaTone === "up" ? "up" : k.deltaTone === "down" ? "down" : "neutral"}>
                  {k.delta}
                </CategoryChip>
              </div>
            )}
            {k.sublabel && <div style={{ fontSize: 12, color: "#71717a", marginTop: 8 }}>{k.sublabel}</div>}
          </SoftCard>
        ))}
      </div>

      {/* Performance chart */}
      <SoftCard padding={28}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <SectionLabel>Performance · 90 days</SectionLabel>
            <h3 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>
              Up <span style={{ color: "#10b981" }}>+12.4%</span> year-to-date
            </h3>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {["1D", "1W", "1M", "3M", "1Y", "All"].map((label) => (
              <button
                key={label}
                style={{
                  border: "none",
                  background: label === "3M" ? "#0a0a0a" : "transparent",
                  color: label === "3M" ? "#fff" : "#71717a",
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Sparkline
          bars={mockSecurityDetail.bars}
          width={1100}
          height={260}
          stroke="#10b981"
          fill="rgba(16, 185, 129, 0.06)"
          showAxisFloor={false}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 12, color: "#a1a1aa" }}>
          <span>Jan 28</span>
          <span>Feb 28</span>
          <span>Mar 28</span>
          <span>Apr 28</span>
        </div>
      </SoftCard>

      {/* Allocation */}
      <SoftCard tint="mint">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
          <h3 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>Allocation</h3>
          <span style={{ fontSize: 13, color: "#71717a" }}>by asset class</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))", gap: 16 }}>
          {[
            { label: "Equities", pct: 71.4, color: "#10b981", emoji: "📈" },
            { label: "Fixed Income", pct: 14.8, color: "#3b82f6", emoji: "🏛️" },
            { label: "Options", pct: 9.9, color: "#f59e0b", emoji: "⚡" },
            { label: "Cash", pct: 3.9, color: "#a1a1aa", emoji: "💵" },
          ].map((row) => (
            <div
              key={row.label}
              style={{
                background: "#fffefb",
                borderRadius: 12,
                padding: 16,
                border: "1px solid rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 6 }}>{row.emoji}</div>
              <div style={{ fontSize: 13, color: "#71717a", marginBottom: 2 }}>{row.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: "#0a0a0a" }}>
                {row.pct.toFixed(1)}%
              </div>
              <div
                style={{
                  height: 6,
                  background: "#f4f4f5",
                  borderRadius: 999,
                  marginTop: 12,
                  overflow: "hidden",
                }}
              >
                <div style={{ height: "100%", background: row.color, width: `${row.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      </SoftCard>
    </HeroBlock>
  );
}
