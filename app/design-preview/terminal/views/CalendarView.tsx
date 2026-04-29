import { mockCalendarEvents } from "../../shared/fixtures";
import { TerminalFrame, TerminalRow } from "../components/TerminalFrame";

const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

const COLS = "90px 60px 70px 80px 1fr 110px 80px 60px";

export function TerminalCalendarView() {
  const sorted = [...mockCalendarEvents].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <TerminalFrame id="calendar" title="Calendar · Week of 2026-04-28" meta="EARNINGS + MACRO">
      <TerminalRow
        tone="header"
        columns={COLS}
        cells={["DATE", "TIME", "SYM", "TYPE", "EVENT", "DATA", "REACT", "IMPACT"]}
      />
      {sorted.map((e) => {
        const impactColor =
          e.expectedImpact === "high" ? "#ef4444" : e.expectedImpact === "medium" ? "#ffb84d" : "#666";
        const isToday = e.date === "2026-04-28";
        return (
          <TerminalRow
            key={e.id}
            columns={COLS}
            cells={[
              <span key="d" style={{ color: isToday ? "#ffb84d" : "#888" }}>
                {e.date}
              </span>,
              <span key="t" style={{ color: "#888", fontSize: 11 }}>{e.releaseTime ?? "—"}</span>,
              <span key="s" style={{ color: e.symbol ? "#ffb84d" : "#60a5fa" }}>
                {e.symbol ?? "—"}
              </span>,
              <span key="ty" style={{ color: "#666", fontSize: 11 }}>{e.eventType.toUpperCase()}</span>,
              <span key="e" style={{ color: e.isHeld ? "#d4d4d4" : "#888", fontSize: 12 }}>
                {e.title}
                {e.isHeld && (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: "1px 4px",
                      border: "1px solid #1f1f1f",
                      color: "#666",
                      fontSize: 9,
                      letterSpacing: "0.18em",
                    }}
                  >
                    HELD
                  </span>
                )}
              </span>,
              <span key="da" style={{ color: e.actual ? "#22c55e" : "#666", fontSize: 11 }}>
                {e.actual ? `act ${e.actual}` : e.consensus ? `cons ${e.consensus}` : "—"}
              </span>,
              <span key="r" style={{ color: e.reactionPct === undefined ? "#444" : e.reactionPct > 0 ? "#22c55e" : "#ef4444" }}>
                {e.reactionPct !== undefined ? `${fmtPct(e.reactionPct)}%` : "—"}
              </span>,
              <span key="i" style={{ color: impactColor, fontSize: 10, letterSpacing: "0.18em" }}>
                {e.expectedImpact.toUpperCase().slice(0, 4)}
              </span>,
            ]}
          />
        );
      })}

      {/* Reaction recap section */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #1f1f1f", display: "flex", gap: 24, fontSize: 11 }}>
        <span style={{ color: "#666", letterSpacing: "0.22em", textTransform: "uppercase" }}>
          Released this week
        </span>
        <span style={{ color: "#888" }}>1 of 7 events enriched</span>
        <span style={{ color: "#22c55e" }}>GLW BMO +2.10% react</span>
      </div>
    </TerminalFrame>
  );
}
