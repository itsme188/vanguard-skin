import { TabNav } from "./components/TabNav";
import { TwsStatus } from "./components/TwsStatus";
import { ToastProvider } from "./components/Toast";
import { DataFreshness } from "./components/DataFreshness";
import { ChatDrawer } from "./components/ChatDrawer";
import { CommandPalette, SearchButton } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { AppVersion } from "./components/AppVersion";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-canvas">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        {/* Header */}
        <header className="border-b border-edge sticky top-0 z-50 bg-canvas/80 backdrop-blur-xl">
          <div className="max-w-[1400px] mx-auto px-6 flex items-center justify-between h-14">
            <h1 className="font-serif text-xl text-gold tracking-tight">
              Vanguard Skin
            </h1>
            <div className="flex items-center gap-4">
              <DataFreshness />
              <SearchButton />
              <ChatDrawer />
              <TwsStatus />
              <SettingsModal />
              <AppVersion />
            </div>
          </div>
          <TabNav />
        </header>

        {/* Content */}
        <main id="main-content" className="max-w-[1400px] mx-auto px-6 py-6">
          {children}
        </main>

        {/* Global command palette (Cmd+K) */}
        <CommandPalette />
      </div>
    </ToastProvider>
  );
}
