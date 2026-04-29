import { TerminalStickyNav } from "./components/StickyNav";
import { TerminalCalendarView } from "./views/CalendarView";
import { TerminalHoldingsView } from "./views/HoldingsView";
import { TerminalOverviewView } from "./views/OverviewView";
import { TerminalSecurityView } from "./views/SecurityDetailView";
import { TerminalTodayView } from "./views/TodayView";

export default function TerminalPage() {
  return (
    <main style={{ background: "#000", color: "#d4d4d4" }}>
      <TerminalStickyNav />
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "16px 16px 80px" }}>
        <header style={{ padding: "16px 0 24px", borderBottom: "1px solid #1f1f1f" }}>
          <p
            style={{
              fontSize: 10,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#666",
              margin: 0,
              marginBottom: 6,
            }}
          >
            Direction 2 of 3
          </p>
          <h1 style={{ fontSize: 28, color: "#eee", margin: 0, marginBottom: 8, fontWeight: 500 }}>
            PURE TERMINAL · DENSE DATA MODE
          </h1>
          <p style={{ fontSize: 13, color: "#888", margin: 0, maxWidth: 720, lineHeight: 1.6 }}>
            Black canvas, mono everywhere, no rounded corners, dense rows. Color is purely
            semantic: green up · red down · amber for current price and active levels.
            Information density is the goal — five views in one scroll, sharing visual rhythm
            and tabular alignment.
          </p>
        </header>
        <TerminalTodayView />
        <TerminalOverviewView />
        <TerminalSecurityView />
        <TerminalHoldingsView />
        <TerminalCalendarView />
      </div>
    </main>
  );
}
