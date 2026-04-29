import { ModernBrokerageStickyNav } from "./components/StickyNav";
import { ModernCalendarView } from "./views/CalendarView";
import { ModernHoldingsView } from "./views/HoldingsView";
import { ModernOverviewView } from "./views/OverviewView";
import { ModernSecurityView } from "./views/SecurityDetailView";
import { ModernTodayView } from "./views/TodayView";

export default function ModernBrokeragePage() {
  return (
    <main style={{ background: "#fefefe", color: "#18181b", minHeight: "100vh" }}>
      <ModernBrokerageStickyNav />
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "40px 24px 120px" }}>
        <header style={{ marginBottom: 24 }}>
          <p
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "#a1a1aa",
              margin: 0,
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Direction 3 of 3
          </p>
          <h1
            style={{
              fontSize: "clamp(40px, 6vw, 64px)",
              fontWeight: 600,
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
              margin: 0,
              marginBottom: 12,
              color: "#0a0a0a",
            }}
          >
            Modern Brokerage.
          </h1>
          <p style={{ fontSize: 17, color: "#52525b", margin: 0, maxWidth: 680, lineHeight: 1.55 }}>
            Light, generous, warm. Soft shadowed cards, large editorial numbers, pastel tints
            for visual category differentiation, friendly chips. Most accessible direction —
            consumer-fintech vibe pushed up-market for a power user.
          </p>
        </header>
        <ModernTodayView />
        <ModernOverviewView />
        <ModernSecurityView />
        <ModernHoldingsView />
        <ModernCalendarView />
      </div>
    </main>
  );
}
