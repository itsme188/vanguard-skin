import { mockOverviewKpis } from "../../shared/fixtures";
import { mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { DataLabel, DataModule } from "../components/DataModule";
import { PaperCard, PaperSection } from "../components/PaperSection";

export function OverviewView() {
  return (
    <PaperSection
      id="overview"
      eyebrow="Overview"
      title="Portfolio at a glance."
      subtitle="The dashboard you check after market close — KPIs, performance, allocation."
    >
      {/* KPI grid — light cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        {mockOverviewKpis.map((k) => (
          <PaperCard key={k.label}>
            <DataLabel>{k.label}</DataLabel>
            <div
              style={{
                fontFamily: "var(--font-instrument-serif)",
                fontSize: 32,
                lineHeight: 1.05,
                marginTop: 6,
                color: k.deltaTone === "down" ? "#b91c1c" : "#1a1a1a",
              }}
            >
              {k.value}
            </div>
            {k.delta && (
              <div style={{ fontSize: 12, color: k.deltaTone === "up" ? "#10802b" : k.deltaTone === "down" ? "#b91c1c" : "#5a5a5a", marginTop: 4 }}>
                {k.delta}
              </div>
            )}
            {k.sublabel && (
              <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 4 }}>{k.sublabel}</div>
            )}
          </PaperCard>
        ))}
      </div>

      {/* Performance chart — dark data module */}
      <DataModule title="Portfolio Performance · 90D" subtitle="vs SPY (−)">
        <Sparkline bars={mockSecurityDetail.bars} width={900} height={260} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 11, color: "#666" }}>
          <span>Jan 28</span>
          <span>Feb 28</span>
          <span>Mar 28</span>
          <span>Apr 28</span>
        </div>
      </DataModule>

      {/* Allocation grid */}
      <PaperCard>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
          <h3 style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 22, margin: 0 }}>
            Allocation
          </h3>
          <span style={{ fontSize: 12, color: "#7a7a7a" }}>by asset class</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { label: "Equities", pct: 71.4, color: "#1a1a1a" },
            { label: "Fixed Income", pct: 14.8, color: "#7d6e58" },
            { label: "Cash", pct: 3.9, color: "#a89876" },
            { label: "Options", pct: 9.9, color: "#b8a572" },
          ].map((row) => (
            <div key={row.label}>
              <DataLabel>{row.label}</DataLabel>
              <div style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 28, marginTop: 4 }}>
                {row.pct.toFixed(1)}%
              </div>
              <div
                style={{
                  height: 4,
                  background: "#ece8db",
                  borderRadius: 2,
                  marginTop: 8,
                  overflow: "hidden",
                }}
              >
                <div style={{ height: "100%", background: row.color, width: `${row.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      </PaperCard>
    </PaperSection>
  );
}
