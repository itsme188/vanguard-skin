"use client";

import { useRef, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import type { Account } from "@/lib/types";

/**
 * Which tab an arrow key moves focus to, per the ARIA tabs pattern:
 * ArrowLeft/ArrowRight step and wrap, Home/End jump to the ends. Returns
 * null for any other key (the key is left alone).
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

const ACCOUNT_DOTS: Record<string, string> = {
  "Vanguard Taxable": "bg-gold",
  "Vanguard Roth IRA": "bg-blue",
  IBKR: "bg-up",
};

export function AccountSelector({
  accounts,
  selected,
}: {
  accounts: Account[];
  selected: number | "all";
}) {
  const router = useRouter();

  function go(id: number | "all") {
    router.push(`/dashboard/accounts?id=${id}`);
  }

  // Roving tabindex: only the selected tab is a Tab stop; the arrow keys
  // move focus between tabs. Focus does not select (selecting loads a new
  // page), so Enter or Space on the focused tab activates it as before.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const ids: (number | "all")[] = ["all", ...accounts.map((a) => a.id)];
  // An id that matches no tab would leave the list with no Tab stop.
  const tabStop = ids.includes(selected) ? selected : "all";

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextTabIndex(event.key, index, ids.length);
    if (next === null) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
  }

  const baseClass =
    "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors focus-ring";
  const activeClass = "bg-raised border border-edge-strong text-ink";
  const inactiveClass = "text-ink-faint hover:bg-raised hover:text-ink-dim";

  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Account selector">
      <button
        ref={(el) => {
          tabRefs.current[0] = el;
        }}
        role="tab"
        aria-selected={selected === "all"}
        tabIndex={tabStop === "all" ? 0 : -1}
        onKeyDown={(e) => onKeyDown(e, 0)}
        onClick={() => go("all")}
        className={`${baseClass} ${selected === "all" ? activeClass : inactiveClass}`}
      >
        <div className="w-2 h-2 rounded-full bg-ink-faint" />
        All Accounts
      </button>
      {accounts.map((account, i) => (
        <button
          key={account.id}
          ref={(el) => {
            tabRefs.current[i + 1] = el;
          }}
          role="tab"
          aria-selected={account.id === selected}
          tabIndex={tabStop === account.id ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, i + 1)}
          onClick={() => go(account.id)}
          className={`${baseClass} ${account.id === selected ? activeClass : inactiveClass}`}
        >
          <div
            className={`w-2 h-2 rounded-full ${
              ACCOUNT_DOTS[account.name] ?? "bg-ink-faint"
            }`}
          />
          {account.name}
        </button>
      ))}
    </div>
  );
}
