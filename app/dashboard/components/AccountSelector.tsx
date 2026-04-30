"use client";

import { useRouter } from "next/navigation";
import type { Account } from "@/lib/types";

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

  const baseClass =
    "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors focus-ring";
  const activeClass = "bg-raised border border-edge-strong text-ink";
  const inactiveClass = "text-ink-faint hover:bg-raised hover:text-ink-dim";

  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Account selector">
      <button
        role="tab"
        aria-selected={selected === "all"}
        onClick={() => go("all")}
        className={`${baseClass} ${selected === "all" ? activeClass : inactiveClass}`}
      >
        <div className="w-2 h-2 rounded-full bg-ink-faint" />
        All Accounts
      </button>
      {accounts.map((account) => (
        <button
          key={account.id}
          role="tab"
          aria-selected={account.id === selected}
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
