import { mockHoldings } from "../../shared/fixtures";
import { HeroBlock } from "../components/HeroBlock";
import { CategoryChip, SectionLabel, SoftCard } from "../components/SoftCard";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const TYPE_TONE = {
  stock: "neutral" as const,
  option: "amber" as const,
  bond: "blue" as const,
  etf: "up" as const,
};

const ACCOUNT_GRADIENTS: Record<string, string> = {
  IBKR: "linear-gradient(135deg, #f59e0b, #fbbf24)",
  Roth: "linear-gradient(135deg, #10b981, #34d399)",
  Vanguard: "linear-gradient(135deg, #8b5cf6, #a78bfa)",
};

export function ModernHoldingsView() {
  const sorted = [...mockHoldings].sort((a, b) => b.marketValue - a.marketValue);
  const totalMV = sorted.reduce((s, h) => s + h.marketValue, 0);

  return (
    <HeroBlock
      id="holdings"
      eyebrow="Holdings"
      title="All your positions"
      subtitle="Across every account, sortable by any column. Click a row to dive into the security."
      action={
        <div style={{ display: "flex", gap: 8 }}>
          {["All", "IBKR", "Roth", "Vanguard"].map((label, i) => (
            <button
              key={label}
              style={{
                background: i === 0 ? "#0a0a0a" : "#fff",
                color: i === 0 ? "#fff" : "#52525b",
                border: i === 0 ? "1px solid #0a0a0a" : "1px solid #e4e4e7",
                borderRadius: 999,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <SoftCard padding={0}>
        <div
          className="mb-holdings-header"
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #f4f4f5",
            fontSize: 13,
            color: "#71717a",
            fontWeight: 500,
          }}
        >
          <span />
          <span>Symbol</span>
          <span>Name</span>
          <span className="mb-hide-mobile">Type</span>
          <span className="mb-hide-mobile" style={{ textAlign: "right" }}>Qty</span>
          <span className="mb-hide-mobile" style={{ textAlign: "right" }}>Price</span>
          <span style={{ textAlign: "right" }}>Value</span>
          <span style={{ textAlign: "right" }}>Gain</span>
        </div>
        {sorted.map((h, i) => {
          const tone = h.totalGainPct >= 0 ? "up" : "down";
          const isOption = h.type === "option";
          const tickerForGradient = isOption ? h.symbol.split("  ")[0] : h.symbol;
          return (
            <div
              key={`${h.symbol}-${i}`}
              className="mb-holdings-row"
              style={{
                padding: "14px 24px",
                borderTop: i === 0 ? "none" : "1px solid #f4f4f5",
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background:
                    ACCOUNT_GRADIENTS[h.account] ?? "linear-gradient(135deg, #71717a, #a1a1aa)",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-geist-sans)",
                }}
              >
                {tickerForGradient.slice(0, 2)}
              </div>
              <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 14, fontWeight: 600 }}>
                {tickerForGradient}
              </span>
              <span style={{ fontSize: 14, color: "#27272a", minWidth: 0, overflow: "hidden" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.name}
                </span>
                <span style={{ display: "block", fontSize: 12, color: "#a1a1aa" }}>{h.account}</span>
              </span>
              <span className="mb-hide-mobile">
                <CategoryChip tone={TYPE_TONE[h.type]}>{h.type}</CategoryChip>
              </span>
              <span className="mb-hide-mobile" style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, textAlign: "right" }}>
                {h.quantity.toLocaleString("en-US")}
              </span>
              <span className="mb-hide-mobile" style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, textAlign: "right" }}>
                ${h.price.toFixed(2)}
              </span>
              <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 14, fontWeight: 600, textAlign: "right" }}>
                {fmtUSD(h.marketValue)}
              </span>
              <span style={{ textAlign: "right" }}>
                <CategoryChip tone={tone}>{fmtPct(h.totalGainPct)}</CategoryChip>
              </span>
            </div>
          );
        })}
        <div
          style={{
            padding: "18px 24px",
            background: "#fafafa",
            borderTop: "1px solid #f4f4f5",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <SectionLabel>{sorted.length} positions across 5 accounts</SectionLabel>
          <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 18, fontWeight: 600 }}>
            {fmtUSD(totalMV)}
          </span>
        </div>
      </SoftCard>

      {/* Stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 16 }}>
        <SoftCard tint="amber">
          <SectionLabel>Largest position</SectionLabel>
          <div style={{ fontSize: 28, fontWeight: 600, color: "#0a0a0a" }}>AAPL</div>
          <div style={{ fontSize: 13, color: "#71717a", marginTop: 2 }}>$43,074 · 3.45% of port</div>
        </SoftCard>
        <SoftCard tint="mint">
          <SectionLabel>Best gainer</SectionLabel>
          <div style={{ fontSize: 28, fontWeight: 600, color: "#15803d" }}>+78.5%</div>
          <div style={{ fontSize: 13, color: "#71717a", marginTop: 2 }}>NVDA · IBKR</div>
        </SoftCard>
        <SoftCard tint="rose">
          <SectionLabel>Biggest loss</SectionLabel>
          <div style={{ fontSize: 28, fontWeight: 600, color: "#b91c1c" }}>−9.85%</div>
          <div style={{ fontSize: 13, color: "#71717a", marginTop: 2 }}>TLT · Vanguard</div>
        </SoftCard>
        <SoftCard tint="lavender">
          <SectionLabel>Cash drag</SectionLabel>
          <div style={{ fontSize: 28, fontWeight: 600, color: "#0a0a0a" }}>3.88%</div>
          <div style={{ fontSize: 13, color: "#71717a", marginTop: 2 }}>$48,392 in VMFXX</div>
        </SoftCard>
      </div>
    </HeroBlock>
  );
}
