import { TabNav } from "./components/TabNav";
import { TwsStatus } from "./components/TwsStatus";
import { ToastProvider } from "./components/Toast";
import { DataConfidenceIndicator } from "./components/DataConfidenceIndicator";
import { ChatDrawer } from "./components/ChatDrawer";
import { ChatToggleButton } from "./components/ChatToggleButton";
import { CommandPalette, SearchButton } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { AppVersion } from "./components/AppVersion";
import { WelcomeOverlay } from "./components/WelcomeOverlay";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { MobileNavDrawer } from "./components/MobileNavDrawer";
import { DigestCatchup } from "./components/DigestCatchup";
import { NotificationBell } from "./components/NotificationBell";
import { PrivacyToggle } from "./components/PrivacyToggle";
import { ThemeToggle } from "./components/ThemeToggle";
import { NotesAmbient } from "./components/NotesAmbient";
import { PinUnlock } from "./components/PinUnlock";
import { PrivacyProvider } from "@/lib/privacy/context";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
     <PrivacyProvider>
      {/*
        .chat-rail-reserve reserves the right rail for the persistent chat
        panel (≥1280px viewport). The reservation reads --chat-rail-width
        which the chat collapse toggle (ChatDrawer) flips between 480px
        (open) and 0px (collapsed). Chat panel is fixed-positioned, so this
        is a layout-level reservation, not a flex/grid container — header
        sticky positioning still works inside.
      */}
      <div className="min-h-dvh bg-canvas chat-rail-reserve">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        {/* Header */}
        <header className="border-b border-edge sticky top-0 z-50 bg-canvas/80 backdrop-blur-xl electron:pt-7">
          <div className="max-w-[1600px] mx-auto px-4 md:px-6 electron:pl-20 flex items-center justify-between h-14">
            <div className="flex items-center gap-2">
              <MobileNavDrawer />
              {/* Finding #13: at 834px (iPad portrait band) the wordmark
                  wraps to 2 lines. TwsStatus's #14 fix frees enough width in
                  that band that the row no longer needs to shrink this item;
                  whitespace-nowrap is the guard that keeps it single-line
                  rather than relying on that headroom implicitly. */}
              <h1 className="text-lg md:text-xl text-gold tracking-tight font-medium md:max-lg:whitespace-nowrap!">
                Portfolio Desk
              </h1>
            </div>
            <div className="flex items-center gap-3 md:gap-4">
              <div className="hidden md:flex"><DataConfidenceIndicator /></div>
              <SearchButton />
              <div className="hidden md:flex"><TwsStatus /></div>
              <NotificationBell />
              <ChatToggleButton />
              <div className="hidden md:inline-flex"><ThemeToggle /></div>
              <PrivacyToggle />
              <SettingsModal />
              <span className="hidden md:inline"><AppVersion /></span>
            </div>
          </div>
          <TabNav />
        </header>

        {/* Digest catch-up notification */}
        <DigestCatchup />

        {/* Content. Mobile pb clears the fixed MobileBottomNav alone — the
            other floating overlay this used to also clear was removed
            2026-09-04 (QA ruling; see NotesAmbient.tsx's own comment).
            MobileBottomNav's own box is ~69px (pt-2 8 + [py-2 16 + 24px icon
            + gap-0.5 2 + 10px/1.5-leading text ≈15] + pb-1 4) plus its
            `pb-safe` inset, which is 0 on most devices and up to ~34px on a
            notched iPhone — pb-20 (80px) is the value that shipped and
            cleared it with no regressions from the first mobile-responsive
            commit (5f4a0080) through 434be9d9, which raised it only because
            that other overlay sat higher than the nav, not because the nav
            itself needed more. At >=768px MobileBottomNav doesn't render at
            all (`md:hidden`), so md:pb-6 is plain breathing room. */}
        <main id="main-content" className="max-w-[1600px] mx-auto px-4 md:px-6 pt-4 md:pt-6 pb-20 md:pb-6">
          {children}
        </main>

        {/* Global command palette (Cmd+K) */}
        <CommandPalette />

        {/* Chat drawer — rendered at root level so mobile full-screen overlay works */}
        <ChatDrawer />

        {/* Electron first-run onboarding */}
        <WelcomeOverlay />

        {/* Mobile bottom navigation (phone only) */}
        <MobileBottomNav />

        {/* Ambient notes overlay (Cmd+; from any tab) */}
        <NotesAmbient />

        {/* Convenience-PIN re-unlock overlay (#35 task 16). Renders only
            while the app is in the client-side "locked" state; dispatch a
            window `lock-app` event to enter it. */}
        <PinUnlock />
      </div>
     </PrivacyProvider>
    </ToastProvider>
  );
}
