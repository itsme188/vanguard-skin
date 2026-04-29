import { DarkStickyNav } from "./components/StickyNav";
import { DARK } from "./palette";
import { DarkCalendarView } from "./views/CalendarView";
import { DarkHoldingsView } from "./views/HoldingsView";
import { DarkOverviewView } from "./views/OverviewView";
import { DarkSecurityView } from "./views/SecurityDetailView";
import { DarkTodayView } from "./views/TodayView";

export default function DarkPage() {
  return (
    <main style={{ background: DARK.canvas, color: DARK.inkBody }}>
      <DarkStickyNav />
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "16px 18px 80px" }}>
        <header style={{ padding: "16px 0 24px", borderBottom: `1px solid ${DARK.border}` }}>
          <p
            style={{
              fontSize: 12,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: DARK.inkDim,
              margin: 0,
              marginBottom: 6,
              fontWeight: 500,
            }}
          >
            Direction · Dark Mode
          </p>
          <h1 style={{ fontSize: 28, color: DARK.ink, margin: 0, marginBottom: 10, fontWeight: 500, letterSpacing: "-0.005em" }}>
            BLOOMBERG-PRO · DENSE DATA
          </h1>
          <p style={{ fontSize: 15, color: DARK.inkDim, margin: 0, maxWidth: 720, lineHeight: 1.55 }}>
            Soft-black canvas, IBM Plex Mono throughout, hairline borders. Color is purely
            semantic: green up · red down · amber for current price, brand, and active
            warnings. Information density is the goal. Five views in one scroll, sharing
            tabular alignment.
          </p>
        </header>
        <DarkTodayView />
        <DarkOverviewView />
        <DarkSecurityView />
        <DarkHoldingsView />
        <DarkCalendarView />
      </div>
    </main>
  );
}
