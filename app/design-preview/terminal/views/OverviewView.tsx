import { mockOverviewKpis, mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { TerminalFrame, TerminalRow } from "../components/TerminalFrame";

export function TerminalOverviewView() {
  return (
    <TerminalFrame id="overview" title="Overview · Portfolio Snapshot" meta="DATA AS OF 16:00 ET">
      {/* KPI grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, 1fr)",
          borderBottom: "1px solid #1f1f1f",
        }}
      >
        {mockOverviewKpis.map((k, i) => (
          <div
            key={k.label}
            style={{
              padding: "14px 16px",
              borderRight: i < mockOverviewKpis.length - 1 ? "1px solid #161616" : "none",
            }}
          >
            <div
              style={{
                fontSize: 9,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#666",
                marginBottom: 4,
              }}
            >
              {k.label}
            </div>
            <div
              style={{
                fontSize: 16,
                color: k.deltaTone === "up" ? "#22c55e" : k.deltaTone === "down" ? "#ef4444" : "#eee",
                marginBottom: 2,
              }}
            >
              {k.value}
            </div>
            {k.sublabel && (
              <div style={{ fontSize: 10, color: "#666" }}>{k.sublabel}</div>
            )}
          </div>
        ))}
      </div>

      {/* Performance chart */}
      <div style={{ padding: 16, borderBottom: "1px solid #1f1f1f" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 12 }}>
          <span style={{ fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "#666" }}>
            PORT 90D
          </span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#666" }}>
            HIGH 1,254,830 · LOW 1,098,422
          </span>
        </div>
        <Sparkline bars={mockSecurityDetail.bars} width={1200} height={220} stroke="#ffb84d" fill="rgba(255,184,77,0.05)" />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "#444" }}>
          <span>2026-01-28</span>
          <span>2026-02-28</span>
          <span>2026-03-28</span>
          <span>2026-04-28</span>
        </div>
      </div>

      {/* Allocation */}
      <div>
        <TerminalRow tone="header" columns="120px 1fr 80px 200px" cells={["CLASS", "DETAIL", "PCT", "BAR"]} />
        {[
          { class: "EQUITY", detail: "Domestic + intl stocks, 47 positions", pct: 71.4, color: "#22c55e" },
          { class: "FIXED-INC", detail: "Treasury bonds + TLT", pct: 14.8, color: "#60a5fa" },
          { class: "OPT", detail: "5 LEAP positions, GLW + TER", pct: 9.9, color: "#ffb84d" },
          { class: "CASH", detail: "VMFXX + VMRXX sweep", pct: 3.9, color: "#888" },
        ].map((row) => (
          <TerminalRow
            key={row.class}
            columns="120px 1fr 80px 200px"
            cells={[
              <span key="c" style={{ color: row.color }}>{row.class}</span>,
              <span key="d" style={{ color: "#888", fontSize: 12 }}>{row.detail}</span>,
              <span key="p" style={{ color: "#eee" }}>{row.pct.toFixed(1)}%</span>,
              <span
                key="b"
                style={{
                  display: "inline-block",
                  height: 10,
                  width: `${row.pct * 2}%`,
                  background: row.color,
                  verticalAlign: "middle",
                }}
              />,
            ]}
          />
        ))}
      </div>
    </TerminalFrame>
  );
}
