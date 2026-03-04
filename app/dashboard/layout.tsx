import { TabNav } from "./components/TabNav";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      {/* Header */}
      <header className="border-b border-edge sticky top-0 z-50 bg-canvas/80 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-6 flex items-center justify-between h-14">
          <h1 className="font-serif text-xl text-gold tracking-tight">
            Vanguard Skin
          </h1>
          <span className="text-[11px] text-ink-faint font-mono">v2.0</span>
        </div>
        <TabNav />
      </header>

      {/* Content */}
      <main className="max-w-[1400px] mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
