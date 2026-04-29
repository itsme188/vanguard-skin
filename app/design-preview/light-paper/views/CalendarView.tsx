import { mockCalendarEvents } from "../../shared/fixtures";
import { DataLabel, DataModule } from "../components/DataModule";
import { PaperCard, PaperSection } from "../components/PaperSection";

const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const days = [
  { date: "2026-04-28", weekday: "Tue", label: "Apr 28" },
  { date: "2026-04-29", weekday: "Wed", label: "Apr 29" },
  { date: "2026-04-30", weekday: "Thu", label: "Apr 30" },
  { date: "2026-05-01", weekday: "Fri", label: "May 1" },
  { date: "2026-05-02", weekday: "Sat", label: "May 2" },
];

export function CalendarView() {
  return (
    <PaperSection
      id="calendar"
      eyebrow="Calendar"
      title="Week of April 28."
      subtitle="Earnings + macro events. Enriched rows show actuals and SPY reaction."
      action={
        <div style={{ display: "flex", gap: 8 }}>
          {["This week", "Next week", "Past releases"].map((label, i) => (
            <span
              key={label}
              style={{
                fontSize: 12,
                padding: "6px 12px",
                borderRadius: 4,
                background: i === 0 ? "#1a1a1a" : "#fffefb",
                color: i === 0 ? "#fffefb" : "#5a5a5a",
                border: i === 0 ? "1px solid #1a1a1a" : "1px solid #d8d2c3",
              }}
            >
              {label}
            </span>
          ))}
        </div>
      }
    >
      {/* Weekly grid */}
      <div className="lp-week-grid">
        {days.map((day) => {
          const events = mockCalendarEvents.filter((e) => e.date === day.date);
          const isToday = day.date === "2026-04-28";
          return (
            <div
              key={day.date}
              style={{
                background: isToday ? "#0a0a0a" : "#fffefb",
                color: isToday ? "#ddd" : "#1a1a1a",
                border: isToday ? "1px solid #1f1f1f" : "1px solid #e4dfd0",
                borderRadius: 6,
                padding: 16,
                minHeight: 220,
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-geist-mono)",
                  fontSize: 10,
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  color: isToday ? "#ffb84d" : "#8a7d65",
                  marginBottom: 4,
                }}
              >
                {day.weekday} {isToday && "· Today"}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-instrument-serif)",
                  fontSize: 24,
                  marginBottom: 12,
                  color: isToday ? "#fff" : "#1a1a1a",
                }}
              >
                {day.label}
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {events.map((e) => {
                  const dotColor =
                    e.expectedImpact === "high" ? "#ef4444" : e.expectedImpact === "medium" ? "#f59e0b" : "#888";
                  return (
                    <div
                      key={e.id}
                      style={{
                        fontSize: 12,
                        padding: 10,
                        borderRadius: 4,
                        background: isToday ? "#161616" : "#faf8f1",
                        border: isToday ? "1px solid #222" : "1px solid #ece8db",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: dotColor,
                            display: "inline-block",
                          }}
                        />
                        <span
                          style={{
                            fontFamily: "var(--font-geist-mono)",
                            fontSize: 10,
                            letterSpacing: "0.16em",
                            textTransform: "uppercase",
                            color: isToday ? "#888" : "#7a7a7a",
                          }}
                        >
                          {e.releaseTime ?? "—"}
                        </span>
                        {e.symbol && (
                          <span
                            style={{
                              fontFamily: "var(--font-geist-mono)",
                              fontSize: 11,
                              color: "#ffb84d",
                              fontWeight: 600,
                            }}
                          >
                            {e.symbol}
                          </span>
                        )}
                        {e.isHeld && (
                          <span
                            style={{
                              fontSize: 9,
                              padding: "1px 4px",
                              border: "1px solid",
                              borderColor: isToday ? "#222" : "#d8d2c3",
                              borderRadius: 2,
                              color: isToday ? "#888" : "#7a7a7a",
                              letterSpacing: "0.16em",
                              textTransform: "uppercase",
                            }}
                          >
                            held
                          </span>
                        )}
                      </div>
                      <div style={{ lineHeight: 1.4, color: isToday ? "#ddd" : "#1a1a1a" }}>{e.title}</div>
                      {(e.actual || e.consensus) && (
                        <div
                          style={{
                            fontFamily: "var(--font-geist-mono)",
                            fontSize: 10,
                            color: e.actual ? "#22c55e" : isToday ? "#888" : "#7a7a7a",
                            marginTop: 4,
                          }}
                        >
                          {e.actual ? `actual ${e.actual}` : `cons ${e.consensus}`}
                          {e.reactionPct !== undefined && (
                            <span style={{ marginLeft: 8, color: e.reactionPct > 0 ? "#22c55e" : "#ef4444" }}>
                              SPY {fmtPct(e.reactionPct)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {events.length === 0 && (
                  <div style={{ fontSize: 11, color: "#999", fontStyle: "italic" }}>No releases</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Released last week — dark module */}
      <DataModule title="Released This Week So Far" subtitle="post-release reactions">
        <div style={{ display: "grid", gap: 8 }}>
          {mockCalendarEvents
            .filter((e) => e.actual)
            .map((e) => (
              <div
                key={e.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 80px 1fr auto auto",
                  gap: 12,
                  padding: "8px 0",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "#888" }}>{e.date}</span>
                <span style={{ color: "#ffb84d", fontWeight: 600 }}>{e.symbol}</span>
                <span style={{ color: "#ddd" }}>{e.title}</span>
                <span style={{ color: "#22c55e" }}>actual {e.actual}</span>
                {e.reactionPct !== undefined && (
                  <span style={{ color: e.reactionPct > 0 ? "#22c55e" : "#ef4444" }}>
                    SPY {fmtPct(e.reactionPct)}
                  </span>
                )}
              </div>
            ))}
        </div>
      </DataModule>

      {/* Legend */}
      <PaperCard padding={16}>
        <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
          <DataLabel>Impact</DataLabel>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
            High
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
            Medium
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#888", display: "inline-block" }} />
            Low
          </span>
        </div>
      </PaperCard>
    </PaperSection>
  );
}
