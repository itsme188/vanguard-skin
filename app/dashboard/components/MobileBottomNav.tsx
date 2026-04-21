"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const navItems = [
  {
    name: "Today",
    href: "/dashboard/today",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ),
  },
  {
    name: "Research",
    href: "/dashboard/research",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
        <path d="M18 14h-8" /><path d="M15 18h-5" /><path d="M10 6h8v4h-8z" />
      </svg>
    ),
  },
  {
    name: "Chat",
    href: "#chat",
    isChat: true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    name: "Calendar",
    href: "/dashboard/calendar",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    name: "Analysis",
    href: "/dashboard/analysis",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
];

export function MobileBottomNav() {
  const pathname = usePathname();

  function handleChatClick(e: React.MouseEvent) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("toggle-mobile-chat"));
  }

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-canvas/90 backdrop-blur-xl border-t border-edge pb-safe md:hidden electron:hidden"
      aria-label="Mobile navigation"
    >
      <div className="flex items-end justify-around px-2 pt-2 pb-1">
        {navItems.map((item) => {
          const isChat = "isChat" in item && item.isChat;
          const isActive = isChat
            ? false
            : item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          if (isChat) {
            return (
              <button
                key="chat"
                onClick={handleChatClick}
                className="flex flex-col items-center gap-0.5 -mt-3"
                aria-label="Open chat"
              >
                <span className="flex items-center justify-center w-12 h-12 rounded-full bg-gold text-canvas shadow-lg shadow-gold/20">
                  {item.icon}
                </span>
                <span className="text-[10px] font-medium text-gold">
                  {item.name}
                </span>
              </button>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 py-2 px-3 transition-colors ${
                isActive ? "text-gold" : "text-ink-faint"
              }`}
            >
              {item.icon}
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
