import { mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { TerminalFrame, TerminalKpiRow, TerminalRow } from "../components/TerminalFrame";

const fmtNum = (n: number, frac = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

export function TerminalSecurityView() {
  const sec = mockSecurityDetail;
  const totalQty = sec.positions.reduce((s, p) => s + p.quantity, 0);
  const totalMV = sec.positions.reduce((s, p) => s + p.marketValue, 0);
  const totalCost = sec.positions.reduce((s, p) => s + p.costBasis, 0);
  const totalGainPct = ((totalMV - totalCost) / totalCost) * 100;

  return (
    <TerminalFrame id="security" title={`Security · ${sec.symbol} · ${sec.name}`} meta="LAST 16:00:02 ET">
      <TerminalKpiRow
        items={[
          { label: "Last", value: fmtNum(sec.price), tone: "amber" },
          { label: "Day Δ", value: `+${fmtNum(sec.todayChange)}`, tone: "up" },
          { label: "Day %", value: `+${sec.todayChangePct.toFixed(2)}`, tone: "up" },
          { label: "Qty", value: fmtNum(totalQty, 0), tone: "neutral" },
          { label: "MV", value: fmtNum(totalMV, 0), tone: "neutral" },
          { label: "Gain %", value: `+${totalGainPct.toFixed(2)}`, tone: "up" },
        ]}
      />

      {/* Chart */}
      <div style={{ padding: 16, borderBottom: "1px solid #1f1f1f", position: "relative" }}>
        <Sparkline bars={sec.bars} width={1200} height={300} />
        {/* SR overlay legend */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12, fontSize: 10 }}>
          {sec.levels.map((l, i) => {
            const color = l.active ? (l.type === "support" ? "#22c55e" : "#ef4444") : "#444";
            return (
              <span key={i} style={{ color, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                {l.type === "support" ? "S" : "R"} · {fmtNum(l.price)} · {l.source.toUpperCase()}
                {!l.active && <span style={{ color: "#444" }}> · OFF</span>}
              </span>
            );
          })}
        </div>
      </div>

      {/* Two-column rows */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #1f1f1f" }}>
        <div style={{ borderRight: "1px solid #161616" }}>
          <TerminalRow tone="header" columns="100px 70px 110px 80px" cells={["ACCT", "QTY", "MV", "GAIN%"]} />
          {sec.positions.map((p) => (
            <TerminalRow
              key={p.account}
              columns="100px 70px 110px 80px"
              cells={[
                p.account,
                fmtNum(p.quantity, 0),
                fmtNum(p.marketValue, 0),
                <span key="g" style={{ color: p.gainPct >= 0 ? "#22c55e" : "#ef4444" }}>
                  {fmtPct(p.gainPct)}%
                </span>,
              ]}
            />
          ))}
        </div>
        <div>
          <TerminalRow tone="header" columns="60px 80px 1fr 60px" cells={["TYPE", "PRICE", "SOURCE", "STATE"]} />
          {sec.levels.map((l, i) => (
            <TerminalRow
              key={i}
              columns="60px 80px 1fr 60px"
              cells={[
                <span key="t" style={{ color: l.type === "support" ? "#22c55e" : "#ef4444" }}>
                  {l.type === "support" ? "SUP" : "RES"}
                </span>,
                fmtNum(l.price),
                <span key="s" style={{ color: "#888", fontSize: 12 }}>{l.source}</span>,
                <span key="st" style={{ color: l.active ? "#22c55e" : "#666", fontSize: 10 }}>
                  {l.active ? "ARMED" : "PAUSED"}
                </span>,
              ]}
            />
          ))}
        </div>
      </div>

      {/* Pending earnings */}
      {sec.pendingEarnings && (
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 24,
            fontSize: 12,
            color: "#d4d4d4",
          }}
        >
          <span style={{ color: "#666", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase" }}>
            Earnings
          </span>
          <span style={{ color: "#ffb84d" }}>{sec.pendingEarnings.date}</span>
          <span style={{ color: "#888" }}>{sec.pendingEarnings.releaseTime}</span>
          <span style={{ marginLeft: "auto", color: "#888" }}>
            CONS · {sec.pendingEarnings.consensus}
          </span>
        </div>
      )}
    </TerminalFrame>
  );
}
