import { mockCalendarEvents } from "../../shared/fixtures";
import { TerminalFrame, TerminalRow } from "../components/TerminalFrame";
import { DARK } from "../palette";

const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

const COLS = "90px 60px 70px 80px 1fr 110px 80px 60px";

export function DarkCalendarView() {
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
          e.expectedImpact === "high" ? DARK.down : e.expectedImpact === "medium" ? DARK.amber : DARK.inkDim;
        const isToday = e.date === "2026-04-28";
        return (
          <TerminalRow
            key={e.id}
            columns={COLS}
            cells={[
              <span key="d" style={{ color: isToday ? DARK.amber : DARK.inkDim }}>
                {e.date}
              </span>,
              <span key="t" style={{ color: DARK.inkDim, fontSize: 13 }}>{e.releaseTime ?? "—"}</span>,
              <span key="s" style={{ color: e.symbol ? DARK.amber : DARK.blue }}>
                {e.symbol ?? "—"}
              </span>,
              <span key="ty" style={{ color: DARK.inkDim, fontSize: 13 }}>{e.eventType.toUpperCase()}</span>,
              <span key="e" style={{ color: e.isHeld ? DARK.inkBody : DARK.inkDim, fontSize: 14 }}>
                {e.title}
                {e.isHeld && (
                  <span
                    style={{
                      marginLeft: 10,
                      padding: "2px 6px",
                      border: `1px solid ${DARK.border}`,
                      color: DARK.inkDim,
                      fontSize: 11,
                      letterSpacing: "0.18em",
                    }}
                  >
                    HELD
                  </span>
                )}
              </span>,
              <span key="da" style={{ color: e.actual ? DARK.up : DARK.inkDim, fontSize: 13 }}>
                {e.actual ? `act ${e.actual}` : e.consensus ? `cons ${e.consensus}` : "—"}
              </span>,
              <span key="r" style={{ color: e.reactionPct === undefined ? DARK.inkFaint : e.reactionPct > 0 ? DARK.up : DARK.down }}>
                {e.reactionPct !== undefined ? `${fmtPct(e.reactionPct)}%` : "—"}
              </span>,
              <span key="i" style={{ color: impactColor, fontSize: 11, letterSpacing: "0.18em", fontWeight: 500 }}>
                {e.expectedImpact.toUpperCase().slice(0, 4)}
              </span>,
            ]}
          />
        );
      })}

      {/* Reaction recap section */}
      <div style={{ padding: "14px 18px", borderTop: `1px solid ${DARK.border}`, display: "flex", gap: 24, fontSize: 12, flexWrap: "wrap" }}>
        <span style={{ color: DARK.inkDim, letterSpacing: "0.22em", textTransform: "uppercase" }}>
          Released this week
        </span>
        <span style={{ color: DARK.inkDim }}>1 of 7 events enriched</span>
        <span style={{ color: DARK.up }}>GLW BMO +2.10% react</span>
      </div>
    </TerminalFrame>
  );
}
