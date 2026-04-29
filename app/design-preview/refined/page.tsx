import { Eyebrow } from "./components/SoftCard";
import { RefinedStickyNav } from "./components/StickyNav";
import { SAGE } from "./palette";
import { RefinedCalendarView } from "./views/CalendarView";
import { RefinedHoldingsView } from "./views/HoldingsView";
import { RefinedOverviewView } from "./views/OverviewView";
import { RefinedSecurityView } from "./views/SecurityDetailView";
import { RefinedTodayView } from "./views/TodayView";

export default function RefinedPage() {
  return (
    <main style={{ background: SAGE.pageBg, color: SAGE.ink, minHeight: "100vh" }}>
      <RefinedStickyNav />
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "32px 20px 96px" }}>
        <header style={{ marginBottom: 24 }}>
          <Eyebrow color={SAGE.brand}>Direction 4 · Refined</Eyebrow>
          <h1
            style={{
              fontSize: "clamp(36px, 5vw, 52px)",
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 1.05,
              margin: 0,
              marginBottom: 12,
              color: SAGE.ink,
            }}
          >
            Sage &amp; Linen + IBM Plex.
          </h1>
          <p style={{ fontSize: 16, color: SAGE.inkDim, margin: 0, maxWidth: 680, lineHeight: 1.55 }}>
            Modern Brokerage&rsquo;s structure with the consumer warmth dialed out. Warm cream
            pages, deep moss brand, restrained sage gains and burned sienna losses. IBM Plex
            Sans body, Plex Mono for every number and stock symbol. Smaller hero numbers. No
            decorative emojis. Five views — Today, Overview, Security Detail, Holdings,
            Calendar — same fixture data as the other directions.
          </p>
        </header>
        <RefinedTodayView />
        <RefinedOverviewView />
        <RefinedSecurityView />
        <RefinedHoldingsView />
        <RefinedCalendarView />
      </div>
    </main>
  );
}
