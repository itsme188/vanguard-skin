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
import { AlertsBell } from "./components/AlertsBell";
import { ReviewBell } from "./components/ReviewBell";
import { PrivacyToggle } from "./components/PrivacyToggle";
import { PrivacyProvider } from "@/lib/privacy/context";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
     <PrivacyProvider>
      <div className="min-h-screen bg-canvas">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        {/* Header */}
        <header className="border-b border-edge sticky top-0 z-50 bg-canvas/80 backdrop-blur-xl electron:pt-7">
          <div className="max-w-[1600px] mx-auto px-4 md:px-6 electron:pl-20 flex items-center justify-between h-14">
            <div className="flex items-center gap-2">
              <MobileNavDrawer />
              <h1 className="font-serif text-lg md:text-xl text-gold tracking-tight">
                Vanguard Skin
              </h1>
            </div>
            <div className="flex items-center gap-3 md:gap-4">
              <div className="hidden md:flex"><DataConfidenceIndicator /></div>
              <SearchButton />
              <TwsStatus />
              <ReviewBell />
              <AlertsBell />
              <ChatToggleButton />
              <PrivacyToggle />
              <SettingsModal />
              <span className="hidden md:inline"><AppVersion /></span>
            </div>
          </div>
          <TabNav />
        </header>

        {/* Digest catch-up notification */}
        <DigestCatchup />

        {/* Content */}
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
      </div>
     </PrivacyProvider>
    </ToastProvider>
  );
}
