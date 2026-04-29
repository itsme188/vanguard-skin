import { mockCalendarEvents } from "../../shared/fixtures";
import { HeroBlock } from "../components/HeroBlock";
import { CategoryChip, SectionLabel, SoftCard } from "../components/SoftCard";

const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const days = [
  { date: "2026-04-28", weekday: "Tue", label: "Apr 28", emoji: "📅" },
  { date: "2026-04-29", weekday: "Wed", label: "Apr 29", emoji: "📊" },
  { date: "2026-04-30", weekday: "Thu", label: "Apr 30", emoji: "🏛️" },
  { date: "2026-05-01", weekday: "Fri", label: "May 1", emoji: "📈" },
  { date: "2026-05-02", weekday: "Sat", label: "May 2", emoji: "💼" },
];

const IMPACT_TONE = {
  high: "down" as const,
  medium: "amber" as const,
  low: "neutral" as const,
};

export function ModernCalendarView() {
  return (
    <HeroBlock
      id="calendar"
      eyebrow="Calendar"
      title="This week"
      subtitle="Earnings + macro events shaping the week. Releases get enriched with actuals + SPY reaction after market close."
      action={
        <div style={{ display: "flex", gap: 8 }}>
          {["This week", "Next week", "Past"].map((label, i) => (
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
      {/* Weekly cards */}
      <div className="mb-week-grid">
        {days.map((day) => {
          const events = mockCalendarEvents.filter((e) => e.date === day.date);
          const isToday = day.date === "2026-04-28";
          return (
            <SoftCard
              key={day.date}
              tint={isToday ? "amber" : "white"}
              padding={20}
              style={{ minHeight: 280 }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: isToday ? "#92400e" : "#a1a1aa",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {day.weekday}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 600, color: "#0a0a0a", letterSpacing: "-0.02em" }}>
                    {day.label}
                  </div>
                </div>
                {isToday && <CategoryChip tone="amber">Today</CategoryChip>}
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {events.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      background: "#fffefb",
                      borderRadius: 10,
                      padding: 12,
                      border: "1px solid rgba(0,0,0,0.04)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                      {e.symbol ? (
                        <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, fontWeight: 700 }}>
                          {e.symbol}
                        </span>
                      ) : (
                        <CategoryChip tone="blue">Macro</CategoryChip>
                      )}
                      {e.isHeld && <CategoryChip tone="up">Held</CategoryChip>}
                      <CategoryChip tone={IMPACT_TONE[e.expectedImpact]}>{e.expectedImpact}</CategoryChip>
                    </div>
                    <div style={{ fontSize: 13, color: "#27272a", lineHeight: 1.4, marginBottom: 4 }}>
                      {e.title}
                    </div>
                    <div style={{ fontSize: 11, color: "#71717a" }}>
                      {e.releaseTime ?? "—"}
                      {e.actual && (
                        <span style={{ color: "#15803d", marginLeft: 6 }}>· actual {e.actual}</span>
                      )}
                      {e.reactionPct !== undefined && (
                        <span style={{ color: e.reactionPct > 0 ? "#15803d" : "#b91c1c", marginLeft: 6 }}>
                          · SPY {fmtPct(e.reactionPct)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {events.length === 0 && (
                  <div style={{ fontSize: 12, color: "#a1a1aa", fontStyle: "italic" }}>No releases</div>
                )}
              </div>
            </SoftCard>
          );
        })}
      </div>

      {/* Released so far */}
      <SoftCard tint="mint">
        <h3 style={{ fontSize: 20, fontWeight: 600, margin: 0, marginBottom: 16, color: "#0a0a0a" }}>
          Released this week
        </h3>
        <div style={{ display: "grid", gap: 10 }}>
          {mockCalendarEvents
            .filter((e) => e.actual)
            .map((e) => (
              <div
                key={e.id}
                style={{
                  background: "#fffefb",
                  borderRadius: 12,
                  padding: 14,
                  border: "1px solid rgba(0,0,0,0.04)",
                  display: "grid",
                  gridTemplateColumns: "100px 1fr auto auto",
                  gap: 16,
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 13, color: "#52525b" }}>{e.date}</span>
                <span style={{ fontSize: 14, color: "#0a0a0a" }}>
                  <strong>{e.symbol}</strong> · {e.title}
                </span>
                <CategoryChip tone="up">actual {e.actual}</CategoryChip>
                {e.reactionPct !== undefined && (
                  <CategoryChip tone={e.reactionPct > 0 ? "up" : "down"}>
                    SPY {fmtPct(e.reactionPct)}
                  </CategoryChip>
                )}
              </div>
            ))}
        </div>
      </SoftCard>

      {/* Legend */}
      <SoftCard padding={16}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <SectionLabel>Impact</SectionLabel>
          <CategoryChip tone="down">High</CategoryChip>
          <CategoryChip tone="amber">Medium</CategoryChip>
          <CategoryChip tone="neutral">Low</CategoryChip>
          <span style={{ marginLeft: "auto", fontSize: 13, color: "#71717a" }}>
            Reactions captured 2h post-release · SPY + sector ETF
          </span>
        </div>
      </SoftCard>
    </HeroBlock>
  );
}
