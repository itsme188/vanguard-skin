import { mockHoldings } from "../../shared/fixtures";
import { TerminalFrame, TerminalRow } from "../components/TerminalFrame";

const fmtNum = (n: number, frac = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

const COLS = "70px 1fr 60px 50px 80px 70px 90px 80px 60px";

export function TerminalHoldingsView() {
  const sorted = [...mockHoldings].sort((a, b) => b.marketValue - a.marketValue);
  const totalMV = sorted.reduce((s, h) => s + h.marketValue, 0);

  return (
    <TerminalFrame id="holdings" title="Holdings · Cross-Account" meta={`${sorted.length} POS · 5 ACCT · MV ${fmtNum(totalMV, 0)}`}>
      <TerminalRow
        tone="header"
        columns={COLS}
        cells={["SYM", "NAME", "TYPE", "ACT", "QTY", "PX", "MV", "GAIN%", "ALC%"]}
      />
      {sorted.map((h, i) => {
        const isOption = h.type === "option";
        return (
          <TerminalRow
            key={`${h.symbol}-${i}`}
            columns={COLS}
            cells={[
              <span key="s" style={{ color: "#ffb84d", fontWeight: 600 }}>
                {isOption ? h.symbol.split("  ")[0] : h.symbol}
              </span>,
              <span key="n" style={{ color: "#888", fontSize: 12 }}>{h.name}</span>,
              <span
                key="t"
                style={{
                  fontSize: 9,
                  letterSpacing: "0.18em",
                  color:
                    h.type === "stock" ? "#888" :
                    h.type === "option" ? "#ffb84d" :
                    h.type === "bond" ? "#60a5fa" :
                    "#22c55e",
                }}
              >
                {h.type.slice(0, 3).toUpperCase()}
              </span>,
              <span key="a" style={{ color: "#666", fontSize: 11 }}>{h.account.slice(0, 4).toUpperCase()}</span>,
              fmtNum(h.quantity, 0),
              fmtNum(h.price),
              fmtNum(h.marketValue, 0),
              <span key="g" style={{ color: h.totalGainPct >= 0 ? "#22c55e" : "#ef4444" }}>
                {fmtPct(h.totalGainPct)}
              </span>,
              <span key="al" style={{ color: "#888" }}>{h.allocationPct.toFixed(2)}</span>,
            ]}
          />
        );
      })}
      <TerminalRow
        columns={COLS}
        bold
        cells={[
          <span key="t" style={{ color: "#666" }}>TOTAL</span>,
          <span key="x" style={{ color: "#888" }}>{sorted.length} positions</span>,
          "",
          "",
          "",
          "",
          <span key="mv" style={{ color: "#eee" }}>{fmtNum(totalMV, 0)}</span>,
          "",
          <span key="al" style={{ color: "#888" }}>100.00</span>,
        ]}
      />
    </TerminalFrame>
  );
}
