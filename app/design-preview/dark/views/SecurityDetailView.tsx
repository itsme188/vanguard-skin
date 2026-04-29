import { mockSecurityDetail } from "../../shared/fixtures";
import { Sparkline } from "../../shared/Sparkline";
import { TerminalFrame, TerminalKpiRow, TerminalRow } from "../components/TerminalFrame";
import { DARK } from "../palette";

const fmtNum = (n: number, frac = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

export function DarkSecurityView() {
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
      <div style={{ padding: 18, borderBottom: `1px solid ${DARK.border}` }}>
        <Sparkline bars={sec.bars} width={1200} height={300} stroke={DARK.amber} fill="rgba(255,184,77,0.06)" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 14, fontSize: 12 }}>
          {sec.levels.map((l, i) => {
            const color = l.active ? (l.type === "support" ? DARK.up : DARK.down) : DARK.inkFaint;
            return (
              <span key={i} style={{ color, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                {l.type === "support" ? "S" : "R"} · {fmtNum(l.price)} · {l.source.toUpperCase()}
                {!l.active && <span style={{ color: DARK.inkFaint }}> · OFF</span>}
              </span>
            );
          })}
        </div>
      </div>

      {/* Two-column rows */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${DARK.border}`, minWidth: 0 }}>
        <div style={{ borderRight: `1px solid ${DARK.borderRow}`, minWidth: 0 }}>
          <TerminalRow tone="header" columns="100px 70px 110px 80px" cells={["ACCT", "QTY", "MV", "GAIN%"]} />
          {sec.positions.map((p) => (
            <TerminalRow
              key={p.account}
              columns="100px 70px 110px 80px"
              cells={[
                p.account,
                fmtNum(p.quantity, 0),
                fmtNum(p.marketValue, 0),
                <span key="g" style={{ color: p.gainPct >= 0 ? DARK.up : DARK.down }}>
                  {fmtPct(p.gainPct)}%
                </span>,
              ]}
            />
          ))}
        </div>
        <div style={{ minWidth: 0 }}>
          <TerminalRow tone="header" columns="60px 80px 1fr 70px" cells={["TYPE", "PRICE", "SOURCE", "STATE"]} />
          {sec.levels.map((l, i) => (
            <TerminalRow
              key={i}
              columns="60px 80px 1fr 70px"
              cells={[
                <span key="t" style={{ color: l.type === "support" ? DARK.up : DARK.down }}>
                  {l.type === "support" ? "SUP" : "RES"}
                </span>,
                fmtNum(l.price),
                <span key="s" style={{ color: DARK.inkDim, fontSize: 14 }}>{l.source}</span>,
                <span key="st" style={{ color: l.active ? DARK.up : DARK.inkDim, fontSize: 12 }}>
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
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 24,
            fontSize: 14,
            color: DARK.inkBody,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: DARK.inkDim, fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase" }}>
            Earnings
          </span>
          <span style={{ color: DARK.amber }}>{sec.pendingEarnings.date}</span>
          <span style={{ color: DARK.inkDim }}>{sec.pendingEarnings.releaseTime}</span>
          <span style={{ marginLeft: "auto", color: DARK.inkDim }}>
            CONS · {sec.pendingEarnings.consensus}
          </span>
        </div>
      )}
    </TerminalFrame>
  );
}
