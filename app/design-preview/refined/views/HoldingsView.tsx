import { mockHoldings } from "../../shared/fixtures";
import { HeroBlock } from "../components/HeroBlock";
import { SagePill } from "../components/SagePill";
import { Eyebrow, SoftCard } from "../components/SoftCard";
import { SAGE } from "../palette";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const TYPE_TONE = {
  stock: "neutral" as const,
  option: "accent" as const,
  bond: "linen" as const,
  etf: "up" as const,
};

const ACCOUNT_GRADIENTS: Record<string, string> = {
  IBKR: `linear-gradient(135deg, ${SAGE.brand}, ${SAGE.brandSoft})`,
  Roth: `linear-gradient(135deg, ${SAGE.up}, ${SAGE.accent})`,
  Vanguard: `linear-gradient(135deg, ${SAGE.brandSoft}, ${SAGE.accentSoft})`,
};

export function RefinedHoldingsView() {
  const sorted = [...mockHoldings].sort((a, b) => b.marketValue - a.marketValue);
  const totalMV = sorted.reduce((s, h) => s + h.marketValue, 0);

  return (
    <HeroBlock
      id="holdings"
      eyebrow="Holdings"
      title="All your positions."
      subtitle="Across every account, sortable by any column. Click a row to dive into the security."
      action={
        <div style={{ display: "flex", gap: 6 }}>
          {["All", "IBKR", "Roth", "Vanguard"].map((label, i) => (
            <button
              key={label}
              style={{
                background: i === 0 ? SAGE.brand : SAGE.surface,
                color: i === 0 ? SAGE.surface : SAGE.inkDim,
                border: i === 0 ? `1px solid ${SAGE.brand}` : `1px solid ${SAGE.border}`,
                borderRadius: 999,
                padding: "6px 14px",
                fontSize: 14,
                fontWeight: 500,
                fontFamily: "var(--font-refined-sans)",
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
          className="rf-holdings-header"
          style={{
            padding: "14px 22px",
            borderBottom: `1px solid ${SAGE.border}`,
            fontSize: 13,
            color: SAGE.inkDim,
            fontWeight: 500,
            fontFamily: "var(--font-refined-mono)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          <span />
          <span>Symbol</span>
          <span>Name</span>
          <span className="rf-hide-mobile">Type</span>
          <span className="rf-hide-mobile" style={{ textAlign: "right" }}>Qty</span>
          <span className="rf-hide-mobile" style={{ textAlign: "right" }}>Price</span>
          <span style={{ textAlign: "right" }}>Value</span>
          <span style={{ textAlign: "right" }}>Gain</span>
        </div>
        {sorted.map((h, i) => {
          const tone = h.totalGainPct >= 0 ? "up" : "down";
          const isOption = h.type === "option";
          const ticker = isOption ? h.symbol.split("  ")[0] : h.symbol;
          return (
            <div
              key={`${h.symbol}-${i}`}
              className="rf-holdings-row"
              style={{
                padding: "13px 22px",
                borderTop: i === 0 ? "none" : `1px solid ${SAGE.border}`,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background:
                    ACCOUNT_GRADIENTS[h.account] ?? `linear-gradient(135deg, ${SAGE.inkFaint}, ${SAGE.inkDim})`,
                  color: SAGE.surface,
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: "var(--font-refined-sans)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {ticker.slice(0, 2)}
              </div>
              <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 15, fontWeight: 600, color: SAGE.ink }}>
                {ticker}
              </span>
              <span style={{ fontSize: 15, color: SAGE.ink, minWidth: 0, overflow: "hidden" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.name}
                </span>
                <span style={{ display: "block", fontSize: 13, color: SAGE.inkFaint, fontFamily: "var(--font-refined-mono)" }}>
                  {h.account}
                </span>
              </span>
              <span className="rf-hide-mobile">
                <SagePill tone={TYPE_TONE[h.type]} size="xs">{h.type}</SagePill>
              </span>
              <span className="rf-hide-mobile" style={{ fontFamily: "var(--font-refined-mono)", fontSize: 14, textAlign: "right", color: SAGE.ink, fontVariantNumeric: "tabular-nums" }}>
                {h.quantity.toLocaleString("en-US")}
              </span>
              <span className="rf-hide-mobile" style={{ fontFamily: "var(--font-refined-mono)", fontSize: 14, textAlign: "right", color: SAGE.ink, fontVariantNumeric: "tabular-nums" }}>
                ${h.price.toFixed(2)}
              </span>
              <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 15, fontWeight: 500, textAlign: "right", color: SAGE.ink, fontVariantNumeric: "tabular-nums" }}>
                {fmtUSD(h.marketValue)}
              </span>
              <span style={{ textAlign: "right" }}>
                <SagePill tone={tone} size="xs" mono>{fmtPct(h.totalGainPct)}</SagePill>
              </span>
            </div>
          );
        })}
        <div
          style={{
            padding: "16px 22px",
            background: SAGE.surfaceAlt,
            borderTop: `1px solid ${SAGE.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Eyebrow>{sorted.length} positions across 5 accounts</Eyebrow>
          <span
            style={{
              fontFamily: "var(--font-refined-mono)",
              fontSize: 16,
              fontWeight: 600,
              color: SAGE.ink,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtUSD(totalMV)}
          </span>
        </div>
      </SoftCard>

      {/* Stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 14 }}>
        <SoftCard tint="parchment">
          <Eyebrow>Largest position</Eyebrow>
          <div style={{ fontSize: 24, fontWeight: 600, color: SAGE.ink, fontFamily: "var(--font-refined-mono)", marginTop: 4 }}>AAPL</div>
          <div style={{ fontSize: 14, color: SAGE.inkDim, marginTop: 2, fontFamily: "var(--font-refined-mono)" }}>$43,074 · 3.45% of port</div>
        </SoftCard>
        <SoftCard tint="sage">
          <Eyebrow>Best gainer</Eyebrow>
          <div style={{ fontSize: 24, fontWeight: 600, color: SAGE.up, fontFamily: "var(--font-refined-mono)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>+78.5%</div>
          <div style={{ fontSize: 14, color: SAGE.inkDim, marginTop: 2 }}>NVDA · IBKR</div>
        </SoftCard>
        <SoftCard tint="linen">
          <Eyebrow>Biggest loss</Eyebrow>
          <div style={{ fontSize: 24, fontWeight: 600, color: SAGE.down, fontFamily: "var(--font-refined-mono)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>−9.85%</div>
          <div style={{ fontSize: 14, color: SAGE.inkDim, marginTop: 2 }}>TLT · Vanguard</div>
        </SoftCard>
        <SoftCard>
          <Eyebrow>Cash drag</Eyebrow>
          <div style={{ fontSize: 24, fontWeight: 600, color: SAGE.ink, fontFamily: "var(--font-refined-mono)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>3.88%</div>
          <div style={{ fontSize: 14, color: SAGE.inkDim, marginTop: 2 }}>$48,392 in VMFXX</div>
        </SoftCard>
      </div>
    </HeroBlock>
  );
}
