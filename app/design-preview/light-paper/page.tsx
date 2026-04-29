import { LightPaperStickyNav } from "./components/StickyNav";
import { CalendarView } from "./views/CalendarView";
import { HoldingsView } from "./views/HoldingsView";
import { OverviewView } from "./views/OverviewView";
import { SecurityDetailView } from "./views/SecurityDetailView";
import { TodayView } from "./views/TodayView";

export default function LightPaperPage() {
  return (
    <main style={{ fontFamily: "var(--font-geist-sans)", color: "#1a1a1a" }}>
      <LightPaperStickyNav />
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 24px 96px" }}>
        <header style={{ marginBottom: 32 }}>
          <p
            style={{
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#8a7d65",
              margin: 0,
              marginBottom: 8,
            }}
          >
            Direction 1 of 3
          </p>
          <h1
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(36px, 5vw, 56px)",
              lineHeight: 1.05,
              letterSpacing: "-0.01em",
              margin: 0,
              marginBottom: 12,
            }}
          >
            Light Paper + Dark Data Modules.
          </h1>
          <p style={{ fontSize: 16, color: "#5a5a5a", margin: 0, maxWidth: 680, lineHeight: 1.55 }}>
            Warm off-white pages, generous serif headers, embedded dark Bloomberg-style data
            modules where density matters. Gold reserved for the current price and triggered
            alerts. Print-friendly tables. Scroll through five views — Today, Overview, Security
            Detail, Holdings, Calendar — to feel the rhythm.
          </p>
        </header>
        <TodayView />
        <OverviewView />
        <SecurityDetailView />
        <HoldingsView />
        <CalendarView />
      </div>
    </main>
  );
}
