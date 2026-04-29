import { mockOverviewKpis, mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { TerminalFrame, TerminalRow } from "../components/TerminalFrame";
import { DARK } from "../palette";

export function DarkOverviewView() {
  return (
    <TerminalFrame id="overview" title="Overview · Portfolio Snapshot" meta="DATA AS OF 16:00 ET">
      {/* KPI grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, 1fr)",
          borderBottom: `1px solid ${DARK.border}`,
        }}
      >
        {mockOverviewKpis.map((k, i) => (
          <div
            key={k.label}
            style={{
              padding: "16px 18px",
              borderRight: i < mockOverviewKpis.length - 1 ? `1px solid ${DARK.borderRow}` : "none",
            }}
          >
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: DARK.inkDim,
                marginBottom: 6,
                fontWeight: 500,
              }}
            >
              {k.label}
            </div>
            <div
              style={{
                fontSize: 19,
                color: k.deltaTone === "up" ? DARK.up : k.deltaTone === "down" ? DARK.down : DARK.ink,
                marginBottom: 4,
                fontVariantNumeric: "tabular-nums",
                fontWeight: 500,
              }}
            >
              {k.value}
            </div>
            {k.sublabel && (
              <div style={{ fontSize: 12, color: DARK.inkDim }}>{k.sublabel}</div>
            )}
          </div>
        ))}
      </div>

      {/* Performance chart */}
      <div style={{ padding: 18, borderBottom: `1px solid ${DARK.border}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 12 }}>
          <span style={{ fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: DARK.inkDim, fontWeight: 500 }}>
            PORT 90D
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: DARK.inkDim }}>
            HIGH 1,254,830 · LOW 1,098,422
          </span>
        </div>
        <Sparkline bars={mockSecurityDetail.bars} width={1200} height={220} stroke={DARK.amber} fill="rgba(255,184,77,0.05)" />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 11, color: DARK.inkFaint }}>
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
          { class: "EQUITY", detail: "Domestic + intl stocks, 47 positions", pct: 71.4, color: DARK.up },
          { class: "FIXED-INC", detail: "Treasury bonds + TLT", pct: 14.8, color: DARK.blue },
          { class: "OPT", detail: "5 LEAP positions, GLW + TER", pct: 9.9, color: DARK.amber },
          { class: "CASH", detail: "VMFXX + VMRXX sweep", pct: 3.9, color: DARK.inkDim },
        ].map((row) => (
          <TerminalRow
            key={row.class}
            columns="120px 1fr 80px 200px"
            cells={[
              <span key="c" style={{ color: row.color }}>{row.class}</span>,
              <span key="d" style={{ color: DARK.inkDim, fontSize: 14 }}>{row.detail}</span>,
              <span key="p" style={{ color: DARK.ink }}>{row.pct.toFixed(1)}%</span>,
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
