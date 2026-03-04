"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const tabs = [
  { name: "Overview", href: "/dashboard" },
  { name: "Accounts", href: "/dashboard/accounts" },
  { name: "Import", href: "/dashboard/import" },
  { name: "Tax Lots", href: "/dashboard/tax-lots" },
  { name: "Reconciliation", href: "/dashboard/reconciliation" },
  { name: "Chat", href: "/dashboard/chat" },
];

export function TabNav() {
  const pathname = usePathname();

  return (
    <nav className="max-w-[1400px] mx-auto px-6 flex gap-1 -mb-px overflow-x-auto">
      {tabs.map((tab) => {
        const isActive =
          tab.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
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
