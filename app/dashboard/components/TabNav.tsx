"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useRef, useCallback } from "react";

const tabs = [
  { name: "Overview", href: "/dashboard" },
  { name: "Accounts", href: "/dashboard/accounts" },
  { name: "Holdings", href: "/dashboard/holdings" },
  { name: "Analysis", href: "/dashboard/analysis" },
  { name: "Charts", href: "/dashboard/charts" },
  { name: "Calendar", href: "/dashboard/calendar" },
  { name: "Research", href: "/dashboard/research" },
  { name: "Import", href: "/dashboard/import" },
];

export function TabNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const nav = navRef.current;
      if (!nav) return;

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
      className="max-w-[1600px] mx-auto px-6 electron:pl-20 flex gap-1 -mb-px overflow-x-auto"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab, index) => {
        const isActive =
          tab.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
              isActive
                ? "text-gold"
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
