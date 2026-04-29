import { mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { HeroBlock } from "../components/HeroBlock";
import { SagePill } from "../components/SagePill";
import { Eyebrow, SectionTitle, SoftCard } from "../components/SoftCard";
import { SAGE } from "../palette";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function RefinedSecurityView() {
  const sec = mockSecurityDetail;
  const totalQty = sec.positions.reduce((s, p) => s + p.quantity, 0);
  const totalMV = sec.positions.reduce((s, p) => s + p.marketValue, 0);
  const totalCost = sec.positions.reduce((s, p) => s + p.costBasis, 0);
  const totalGainPct = ((totalMV - totalCost) / totalCost) * 100;

  return (
    <HeroBlock
      id="security"
      eyebrow={`Security · ${sec.symbol}`}
      title={sec.name}
      subtitle="Chart, levels, cross-account positions, upcoming earnings."
      action={
        <button
          style={{
            background: SAGE.brand,
            color: SAGE.surface,
            border: "none",
            borderRadius: 999,
            padding: "8px 18px",
            fontSize: 15,
            fontWeight: 500,
            fontFamily: "var(--font-refined-sans)",
            cursor: "pointer",
          }}
        >
          ★ Watching
        </button>
      }
    >
      {/* Hero card with chart */}
      <SoftCard padding={24}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 14 }}>
          <div>
            <Eyebrow>Last price</Eyebrow>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 44,
                  fontWeight: 600,
                  letterSpacing: "-0.025em",
                  color: SAGE.ink,
                  lineHeight: 1,
                  fontFamily: "var(--font-refined-mono)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                ${sec.price.toFixed(2)}
              </span>
              <SagePill tone="up" mono>
                ▲ ${sec.todayChange.toFixed(2)} ({fmtPct(sec.todayChangePct)})
              </SagePill>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {["1D", "1W", "1M", "3M", "1Y", "5Y"].map((label) => (
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
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Sparkline bars={sec.bars} width={1100} height={300} stroke={SAGE.up} fill="rgba(90, 122, 92, 0.08)" />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 14, fontSize: 14, color: SAGE.inkDim, fontFamily: "var(--font-refined-mono)" }}>
          {sec.levels.map((l, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 14,
                  height: 2,
                  background: l.active ? (l.type === "support" ? SAGE.up : SAGE.down) : SAGE.inkFaint,
                  display: "inline-block",
                  borderRadius: 1,
                }}
              />
              {l.type === "support" ? "S" : "R"} ${l.price.toFixed(2)} · {l.source}
              {!l.active && <span style={{ color: SAGE.inkFaint }}> (paused)</span>}
            </span>
          ))}
        </div>
      </SoftCard>

      {/* Positions + Levels two-column */}
      <div className="rf-two-col">
        <SoftCard tint="sage">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
            <SectionTitle>Your positions</SectionTitle>
            <SagePill tone="up" mono>{fmtPct(totalGainPct)} blended</SagePill>
          </div>
          <div style={{ fontSize: 15, color: SAGE.inkDim, marginBottom: 14, fontFamily: "var(--font-refined-mono)" }}>
            {totalQty} shares · {fmtUSD(totalMV)} market value
          </div>
          <div style={{ display: "grid", gap: 0 }}>
            {sec.positions.map((p, i) => (
              <div
                key={p.account}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 70px 100px 80px",
                  gap: 10,
                  padding: "12px 0",
                  borderTop: i === 0 ? "none" : `1px solid ${SAGE.upGlow}`,
                  alignItems: "center",
                  minWidth: 0,
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 500, color: SAGE.ink }}>{p.account}</span>
                <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 14, textAlign: "right", color: SAGE.ink }}>
                  {p.quantity}
                </span>
                <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 14, textAlign: "right", color: SAGE.ink, fontVariantNumeric: "tabular-nums" }}>
                  {fmtUSD(p.marketValue)}
                </span>
                <span style={{ textAlign: "right" }}>
                  <SagePill tone={p.gainPct >= 0 ? "up" : "down"} size="xs" mono>{fmtPct(p.gainPct)}</SagePill>
                </span>
              </div>
            ))}
          </div>
        </SoftCard>

        <SoftCard tint="linen">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
            <SectionTitle>Price levels</SectionTitle>
            <span style={{ fontSize: 14, color: SAGE.inkDim }}>{sec.levels.filter((l) => l.active).length} armed</span>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {sec.levels.map((l, i) => (
              <div
                key={i}
                style={{
                  background: SAGE.surface,
                  borderRadius: 8,
                  padding: "10px 12px",
                  border: `1px solid ${SAGE.border}`,
                  opacity: l.active ? 1 : 0.55,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <SagePill tone={l.type === "support" ? "up" : "down"} size="xs">
                    {l.type === "support" ? "Support" : "Resistance"}
                  </SagePill>
                  <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 16, fontWeight: 600, color: SAGE.ink, fontVariantNumeric: "tabular-nums" }}>
                    ${l.price.toFixed(2)}
                  </span>
                  {!l.active && <SagePill tone="neutral" size="xs">Paused</SagePill>}
                </div>
                <div style={{ fontSize: 13, color: SAGE.inkDim, marginTop: 3, fontFamily: "var(--font-refined-mono)" }}>{l.source}</div>
              </div>
            ))}
          </div>
        </SoftCard>
      </div>

      {/* Earnings strip */}
      {sec.pendingEarnings && (
        <SoftCard tint="parchment" padding={18}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <Eyebrow color={SAGE.brand}>Upcoming earnings</Eyebrow>
            <span
              style={{
                fontFamily: "var(--font-refined-mono)",
                fontSize: 16,
                fontWeight: 600,
                color: SAGE.ink,
              }}
            >
              {sec.pendingEarnings.date} · {sec.pendingEarnings.releaseTime}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 15, color: SAGE.inkDim }}>
              Consensus:{" "}
              <strong style={{ fontFamily: "var(--font-refined-mono)", color: SAGE.ink }}>
                {sec.pendingEarnings.consensus}
              </strong>
            </span>
          </div>
        </SoftCard>
      )}
    </HeroBlock>
  );
}
