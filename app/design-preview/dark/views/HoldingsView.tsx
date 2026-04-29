import { mockHoldings } from "../../shared/fixtures";
import { TerminalFrame, TerminalRow } from "../components/TerminalFrame";
import { DARK } from "../palette";

const fmtNum = (n: number, frac = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

const COLS = "70px 1fr 60px 60px 80px 70px 100px 80px 60px";

export function DarkHoldingsView() {
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
              <span key="s" style={{ color: DARK.amber, fontWeight: 600 }}>
                {isOption ? h.symbol.split("  ")[0] : h.symbol}
              </span>,
              <span key="n" style={{ color: DARK.inkDim, fontSize: 14 }}>{h.name}</span>,
              <span
                key="t"
                style={{
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  fontWeight: 500,
                  color:
                    h.type === "stock" ? DARK.inkDim :
                    h.type === "option" ? DARK.amber :
                    h.type === "bond" ? DARK.blue :
                    DARK.up,
                }}
              >
                {h.type.slice(0, 3).toUpperCase()}
              </span>,
              <span key="a" style={{ color: DARK.inkDim, fontSize: 13 }}>{h.account.slice(0, 4).toUpperCase()}</span>,
              fmtNum(h.quantity, 0),
              fmtNum(h.price),
              fmtNum(h.marketValue, 0),
              <span key="g" style={{ color: h.totalGainPct >= 0 ? DARK.up : DARK.down }}>
                {fmtPct(h.totalGainPct)}
              </span>,
              <span key="al" style={{ color: DARK.inkDim }}>{h.allocationPct.toFixed(2)}</span>,
            ]}
          />
        );
      })}
      <TerminalRow
        columns={COLS}
        bold
        cells={[
          <span key="t" style={{ color: DARK.inkDim }}>TOTAL</span>,
          <span key="x" style={{ color: DARK.inkDim }}>{sorted.length} positions</span>,
          "",
          "",
          "",
          "",
          <span key="mv" style={{ color: DARK.ink }}>{fmtNum(totalMV, 0)}</span>,
          "",
          <span key="al" style={{ color: DARK.inkDim }}>100.00</span>,
        ]}
      />
    </TerminalFrame>
  );
}
