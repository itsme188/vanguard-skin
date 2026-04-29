import { mockHoldings } from "../../shared/fixtures";
import { PaperCard, PaperSection } from "../components/PaperSection";
import { DataLabel } from "../components/DataModule";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function HoldingsView() {
  const sorted = [...mockHoldings].sort((a, b) => b.marketValue - a.marketValue);

  return (
    <PaperSection
      id="holdings"
      eyebrow="Holdings"
      title="Cross-account positions."
      subtitle="The workhorse list — every position across every account, sortable, filterable."
      action={
        <div style={{ display: "flex", gap: 8 }}>
          {["All accounts", "IBKR", "Roth", "Vanguard"].map((label, i) => (
            <span
              key={label}
              style={{
                fontSize: 12,
                padding: "6px 12px",
                borderRadius: 4,
                background: i === 0 ? "#1a1a1a" : "#fffefb",
                color: i === 0 ? "#fffefb" : "#5a5a5a",
                border: i === 0 ? "1px solid #1a1a1a" : "1px solid #d8d2c3",
                cursor: "pointer",
              }}
            >
              {label}
            </span>
          ))}
        </div>
      }
    >
      <PaperCard padding={0}>
       <div className="lp-table-scroll">
        {/* Header row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "100px 1fr 70px 70px 90px 100px 90px 80px",
            gap: 12,
            padding: "14px 24px",
            borderBottom: "1px solid #d8d2c3",
            background: "#faf8f1",
            fontSize: 11,
            color: "#7a7a7a",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "var(--font-geist-mono)",
          }}
        >
          <span>Symbol</span>
          <span>Name</span>
          <span>Account</span>
          <span style={{ textAlign: "right" }}>Qty</span>
          <span style={{ textAlign: "right" }}>Price</span>
          <span style={{ textAlign: "right" }}>Market Value</span>
          <span style={{ textAlign: "right" }}>Gain</span>
          <span style={{ textAlign: "right" }}>Alloc</span>
        </div>
        {sorted.map((h, i) => {
          const isOption = h.type === "option";
          const isBond = h.type === "bond";
          return (
            <div
              key={`${h.symbol}-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 70px 70px 90px 100px 90px 80px",
                gap: 12,
                padding: "14px 24px",
                borderBottom: "1px solid #ece8db",
                fontSize: 14,
                alignItems: "center",
              }}
            >
              <span style={{ fontFamily: "var(--font-geist-mono)", fontWeight: 600, fontSize: 13 }}>
                {isOption ? h.symbol.split("  ")[0] : h.symbol}
                {isOption && (
                  <span
                    style={{
                      display: "inline-block",
                      marginLeft: 6,
                      padding: "1px 5px",
                      fontSize: 9,
                      letterSpacing: "0.18em",
                      background: "#f3edd9",
                      color: "#7d6e58",
                      borderRadius: 2,
                    }}
                  >
                    OPT
                  </span>
                )}
                {isBond && (
                  <span
                    style={{
                      display: "inline-block",
                      marginLeft: 6,
                      padding: "1px 5px",
                      fontSize: 9,
                      letterSpacing: "0.18em",
                      background: "#e9efe8",
                      color: "#4a6e58",
                      borderRadius: 2,
                    }}
                  >
                    BND
                  </span>
                )}
              </span>
              <span style={{ color: "#5a5a5a", fontSize: 13 }}>{h.name}</span>
              <span style={{ fontSize: 12, color: "#7a7a7a" }}>{h.account}</span>
              <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right", fontSize: 13 }}>
                {h.quantity.toLocaleString("en-US")}
              </span>
              <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right", fontSize: 13 }}>
                ${h.price.toFixed(2)}
              </span>
              <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right", fontSize: 13, fontWeight: 500 }}>
                {fmtUSD(h.marketValue)}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-geist-mono)",
                  textAlign: "right",
                  fontSize: 13,
                  color: h.totalGainPct >= 0 ? "#10802b" : "#b91c1c",
                  fontWeight: 500,
                }}
              >
                {fmtPct(h.totalGainPct)}
              </span>
              <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right", fontSize: 12, color: "#7a7a7a" }}>
                {h.allocationPct.toFixed(2)}%
              </span>
            </div>
          );
        })}
        {/* Totals row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "100px 1fr 70px 70px 90px 100px 90px 80px",
            gap: 12,
            padding: "14px 24px",
            background: "#faf8f1",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <span style={{ gridColumn: "1 / 6", color: "#5a5a5a" }}>{sorted.length} positions</span>
          <span style={{ fontFamily: "var(--font-geist-mono)", textAlign: "right" }}>
            {fmtUSD(sorted.reduce((s, h) => s + h.marketValue, 0))}
          </span>
          <span style={{ gridColumn: "7 / 9" }} />
        </div>
       </div>
      </PaperCard>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 16, marginTop: 8 }}>
        <PaperCard>
          <DataLabel>Largest position</DataLabel>
          <div style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 28, marginTop: 4 }}>AAPL</div>
          <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 2 }}>$43,074 · 3.45%</div>
        </PaperCard>
        <PaperCard>
          <DataLabel>Best gain</DataLabel>
          <div style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 28, marginTop: 4, color: "#10802b" }}>+78.5%</div>
          <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 2 }}>NVDA · IBKR</div>
        </PaperCard>
        <PaperCard>
          <DataLabel>Worst gain</DataLabel>
          <div style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 28, marginTop: 4, color: "#b91c1c" }}>−9.85%</div>
          <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 2 }}>TLT · Vanguard</div>
        </PaperCard>
        <PaperCard>
          <DataLabel>Cash drag</DataLabel>
          <div style={{ fontFamily: "var(--font-instrument-serif)", fontSize: 28, marginTop: 4 }}>3.88%</div>
          <div style={{ fontSize: 12, color: "#7a7a7a", marginTop: 2 }}>$48,392</div>
        </PaperCard>
      </div>
    </PaperSection>
  );
}
