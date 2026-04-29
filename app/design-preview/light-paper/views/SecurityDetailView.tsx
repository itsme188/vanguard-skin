import { mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { DataLabel, DataModule } from "../components/DataModule";
import { PaperCard, PaperSection } from "../components/PaperSection";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function SecurityDetailView() {
  const sec = mockSecurityDetail;
  const supports = sec.levels.filter((l) => l.type === "support");
  const resistances = sec.levels.filter((l) => l.type === "resistance");
  const totalQty = sec.positions.reduce((s, p) => s + p.quantity, 0);
  const totalMV = sec.positions.reduce((s, p) => s + p.marketValue, 0);
  const totalCost = sec.positions.reduce((s, p) => s + p.costBasis, 0);
  const totalGainPct = ((totalMV - totalCost) / totalCost) * 100;

  return (
    <PaperSection
      id="security"
      eyebrow="Security Detail"
      title={`${sec.name} (${sec.symbol})`}
      subtitle="The hub page — chart, levels, cross-account positions, upcoming earnings."
    >
      {/* Big embedded data module: chart + price */}
      <DataModule
        title={`Market Data · ${sec.symbol}`}
        subtitle="As of 4:00 PM ET · 90-day daily"
        action="LIVE"
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 36, color: "#ffb84d", fontFamily: "var(--font-geist-mono)", fontWeight: 600 }}>
            ${sec.price.toFixed(2)}
          </span>
          <span style={{ fontSize: 16, color: sec.todayChange >= 0 ? "#22c55e" : "#ef4444" }}>
            {sec.todayChange >= 0 ? "+" : ""}{sec.todayChange.toFixed(2)} ({fmtPct(sec.todayChangePct)})
          </span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#888", letterSpacing: "0.18em" }}>
            QTY {totalQty} · MV ${totalMV.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        </div>
        <Sparkline bars={sec.bars} width={900} height={300} />
        {/* Level overlays as legend */}
        <div style={{ display: "flex", gap: 24, marginTop: 12, fontSize: 11, color: "#888", flexWrap: "wrap" }}>
          {sec.levels.map((l, i) => (
            <span key={i}>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 2,
                  background: l.active ? (l.type === "support" ? "#22c55e" : "#ef4444") : "#444",
                  marginRight: 6,
                  verticalAlign: "middle",
                }}
              />
              {l.type === "support" ? "S" : "R"} ${l.price.toFixed(2)} · {l.source}
              {!l.active && <span style={{ color: "#555" }}> (paused)</span>}
            </span>
          ))}
        </div>
      </DataModule>

      {/* Two-column: positions + levels */}
      <div className="lp-two-col">
        <PaperCard>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <h3 style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 22, margin: 0 }}>Positions</h3>
            <span style={{ fontSize: 12, color: "#10802b" }}>{fmtPct(totalGainPct)} blended</span>
          </div>
          <div style={{ display: "grid", gap: 0 }}>
            {sec.positions.map((p) => (
              <div
                key={p.account}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 70px 90px 70px",
                  gap: 12,
                  padding: "10px 0",
                  borderTop: "1px solid #ece8db",
                  fontSize: 14,
                  alignItems: "center",
                }}
              >
                <span>{p.account}</span>
                <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right" }}>{p.quantity}</span>
                <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right" }}>
                  {fmtUSD(p.marketValue)}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-geist-mono)",
                    textAlign: "right",
                    color: p.gainPct >= 0 ? "#10802b" : "#b91c1c",
                  }}
                >
                  {fmtPct(p.gainPct)}
                </span>
              </div>
            ))}
          </div>
        </PaperCard>

        <PaperCard>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <h3 style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 22, margin: 0 }}>Levels</h3>
            <span style={{ fontSize: 12, color: "#7a7a7a" }}>{sec.levels.filter((l) => l.active).length} armed</span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <DataLabel>Resistance</DataLabel>
            {resistances.map((l, i) => (
              <div key={i} style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, padding: "6px 0", color: l.active ? "#1a1a1a" : "#999" }}>
                ${l.price.toFixed(2)} <span style={{ color: "#7a7a7a" }}>· {l.source}</span>
                {!l.active && <span style={{ color: "#999" }}> · paused</span>}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #ece8db" }}>
            <DataLabel>Support</DataLabel>
            {supports.map((l, i) => (
              <div key={i} style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, padding: "6px 0" }}>
                ${l.price.toFixed(2)} <span style={{ color: "#7a7a7a" }}>· {l.source}</span>
              </div>
            ))}
          </div>
        </PaperCard>
      </div>

      {/* Upcoming earnings strip */}
      {sec.pendingEarnings && (
        <PaperCard padding={20}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <DataLabel>Upcoming Earnings</DataLabel>
            <span style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 22 }}>
              {sec.pendingEarnings.date}
            </span>
            <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 12, color: "#7a7a7a" }}>
              {sec.pendingEarnings.releaseTime}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 14, color: "#5a5a5a" }}>
              Consensus: <strong>{sec.pendingEarnings.consensus}</strong>
            </span>
          </div>
        </PaperCard>
      )}
    </PaperSection>
  );
}
