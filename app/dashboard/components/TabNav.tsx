"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Suspense, useRef, useCallback } from "react";
import type { Tab } from "./nav-tabs";
import { tabs } from "./nav-tabs";
import { TabDropdown } from "./TabDropdown";

// TabDropdown reads useSearchParams. Rendering it unwrapped would trigger a
// CSR-bailout during `next build` for any dashboard page that isn't
// force-dynamic. Wrapping in Suspense isolates the bailout to the dropdown
// itself and keeps the rest of the nav statically renderable.
function TabDropdownFallback({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  return (
    <Link
      href={tab.href}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      className={`relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
        isActive ? "text-gold-ink" : "text-ink-faint hover:text-ink-dim"
      }`}
    >
      {tab.name}
      {isActive && (
        <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-gold rounded-full" />
      )}
    </Link>
  );
}

export function TabNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const nav = navRef.current;
      if (!nav) return;

      // Don't intercept arrow keys when a dropdown menu is open — it handles its own up/down.
      const target = e.target as HTMLElement;
      if (target?.getAttribute("role") === "menuitem") return;

      const links = Array.from(
        nav.querySelectorAll<HTMLAnchorElement>('[role="tab"]')
      );
      const current = links.findIndex((l) => l === document.activeElement);
      if (current === -1) return;

      let next = current;
      if (e.key === "ArrowRight") next = (current + 1) % links.length;
      else if (e.key === "ArrowLeft")
        next = (current - 1 + links.length) % links.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = links.length - 1;
      else return;

      e.preventDefault();
      links[next].focus();
    },
    []
  );

  return (
    <nav
      ref={navRef}
      role="tablist"
      aria-label="Dashboard navigation"
      className="max-w-[1600px] mx-auto px-4 md:px-6 electron:pl-20 hidden md:flex gap-1 -mb-px overflow-x-auto"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive =
          tab.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(tab.href);

        if (tab.subviews && tab.subviews.length > 0) {
          return (
            <Suspense
              key={tab.href}
              fallback={<TabDropdownFallback tab={tab} isActive={isActive} />}
            >
              <TabDropdown tab={tab} isActive={isActive} />
            </Suspense>
          );
        }

        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
              isActive
                ? "text-gold-ink"
                : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            {tab.name}
            {isActive && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-gold rounded-full" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
