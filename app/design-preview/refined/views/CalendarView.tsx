import { mockCalendarEvents } from "../../shared/fixtures";
import { HeroBlock } from "../components/HeroBlock";
import { SagePill } from "../components/SagePill";
import { Eyebrow, SectionTitle, SoftCard } from "../components/SoftCard";
import { SAGE } from "../palette";

const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const days = [
  { date: "2026-04-28", weekday: "Tue", label: "Apr 28" },
  { date: "2026-04-29", weekday: "Wed", label: "Apr 29" },
  { date: "2026-04-30", weekday: "Thu", label: "Apr 30" },
  { date: "2026-05-01", weekday: "Fri", label: "May 1" },
  { date: "2026-05-02", weekday: "Sat", label: "May 2" },
];

const IMPACT_TONE = {
  high: "down" as const,
  medium: "linen" as const,
  low: "neutral" as const,
};

export function RefinedCalendarView() {
  return (
    <HeroBlock
      id="calendar"
      eyebrow="Calendar"
      title="Week of April 28."
      subtitle="Earnings + macro events. Releases get enriched with actuals + SPY reaction post-close."
      action={
        <div style={{ display: "flex", gap: 6 }}>
          {["This week", "Next week", "Past"].map((label, i) => (
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
      {/* Weekly cards */}
      <div className="rf-week-grid">
        {days.map((day) => {
          const events = mockCalendarEvents.filter((e) => e.date === day.date);
          const isToday = day.date === "2026-04-28";
          return (
            <SoftCard
              key={day.date}
              tint={isToday ? "sage" : "surface"}
              padding={16}
              style={{ minHeight: 240 }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
                <div>
                  <Eyebrow color={isToday ? SAGE.brand : SAGE.inkFaint}>{day.weekday}</Eyebrow>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 600,
                      color: SAGE.ink,
                      letterSpacing: "-0.015em",
                      fontFamily: "var(--font-refined-sans)",
                    }}
                  >
                    {day.label}
                  </div>
                </div>
                {isToday && <SagePill tone="brand" size="xs">Today</SagePill>}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {events.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      background: isToday ? SAGE.surface : SAGE.surfaceAlt,
                      borderRadius: 8,
                      padding: 10,
                      border: `1px solid ${SAGE.border}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, flexWrap: "wrap" }}>
                      {e.symbol ? (
                        <span
                          style={{
                            fontFamily: "var(--font-refined-mono)",
                            fontSize: 14,
                            fontWeight: 600,
                            color: SAGE.ink,
                          }}
                        >
                          {e.symbol}
                        </span>
                      ) : (
                        <SagePill tone="accent" size="xs">Macro</SagePill>
                      )}
                      {e.isHeld && <SagePill tone="up" size="xs">Held</SagePill>}
                      <SagePill tone={IMPACT_TONE[e.expectedImpact]} size="xs">{e.expectedImpact}</SagePill>
                    </div>
                    <div style={{ fontSize: 14, color: SAGE.ink, lineHeight: 1.4, marginBottom: 3 }}>
                      {e.title}
                    </div>
                    <div style={{ fontSize: 12, color: SAGE.inkDim, fontFamily: "var(--font-refined-mono)" }}>
                      {e.releaseTime ?? "—"}
                      {e.actual && (
                        <span style={{ color: SAGE.up, marginLeft: 5 }}>· actual {e.actual}</span>
                      )}
                      {e.reactionPct !== undefined && (
                        <span style={{ color: e.reactionPct > 0 ? SAGE.up : SAGE.down, marginLeft: 5 }}>
                          · SPY {fmtPct(e.reactionPct)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {events.length === 0 && (
                  <div style={{ fontSize: 13, color: SAGE.inkFaint, fontStyle: "italic" }}>No releases</div>
                )}
              </div>
            </SoftCard>
          );
        })}
      </div>

      {/* Released so far */}
      <SoftCard tint="sage">
        <SectionTitle>Released this week</SectionTitle>
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          {mockCalendarEvents
            .filter((e) => e.actual)
            .map((e) => (
              <div
                key={e.id}
                style={{
                  background: SAGE.surface,
                  borderRadius: 8,
                  padding: 12,
                  border: `1px solid ${SAGE.border}`,
                  display: "grid",
                  gridTemplateColumns: "100px 1fr auto auto",
                  gap: 14,
                  alignItems: "center",
                  minWidth: 0,
                }}
              >
                <span style={{ fontFamily: "var(--font-refined-mono)", fontSize: 14, color: SAGE.inkDim }}>{e.date}</span>
                <span style={{ fontSize: 15, color: SAGE.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <strong style={{ fontFamily: "var(--font-refined-mono)" }}>{e.symbol}</strong> · {e.title}
                </span>
                <SagePill tone="up" size="xs" mono>actual {e.actual}</SagePill>
                {e.reactionPct !== undefined && (
                  <SagePill tone={e.reactionPct > 0 ? "up" : "down"} size="xs" mono>
                    SPY {fmtPct(e.reactionPct)}
                  </SagePill>
                )}
              </div>
            ))}
        </div>
      </SoftCard>

      {/* Legend */}
      <SoftCard padding={14}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <Eyebrow>Impact</Eyebrow>
          <SagePill tone="down" size="xs">High</SagePill>
          <SagePill tone="linen" size="xs">Medium</SagePill>
          <SagePill tone="neutral" size="xs">Low</SagePill>
          <span style={{ marginLeft: "auto", fontSize: 14, color: SAGE.inkDim }}>
            Reactions captured 2h post-release · SPY + sector ETF
          </span>
        </div>
      </SoftCard>
    </HeroBlock>
  );
}
