import { mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { HeroBlock } from "../components/HeroBlock";
import { CategoryChip, SectionLabel, SoftCard } from "../components/SoftCard";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function ModernSecurityView() {
  const sec = mockSecurityDetail;
  const totalQty = sec.positions.reduce((s, p) => s + p.quantity, 0);
  const totalMV = sec.positions.reduce((s, p) => s + p.marketValue, 0);
  const totalCost = sec.positions.reduce((s, p) => s + p.costBasis, 0);
  const totalGainPct = ((totalMV - totalCost) / totalCost) * 100;

  return (
    <HeroBlock
      id="security"
      eyebrow="Security · GLW"
      title={sec.name}
      subtitle="Chart, levels, positions, and what's coming up. Everything you need before market open tomorrow."
      action={
        <button
          style={{
            background: "#0a0a0a",
            color: "#fff",
            border: "none",
            borderRadius: 999,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          ★ Watching
        </button>
      }
    >
      {/* Hero card with chart */}
      <SoftCard padding={32}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 16 }}>
          <div>
            <SectionLabel>Last price</SectionLabel>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: 56, fontWeight: 600, letterSpacing: "-0.03em", color: "#0a0a0a", lineHeight: 1 }}>
                ${sec.price.toFixed(2)}
              </span>
              <CategoryChip tone="up">
                ▲ ${sec.todayChange.toFixed(2)} ({fmtPct(sec.todayChangePct)})
              </CategoryChip>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {["1D", "1W", "1M", "3M", "1Y", "5Y"].map((label) => (
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
        <Sparkline bars={sec.bars} width={1100} height={300} stroke="#10b981" fill="rgba(16,185,129,0.07)" />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 16, fontSize: 13, color: "#52525b" }}>
          {sec.levels.map((l, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: l.active ? (l.type === "support" ? "#10b981" : "#f43f5e") : "#d4d4d8",
                  display: "inline-block",
                  borderRadius: 1,
                }}
              />
              {l.type === "support" ? "Support" : "Resistance"} ${l.price.toFixed(2)} · {l.source}
              {!l.active && <span style={{ color: "#a1a1aa" }}> (paused)</span>}
            </span>
          ))}
        </div>
      </SoftCard>

      {/* Positions + Levels two-column */}
      <div className="mb-two-col">
        <SoftCard tint="mint">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>Your positions</h3>
            <CategoryChip tone="up">{fmtPct(totalGainPct)} blended</CategoryChip>
          </div>
          <div style={{ fontSize: 14, color: "#52525b", marginBottom: 16 }}>
            {totalQty} shares · {fmtUSD(totalMV)} market value
          </div>
          <div style={{ display: "grid", gap: 0 }}>
            {sec.positions.map((p, i) => (
              <div
                key={p.account}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 110px 80px",
                  gap: 12,
                  padding: "12px 0",
                  borderTop: i === 0 ? "none" : "1px solid #d1fae5",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 500 }}>{p.account}</span>
                <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, textAlign: "right" }}>{p.quantity}</span>
                <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, textAlign: "right" }}>
                  {fmtUSD(p.marketValue)}
                </span>
                <span style={{ textAlign: "right" }}>
                  <CategoryChip tone={p.gainPct >= 0 ? "up" : "down"}>{fmtPct(p.gainPct)}</CategoryChip>
                </span>
              </div>
            ))}
          </div>
        </SoftCard>

        <SoftCard tint="rose">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "#0a0a0a" }}>Price levels</h3>
            <span style={{ fontSize: 13, color: "#71717a" }}>{sec.levels.filter((l) => l.active).length} armed</span>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {sec.levels.map((l, i) => (
              <div
                key={i}
                style={{
                  background: "#fffefb",
                  borderRadius: 12,
                  padding: "12px 14px",
                  border: "1px solid rgba(0,0,0,0.04)",
                  opacity: l.active ? 1 : 0.5,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <CategoryChip tone={l.type === "support" ? "up" : "down"}>
                    {l.type === "support" ? "Support" : "Resistance"}
                  </CategoryChip>
                  <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 18, fontWeight: 600 }}>
                    ${l.price.toFixed(2)}
                  </span>
                  {!l.active && <CategoryChip tone="neutral">Paused</CategoryChip>}
                </div>
                <div style={{ fontSize: 13, color: "#71717a", marginTop: 4 }}>{l.source}</div>
              </div>
            ))}
          </div>
        </SoftCard>
      </div>

      {/* Earnings */}
      {sec.pendingEarnings && (
        <SoftCard tint="amber" padding={20}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 28 }}>📅</span>
            <div>
              <div style={{ fontSize: 13, color: "#92400e", fontWeight: 500 }}>Upcoming earnings</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "#0a0a0a" }}>
                {sec.pendingEarnings.date} at {sec.pendingEarnings.releaseTime}
              </div>
            </div>
            <span style={{ marginLeft: "auto", fontSize: 14, color: "#52525b" }}>
              Consensus: <strong>{sec.pendingEarnings.consensus}</strong>
            </span>
          </div>
        </SoftCard>
      )}
    </HeroBlock>
  );
}
