import { mockOverviewKpis, mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { HeroBlock } from "../components/HeroBlock";
import { SagePill } from "../components/SagePill";
import { Eyebrow, SectionTitle, SoftCard } from "../components/SoftCard";
import { SAGE } from "../palette";

const KPI_TINTS: Array<"surface" | "sage" | "linen" | "parchment" | "alt"> = [
  "sage",
  "linen",
  "surface",
  "parchment",
  "alt",
  "linen",
];

export function RefinedOverviewView() {
  return (
    <HeroBlock
      id="overview"
      eyebrow="Overview"
      title="Portfolio at a glance."
      subtitle="The dashboard you check after market close — performance, allocation, key metrics."
    >
      {/* KPI grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 14 }}>
        {mockOverviewKpis.map((k, i) => (
          <SoftCard key={k.label} tint={KPI_TINTS[i % KPI_TINTS.length]}>
            <Eyebrow>{k.label}</Eyebrow>
            <div
              style={{
                fontSize: 28,
                fontWeight: 600,
                letterSpacing: "-0.015em",
                color: k.deltaTone === "down" ? SAGE.down : SAGE.ink,
                lineHeight: 1.1,
                fontFamily: "var(--font-refined-sans)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {k.value}
            </div>
            {k.delta && (
              <div style={{ marginTop: 8 }}>
                <SagePill tone={k.deltaTone === "up" ? "up" : k.deltaTone === "down" ? "down" : "neutral"} size="xs" mono>
                  {k.delta}
                </SagePill>
              </div>
            )}
            {k.sublabel && (
              <div style={{ fontSize: 13, color: SAGE.inkDim, marginTop: 8, fontFamily: "var(--font-refined-mono)" }}>
                {k.sublabel}
              </div>
            )}
          </SoftCard>
        ))}
      </div>

      {/* Performance chart */}
      <SoftCard padding={24}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <div>
            <Eyebrow>Performance · 90 days</Eyebrow>
            <h3 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: SAGE.ink, letterSpacing: "-0.005em" }}>
              Up <span style={{ color: SAGE.up }}>+12.4%</span> year-to-date
            </h3>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {["1D", "1W", "1M", "3M", "1Y", "All"].map((label) => (
              <button
                key={label}
                style={{
                  border: "none",
                  background: label === "3M" ? SAGE.brand : "transparent",
                  color: label === "3M" ? SAGE.surface : SAGE.inkDim,
                  padding: "5px 11px",
                  borderRadius: 999,
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: "var(--font-refined-mono)",
                  letterSpacing: "0.04em",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Sparkline bars={mockSecurityDetail.bars} width={1100} height={240} stroke={SAGE.up} fill="rgba(90, 122, 92, 0.08)" />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 13, color: SAGE.inkFaint, fontFamily: "var(--font-refined-mono)" }}>
          <span>2026-01-28</span>
          <span>2026-02-28</span>
          <span>2026-03-28</span>
          <span>2026-04-28</span>
        </div>
      </SoftCard>

      {/* Allocation */}
      <SoftCard tint="sage">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
          <SectionTitle>Allocation</SectionTitle>
          <span style={{ fontSize: 14, color: SAGE.inkDim }}>by asset class</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))", gap: 14 }}>
          {[
            { label: "Equities", pct: 71.4, color: SAGE.up },
            { label: "Fixed Income", pct: 14.8, color: SAGE.brandSoft },
            { label: "Options", pct: 9.9, color: SAGE.accent },
            { label: "Cash", pct: 3.9, color: SAGE.inkFaint },
          ].map((row) => (
            <div
              key={row.label}
              style={{
                background: SAGE.surface,
                borderRadius: 10,
                padding: 14,
                border: `1px solid ${SAGE.border}`,
              }}
            >
              <Eyebrow>{row.label}</Eyebrow>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: "-0.015em",
                  color: SAGE.ink,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {row.pct.toFixed(1)}%
              </div>
              <div
                style={{
                  height: 4,
                  background: SAGE.surfaceAlt,
                  borderRadius: 999,
                  marginTop: 10,
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
